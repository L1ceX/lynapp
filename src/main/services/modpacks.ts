import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import type { WebContents } from "electron";
import path from "node:path";
import { promisify } from "node:util";
import { IPC } from "@shared/ipc";
import type { LauncherInstance, ModLoader } from "@shared/types";
import { writeContentManifest } from "./manifest";
import { getLauncherRoot } from "../paths";
import { JsonStore } from "../store";
import { InstanceService } from "./instances";
import { MinecraftService, pickLatestLoaderVersion } from "./minecraft";
import { readUrlBytes, createThrottledEmitter, type BytesCallback } from "./transfer";
import { tr } from "../i18n";
import { curseForgeDependencies, type CurseForgeManifest, type CurseForgeService, type ResolvedPackFile } from "./curseforge";

const execFileAsync = promisify(execFile);

interface MrpackIndexFile {
  path: string;
  hashes?: {
    sha1?: string;
    sha512?: string;
  };
  env?: {
    client?: string;
    server?: string;
  };
  downloads?: string[];
  fileSize?: number;
}

interface MrpackIndex {
  formatVersion?: number;
  game?: string;
  versionId?: string;
  name?: string;
  summary?: string;
  dependencies?: Record<string, string>;
  files?: MrpackIndexFile[];
}

interface MrpackVersion {
  id: string;
  project_id: string;
}

interface MrpackProject {
  id: string;
  slug?: string;
  title?: string;
  icon_url?: string;
}

interface DownloadedEntry {
  rel: string;
  fileName: string;
  sha512?: string;
  sha1?: string;
}

interface ResolvedMeta {
  projectId: string;
  versionId: string;
  name: string;
  slug?: string;
  iconUrl?: string;
}

const dirProjectType: Record<string, "mod" | "resourcepack" | "shader" | "datapack"> = {
  mods: "mod",
  resourcepacks: "resourcepack",
  shaderpacks: "shader",
  datapacks: "datapack"
};

const dirKindFolder: Record<string, string> = {
  mod: "mods",
  resourcepack: "resourcepacks",
  shader: "shaderpacks",
  datapack: "datapacks"
};

interface ExportVersionFile {
  url: string;
  filename: string;
  primary?: boolean;
  size?: number;
  hashes?: { sha1?: string; sha512?: string };
}

interface ExportVersion {
  id: string;
  files: ExportVersionFile[];
}

interface PendingImport {
  tmp: string;
  files: MrpackIndexFile[];
  at: number;
  created: boolean;
  overrides: string[];
  cfMeta: Map<string, ResolvedPackFile>;
}

interface UnpackedPack {
  tmp: string;
  index: MrpackIndex;
  overrides: string[];
  skipped: string[];
  cfMeta: Map<string, ResolvedPackFile>;
}

function pickLoader(dependencies: Record<string, string>, gameVersion: string): { loader: ModLoader; loaderVersion?: string } {
  const fabric = (dependencies["fabric-loader"] ?? "").trim();
  if (fabric) return { loader: "fabric", loaderVersion: fabric };

  const quilt = (dependencies["quilt-loader"] ?? "").trim();
  if (quilt) return { loader: "quilt", loaderVersion: quilt };

  const forge = (dependencies.forge ?? "").trim();
  if (forge) return { loader: "forge", loaderVersion: forge.startsWith(`${gameVersion}-`) ? forge : `${gameVersion}-${forge}` };

  const neoforge = (dependencies.neoforge ?? "").trim();
  if (neoforge) return { loader: "neoforge", loaderVersion: neoforge };

  return { loader: "vanilla" };
}


function unsafePackPath(entryPath: string): Error {
  return new Error(tr(`Unsafe path inside the modpack: ${entryPath}`, `Недопустимый путь внутри сборки: ${entryPath}`));
}

