import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import type { WebContents } from "electron";
import path from "node:path";
import { promisify } from "node:util";
import { IPC } from "@shared/ipc";
import type { LauncherInstance, ModLoader } from "@shared/types";
import { getLauncherRoot } from "../paths";
import { JsonStore } from "../store";
import { InstanceService } from "./instances";
import { MinecraftService } from "./minecraft";
import { readUrlBytes, createThrottledEmitter, type BytesCallback } from "./transfer";

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


function resolveTarget(instanceDir: string, entryPath: string): string {
  const normalized = path.normalize(entryPath.replace(/\//g, path.sep));
  if (path.isAbsolute(normalized) || normalized.startsWith("..") || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`Unsafe path inside .mrpack: ${entryPath}`);
  }
  const target = path.join(instanceDir, normalized);
  if (target !== instanceDir && !target.startsWith(instanceDir + path.sep)) {
    throw new Error(`Unsafe path inside .mrpack: ${entryPath}`);
  }
  return target;
}

function verifyBuffer(buffer: Buffer, hashes: MrpackIndexFile["hashes"], entryPath: string): void {
  const sha512 = hashes?.sha512?.toLowerCase();
  if (sha512) {
    const actual = createHash("sha512").update(buffer).digest("hex").toLowerCase();
    if (actual !== sha512) throw new Error(`Checksum mismatch: ${entryPath}`);
    return;
  }
  const sha1 = hashes?.sha1?.toLowerCase();
  if (sha1) {
    const actual = createHash("sha1").update(buffer).digest("hex").toLowerCase();
    if (actual !== sha1) throw new Error(`Checksum mismatch: ${entryPath}`);
  }
}

async function downloadBuffer(url: string, onBytes?: BytesCallback): Promise<Buffer> {
  const { buffer } = await readUrlBytes(url, { "User-Agent": "lynapp" }, undefined, (received, total) => onBytes?.(received, total), 15 * 60 * 1000);
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
    private readonly minecraft: MinecraftService
  ) {}

  private readonly pending = new Map<string, { tmp: string; files: MrpackIndexFile[]; at: number; created: boolean }>();

  private async unpackIndex(filePath: string): Promise<{ tmp: string; index: MrpackIndex }> {
    if (!/\.mrpack$/i.test(filePath) || !existsSync(filePath)) {
      throw new Error("Drop a Modrinth .mrpack file to import it");
    }
    const tmp = path.join(getLauncherRoot(), "cache", "modpacks", `import-${randomUUID()}`);
    try {
      await mkdir(tmp, { recursive: true });
      try {
        await execFileAsync("tar.exe", ["-xf", filePath, "-C", tmp], {
          windowsHide: true,
          timeout: 120000,
          maxBuffer: 32 * 1024 * 1024
        });
      } catch {
        throw new Error("Could not unpack the .mrpack file (corrupt archive?)");
      }
      let index: MrpackIndex;
      try {
        index = JSON.parse(await readFile(path.join(tmp, "modrinth.index.json"), "utf8")) as MrpackIndex;
      } catch {
        throw new Error("modrinth.index.json is missing or broken: not a valid .mrpack");
      }
      if (index.formatVersion !== 1 || index.game !== "minecraft") {
        throw new Error("Unsupported .mrpack format (need formatVersion 1 for Minecraft)");
      }
      return { tmp, index };
    } catch (error) {
      await rm(tmp, { recursive: true, force: true });
      throw error;
    }
  }

  private wantedFiles(index: MrpackIndex): MrpackIndexFile[] {
    return (index.files ?? []).filter(
      (file) => file?.path && file.downloads?.length && (file.env?.client ?? "required") !== "unsupported"
    );
  }

  async beginImport(filePath: string): Promise<{ instance: LauncherInstance; totalFiles: number }> {
    const { tmp, index } = await this.unpackIndex(filePath);
    let createdId: string | null = null;
    try {
      const dependencies = index.dependencies ?? {};
      const gameVersion = (dependencies.minecraft ?? "").trim();
      if (!gameVersion) {
        throw new Error("The .mrpack does not declare a Minecraft version");
      }
      await this.minecraft.assertVersionExists(gameVersion);
      const { loader, loaderVersion } = pickLoader(dependencies, gameVersion);
      await this.minecraft.assertLoaderCompatible(loader, gameVersion);

      const fallbackName = path.basename(filePath, path.extname(filePath));
      const instance = await this.instances.create({
        name: (index.name ?? "").trim() || fallbackName,
        gameVersion,
        loader,
        loaderVersion
      });
      createdId = instance.id;

      const wanted = this.wantedFiles(index);
      this.sweepPending();
      this.pending.set(instance.id, { tmp, files: wanted, at: Date.now(), created: true });
      return { instance, totalFiles: wanted.length };
    } catch (error) {
      if (createdId) this.pending.delete(createdId);
      await rm(tmp, { recursive: true, force: true });
      throw error;
    }
  }

  async beginImportToInstance(filePath: string, instanceId: string): Promise<{ totalFiles: number; packName: string; packGameVersion: string; packLoader: string }> {
    const { tmp, index } = await this.unpackIndex(filePath);
    try {
      const data = await this.store.getData();
      const instance = data.instances.find((item) => item.id === instanceId);
      if (!instance) {
        throw new Error("Instance not found");
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
      this.pending.set(instanceId, { tmp, files: wanted, at: Date.now(), created: false });
      return { totalFiles: wanted.length, packName: (index.name ?? "").trim() || path.basename(filePath, path.extname(filePath)), packGameVersion, packLoader };
    } catch (error) {
      await rm(tmp, { recursive: true, force: true });
      throw error;
    }
  }

  async cancelImport(instanceId: string): Promise<void> {
    const job = this.pending.get(instanceId);
    if (!job) return;
    this.pending.delete(instanceId);
    await rm(job.tmp, { recursive: true, force: true }).catch(() => undefined);
  }

  async listExportEntries(instanceId: string): Promise<Array<{ name: string; isDir: boolean; size: number; modified: string | null }>> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === instanceId);
    if (!instance) {
      throw new Error("Instance not found");
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
      throw new Error("Instance not found");
    }
    const included = include ? new Set(include) : null;
    const dependencies: Record<string, string> = { minecraft: instance.gameVersion };
    let loaderVersion = (instance.loaderVersion ?? "").trim();
    if (!loaderVersion && instance.loader !== "vanilla") {
      const available = await this.minecraft.listLoaderVersions(instance.loader, instance.gameVersion).catch(() => [] as string[]);
      loaderVersion = instance.loader === "forge" || instance.loader === "neoforge"
        ? available[available.length - 1] ?? ""
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
      const version = mod.versionId ? versionMap.get(mod.versionId) : undefined;
      const apiFile = version?.files.find((f) => f.primary) ?? version?.files[0];
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
          if (knownFiles.has(name.toLowerCase())) {
            continue;
          }
          await mkdir(path.join(tmp, "overrides", folder), { recursive: true });
          await cp(path.join(instance.directory, folder, name), path.join(tmp, "overrides", folder, name), { recursive: true });
        }
      }
      for (const extra of ["config", "options.txt", "servers.dat", "optionsof.txt"]) {
        if (included && !included.has(extra)) {
          continue;
        }
        const src = path.join(instance.directory, extra);
        if (existsSync(src)) {
          await cp(src, path.join(tmp, "overrides", extra), { recursive: true });
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
      const psPath = (value: string): string => `'${value.replace(/'/g, "''")}'`;
      const packScript = [
        "Add-Type -AssemblyName System.IO.Compression.FileSystem",
        `$zip = [System.IO.Compression.ZipFile]::Open(${psPath(zipStage)}, 'Create')`,
        "try {",
        `$items = Get-ChildItem -LiteralPath ${psPath(tmp)} -Recurse -Force`,
        `$base = ${psPath(tmp)}`,
        "foreach ($item in $items) {",
        `  $rel = $item.FullName.Substring($base.Length).TrimStart('\\').Replace('\\', '/')`,
        "  if ($item.PSIsContainer) {",
        "    $null = $zip.CreateEntry($rel + '/')",
        "  } else {",
        "    $entry = $zip.CreateEntry($rel)",
        "    $out = $entry.Open()",
        "    $in = [System.IO.File]::OpenRead($item.FullName)",
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
        throw new Error("Could not pack the .mrpack file");
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
      throw new Error("Import session expired, drop the .mrpack again");
    }
    this.pending.delete(instanceId);

    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === instanceId);
    if (!instance) {
      await rm(job.tmp, { recursive: true, force: true });
      throw new Error("The instance was deleted before the import finished");
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

    try {
      const settings = (await this.store.getData()).settings;
      const limit = Math.min(16, Math.max(1, Math.round(settings.concurrentDownloads) || 8));
      const downloaded: DownloadedEntry[] = [];
      let done = 0;
      await pool(job.files, limit, async (file) => {
        const buffer = await downloadBuffer(file.downloads![0], (received, total) =>
          emitBytes(`mrpack:${instanceId}`, file.path, received, total, { doneFiles: done, totalFiles: job.files.length })
        );
        verifyBuffer(buffer, file.hashes, file.path);
        const target = resolveTarget(instance.directory, file.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, buffer);
        const rel = file.path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
        downloaded.push({
          rel,
          fileName: path.basename(target),
          sha512: file.hashes?.sha512?.toLowerCase(),
          sha1: file.hashes?.sha1?.toLowerCase()
        });
        done += 1;
        emit(done, job.files.length, file.path);
      });

      for (const overridesName of ["overrides", "client-overrides"]) {
        const overrides = path.join(job.tmp, overridesName);
        if (existsSync(overrides)) {
          await this.copyOverrides(overrides, instance.directory);
        }
      }

      await this.linkModrinthEntries(instance.id, downloaded, limit).catch(() => undefined);

      emit(job.files.length, job.files.length, "");
      const fresh = await this.store.getData();
      return fresh.instances.find((item) => item.id === instanceId) ?? instance;
    } catch (error) {
      if (job.created) {
        await this.instances.remove(instanceId).catch(() => undefined);
      }
      throw error;
    } finally {
      await rm(job.tmp, { recursive: true, force: true });
    }
  }

  private async copyOverrides(from: string, instanceDir: string): Promise<void> {
    const entries = await readdir(from, { withFileTypes: true });
    for (const entry of entries) {
      const rel = entry.name;
      const target = resolveTarget(instanceDir, rel);
      const src = path.join(from, rel);
      if (entry.isDirectory()) {
        await mkdir(target, { recursive: true });
        await this.copyOverrides(src, path.join(instanceDir, rel));
      } else {
        await mkdir(path.dirname(target), { recursive: true });
        await cp(src, target);
      }
    }
  }

  private async fetchVersionsByIds(ids: string[]): Promise<Map<string, ExportVersion>> {
    const out = new Map<string, ExportVersion>();
    if (!ids.length) return out;
    try {
      const response = await fetch(`https://api.modrinth.com/v2/versions?ids=${encodeURIComponent(JSON.stringify(ids))}`, {
        headers: { "User-Agent": "lynapp" },
        signal: AbortSignal.timeout(30000)
      });
      if (!response.ok) return out;
      const body = (await response.json()) as ExportVersion[];
      for (const version of body ?? []) {
        if (version?.id) out.set(version.id, version);
      }
    } catch {
    }
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
    try {
      const response = await fetch(`https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`, {
        headers: { "User-Agent": "lynapp" },
        signal: AbortSignal.timeout(20000)
      });
      if (!response.ok) return out;
      const body = (await response.json()) as MrpackProject[];
      for (const project of body ?? []) {
        if (project?.id) out.set(project.id, project);
      }
    } catch {
    }
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

    const updated = await this.store.update((current) => {
      const target = current.instances.find((item) => item.id === instanceId);
      if (!target) throw new Error("Instance not found");
      for (const [rel, meta] of metas) {
        const projectType = dirProjectType[rel.split("/")[0]?.toLowerCase() ?? ""];
        if (!projectType) continue;
        const fileName = rel.split("/").pop() ?? rel;
        const exists = target.mods.some(
          (mod) => mod.provider === "modrinth" && mod.projectId === meta.projectId && (mod.projectType ?? "mod") === projectType
        );
        if (exists) continue;
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
    await writeFile(path.join(updated.directory, ".launcher", "content.json"), JSON.stringify(updated.mods, null, 2), "utf8");
  }
}
