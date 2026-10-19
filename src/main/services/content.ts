import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ContentImportResult, InstalledMod, LauncherInstance, LocalContentItem, LocalContentKind } from "@shared/types";
import { getTarPath } from "../paths";
import { sha1Cached } from "./hashes";
import { JsonStore } from "../store";
import { tr } from "../i18n";

const kindDirs: Record<LocalContentKind, string> = {
  mod: "mods",
  resourcepack: "resourcepacks",
  shader: "shaderpacks",
  datapack: "datapacks"
};

const kindExtensions: Record<LocalContentKind, string[]> = {
  mod: [".jar"],
  resourcepack: [".zip"],
  shader: [".zip"],
  datapack: [".zip"]
};

const kindAllowsDirectories: Record<LocalContentKind, boolean> = {
  mod: false,
  resourcepack: true,
  shader: true,
  datapack: true
};

const disabledSuffix = ".disabled";
const kindOrder: LocalContentKind[] = ["mod", "resourcepack", "shader", "datapack"];

const execFileAsync = promisify(execFile);

const modrinthHeaders = { "User-Agent": "lynapp/1.1.0-beta.3" };
const unknownRecheckMs = 3 * 24 * 60 * 60 * 1000;

interface HashCacheEntry {
  sha1: string;
  projectId: string | null;
  checkedAt: number;
}

interface UnlinkedFile {
  kind: LocalContentKind;
  fileName: string;
  fullPath: string;
  cacheKey: string;
  sha1?: string;
}

async function sha1File(filePath: string): Promise<string> {
  return sha1Cached(filePath);
}

async function listZipNames(filePath: string): Promise<string[]> {
  const handle = await open(filePath, "r");
  try {
    const size = (await handle.stat()).size;
    const tailSize = Math.min(size, 65557);
    const tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tailSize, size - tailSize);
    let eocd = -1;
    for (let i = tailSize - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return [];
    const count = tail.readUInt16LE(eocd + 10);
    const dirSize = tail.readUInt32LE(eocd + 12);
    const dirOffset = tail.readUInt32LE(eocd + 16);
    if (dirOffset === 0xffffffff || dirSize === 0xffffffff || dirOffset + dirSize > size) return [];
    const dir = Buffer.alloc(dirSize);
    await handle.read(dir, 0, dirSize, dirOffset);
    const names: string[] = [];
    let pos = 0;
    for (let i = 0; i < count && pos + 46 <= dir.length; i += 1) {
      if (dir.readUInt32LE(pos) !== 0x02014b50) break;
      const flags = dir.readUInt16LE(pos + 8);
      const nameLength = dir.readUInt16LE(pos + 28);
      const extraLength = dir.readUInt16LE(pos + 30);
      const commentLength = dir.readUInt16LE(pos + 32);
      const raw = dir.subarray(pos + 46, pos + 46 + nameLength);
      names.push((flags & 0x800 ? raw.toString("utf8") : raw.toString("latin1")).replace(/\\/g, "/"));
      pos += 46 + nameLength + extraLength + commentLength;
    }
    return names;
  } finally {
    await handle.close();
  }
}

