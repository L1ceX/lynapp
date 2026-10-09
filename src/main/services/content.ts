import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { InstalledMod, LocalContentItem, LocalContentKind } from "@shared/types";
import { JsonStore } from "../store";

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
    const { stdout } = await execFileAsync("tar.exe", ["-tf", archive], {
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
    const { stdout } = await execFileAsync("tar.exe", ["-xOf", archive, internalPath], {
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
      throw new Error("Instance not found");
    }

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

  async toggle(instanceId: string, fileName: string): Promise<LocalContentItem[]> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === instanceId);

    if (!instance) {
      throw new Error("Instance not found");
    }

    const location = await this.findEntry(instance.directory, fileName);

    if (!location) {
      throw new Error(`File not found: ${fileName}`);
    }

    const { enabled } = stripDisabled(location.name);
    const nextName = enabled ? `${location.name}${disabledSuffix}` : stripDisabled(location.name).base;
    await rename(path.join(location.dir, location.name), path.join(location.dir, nextName));

    await this.store.update((current) => {
      const target = current.instances.find((item) => item.id === instanceId);
      if (!target) {
        throw new Error("Instance not found");
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

  async remove(instanceId: string, fileName: string): Promise<LocalContentItem[]> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === instanceId);

    if (!instance) {
      throw new Error("Instance not found");
    }

    const location = await this.findEntry(instance.directory, fileName);

    if (!location) {
      throw new Error(`File not found: ${fileName}`);
    }

    const targetPath = path.join(location.dir, location.name);
    await rm(targetPath, { recursive: true, force: true });

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
        throw new Error("Instance not found");
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
        headers: { "User-Agent": "lynapp/1.0.3" }
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

  private async findEntry(instanceDir: string, fileName: string): Promise<{ kind: LocalContentKind; dir: string; name: string } | null> {
    if (!fileName || fileName.includes("..") || fileName.includes("/") || fileName.includes("\\") || fileName.includes(":") || path.isAbsolute(fileName)) {
      throw new Error(`Unsafe file name: ${fileName}`);
    }
    for (const kind of kindOrder) {
      const dir = path.join(instanceDir, kindDirs[kind]);
      const direct = path.join(dir, fileName);
      if (path.resolve(direct) !== direct || !direct.startsWith(dir + path.sep)) {
        throw new Error(`Unsafe file name: ${fileName}`);
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
        continue;
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
