import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

async function downloadBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url, { headers: { "User-Agent": "lynapp" } });
  if (!response.ok) throw new Error(`Modpack file download failed with HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
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

  private readonly pending = new Map<string, { tmp: string; files: MrpackIndexFile[] }>();

  async beginImport(filePath: string): Promise<{ instance: LauncherInstance; totalFiles: number }> {
    if (!/\.mrpack$/i.test(filePath) || !existsSync(filePath)) {
      throw new Error("Drop a Modrinth .mrpack file to import it");
    }

    const tmp = path.join(getLauncherRoot(), "cache", "modpacks", `import-${randomUUID()}`);
    let createdId: string | null = null;
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

      const wanted = (index.files ?? []).filter(
        (file) => file?.path && file.downloads?.length && (file.env?.client ?? "required") !== "unsupported"
      );

      this.pending.set(instance.id, { tmp, files: wanted });
      return { instance, totalFiles: wanted.length };
    } catch (error) {
      if (createdId) this.pending.delete(createdId);
      await rm(tmp, { recursive: true, force: true });
      throw error;
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

    try {
      const downloaded: DownloadedEntry[] = [];
      let done = 0;
      await pool(job.files, 6, async (file) => {
        const buffer = await downloadBuffer(file.downloads![0]);
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

      const overrides = path.join(job.tmp, "overrides");
      if (existsSync(overrides)) {
        await cp(overrides, instance.directory, { recursive: true });
      }

      await this.linkModrinthEntries(instance.id, downloaded);

      emit(job.files.length, job.files.length, "");
      const fresh = await this.store.getData();
      return fresh.instances.find((item) => item.id === instanceId) ?? instance;
    } finally {
      await rm(job.tmp, { recursive: true, force: true });
    }
  }

  private async fetchVersionByHash(hash: string, algorithm: "sha512" | "sha1"): Promise<MrpackVersion | null> {
    try {
      const response = await fetch(`https://api.modrinth.com/v2/version_file/${hash}?algorithm=${algorithm}`, {
        headers: { "User-Agent": "lynapp" }
      });
      if (!response.ok) return null;
      const body = (await response.json()) as Partial<MrpackVersion>;
      return body.id && body.project_id ? { id: body.id, project_id: body.project_id } : null;
    } catch {
      return null;
    }
  }

  private async resolveVersions(entries: DownloadedEntry[]): Promise<Map<string, MrpackVersion>> {
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
          body: JSON.stringify({ hashes: sha512Hashes, algorithm: "sha512" })
        });
        if (response.ok) {
          const body = (await response.json()) as Record<string, Partial<MrpackVersion>> | MrpackVersion[];
          const pairs: Array<[string, Partial<MrpackVersion>]> = Array.isArray(body)
            ? body.map((version, index) => [sha512Hashes[index] ?? "", version] as [string, Partial<MrpackVersion>])
            : Object.entries(body);
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
    await pool(missing, 6, async (entry) => {
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
        headers: { "User-Agent": "lynapp" }
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

  private async linkModrinthEntries(instanceId: string, downloaded: DownloadedEntry[]): Promise<void> {
    const candidates = downloaded.filter((entry) => dirProjectType[entry.rel.split("/")[0]?.toLowerCase() ?? ""] && (entry.sha512 || entry.sha1));
    if (!candidates.length) return;

    let versions: Map<string, MrpackVersion>;
    try {
      versions = await this.resolveVersions(candidates);
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