function isStrictlyInside(root: string, target: string): boolean {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  const rel = path.relative(base, resolved);
  return Boolean(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function resolveTarget(instanceDir: string, entryPath: string): string {
  const raw = entryPath.replace(/[\\/]+/g, "/");
  if (!raw || raw.startsWith("/") || /^[a-zA-Z]:/.test(raw) || raw.includes("\0")) {
    throw unsafePackPath(entryPath);
  }
  const segments = raw.split("/").filter((segment) => segment && segment !== ".");
  if (!segments.length || segments.some((segment) => segment === ".." || segment.includes(":"))) {
    throw unsafePackPath(entryPath);
  }
  const head = segments[0].replace(/[. ]+$/g, "").toLowerCase();
  if (head === ".launcher" || head === "") {
    throw unsafePackPath(entryPath);
  }
  const target = path.join(instanceDir, ...segments);
  if (!isStrictlyInside(instanceDir, target)) {
    throw unsafePackPath(entryPath);
  }
  return target;
}

function resolveOverridesDir(tmp: string, name: string): string {
  const raw = name.replace(/[\\/]+/g, "/").replace(/\/+$/g, "");
  if (!raw || raw.startsWith("/") || /^[a-zA-Z]:/.test(raw) || raw.includes("\0")) {
    throw unsafePackPath(name);
  }
  const segments = raw.split("/").filter((segment) => segment && segment !== ".");
  if (!segments.length || segments.some((segment) => segment === ".." || segment.includes(":"))) {
    throw unsafePackPath(name);
  }
  const dir = path.join(tmp, ...segments);
  if (!isStrictlyInside(tmp, dir)) {
    throw unsafePackPath(name);
  }
  return dir;
}

function verifyBuffer(buffer: Buffer, hashes: MrpackIndexFile["hashes"], entryPath: string): void {
  const sha512 = hashes?.sha512?.toLowerCase();
  if (sha512) {
    const actual = createHash("sha512").update(buffer).digest("hex").toLowerCase();
    if (actual !== sha512) throw new Error(tr(`Checksum mismatch: ${entryPath}`, `Контрольная сумма не совпадает: ${entryPath}`));
    return;
  }
  const sha1 = hashes?.sha1?.toLowerCase();
  if (sha1) {
    const actual = createHash("sha1").update(buffer).digest("hex").toLowerCase();
    if (actual !== sha1) throw new Error(tr(`Checksum mismatch: ${entryPath}`, `Контрольная сумма не совпадает: ${entryPath}`));
  }
}

const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

async function extractZip(zipPath: string, destination: string): Promise<void> {
  const script = [
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    `[System.IO.Compression.ZipFile]::ExtractToDirectory(${psQuote(zipPath)}, ${psQuote(destination)}, [System.Text.Encoding]::UTF8)`
  ].join("\r\n");
  await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    timeout: 180000,
    maxBuffer: 32 * 1024 * 1024
  });
}

async function downloadBuffer(url: string, onBytes?: BytesCallback, signal?: AbortSignal): Promise<Buffer> {
  const { buffer } = await readUrlBytes(url, { "User-Agent": "lynapp" }, signal, (received, total) => onBytes?.(received, total), 15 * 60 * 1000);
  return buffer;
}

async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  async function run(): Promise<void> {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
}

export class ModpackService {
  constructor(
    private readonly store: JsonStore,
    private readonly instances: InstanceService,
    private readonly minecraft: MinecraftService,
    private readonly curseforge?: CurseForgeService
  ) {}

  private readonly pending = new Map<string, PendingImport>();
  private readonly activeImports = new Map<string, AbortController>();

  private async unpackIndex(filePath: string): Promise<UnpackedPack> {
    if (!/\.(mrpack|zip)$/i.test(filePath) || !existsSync(filePath)) {
      throw new Error(tr("Drop a modpack file (.mrpack or a CurseForge .zip) to import it", "Перетащите файл сборки (.mrpack или .zip CurseForge), чтобы импортировать его"));
    }
    const tmp = path.join(getLauncherRoot(), "cache", "modpacks", `import-${randomUUID()}`);
    try {
      await mkdir(tmp, { recursive: true });
      try {
        await extractZip(filePath, tmp);
      } catch {
        throw new Error(tr("Could not unpack the modpack file (corrupt archive?)", "Не удалось распаковать файл сборки (архив повреждён?)"));
      }
      if (!existsSync(path.join(tmp, "modrinth.index.json")) && existsSync(path.join(tmp, "manifest.json"))) {
        return await this.unpackCurseForge(tmp);
      }
      let index: MrpackIndex;
      try {
        index = JSON.parse(await readFile(path.join(tmp, "modrinth.index.json"), "utf8")) as MrpackIndex;
      } catch {
        throw new Error(tr("modrinth.index.json is missing or broken: not a valid .mrpack", "Файл modrinth.index.json отсутствует или повреждён: это не модпак .mrpack"));
      }
      if (index.formatVersion !== 1 || index.game !== "minecraft") {
        throw new Error(tr("Unsupported .mrpack format (need formatVersion 1 for Minecraft)", "Неподдерживаемый формат .mrpack (нужен formatVersion 1 для Minecraft)"));
      }
      return { tmp, index, overrides: ["overrides", "client-overrides"], skipped: [], cfMeta: new Map() };
    } catch (error) {
      await rm(tmp, { recursive: true, force: true });
      throw error;
    }
  }

  private async unpackCurseForge(tmp: string): Promise<UnpackedPack> {
    let manifest: CurseForgeManifest;
    try {
      manifest = JSON.parse(await readFile(path.join(tmp, "manifest.json"), "utf8")) as CurseForgeManifest;
    } catch {
      throw new Error(tr("manifest.json is broken: not a valid CurseForge modpack", "Файл manifest.json повреждён: это не сборка CurseForge"));
    }
    if (manifest.manifestType && manifest.manifestType !== "minecraftModpack") {
      throw new Error(tr("This CurseForge archive is not a Minecraft modpack", "Этот архив CurseForge — не сборка Minecraft"));
    }
    if (!this.curseforge) {
      throw new Error(tr("CurseForge modpacks are not supported here", "Сборки CurseForge здесь не поддерживаются"));
    }
    const resolved = await this.curseforge.resolveManifest(manifest);
    const cfMeta = new Map<string, ResolvedPackFile>();
    const files: MrpackIndexFile[] = resolved.files.map((file) => {
      cfMeta.set(file.path, file);
      return { path: file.path, hashes: file.sha1 ? { sha1: file.sha1 } : undefined, downloads: [file.url], fileSize: file.size };
    });
    const overridesName = (manifest.overrides ?? "overrides").replace(/[\\/]+$/g, "") || "overrides";
    resolveOverridesDir(tmp, overridesName);
    const index: MrpackIndex = {
      formatVersion: 1,
      game: "minecraft",
      name: manifest.name,
      dependencies: curseForgeDependencies(manifest),
      files
    };
    return { tmp, index, overrides: [overridesName], skipped: resolved.skipped, cfMeta };
  }