function classifyEntries(names: string[]): LocalContentKind | null {
  let list = names.map((name) => name.toLowerCase().replace(/^\.\//, "")).filter(Boolean);
  const roots = new Set(list.map((name) => name.split("/")[0]));
  const root = roots.size === 1 ? [...roots][0] : "";
  if (root && !["shaders", "assets", "data", "meta-inf"].includes(root) && list.every((name) => name.startsWith(`${root}/`))) {
    list = list.map((name) => name.slice(root.length + 1)).filter(Boolean);
  }
  const has = (prefix: string): boolean => list.some((name) => name === prefix || name.startsWith(`${prefix}/`));
  if (list.includes("fabric.mod.json") || list.includes("quilt.mod.json") || list.includes("meta-inf/mods.toml") || list.includes("meta-inf/neoforge.mods.toml")) return "mod";
  if (has("shaders")) return "shader";
  if (list.includes("pack.mcmeta")) {
    if (has("data") && !has("assets")) return "datapack";
    return "resourcepack";
  }
  return null;
}

const iconMime: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif"
};

function sanitizeIconPart(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").slice(0, 80) || "icon";
}

function toDataUrl(ext: string, data: Buffer): string {
  return `data:${iconMime[ext] ?? "image/png"};base64,${data.toString("base64")}`;
}

async function tarList(archive: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(getTarPath(), ["-tf", archive], {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 8 * 1024 * 1024
    });
    return String(stdout)
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^\.\//, ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function tarRead(archive: string, internalPath: string): Promise<Buffer | null> {
  try {
    const { stdout } = await execFileAsync(getTarPath(), ["-xOf", archive, internalPath], {
      windowsHide: true,
      timeout: 15000,
      encoding: "buffer",
      maxBuffer: 8 * 1024 * 1024
    });
    const data = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout), "binary");
    return data.length ? data : null;
  } catch {
    return null;
  }
}

function findArchiveEntry(entries: string[], wanted: string): string | null {
  const lower = wanted.toLowerCase().replace(/\\/g, "/");
  return (
    entries.find((entry) => entry.toLowerCase() === lower) ??
    entries.find((entry) => entry.toLowerCase().endsWith(`/${lower}`)) ??
    null
  );
}

async function readArchiveIcon(archive: string, entries: string[], wanted: string): Promise<{ ext: string; data: Buffer } | null> {
  const found = findArchiveEntry(entries, wanted);
  if (!found) return null;
  const ext = path.extname(found).toLowerCase();
  if (!iconMime[ext]) return null;
  const data = await tarRead(archive, found);
  if (!data) return null;
  return { ext, data };
}

async function readModIcon(archive: string, entries: string[]): Promise<{ ext: string; data: Buffer } | null> {
  const byLower = new Map(entries.map((entry) => [entry.toLowerCase(), entry]));

  const fabricEntry = byLower.get("fabric.mod.json");
  if (fabricEntry) {
    const raw = await tarRead(archive, fabricEntry);
    if (raw) {
      try {
        const meta = JSON.parse(raw.toString("utf8")) as { icon?: unknown };
        if (typeof meta.icon === "string") {
          const hit = await readArchiveIcon(archive, entries, meta.icon);
          if (hit) return hit;
        }
      } catch {
      }
    }
  }

  const quiltEntry = byLower.get("quilt.json");
  if (quiltEntry) {
    const raw = await tarRead(archive, quiltEntry);
    if (raw) {
      try {
        const meta = JSON.parse(raw.toString("utf8")) as { icon?: unknown; metadata?: { icon?: unknown } };
        const icon = typeof meta.icon === "string" ? meta.icon : typeof meta.metadata?.icon === "string" ? meta.metadata.icon : null;
        if (icon) {
          const hit = await readArchiveIcon(archive, entries, icon);
          if (hit) return hit;
        }
      } catch {
      }
    }
  }

  const modsToml = byLower.get("meta-inf/mods.toml");
  if (modsToml) {
    const raw = await tarRead(archive, modsToml);
    const logo = raw ? /logoFile\s*=\s*"([^"]+)"/.exec(raw.toString("utf8"))?.[1] : null;
    if (logo) {
      const hit = await readArchiveIcon(archive, entries, logo);
      if (hit) return hit;
    }
  }

  for (const candidate of ["pack.png", "icon.png", "logo.png"]) {
    const hit = await readArchiveIcon(archive, entries, candidate);
    if (hit) return hit;
  }

  return null;
}

function stripDisabled(fileName: string): { base: string; enabled: boolean } {
  if (fileName.toLowerCase().endsWith(disabledSuffix)) {
    return { base: fileName.slice(0, -disabledSuffix.length), enabled: false };
  }
  return { base: fileName, enabled: true };
}

function normalizeName(fileName: string): string {
  return stripDisabled(fileName).base.toLowerCase();
}