  private wantedFiles(index: MrpackIndex): MrpackIndexFile[] {
    const wanted = (index.files ?? []).filter(
      (file) => file?.path && file.downloads?.length && (file.env?.client ?? "required") !== "unsupported"
    );
    const probe = path.join(getLauncherRoot(), "cache", "modpacks", "probe");
    for (const file of wanted) {
      resolveTarget(probe, file.path);
    }
    return wanted;
  }

  async beginImport(filePath: string): Promise<{ instance: LauncherInstance; totalFiles: number; skipped: string[] }> {
    const unpacked = await this.unpackIndex(filePath);
    const { tmp, index } = unpacked;
    let createdId: string | null = null;
    try {
      const dependencies = index.dependencies ?? {};
      const gameVersion = (dependencies.minecraft ?? "").trim();
      if (!gameVersion) {
        throw new Error(tr("The modpack does not declare a Minecraft version", "В сборке не указана версия Minecraft"));
      }
      await this.minecraft.assertVersionExists(gameVersion);
      const { loader, loaderVersion } = pickLoader(dependencies, gameVersion);
      await this.minecraft.assertLoaderCompatible(loader, gameVersion);
      const wanted = this.wantedFiles(index);

      const fallbackName = path.basename(filePath, path.extname(filePath));
      const instance = await this.instances.create({
        name: (index.name ?? "").trim() || fallbackName,
        gameVersion,
        loader,
        loaderVersion
      });
      createdId = instance.id;

      this.sweepPending();
      this.pending.set(instance.id, { tmp, files: wanted, at: Date.now(), created: true, overrides: unpacked.overrides, cfMeta: unpacked.cfMeta });
      return { instance, totalFiles: wanted.length, skipped: unpacked.skipped };
    } catch (error) {
      if (createdId) this.pending.delete(createdId);
      await rm(tmp, { recursive: true, force: true });
      throw error;
    }
  }

  async beginImportToInstance(filePath: string, instanceId: string): Promise<{ totalFiles: number; packName: string; packGameVersion: string; packLoader: string; skipped: string[] }> {
    const unpacked = await this.unpackIndex(filePath);
    const { tmp, index } = unpacked;
    try {
      const data = await this.store.getData();
      const instance = data.instances.find((item) => item.id === instanceId);
      if (!instance) {
        throw new Error(tr("Instance not found", "Инстанция не найдена"));
      }
      const dependencies = index.dependencies ?? {};
      const packGameVersion = (dependencies.minecraft ?? "").trim() || instance.gameVersion;
      const picked = pickLoader(dependencies, packGameVersion);
      const packLoader = dependencies.minecraft ? picked.loader : instance.loader;
      const old = this.pending.get(instanceId);
      if (old) {
        this.pending.delete(instanceId);
        await rm(old.tmp, { recursive: true, force: true }).catch(() => undefined);
      }
      const wanted = this.wantedFiles(index);
      this.sweepPending();
      this.pending.set(instanceId, { tmp, files: wanted, at: Date.now(), created: false, overrides: unpacked.overrides, cfMeta: unpacked.cfMeta });
      return { totalFiles: wanted.length, packName: (index.name ?? "").trim() || path.basename(filePath, path.extname(filePath)), packGameVersion, packLoader, skipped: unpacked.skipped };
    } catch (error) {
      await rm(tmp, { recursive: true, force: true });
      throw error;
    }
  }

  async cancelImport(instanceId: string): Promise<void> {
    const active = this.activeImports.get(instanceId);
    if (active) {
      active.abort();
    }
    const job = this.pending.get(instanceId);
    if (!job) return;
    this.pending.delete(instanceId);
    await rm(job.tmp, { recursive: true, force: true }).catch(() => undefined);
    if (job.created) {
      await this.instances.remove(instanceId).catch(() => undefined);
    }
  }

  async listExportEntries(instanceId: string): Promise<Array<{ name: string; isDir: boolean; size: number; modified: string | null }>> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === instanceId);
    if (!instance) {
      throw new Error(tr("Instance not found", "Инстанция не найдена"));
    }
    const out: Array<{ name: string; isDir: boolean; size: number; modified: string | null }> = [];
    let names: string[] = [];
    try {
      names = await readdir(instance.directory);
    } catch {
      return out;
    }
    for (const name of names) {
      if (name === ".launcher") {
        continue;
      }
      const full = path.join(instance.directory, name);
      try {
        const fileStat = await stat(full);
        out.push({
          name,
          isDir: fileStat.isDirectory(),
          size: fileStat.isDirectory() ? await this.dirSize(full).catch(() => 0) : fileStat.size,
          modified: fileStat.mtime.toISOString()
        });
      } catch {
      }
    }
    out.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    return out;
  }

  private async dirSize(target: string): Promise<number> {
    let total = 0;
    const entries = await readdir(target, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(target, entry.name);
      if (entry.isDirectory()) {
        total += await this.dirSize(full);
      } else {
        try {
          total += (await stat(full)).size;
        } catch {
        }
      }
    }
    return total;
  }

  async exportInstance(instanceId: string, outPath: string, include?: string[]): Promise<string> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === instanceId);
    if (!instance) {
      throw new Error(tr("Instance not found", "Инстанция не найдена"));
    }
    const included = include ? new Set(include) : null;
    const dependencies: Record<string, string> = { minecraft: instance.gameVersion };
    let loaderVersion = (instance.loaderVersion ?? "").trim();
    if (!loaderVersion && instance.loader !== "vanilla") {
      const available = await this.minecraft.listLoaderVersions(instance.loader, instance.gameVersion).catch(() => [] as string[]);
      loaderVersion = instance.loader === "forge" || instance.loader === "neoforge"
        ? pickLatestLoaderVersion(available) ?? ""
        : available.find((item) => !item.includes("-")) ?? available[0] ?? "";
    }
    if (instance.loader === "fabric" && loaderVersion) {
      dependencies["fabric-loader"] = loaderVersion;
    } else if (instance.loader === "quilt" && loaderVersion) {
      dependencies["quilt-loader"] = loaderVersion;
    } else if (instance.loader === "forge" && loaderVersion) {
      dependencies["forge"] = loaderVersion.startsWith(`${instance.gameVersion}-`) ? loaderVersion.slice(instance.gameVersion.length + 1) : loaderVersion;
    } else if (instance.loader === "neoforge" && loaderVersion) {
      dependencies["neoforge"] = loaderVersion;
    }
    const withVersions = instance.mods.filter((mod) => mod.provider === "modrinth" && mod.projectId && mod.versionId);
    const versionMap = await this.fetchVersionsByIds([...new Set(withVersions.map((mod) => mod.versionId as string))]);
    const worldFolders = (await readdir(path.join(instance.directory, "saves"), { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name);
    const indexedWorldDatapacks = new Set<string>();
    const files: MrpackIndexFile[] = [];
    const manual: Array<{ kind: string; fileName: string }> = [];
    for (const mod of instance.mods) {
      const kind = (mod.projectType ?? "mod") as keyof typeof dirKindFolder;
      const folder = dirKindFolder[kind];
      if (!folder || !mod.fileName) {
        continue;
      }
      if (included && !included.has(folder)) {
        continue;
      }
      if (/\.disabled$/i.test(mod.fileName)) {
        continue;
      }
      const inRoot = existsSync(path.join(instance.directory, folder, mod.fileName));
      const matchedWorlds = kind === "datapack"
        ? worldFolders.filter((world) => existsSync(path.join(instance.directory, "saves", world, "datapacks", mod.fileName as string)))
        : [];
      if (!inRoot && !matchedWorlds.length) {
        continue;
      }
      const version = mod.versionId ? versionMap.get(mod.versionId) : undefined;
      const apiFile = version?.files.find((f) => f.primary) ?? version?.files[0];
      if (inRoot) {
        if (version && apiFile?.hashes && apiFile.url && typeof apiFile.size === "number") {
          files.push({
            path: `${folder}/${apiFile.filename}`,
            hashes: { sha1: apiFile.hashes.sha1, sha512: apiFile.hashes.sha512 },
            env: kind === "mod"
              ? { client: "required", server: "optional" }
              : kind === "datapack"
                ? { client: "required", server: "required" }
                : { client: "required", server: "unsupported" },
            downloads: [apiFile.url],
            fileSize: apiFile.size
          });
        } else {
          manual.push({ kind: folder, fileName: mod.fileName });
        }
      }
      for (const world of matchedWorlds) {
        if (version && apiFile?.hashes && apiFile.url && typeof apiFile.size === "number") {
          files.push({
            path: `saves/${world}/datapacks/${apiFile.filename}`,
            hashes: { sha1: apiFile.hashes.sha1, sha512: apiFile.hashes.sha512 },
            env: { client: "required", server: "required" },
            downloads: [apiFile.url],
            fileSize: apiFile.size
          });
          indexedWorldDatapacks.add(`${world}:${mod.fileName.toLowerCase()}`);
        }
      }
    }
    const tmp = path.join(getLauncherRoot(), "cache", "modpacks", `export-${randomUUID()}`);
    try {
      await mkdir(path.join(tmp, "overrides"), { recursive: true });
      for (const entry of manual) {
        const src = path.join(instance.directory, entry.kind, entry.fileName);
        if (!existsSync(src)) {
          continue;
        }
        await mkdir(path.join(tmp, "overrides", entry.kind), { recursive: true });
        await cp(src, path.join(tmp, "overrides", entry.kind, entry.fileName), { recursive: true });
      }
      const knownFiles = new Set([
        ...instance.mods.map((mod) => (mod.fileName ?? "").toLowerCase()),
        ...instance.mods.map((mod) => `${mod.fileName ?? ""}.disabled`.toLowerCase())
      ]);
      for (const folder of Object.values(dirKindFolder)) {
        if (included && !included.has(folder)) {
          continue;
        }
        let entries: string[] = [];
        try {
          entries = await readdir(path.join(instance.directory, folder));
        } catch {
          continue;
        }
        for (const name of entries) {
          if (knownFiles.has(name.toLowerCase()) || /\.disabled$/i.test(name)) {
            continue;
          }
          await mkdir(path.join(tmp, "overrides", folder), { recursive: true });
          await cp(path.join(instance.directory, folder, name), path.join(tmp, "overrides", folder, name), { recursive: true });
        }
      }
      const contentFolders = new Set(Object.values(dirKindFolder));
      const extras = included
        ? [...included].filter((name) => !contentFolders.has(name))
        : ["config", "defaultconfigs", "options.txt", "optionsof.txt", "optionsshaders.txt", "servers.dat"];
      for (const extra of extras) {
        if (!extra || extra === ".launcher" || extra.includes("/") || extra.includes("\\") || extra.includes("..")) {
          continue;
        }
        const src = path.join(instance.directory, extra);
        if (existsSync(src)) {
          await cp(src, path.join(tmp, "overrides", extra), {
            recursive: true,
            filter: (itemPath) => path.basename(itemPath).toLowerCase() !== "session.lock"
          });
        }
      }
      if ((!included || included.has("datapacks")) && !extras.includes("saves")) {
        const worlds = await readdir(path.join(instance.directory, "saves"), { withFileTypes: true }).catch(() => []);
        for (const world of worlds) {
          if (!world.isDirectory()) continue;
          const dpDir = path.join(instance.directory, "saves", world.name, "datapacks");
          const dpEntries = await readdir(dpDir).catch(() => []);
          for (const entryName of dpEntries) {
            if (/\.disabled$/i.test(entryName) || indexedWorldDatapacks.has(`${world.name}:${entryName.toLowerCase()}`)) continue;
            await mkdir(path.join(tmp, "overrides", "saves", world.name, "datapacks"), { recursive: true });
            await cp(path.join(dpDir, entryName), path.join(tmp, "overrides", "saves", world.name, "datapacks", entryName), {
              recursive: true,
              filter: (itemPath) => path.basename(itemPath).toLowerCase() !== "session.lock"
            });
          }
        }
      }
      const index: MrpackIndex = {
        formatVersion: 1,
        game: "minecraft",
        versionId: randomUUID(),
        name: instance.name,
        summary: `${instance.gameVersion} / ${instance.loader}`,
        dependencies,
        files
      };
      await writeFile(path.join(tmp, "modrinth.index.json"), JSON.stringify(index, null, 2), "utf8");
      await mkdir(path.dirname(outPath), { recursive: true });
      const zipStage = `${outPath}.${process.pid}.zip`;
      const psPath = psQuote;
      const packScript = [
        "$ErrorActionPreference = 'Stop'",
        "Add-Type -AssemblyName System.IO.Compression.FileSystem",
        `$zip = [System.IO.Compression.ZipFile]::Open(${psPath(zipStage)}, 'Create', [System.Text.Encoding]::UTF8)`,
        "try {",
        `$items = Get-ChildItem -LiteralPath ${psPath(tmp)} -Recurse -Force`,
        `$base = ${psPath(tmp)}`,
        "foreach ($item in $items) {",
        `  $rel = $item.FullName.Substring($base.Length).TrimStart('\\').Replace('\\', '/')`,
        "  if ($item.PSIsContainer) {",
        "    $null = $zip.CreateEntry($rel + '/')",
        "  } else {",
        "    try { $in = [System.IO.File]::Open($item.FullName, 'Open', 'Read', 'ReadWrite') } catch { [Console]::Error.WriteLine('skipped: ' + $rel); continue }",
        "    $entry = $zip.CreateEntry($rel)",
        "    $out = $entry.Open()",
        "    try { $in.CopyTo($out) } finally { $out.Dispose(); $in.Dispose() }",
        "  }",
        "}",
        "} finally { $zip.Dispose() }"
      ].join("\r\n");
      try {
        await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", packScript], {
          windowsHide: true,
          timeout: 180000,
          maxBuffer: 32 * 1024 * 1024
        });
      } catch {
        await rm(zipStage, { force: true }).catch(() => undefined);
        throw new Error(tr("Could not pack the .mrpack file", "Не удалось упаковать файл .mrpack"));
      }
      await rm(outPath, { force: true }).catch(() => undefined);
      await rename(zipStage, outPath);
      return outPath;
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private sweepPending(): void {
    const now = Date.now();
    for (const [id, job] of this.pending) {
      if (now - job.at > 30 * 60 * 1000) {
        this.pending.delete(id);
        void rm(job.tmp, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  async finishImport(instanceId: string, sender: WebContents): Promise<LauncherInstance> {
    const job = this.pending.get(instanceId);
    if (!job) {
      throw new Error(tr("Import session expired, start the import again", "Сеанс импорта истёк, начните импорт заново"));
    }
    this.pending.delete(instanceId);

    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === instanceId);
    if (!instance) {
      await rm(job.tmp, { recursive: true, force: true });
      throw new Error(tr("The instance was deleted before the import finished", "Инстанция была удалена до завершения импорта"));
    }

    const emit = (done: number, total: number, fileName: string): void => {
      if (!sender.isDestroyed()) {
        sender.send(IPC.mrpackProgress, { instanceId, done, total, fileName });
      }
    };
    const emitBytes = createThrottledEmitter((update) => {
      if (!sender.isDestroyed()) {
        sender.send(IPC.transferProgress, update);
      }
    });

    const controller = new AbortController();
    this.activeImports.set(instanceId, controller);

    try {
      const settings = (await this.store.getData()).settings;
      const limit = Math.min(16, Math.max(1, Math.round(settings.concurrentDownloads) || 8));
      const stageDir = path.join(job.tmp, "stage");
      await mkdir(stageDir, { recursive: true });
      const downloaded: DownloadedEntry[] = [];
      let done = 0;
      await pool(job.files, limit, async (file) => {
        if (controller.signal.aborted) {
          throw new Error(tr("Import cancelled", "Импорт отменён"));
        }
        const urls = (file.downloads ?? []).filter(Boolean);
        let buffer: Buffer | null = null;
        let lastError: unknown;
        for (let i = 0; i < urls.length; i += 1) {
          if (controller.signal.aborted) {
            throw new Error(tr("Import cancelled", "Импорт отменён"));
          }
          try {
            const candidate = await downloadBuffer(
              urls[i],
              (received, total) => emitBytes(`mrpack:${instanceId}`, file.path, received, total, { doneFiles: done, totalFiles: job.files.length }),
              controller.signal
            );
            verifyBuffer(candidate, file.hashes, file.path);
            buffer = candidate;
            break;
          } catch (err) {
            lastError = err;
            if (controller.signal.aborted) throw err;
          }
        }
        if (!buffer) {
          throw lastError ?? new Error(tr(`Failed to download ${file.path}`, `Не удалось скачать ${file.path}`));
        }
        const stagedTarget = resolveTarget(stageDir, file.path);
        await mkdir(path.dirname(stagedTarget), { recursive: true });
        await writeFile(stagedTarget, buffer);
        const rel = file.path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
        downloaded.push({
          rel,
          fileName: path.basename(stagedTarget),
          sha512: file.hashes?.sha512?.toLowerCase(),
          sha1: file.hashes?.sha1?.toLowerCase()
        });
        done += 1;
        emit(done, job.files.length, file.path);
      });

      if (controller.signal.aborted) {
        throw new Error(tr("Import cancelled", "Импорт отменён"));
      }

      for (const overridesName of job.overrides) {
        const overrides = resolveOverridesDir(job.tmp, overridesName);
        if (existsSync(overrides)) {
          await this.copyOverrides(overrides, stageDir);
        }
      }

      if (controller.signal.aborted) {
        throw new Error(tr("Import cancelled", "Импорт отменён"));
      }

      await this.copyOverrides(stageDir, instance.directory);

      await this.linkModrinthEntries(instance.id, downloaded, limit).catch(() => undefined);
      if (job.cfMeta.size) await this.linkCurseForgeEntries(instance.id, downloaded, job.cfMeta).catch(() => undefined);

      emit(job.files.length, job.files.length, "");
      const fresh = await this.store.getData();
      return fresh.instances.find((item) => item.id === instanceId) ?? instance;
    } catch (error) {
      if (job.created) {
        await this.instances.remove(instanceId).catch(() => undefined);
      }
      throw error;
    } finally {
      this.activeImports.delete(instanceId);
      await rm(job.tmp, { recursive: true, force: true });
    }
  }

  private async linkCurseForgeEntries(instanceId: string, downloaded: DownloadedEntry[], meta: Map<string, ResolvedPackFile>): Promise<void> {
    const staleFiles: string[] = [];
    const disabledRenames: Array<{ from: string; to: string }> = [];
    const updated = await this.store.update((current) => {
      const target = current.instances.find((item) => item.id === instanceId);
      if (!target) throw new Error(tr("Instance not found", "Инстанция не найдена"));
      const now = new Date().toISOString();
      for (const entry of downloaded) {
        const info = meta.get(entry.rel);
        if (!info) continue;
        const folder = dirKindFolder[info.projectType] ?? "mods";
        const lower = entry.fileName.toLowerCase();
        const existing = target.mods.find(
          (mod) =>
            (mod.provider === "curseforge" && mod.projectId === info.projectId && (mod.projectType ?? "mod") === info.projectType) ||
            ((mod.projectType ?? "mod") === info.projectType && (mod.fileName ?? "").replace(/\.disabled$/i, "").toLowerCase() === lower)
        );
        if (existing) {
          const wasDisabled = Boolean(existing.fileName && /\.disabled$/i.test(existing.fileName));
          const oldName = existing.fileName?.replace(/\.disabled$/i, "");
          if (oldName && oldName.toLowerCase() !== entry.fileName.toLowerCase()) {
            staleFiles.push(path.join(target.directory, folder, oldName), path.join(target.directory, folder, `${oldName}.disabled`));
          }
          if (wasDisabled) {
            disabledRenames.push({
              from: path.join(target.directory, folder, entry.fileName),
              to: path.join(target.directory, folder, `${entry.fileName}.disabled`)
            });
            existing.fileName = `${entry.fileName}.disabled`;
          } else {
            existing.fileName = entry.fileName;
          }
          existing.provider = "curseforge";
          existing.projectId = info.projectId;
          existing.versionId = info.fileId;
          existing.name = info.name;
          existing.slug = info.slug ?? existing.slug;
          existing.iconUrl = info.iconUrl ?? existing.iconUrl;
          existing.installedAt = now;
          continue;
        }
        target.mods.push({ id: randomUUID(), provider: "curseforge", projectId: info.projectId, versionId: info.fileId, name: info.name, slug: info.slug, fileName: entry.fileName, iconUrl: info.iconUrl, installedAt: now, status: "installed", projectType: info.projectType });
      }
      target.updatedAt = now;
      return target;
    });
    for (const pair of disabledRenames) {
      await rm(pair.to, { force: true }).catch(() => undefined);
      await rename(pair.from, pair.to).catch(() => undefined);
    }
    for (const file of staleFiles) {
      await rm(file, { force: true }).catch(() => undefined);
    }
    await writeContentManifest(updated.directory, updated.mods);
  }

  private async copyOverrides(from: string, instanceDir: string, prefix = ""): Promise<void> {
    const entries = await readdir(from, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = resolveTarget(instanceDir, rel);
      const src = path.join(from, entry.name);
      if (entry.isDirectory()) {
        await mkdir(target, { recursive: true });
        await this.copyOverrides(src, instanceDir, rel);
      } else if (entry.isFile()) {
        await mkdir(path.dirname(target), { recursive: true });
        await cp(src, target, { force: true });
      }
    }
  }

  private chunkIds(ids: string[], size = 60): string[][] {
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += size) {
      chunks.push(ids.slice(i, i + size));
    }
    return chunks;
  }

  private async fetchVersionsByIds(ids: string[]): Promise<Map<string, ExportVersion>> {
    const out = new Map<string, ExportVersion>();
    if (!ids.length) return out;
    await Promise.all(this.chunkIds(ids).map(async (chunk) => {
      try {
        const response = await fetch(`https://api.modrinth.com/v2/versions?ids=${encodeURIComponent(JSON.stringify(chunk))}`, {
          headers: { "User-Agent": "lynapp" },
          signal: AbortSignal.timeout(30000)
        });
        if (!response.ok) return;
        const body = (await response.json()) as ExportVersion[];
        for (const version of body ?? []) {
          if (version?.id) out.set(version.id, version);
        }
      } catch {
      }
    }));
    return out;
  }

  private async fetchVersionByHash(hash: string, algorithm: "sha512" | "sha1"): Promise<MrpackVersion | null> {
    try {
      const response = await fetch(`https://api.modrinth.com/v2/version_file/${hash}?algorithm=${algorithm}`, {
        headers: { "User-Agent": "lynapp" },
        signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) return null;
      const body = (await response.json()) as Partial<MrpackVersion>;
      return body.id && body.project_id ? { id: body.id, project_id: body.project_id } : null;
    } catch {
      return null;
    }
  }

  private async resolveVersions(entries: DownloadedEntry[], limit = 6): Promise<Map<string, MrpackVersion>> {
    const byHash = new Map<string, DownloadedEntry[]>();
    for (const entry of entries) {
      const hash = entry.sha512 || entry.sha1;
      if (!hash) continue;
      const list = byHash.get(hash) ?? [];
      list.push(entry);
      byHash.set(hash, list);
    }
    const resolved = new Map<string, MrpackVersion>();

    const sha512Hashes = [...new Set(entries.map((entry) => entry.sha512).filter((hash): hash is string => Boolean(hash)))];
    if (sha512Hashes.length) {
      try {
        const response = await fetch("https://api.modrinth.com/v2/version_files", {
          method: "POST",
          headers: { "User-Agent": "lynapp", "Content-Type": "application/json" },
          body: JSON.stringify({ hashes: sha512Hashes, algorithm: "sha512" }),
          signal: AbortSignal.timeout(20000)
        });
        if (response.ok) {
          const body = (await response.json()) as Record<string, Partial<MrpackVersion>> | MrpackVersion[];
          const pairs: Array<[string, Partial<MrpackVersion>]> = Array.isArray(body) ? [] : Object.entries(body);
          for (const [hash, version] of pairs) {
            if (version?.id && version?.project_id && byHash.has(hash)) {
              for (const entry of byHash.get(hash)!) resolved.set(entry.rel, { id: version.id, project_id: version.project_id });
            }
          }
        }
      } catch {
      }
    }

    const missing = entries.filter((entry) => !resolved.has(entry.rel) && (entry.sha512 || entry.sha1));
    await pool(missing, Math.min(16, Math.max(1, limit)), async (entry) => {
      const version =
        (entry.sha512 ? await this.fetchVersionByHash(entry.sha512, "sha512") : null) ??
        (entry.sha1 ? await this.fetchVersionByHash(entry.sha1, "sha1") : null);
      if (version) resolved.set(entry.rel, version);
    });
    return resolved;
  }

  private async fetchProjects(ids: string[]): Promise<Map<string, MrpackProject>> {
    const out = new Map<string, MrpackProject>();
    if (!ids.length) return out;
    await Promise.all(this.chunkIds(ids).map(async (chunk) => {
      try {
        const response = await fetch(`https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(chunk))}`, {
          headers: { "User-Agent": "lynapp" },
          signal: AbortSignal.timeout(20000)
        });
        if (!response.ok) return;
        const body = (await response.json()) as MrpackProject[];
        for (const project of body ?? []) {
          if (project?.id) out.set(project.id, project);
        }
      } catch {
      }
    }));
    return out;
  }

  private async linkModrinthEntries(instanceId: string, downloaded: DownloadedEntry[], limit = 6): Promise<void> {
    const candidates = downloaded.filter((entry) => dirProjectType[entry.rel.split("/")[0]?.toLowerCase() ?? ""] && (entry.sha512 || entry.sha1));
    if (!candidates.length) return;

    let versions: Map<string, MrpackVersion>;
    try {
      versions = await this.resolveVersions(candidates, limit);
    } catch {
      return;
    }
    if (!versions.size) return;

    const projectIds = [...new Set([...versions.values()].map((version) => version.project_id))];
    const projects = await this.fetchProjects(projectIds);

    const metas = new Map<string, ResolvedMeta>();
    for (const [rel, version] of versions) {
      const project = projects.get(version.project_id);
      const fileName = rel.split("/").pop() ?? rel;
      metas.set(rel, {
        projectId: version.project_id,
        versionId: version.id,
        name: project?.title || fileName,
        slug: project?.slug,
        iconUrl: project?.icon_url
      });
    }

    const staleFiles: string[] = [];
    const disabledRenames: Array<{ from: string; to: string }> = [];
    const updated = await this.store.update((current) => {
      const target = current.instances.find((item) => item.id === instanceId);
      if (!target) throw new Error(tr("Instance not found", "Инстанция не найдена"));
      for (const [rel, meta] of metas) {
        const folder = rel.split("/")[0] ?? "";
        const projectType = dirProjectType[folder.toLowerCase()];
        if (!projectType) continue;
        const fileName = rel.split("/").pop() ?? rel;
        const fileBase = fileName.replace(/\.disabled$/i, "");
        const matchingIndices: number[] = [];
        for (let i = 0; i < target.mods.length; i++) {
          const mod = target.mods[i];
          if ((mod.projectType ?? "mod") !== projectType) continue;
          const sameProject = mod.provider === "modrinth" && mod.projectId === meta.projectId;
          const sameFile = Boolean(mod.fileName && mod.fileName.replace(/\.disabled$/i, "").toLowerCase() === fileBase.toLowerCase());
          if (sameProject || sameFile) matchingIndices.push(i);
        }
        const existing = matchingIndices.length ? target.mods[matchingIndices[0]] : undefined;
        if (matchingIndices.length > 1) {
          for (let k = matchingIndices.length - 1; k >= 1; k--) {
            target.mods.splice(matchingIndices[k], 1);
          }
        }
        if (existing) {
          const wasDisabled = Boolean((existing.fileName && /\.disabled$/i.test(existing.fileName)) || /\.disabled$/i.test(fileName));
          const oldBase = existing.fileName?.replace(/\.disabled$/i, "");
          if (oldBase && oldBase.toLowerCase() !== fileBase.toLowerCase()) {
            staleFiles.push(path.join(target.directory, folder, oldBase), path.join(target.directory, folder, `${oldBase}.disabled`));
          }
          if (wasDisabled) {
            if (!/\.disabled$/i.test(fileName)) {
              disabledRenames.push({
                from: path.join(target.directory, folder, fileName),
                to: path.join(target.directory, folder, `${fileBase}.disabled`)
              });
            }
            existing.fileName = `${fileBase}.disabled`;
          } else {
            existing.fileName = fileBase;
          }
          existing.provider = "modrinth";
          existing.projectId = meta.projectId;
          existing.versionId = meta.versionId;
          existing.name = meta.name;
          existing.slug = meta.slug ?? existing.slug;
          existing.iconUrl = meta.iconUrl ?? existing.iconUrl;
          existing.installedAt = new Date().toISOString();
          continue;
        }
        target.mods.push({
          id: randomUUID(),
          provider: "modrinth",
          projectId: meta.projectId,
          versionId: meta.versionId,
          name: meta.name,
          slug: meta.slug,
          fileName,
          iconUrl: meta.iconUrl,
          installedAt: new Date().toISOString(),
          status: "installed",
          projectType
        });
      }
      target.updatedAt = new Date().toISOString();
      return target;
    });
    for (const pair of disabledRenames) {
      await rm(pair.to, { force: true }).catch(() => undefined);
      await rename(pair.from, pair.to).catch(() => undefined);
    }
    for (const file of staleFiles) {
      await rm(file, { force: true }).catch(() => undefined);
    }
    await writeContentManifest(updated.directory, updated.mods);
  }
}