async function entrySize(target: string): Promise<number> {
  const fileStat = await stat(target);

  if (!fileStat.isDirectory()) {
    return fileStat.size;
  }

  let total = 0;
  const entries = await readdir(target);

  for (const entry of entries) {
    total += await entrySize(path.join(target, entry));
  }

  return total;
}

export class ContentService {
  constructor(private readonly store: JsonStore) {}

  async list(instanceId: string): Promise<LocalContentItem[]> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === instanceId);

    if (!instance) {
      throw new Error(tr("Instance not found", "Инстанция не найдена"));
    }

    await this.pruneMissing(instance);
    const items: LocalContentItem[] = [];
    const seen = new Set<string>();

    for (const kind of kindOrder) {
      const dir = path.join(instance.directory, kindDirs[kind]);
      await mkdir(dir, { recursive: true });
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const { base, enabled } = stripDisabled(entry.name);
        const lowerBase = base.toLowerCase();

        if (entry.isDirectory() && !kindAllowsDirectories[kind]) {
          continue;
        }

        if (!entry.isDirectory() && !kindExtensions[kind].some((ext) => lowerBase.endsWith(ext))) {
          continue;
        }

        const fullPath = path.join(dir, entry.name);
        const fileStat = await stat(fullPath);
        const size = await entrySize(fullPath).catch(() => fileStat.size);
        const record = instance.mods.find(
          (mod) => (mod.projectType ?? "mod") === kind && mod.fileName !== undefined && normalizeName(mod.fileName) === lowerBase
        );

        seen.add(`${kind}:${lowerBase}`);
        items.push({
          kind,
          fileName: entry.name,
          displayName: record?.name ?? base,
          iconUrl: await this.resolveIcon(instance.directory, instanceId, kind, dir, entry.name, entry.isDirectory(), fileStat, record),
          size,
          modified: fileStat.mtime.toISOString(),
          enabled,
          source: record ? "modrinth" : "manual"
        });
      }
    }

    for (const { world, dir } of await this.worldDatapackDirs(instance.directory)) {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const { base, enabled } = stripDisabled(entry.name);
        const lowerBase = base.toLowerCase();
        if (seen.has(`datapack:${lowerBase}`)) {
          continue;
        }
        if (!entry.isDirectory() && !lowerBase.endsWith(".zip")) {
          continue;
        }
        const fullPath = path.join(dir, entry.name);
        const fileStat = await stat(fullPath);
        const record = instance.mods.find(
          (mod) => (mod.projectType ?? "mod") === "datapack" && mod.fileName !== undefined && normalizeName(mod.fileName) === lowerBase
        );
        seen.add(`datapack:${lowerBase}`);
        items.push({
          kind: "datapack",
          fileName: entry.name,
          displayName: `${record?.name ?? base} (${world})`,
          iconUrl: undefined,
          size: await entrySize(fullPath).catch(() => fileStat.size),
          modified: fileStat.mtime.toISOString(),
          enabled,
          source: record ? "modrinth" : "manual"
        });
      }
    }

    for (const mod of instance.mods) {
      const kind = (mod.projectType ?? "mod") as LocalContentKind;

      if (!kindDirs[kind] || !mod.fileName || seen.has(`${kind}:${normalizeName(mod.fileName)}`)) {
        continue;
      }

      items.push({
        kind,
        fileName: mod.fileName,
        displayName: mod.name,
        size: 0,
        modified: mod.installedAt,
        enabled: false,
        source: "missing"
      });
    }

    return items.sort((a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind) || a.displayName.localeCompare(b.displayName));
  }

  async toggle(instanceId: string, fileName: string, kind?: LocalContentKind): Promise<LocalContentItem[]> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === instanceId);

    if (!instance) {
      throw new Error(tr("Instance not found", "Инстанция не найдена"));
    }

    const locations = await this.findEntries(instance.directory, fileName, kind);
    const location = locations[0];

    if (!location) {
      throw new Error(tr(`File not found: ${fileName}`, `Файл не найден: ${fileName}`));
    }

    const { enabled } = stripDisabled(location.name);
    const nextName = enabled ? `${location.name}${disabledSuffix}` : stripDisabled(location.name).base;
    for (const item of locations) {
      const itemNext = enabled ? `${stripDisabled(item.name).base}${disabledSuffix}` : stripDisabled(item.name).base;
      if (itemNext !== item.name) {
        await rename(path.join(item.dir, item.name), path.join(item.dir, itemNext));
      }
    }

    await this.store.update((current) => {
      const target = current.instances.find((item) => item.id === instanceId);
      if (!target) {
        throw new Error(tr("Instance not found", "Инстанция не найдена"));
      }

      const record = target.mods.find(
        (mod) => (mod.projectType ?? "mod") === location.kind && mod.fileName !== undefined && normalizeName(mod.fileName) === normalizeName(location.name)
      );

      if (record) {
        record.fileName = nextName;
      }

      target.updatedAt = new Date().toISOString();
      return target;
    });

    await this.writeContentManifest(instanceId);
    return this.list(instanceId);
  }

  async remove(instanceId: string, fileName: string, kind?: LocalContentKind): Promise<LocalContentItem[]> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === instanceId);

    if (!instance) {
      throw new Error(tr("Instance not found", "Инстанция не найдена"));
    }

    const locations = await this.findEntries(instance.directory, fileName, kind);
    const location = locations[0];

    if (!location) {
      const wanted = fileName.toLowerCase().replace(/\.disabled$/, "");
      await this.store.update((current) => {
        const target = current.instances.find((item) => item.id === instanceId);
        if (!target) {
          throw new Error(tr("Instance not found", "Инстанция не найдена"));
        }
        const before = target.mods.length;
        target.mods = target.mods.filter((mod) => {
          if (mod.fileName === undefined || normalizeName(mod.fileName) !== wanted) {
            return true;
          }
          if (kind && (mod.projectType ?? "mod") !== kind) {
            return true;
          }
          return false;
        });
        if (target.mods.length === before) {
          throw new Error(tr(`File not found: ${fileName}`, `Файл не найден: ${fileName}`));
        }
        target.updatedAt = new Date().toISOString();
      });

      await this.writeContentManifest(instanceId);
      return this.list(instanceId);
    }

    for (const item of locations) {
      await rm(path.join(item.dir, item.name), { recursive: true, force: true });
    }

    try {
      const iconsDir = path.join(instance.directory, ".launcher", "icons");
      const prefix = sanitizeIconPart(`${location.kind}-${normalizeName(location.name)}-`);
      const cached = await readdir(iconsDir);

      for (const file of cached) {
        if (file.startsWith(prefix)) {
          await rm(path.join(iconsDir, file), { force: true });
        }
      }
    } catch {
    }

    await this.store.update((current) => {
      const target = current.instances.find((item) => item.id === instanceId);
      if (!target) {
        throw new Error(tr("Instance not found", "Инстанция не найдена"));
      }

      target.mods = target.mods.filter(
        (mod) =>
          !((mod.projectType ?? "mod") === location.kind && mod.fileName !== undefined && normalizeName(mod.fileName) === normalizeName(location.name))
      );
      target.updatedAt = new Date().toISOString();
      return target;
    });

    await this.writeContentManifest(instanceId);
    return this.list(instanceId);
  }

  async importFiles(instanceId: string, paths: string[]): Promise<ContentImportResult> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === instanceId);
    if (!instance) {
      throw new Error(tr("Instance not found", "Инстанция не найдена"));
    }

    const result: ContentImportResult = { added: [], skipped: [] };
    const pending: Array<{ source: string; name: string; isDir: boolean; kind: LocalContentKind | null }> = [];
    for (const source of paths) {
      const name = path.basename(source);
      const sourceStat = await stat(source).catch(() => null);
      if (!sourceStat) {
        result.skipped.push({ fileName: name, reason: "failed" });
        continue;
      }
      const lower = name.toLowerCase();
      if (sourceStat.isDirectory()) {
        const entries = await readdir(source, { withFileTypes: true }).catch(() => []);
        pending.push({ source, name, isDir: true, kind: classifyEntries(entries.map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name)) });
      } else if (lower.endsWith(".jar")) {
        pending.push({ source, name, isDir: false, kind: "mod" });
      } else if (lower.endsWith(".zip")) {
        pending.push({ source, name, isDir: false, kind: classifyEntries(await listZipNames(source).catch(() => [])) });
      } else {
        result.skipped.push({ fileName: name, reason: "unsupported" });
      }
    }

    const unknown = pending.filter((item) => !item.kind && !item.isDir);
    if (unknown.length) {
      const hashes = new Map<string, string>();
      for (const item of unknown) {
        const sha1 = await sha1File(item.source).catch(() => "");
        if (sha1) hashes.set(item.source, sha1);
      }
      try {
        const response = await fetch("https://api.modrinth.com/v2/version_files", {
          method: "POST",
          headers: { ...modrinthHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ hashes: [...new Set(hashes.values())], algorithm: "sha1" }),
          signal: AbortSignal.timeout(20000)
        });
        if (response.ok) {
          const versions = (await response.json()) as Record<string, { loaders?: string[] }>;
          for (const item of unknown) {
            const loaders = versions[hashes.get(item.source) ?? ""]?.loaders;
            if (!loaders) continue;
            item.kind = loaders.includes("datapack")
              ? "datapack"
              : loaders.includes("minecraft")
                ? "resourcepack"
                : loaders.some((loader) => ["iris", "optifine", "canvas", "vanilla"].includes(loader))
                  ? "shader"
                  : "mod";
          }
        }
      } catch {
      }
    }

    for (const item of pending) {
      if (!item.kind) {
        result.skipped.push({ fileName: item.name, reason: "unknown" });
        continue;
      }
      const baseDir = path.join(instance.directory, kindDirs[item.kind]);
      const worldDirs = item.kind === "datapack" ? (await this.worldDatapackDirs(instance.directory)).map((world) => world.dir) : [];
      const destinations = worldDirs.length ? worldDirs : [baseDir];
      const { base } = stripDisabled(item.name);
      if (destinations.some((dir) => existsSync(path.join(dir, base)) || existsSync(path.join(dir, `${base}${disabledSuffix}`)))) {
        result.skipped.push({ fileName: item.name, reason: "exists" });
        continue;
      }
      try {
        for (const dir of destinations) {
          await mkdir(dir, { recursive: true });
          if (item.isDir) {
            await cp(item.source, path.join(dir, item.name), { recursive: true });
          } else {
            await copyFile(item.source, path.join(dir, item.name));
          }
        }
        result.added.push({ fileName: item.name, kind: item.kind });
      } catch {
        result.skipped.push({ fileName: item.name, reason: "failed" });
      }
    }
    return result;
  }

  private async pruneMissing(instance: LauncherInstance): Promise<void> {
    const instanceId = instance.id;
    const worldDirs = (await this.worldDatapackDirs(instance.directory)).map((world) => world.dir);
    const fileGone = (mod: InstalledMod): boolean => {
      const kind = (mod.projectType ?? "mod") as LocalContentKind;
      if (!kindDirs[kind] || !mod.fileName || mod.status !== "installed") return false;
      const { base } = stripDisabled(mod.fileName);
      const dirs = [path.join(instance.directory, kindDirs[kind]), ...(kind === "datapack" ? worldDirs : [])];
      return !dirs.some((dir) => existsSync(path.join(dir, base)) || existsSync(path.join(dir, `${base}${disabledSuffix}`)));
    };
    const goneIds = new Set(instance.mods.filter(fileGone).map((mod) => mod.id));
    if (goneIds.size) {
      await this.store.update((current) => {
        const target = current.instances.find((item) => item.id === instanceId);
        if (target) {
          target.mods = target.mods.filter((mod) => !goneIds.has(mod.id));
          target.updatedAt = new Date().toISOString();
        }
      });
      await this.writeContentManifest(instanceId);
    }
  }

  async detectFromModrinth(instanceId: string): Promise<LauncherInstance> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === instanceId);
    if (!instance) {
      throw new Error(tr("Instance not found", "Инстанция не найдена"));
    }

    await this.pruneMissing(instance);

    const cachePath = path.join(instance.directory, ".launcher", "hash-cache.json");
    let cache: Record<string, HashCacheEntry> = {};
    try {
      cache = JSON.parse(await readFile(cachePath, "utf8")) as Record<string, HashCacheEntry>;
    } catch {
    }

    const known = new Set(
      instance.mods
        .filter((mod) => mod.fileName)
        .map((mod) => `${mod.projectType ?? "mod"}:${normalizeName(mod.fileName as string)}`)
    );
    const unlinked: UnlinkedFile[] = [];
    for (const kind of kindOrder) {
      const dir = path.join(instance.directory, kindDirs[kind]);
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }
        const { base } = stripDisabled(entry.name);
        if (!kindExtensions[kind].some((ext) => base.toLowerCase().endsWith(ext)) || known.has(`${kind}:${base.toLowerCase()}`)) {
          continue;
        }
        const fullPath = path.join(dir, entry.name);
        const fileStat = await stat(fullPath).catch(() => null);
        if (!fileStat) {
          continue;
        }
        unlinked.push({ kind, fileName: entry.name, fullPath, cacheKey: `${kind}/${base.toLowerCase()}|${fileStat.size}|${Math.round(fileStat.mtimeMs)}` });
      }
    }
    if (!unlinked.length) {
      return instance;
    }

    const now = Date.now();
    const toLookup: UnlinkedFile[] = [];
    for (const file of unlinked) {
      const cached = cache[file.cacheKey];
      if (cached && cached.projectId === null && now - cached.checkedAt < unknownRecheckMs) {
        continue;
      }
      file.sha1 = cached?.sha1 ?? await sha1File(file.fullPath).catch(() => undefined);
      if (file.sha1) {
        toLookup.push(file);
      }
    }
    if (!toLookup.length) {
      return instance;
    }

    let versions: Record<string, { id?: string; project_id?: string }>;
    try {
      const response = await fetch("https://api.modrinth.com/v2/version_files", {
        method: "POST",
        headers: { ...modrinthHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ hashes: [...new Set(toLookup.map((file) => file.sha1 as string))], algorithm: "sha1" }),
        signal: AbortSignal.timeout(20000)
      });
      if (!response.ok) {
        return instance;
      }
      versions = (await response.json()) as Record<string, { id?: string; project_id?: string }>;
    } catch {
      return instance;
    }

    const projectIds = [...new Set(Object.values(versions).map((version) => version.project_id).filter((id): id is string => Boolean(id)))];
    const projects = new Map<string, { title?: string; slug?: string; icon_url?: string }>();
    if (projectIds.length) {
      try {
        const response = await fetch(`https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(projectIds))}`, {
          headers: modrinthHeaders,
          signal: AbortSignal.timeout(20000)
        });
        if (response.ok) {
          for (const project of (await response.json()) as Array<{ id: string; title?: string; slug?: string; icon_url?: string }>) {
            projects.set(project.id, project);
          }
        }
      } catch {
      }
    }

    const matched: Array<{ file: UnlinkedFile; versionId: string; projectId: string }> = [];
    for (const file of toLookup) {
      const version = versions[file.sha1 as string];
      cache[file.cacheKey] = { sha1: file.sha1 as string, projectId: version?.project_id ?? null, checkedAt: now };
      if (version?.id && version.project_id) {
        matched.push({ file, versionId: version.id, projectId: version.project_id });
      }
    }

    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify(cache), "utf8").catch(() => undefined);
    if (!matched.length) {
      return instance;
    }

    const updated = await this.store.update((current) => {
      const target = current.instances.find((item) => item.id === instanceId);
      if (!target) {
        throw new Error(tr("Instance not found", "Инстанция не найдена"));
      }
      for (const { file, versionId, projectId } of matched) {
        const project = projects.get(projectId);
        const existing = target.mods.find((mod) => mod.provider === "modrinth" && mod.projectId === projectId && (mod.projectType ?? "mod") === file.kind);
        if (existing) {
          const oldBase = existing.fileName ? stripDisabled(existing.fileName).base : "";
          const oldDir = path.join(target.directory, kindDirs[file.kind]);
          const stillThere = oldBase !== "" && normalizeName(oldBase) !== normalizeName(file.fileName)
            && (existsSync(path.join(oldDir, oldBase)) || existsSync(path.join(oldDir, `${oldBase}${disabledSuffix}`)));
          if (stillThere) {
            continue;
          }
          existing.fileName = file.fileName;
          existing.versionId = versionId;
          continue;
        }
        target.mods.push({
          id: randomUUID(),
          provider: "modrinth",
          projectId,
          versionId,
          name: project?.title || stripDisabled(file.fileName).base,
          slug: project?.slug,
          fileName: file.fileName,
          iconUrl: project?.icon_url,
          installedAt: new Date().toISOString(),
          status: "installed",
          projectType: file.kind
        });
      }
      target.updatedAt = new Date().toISOString();
      return target;
    });

    await this.writeContentManifest(instanceId);
    return updated;
  }

  private async resolveIcon(
    instanceDir: string,
    instanceId: string,
    kind: LocalContentKind,
    dir: string,
    entryName: string,
    isDir: boolean,
    fileStat: { size: number; mtimeMs: number },
    record?: InstalledMod
  ): Promise<string | undefined> {
    if (record?.iconUrl) {
      return record.iconUrl;
    }

    const fullPath = path.join(dir, entryName);

    if (isDir) {
      const packPng = path.join(fullPath, "pack.png");

      try {
        return toDataUrl(".png", await readFile(packPng));
      } catch {
        return this.fetchModrinthIcon(instanceId, record);
      }
    }

    const iconsDir = path.join(instanceDir, ".launcher", "icons");
    const cacheKey = sanitizeIconPart(`${kind}-${normalizeName(entryName)}-${fileStat.size}-${Math.round(fileStat.mtimeMs)}`);

    try {
      const cached = (await readdir(iconsDir)).find((file) => file.startsWith(`${cacheKey}.`) && iconMime[path.extname(file).toLowerCase()]);

      if (cached) {
        return toDataUrl(path.extname(cached).toLowerCase(), await readFile(path.join(iconsDir, cached)));
      }
    } catch {
    }

    const entries = await tarList(fullPath);
    const found = entries.length ? ((kind === "mod" ? await readModIcon(fullPath, entries) : await readArchiveIcon(fullPath, entries, "pack.png")) ?? null) : null;

    if (found) {
      await mkdir(iconsDir, { recursive: true });
      await writeFile(path.join(iconsDir, `${cacheKey}${found.ext}`), found.data);
      return toDataUrl(found.ext, found.data);
    }

    return this.fetchModrinthIcon(instanceId, record);
  }

  private async fetchModrinthIcon(instanceId: string, record?: InstalledMod): Promise<string | undefined> {
    const ref = record?.slug || record?.projectId;
    if (!ref) {
      return undefined;
    }

    try {
      const response = await fetch(`https://api.modrinth.com/v2/project/${ref}`, {
        headers: { "User-Agent": "lynapp/1.1.0-beta.3" }
      });

      if (!response.ok) {
        return undefined;
      }

      const project = (await response.json()) as { icon_url?: string };
      if (!project.icon_url) {
        return undefined;
      }

      await this.store.update((current) => {
        const target = current.instances.find((item) => item.id === instanceId);
        const entry = target?.mods.find((mod) => mod.id === record?.id);
        if (entry) {
          entry.iconUrl = project.icon_url;
        }
        return true;
      });

      return project.icon_url;
    } catch {
      return undefined;
    }
  }

  private async worldDatapackDirs(instanceDir: string): Promise<Array<{ world: string; dir: string }>> {
    const out: Array<{ world: string; dir: string }> = [];
    let worlds: string[] = [];
    try {
      worlds = await readdir(path.join(instanceDir, "saves"));
    } catch {
      return out;
    }
    for (const world of worlds) {
      const dir = path.join(instanceDir, "saves", world, "datapacks");
      try {
        const fileStat = await stat(dir);
        if (fileStat.isDirectory()) {
          out.push({ world, dir });
        }
      } catch {
      }
    }
    return out;
  }

  private async findEntries(instanceDir: string, fileName: string, onlyKind?: LocalContentKind): Promise<Array<{ kind: LocalContentKind; dir: string; name: string }>> {
    const first = await this.findEntry(instanceDir, fileName, onlyKind);
    if (!first || first.kind !== "datapack") {
      return first ? [first] : [];
    }
    const { base, enabled } = stripDisabled(fileName);
    const variant = enabled ? `${fileName}${disabledSuffix}` : base;
    const dirs = [path.join(instanceDir, kindDirs.datapack), ...(await this.worldDatapackDirs(instanceDir)).map((item) => item.dir)];
    const found: Array<{ kind: LocalContentKind; dir: string; name: string }> = [];
    for (const dir of dirs) {
      for (const candidate of [fileName, variant]) {
        try {
          await stat(path.join(dir, candidate));
          found.push({ kind: "datapack", dir, name: candidate });
          break;
        } catch {
        }
      }
    }
    return found.length ? found : [first];
  }

  private async findEntry(instanceDir: string, fileName: string, onlyKind?: LocalContentKind): Promise<{ kind: LocalContentKind; dir: string; name: string } | null> {
    if (!fileName || fileName.includes("..") || fileName.includes("/") || fileName.includes("\\") || fileName.includes(":") || path.isAbsolute(fileName)) {
      throw new Error(tr(`Unsafe file name: ${fileName}`, `Недопустимое имя файла: ${fileName}`));
    }
    const kinds = onlyKind ? [onlyKind] : kindOrder;
    for (const kind of kinds) {
      const dir = path.join(instanceDir, kindDirs[kind]);
      const direct = path.join(dir, fileName);
      if (path.resolve(direct) !== direct || !direct.startsWith(dir + path.sep)) {
        throw new Error(tr(`Unsafe file name: ${fileName}`, `Недопустимое имя файла: ${fileName}`));
      }

      try {
        await stat(direct);
        return { kind, dir, name: fileName };
      } catch {
      }

      const { base, enabled } = stripDisabled(fileName);
      const variant = enabled ? `${fileName}${disabledSuffix}` : base;
      const variantPath = path.join(dir, variant);

      try {
        await stat(variantPath);
        return { kind, dir, name: variant };
      } catch {
      }

      if (kind === "datapack" && (!onlyKind || onlyKind === "datapack")) {
        for (const { dir: worldDir } of await this.worldDatapackDirs(instanceDir)) {
          for (const candidate of [fileName, variant]) {
            const candidatePath = path.join(worldDir, candidate);
            if (path.resolve(candidatePath) === candidatePath && candidatePath.startsWith(worldDir + path.sep)) {
              try {
                await stat(candidatePath);
                return { kind, dir: worldDir, name: candidate };
              } catch {
              }
            }
          }
        }
      }
    }

    return null;
  }

  private async writeContentManifest(instanceId: string): Promise<void> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === instanceId);

    if (!instance) {
      return;
    }

    await mkdir(path.join(instance.directory, ".launcher"), { recursive: true });
    await writeFile(path.join(instance.directory, ".launcher", "content.json"), JSON.stringify(instance.mods, null, 2), "utf8");
  }
}
