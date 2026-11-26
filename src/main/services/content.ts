import { createHash, randomUUID } from "node:crypto";
import { clipboard, nativeImage } from "electron";
import { existsSync } from "node:fs";
import { copyFile, cp, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ContentImportResult, InstalledMod, LauncherInstance, LocalContentItem, LocalContentKind, ModProvider, ScreenshotInfo } from "@shared/types";
import { curseForgeAvailable, projectTypeForClass, type CurseForgeService } from "./curseforge";
import { writeContentManifest } from "./manifest";
import { cfFingerprintCached, sha1Cached } from "./hashes";
import { listZipEntries, readZipEntry, readZipFiles } from "./zip";
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

const modrinthHeaders = { "User-Agent": "lynapp/1.1.0-beta.7" };
const unknownRecheckMs = 3 * 24 * 60 * 60 * 1000;

interface HashCacheEntry {
  sha1: string;
  projectId: string | null;
  checkedAt: number;
  cfChecked?: boolean;
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
  const data = await readZipEntry(archive, found);
  if (!data) return null;
  return { ext, data };
}

async function readModIcon(archive: string, entries: string[]): Promise<{ ext: string; data: Buffer } | null> {
  const byLower = new Map(entries.map((entry) => [entry.toLowerCase(), entry]));

  const fabricEntry = byLower.get("fabric.mod.json");
  if (fabricEntry) {
    const raw = await readZipEntry(archive, fabricEntry);
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

  const quiltEntry = byLower.get("quilt.mod.json") ?? byLower.get("quilt.json");
  if (quiltEntry) {
    const raw = await readZipEntry(archive, quiltEntry);
    if (raw) {
      try {
        const meta = JSON.parse(raw.toString("utf8")) as {
          icon?: unknown;
          metadata?: { icon?: unknown };
          quilt_loader?: { metadata?: { icon?: unknown } };
        };
        const icon =
          typeof meta.icon === "string"
            ? meta.icon
            : typeof meta.metadata?.icon === "string"
              ? meta.metadata.icon
              : typeof meta.quilt_loader?.metadata?.icon === "string"
                ? meta.quilt_loader.metadata.icon
                : null;
        if (icon) {
          const hit = await readArchiveIcon(archive, entries, icon);
          if (hit) return hit;
        }
      } catch {
      }
    }
  }

  for (const tomlName of ["meta-inf/neoforge.mods.toml", "meta-inf/mods.toml"]) {
    const modsToml = byLower.get(tomlName);
    if (modsToml) {
      const raw = await readZipEntry(archive, modsToml);
      const logo = raw ? /logoFile\s*=\s*"([^"]+)"/.exec(raw.toString("utf8"))?.[1] : null;
      if (logo) {
        const hit = await readArchiveIcon(archive, entries, logo);
        if (hit) return hit;
      }
    }
  }

  for (const candidate of ["pack.png", "icon.png", "logo.png"]) {
    const hit = await readArchiveIcon(archive, entries, candidate);
    if (hit) return hit;
  }

  return null;
}

interface JarModMeta {
  modIds: string[];
  provides: string[];
  depends: string[];
}

const jarMetaCache = new Map<string, JarModMeta>();
const BUILTIN_MOD_IDS = new Set([
  "minecraft",
  "java",
  "fabricloader",
  "fabric_loader",
  "fabric-loader",
  "quilt_loader",
  "quilt-loader",
  "forge",
  "neoforge",
  "fml",
  "mixinextras"
]);

async function readJarModMeta(fullPath: string, size: number, mtimeMs: number): Promise<JarModMeta> {
  const key = `${fullPath}|${size}|${Math.round(mtimeMs)}`;
  const cached = jarMetaCache.get(key);
  if (cached) return cached;

  const modIds = new Set<string>();
  const provides = new Set<string>();
  const depends = new Set<string>();
  const addId = (set: Set<string>, id: unknown): void => {
    if (typeof id !== "string") return;
    const clean = id.trim().toLowerCase();
    if (clean && !BUILTIN_MOD_IDS.has(clean)) set.add(clean);
  };

  try {
    const files = await readZipFiles(
      fullPath,
      new Set(["fabric.mod.json", "quilt.mod.json", "meta-inf/mods.toml", "meta-inf/neoforge.mods.toml", "mcmod.info"])
    );

    const fabricBuf = files.get("fabric.mod.json");
    if (fabricBuf) {
      try {
        const parsed = JSON.parse(fabricBuf.toString("utf8").replace(/\r?\n/g, " ")) as {
          id?: string;
          provides?: unknown[];
          depends?: Record<string, unknown>;
          jars?: Array<{ file?: string }>;
        };
        addId(modIds, parsed.id);
        if (Array.isArray(parsed.provides)) {
          for (const p of parsed.provides) {
            if (typeof p === "string") addId(provides, p);
            else if (p && typeof p === "object" && "id" in p) addId(provides, (p as { id?: string }).id);
          }
        }
        if (parsed.depends && typeof parsed.depends === "object") {
          for (const depKey of Object.keys(parsed.depends)) {
            addId(depends, depKey);
          }
        }
      } catch {
      }
    }

    const quiltBuf = files.get("quilt.mod.json");
    if (quiltBuf) {
      try {
        const parsed = JSON.parse(quiltBuf.toString("utf8")) as {
          quilt_loader?: {
            id?: string;
            provides?: Array<string | { id?: string }>;
            depends?: Array<string | { id?: string; optional?: boolean }>;
          };
        };
        const ql = parsed.quilt_loader;
        if (ql) {
          addId(modIds, ql.id);
          if (Array.isArray(ql.provides)) {
            for (const p of ql.provides) {
              addId(provides, typeof p === "string" ? p : p?.id);
            }
          }
          if (Array.isArray(ql.depends)) {
            for (const d of ql.depends) {
              if (typeof d === "string") addId(depends, d);
              else if (d && !d.optional) addId(depends, d.id);
            }
          }
        }
      } catch {
      }
    }

    for (const tomlName of ["meta-inf/mods.toml", "meta-inf/neoforge.mods.toml"]) {
      const tomlBuf = files.get(tomlName);
      if (!tomlBuf) continue;
      const text = tomlBuf.toString("utf8");
      const sections = text.split(/\[\[\s*(?:mods|dependencies\.[^\]]+)\s*\]\]/i);
      const headers = [...text.matchAll(/\[\[\s*(mods|dependencies\.[^\]]+)\s*\]\]/gi)].map((m) => m[1].toLowerCase());
      for (let i = 0; i < headers.length; i += 1) {
        const body = sections[i + 1] ?? "";
        const modIdMatch = /(?:^|\n)\s*modId\s*=\s*["']([^"']+)["']/i.exec(body);
        if (!modIdMatch) continue;
        const id = modIdMatch[1];
        if (headers[i] === "mods") {
          addId(modIds, id);
        } else {
          const mandatory = /(?:^|\n)\s*mandatory\s*=\s*(true|false)/i.exec(body);
          const typeField = /(?:^|\n)\s*type\s*=\s*["']([^"']+)["']/i.exec(body);
          const isReq = mandatory ? mandatory[1].toLowerCase() === "true" : (!typeField || typeField[1].toLowerCase() === "required");
          if (isReq) addId(depends, id);
        }
      }
    }
  } catch {
  }

  for (const id of modIds) depends.delete(id);
  for (const id of provides) depends.delete(id);

  const meta: JarModMeta = {
    modIds: [...modIds],
    provides: [...provides],
    depends: [...depends]
  };
  jarMetaCache.set(key, meta);
  return meta;
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
  const fileStat = await lstat(target);

  if (fileStat.isSymbolicLink()) {
    return 0;
  }

  if (!fileStat.isDirectory()) {
    return fileStat.size;
  }

  let total = 0;
  const entries = await readdir(target);

  for (const entry of entries) {
    total += await entrySize(path.join(target, entry)).catch(() => 0);
  }

  return total;
}

export class ContentService {
  constructor(
    private readonly store: JsonStore,
    private readonly curseforge?: CurseForgeService
  ) {}

  async list(instanceId: string): Promise<LocalContentItem[]> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === instanceId);

    if (!instance) {
      throw new Error(tr("Instance not found", "Инстанция не найдена"));
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
        const fileStat = await stat(fullPath).catch(() => null);
        if (!fileStat) {
          continue;
        }
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
          source: record ? (record.provider === "curseforge" ? "curseforge" : "modrinth") : "manual"
        });
      }
    }

    const seenWorld = new Set<string>();
    for (const { world, dir } of await this.worldDatapackDirs(instance.directory)) {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const { base, enabled } = stripDisabled(entry.name);
        const lowerBase = base.toLowerCase();
        if (seenWorld.has(`${world}:${lowerBase}`)) {
          continue;
        }
        if (!entry.isDirectory() && !lowerBase.endsWith(".zip")) {
          continue;
        }
        const fullPath = path.join(dir, entry.name);
        const fileStat = await stat(fullPath).catch(() => null);
        if (!fileStat) {
          continue;
        }
        const record = instance.mods.find(
          (mod) => (mod.projectType ?? "mod") === "datapack" && mod.fileName !== undefined && normalizeName(mod.fileName) === lowerBase
        );
        seenWorld.add(`${world}:${lowerBase}`);
        seen.add(`datapack:${lowerBase}`);
        items.push({
          kind: "datapack",
          fileName: entry.name,
          displayName: `${record?.name ?? base} (${world})`,
          world,
          iconUrl: await this.resolveIcon(instance.directory, instanceId, "datapack", dir, entry.name, entry.isDirectory(), fileStat, record),
          size: await entrySize(fullPath).catch(() => fileStat.size),
          modified: fileStat.mtime.toISOString(),
          enabled,
          source: record ? (record.provider === "curseforge" ? "curseforge" : "modrinth") : "manual"
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

    await this.annotateModRelations(instance, items);

    return items.sort((a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind) || a.displayName.localeCompare(b.displayName));
  }

  private async annotateModRelations(instance: LauncherInstance, items: LocalContentItem[]): Promise<void> {
    const modItems = items.filter((item) => item.kind === "mod" && item.source !== "missing");
    if (modItems.length < 2) return;

    const modsDir = path.join(instance.directory, kindDirs.mod);
    const metaByFile = new Map<string, JarModMeta>();
    const recordByFile = new Map<string, InstalledMod | undefined>();

    for (const item of modItems) {
      const lowerBase = normalizeName(item.fileName);
      const record = instance.mods.find(
        (mod) => (mod.projectType ?? "mod") === "mod" && mod.fileName !== undefined && normalizeName(mod.fileName) === lowerBase
      );
      recordByFile.set(item.fileName, record);
      const fullPath = path.join(modsDir, item.fileName);
      const mtimeMs = Date.parse(item.modified) || 0;
      metaByFile.set(item.fileName, await readJarModMeta(fullPath, item.size, mtimeMs));
    }

    for (let i = 0; i < modItems.length; i += 1) {
      const a = modItems[i];
      if (!a.enabled) continue;
      const recA = recordByFile.get(a.fileName);
      const metaA = metaByFile.get(a.fileName);
      const primaryIdA = metaA?.modIds[0];

      for (let j = i + 1; j < modItems.length; j += 1) {
        const b = modItems[j];
        if (!b.enabled) continue;
        const recB = recordByFile.get(b.fileName);
        const metaB = metaByFile.get(b.fileName);
        const primaryIdB = metaB?.modIds[0];

        const sameProject = Boolean(recA?.projectId && recB?.projectId && recA.provider === recB.provider && recA.projectId === recB.projectId);
        const sameModId = Boolean(primaryIdA && primaryIdB && primaryIdA === primaryIdB);
        if (sameProject || sameModId) {
          if (!a.duplicateOf) a.duplicateOf = b.fileName;
          if (!b.duplicateOf) b.duplicateOf = a.fileName;
        }
      }
    }

    for (const providerItem of modItems) {
      const recP = recordByFile.get(providerItem.fileName);
      const metaP = metaByFile.get(providerItem.fileName);
      const offeredIds = new Set<string>([
        ...(metaP?.modIds ?? []),
        ...(metaP?.provides ?? [])
      ]);
      if (recP?.slug) offeredIds.add(recP.slug.toLowerCase());
      if (recP?.projectId === "P7dR8mSH" || recP?.projectId === "306612" || offeredIds.has("fabric-api") || offeredIds.has("fabric")) {
        offeredIds.add("fabric");
        offeredIds.add("fabric-api");
      }
      if (!offeredIds.size) continue;

      const dependents: string[] = [];
      for (const consumer of modItems) {
        if (consumer === providerItem || !consumer.enabled) continue;
        const metaC = metaByFile.get(consumer.fileName);
        if (!metaC) continue;
        const needsIt = metaC.depends.some((dep) => offeredIds.has(dep));
        if (needsIt) {
          dependents.push(consumer.displayName);
        }
      }
      if (dependents.length > 0) {
        providerItem.dependents = [...new Set(dependents)];
      }
    }
  }

  async listScreenshots(instanceId: string): Promise<ScreenshotInfo[]> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === instanceId);
    if (!instance) {
      throw new Error(tr("Instance not found", "Инстанция не найдена"));
    }
    const dir = path.join(instance.directory, "screenshots");
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const out: ScreenshotInfo[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(png|jpg|jpeg|webp)$/i.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const st = await stat(full).catch(() => null);
      if (!st) continue;
      try {
        const buf = await readFile(full);
        const ext = path.extname(entry.name).toLowerCase();
        out.push({
          fileName: entry.name,
          size: st.size,
          modified: st.mtime.toISOString(),
          dataUrl: toDataUrl(ext, buf)
        });
      } catch {
      }
    }
    out.sort((a, b) => b.modified.localeCompare(a.modified));
    return out;
  }

  async copyScreenshot(instanceId: string, fileName: string): Promise<boolean> {
    const safe = path.basename(fileName);
    if (!safe || safe !== fileName) return false;
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === instanceId);
    if (!instance) return false;
    const full = path.join(instance.directory, "screenshots", safe);
    if (!existsSync(full)) return false;
    const img = nativeImage.createFromPath(full);
    if (img.isEmpty()) return false;
    clipboard.writeImage(img);
    return true;
  }

  async deleteScreenshot(instanceId: string, fileName: string): Promise<ScreenshotInfo[]> {
    const safe = path.basename(fileName);
    if (!safe || safe !== fileName) {
      throw new Error(tr("Invalid file name", "Недопустимое имя файла"));
    }
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === instanceId);
    if (!instance) {
      throw new Error(tr("Instance not found", "Инстанция не найдена"));
    }
    const full = path.join(instance.directory, "screenshots", safe);
    await rm(full, { force: true });
    return this.listScreenshots(instanceId);
  }

  async toggle(instanceId: string, fileName: string, kind?: LocalContentKind, world?: string): Promise<LocalContentItem[]> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === instanceId);

    if (!instance) {
      throw new Error(tr("Instance not found", "Инстанция не найдена"));
    }

    const location = await this.findEntry(instance.directory, fileName, kind, world);

    if (!location) {
      throw new Error(tr(`File not found: ${fileName}`, `Файл не найден: ${fileName}`));
    }

    const { enabled } = stripDisabled(location.name);
    const nextName = enabled ? `${location.name}${disabledSuffix}` : stripDisabled(location.name).base;
    const destPath = path.join(location.dir, nextName);
    const destStat = await stat(destPath).catch(() => null);
    if (destStat) {
      if (destStat.isDirectory()) {
        const children = await readdir(destPath).catch(() => ["_nonempty"]);
        if (children.length === 0) {
          await rm(destPath, { recursive: true, force: true });
        } else {
          throw new Error(tr(`Cannot toggle ${location.name}: ${nextName} already exists`, `Не удалось переключить ${location.name}: ${nextName} уже существует`));
        }
      } else {
        throw new Error(tr(`Cannot toggle ${location.name}: ${nextName} already exists`, `Не удалось переключить ${location.name}: ${nextName} уже существует`));
      }
    }
    await rename(path.join(location.dir, location.name), destPath);

    let datapackDirs: string[] = [];
    if (location.kind === "datapack") {
      datapackDirs = [
        path.join(instance.directory, kindDirs.datapack),
        ...(await this.worldDatapackDirs(instance.directory)).map((w) => w.dir)
      ];
    }

    const { base: toggledBase } = stripDisabled(location.name);
    let anotherEnabledCopy = false;
    if (location.kind === "datapack") {
      for (const dir of datapackDirs) {
        if (dir === location.dir) continue;
        try {
          await stat(path.join(dir, toggledBase));
          anotherEnabledCopy = true;
          break;
        } catch {
        }
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
        if (location.kind === "datapack" && anotherEnabledCopy) {
          record.fileName = toggledBase;
        } else {
          record.fileName = nextName;
        }
      }

      target.updatedAt = new Date().toISOString();
      return target;
    });

    await this.writeContentManifest(instanceId);
    return this.list(instanceId);
  }

  async remove(instanceId: string, fileName: string, kind?: LocalContentKind, world?: string): Promise<LocalContentItem[]> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === instanceId);

    if (!instance) {
      throw new Error(tr("Instance not found", "Инстанция не найдена"));
    }

    const location = await this.findEntry(instance.directory, fileName, kind, world);

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

    await rm(path.join(location.dir, location.name), { recursive: true, force: true });

    const remainingName = location.kind === "datapack"
      ? await this.findRemainingDatapackName(instance.directory, location.name, location.dir)
      : null;

    if (!remainingName) {
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
    }

    await this.store.update((current) => {
      const target = current.instances.find((item) => item.id === instanceId);
      if (!target) {
        throw new Error(tr("Instance not found", "Инстанция не найдена"));
      }

      if (remainingName) {
        const existing = target.mods.find(
          (mod) => (mod.projectType ?? "mod") === location.kind && mod.fileName !== undefined && normalizeName(mod.fileName) === normalizeName(location.name)
        );
        if (existing) existing.fileName = remainingName;
      } else {
        target.mods = target.mods.filter(
          (mod) =>
            !((mod.projectType ?? "mod") === location.kind && mod.fileName !== undefined && normalizeName(mod.fileName) === normalizeName(location.name))
        );
      }
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
      const baseLower = stripDisabled(name).base.toLowerCase();
      if (sourceStat.isDirectory()) {
        const entries = await readdir(source, { withFileTypes: true }).catch(() => []);
        pending.push({ source, name, isDir: true, kind: classifyEntries(entries.map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name)) });
      } else if (baseLower.endsWith(".jar")) {
        pending.push({ source, name, isDir: false, kind: "mod" });
      } else if (baseLower.endsWith(".zip")) {
        pending.push({ source, name, isDir: false, kind: classifyEntries(await listZipEntries(source).catch(() => [])) });
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
      if (hashes.size > 0) {
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

      const stillUnknown = unknown.filter((item) => !item.kind);
      if (stillUnknown.length && this.curseforge && curseForgeAvailable) {
        const fps = new Map<string, number>();
        for (const item of stillUnknown) {
          const fp = await cfFingerprintCached(item.source).catch(() => 0);
          if (fp > 0) fps.set(item.source, fp);
        }
        const matches = await this.curseforge.matchFingerprints([...fps.values()]);
        const modIds = [...new Set([...matches.values()].map((m) => m.id))];
        const mods = await this.curseforge.getModsByIds(modIds);
        for (const item of stillUnknown) {
          const match = matches.get(fps.get(item.source) ?? 0);
          if (!match) continue;
          const mod = mods.get(match.id);
          const pt = projectTypeForClass(mod?.classId, "resourcepack");
          if (pt !== "modpack") item.kind = pt;
        }
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
    const seenUnlinked = new Set<string>();
    const worldDirs = (await this.worldDatapackDirs(instance.directory)).map((w) => w.dir);
    for (const kind of kindOrder) {
      const dirs = [path.join(instance.directory, kindDirs[kind]), ...(kind === "datapack" ? worldDirs : [])];
      for (const dir of dirs) {
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (!entry.isFile()) {
            continue;
          }
          const { base } = stripDisabled(entry.name);
          const lowerBase = base.toLowerCase();
          if (!kindExtensions[kind].some((ext) => lowerBase.endsWith(ext)) || known.has(`${kind}:${lowerBase}`) || seenUnlinked.has(`${kind}:${lowerBase}`)) {
            continue;
          }
          const fullPath = path.join(dir, entry.name);
          const fileStat = await stat(fullPath).catch(() => null);
          if (!fileStat) {
            continue;
          }
          seenUnlinked.add(`${kind}:${lowerBase}`);
          unlinked.push({ kind, fileName: entry.name, fullPath, cacheKey: `${kind}/${lowerBase}|${fileStat.size}|${Math.round(fileStat.mtimeMs)}` });
        }
      }
    }
    if (!unlinked.length) {
      return instance;
    }

    const now = Date.now();
    const canCheckCf = Boolean(this.curseforge && curseForgeAvailable);
    const toLookup: UnlinkedFile[] = [];
    for (const file of unlinked) {
      const cached = cache[file.cacheKey];
      if (cached && cached.projectId === null && (!canCheckCf || cached.cfChecked) && now - cached.checkedAt < unknownRecheckMs) {
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

    let versions: Record<string, { id?: string; project_id?: string }> = {};
    try {
      const response = await fetch("https://api.modrinth.com/v2/version_files", {
        method: "POST",
        headers: { ...modrinthHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ hashes: [...new Set(toLookup.map((file) => file.sha1 as string))], algorithm: "sha1" }),
        signal: AbortSignal.timeout(20000)
      });
      if (response.ok) {
        versions = (await response.json()) as Record<string, { id?: string; project_id?: string }>;
      }
    } catch {
    }

    const projectIds = [...new Set(Object.values(versions).map((version) => version.project_id).filter((id): id is string => Boolean(id)))];
    const projects = new Map<string, { title?: string; slug?: string; icon_url?: string }>();
    if (projectIds.length) {
      const chunks: string[][] = [];
      for (let i = 0; i < projectIds.length; i += 60) {
        chunks.push(projectIds.slice(i, i + 60));
      }
      await Promise.all(chunks.map(async (chunk) => {
        try {
          const response = await fetch(`https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(chunk))}`, {
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
      }));
    }

    const matched: Array<{
      file: UnlinkedFile;
      provider: ModProvider;
      versionId: string;
      projectId: string;
      name?: string;
      slug?: string;
      iconUrl?: string;
    }> = [];
    const unmatchedForCf: UnlinkedFile[] = [];

    for (const file of toLookup) {
      const version = versions[file.sha1 as string];
      if (version?.id && version.project_id) {
        const project = projects.get(version.project_id);
        cache[file.cacheKey] = { sha1: file.sha1 as string, projectId: version.project_id, checkedAt: now, cfChecked: true };
        matched.push({
          file,
          provider: "modrinth",
          versionId: version.id,
          projectId: version.project_id,
          name: project?.title,
          slug: project?.slug,
          iconUrl: project?.icon_url
        });
      } else {
        unmatchedForCf.push(file);
      }
    }

    if (unmatchedForCf.length && this.curseforge && curseForgeAvailable) {
      const fpByFile = new Map<UnlinkedFile, number>();
      for (const file of unmatchedForCf) {
        const fp = await cfFingerprintCached(file.fullPath).catch(() => 0);
        if (fp > 0) fpByFile.set(file, fp);
      }
      const cfMatches = await this.curseforge.matchFingerprints([...fpByFile.values()]);
      const cfModIds = [...new Set([...cfMatches.values()].map((m) => m.id))];
      const cfMods = await this.curseforge.getModsByIds(cfModIds);

      for (const file of unmatchedForCf) {
        const fp = fpByFile.get(file);
        const match = fp ? cfMatches.get(fp) : undefined;
        if (match?.id && match.file?.id) {
          const mod = cfMods.get(match.id);
          cache[file.cacheKey] = { sha1: file.sha1 as string, projectId: String(match.id), checkedAt: now, cfChecked: true };
          matched.push({
            file,
            provider: "curseforge",
            versionId: String(match.file.id),
            projectId: String(match.id),
            name: mod?.name,
            slug: mod?.slug,
            iconUrl: mod?.logo?.thumbnailUrl || mod?.logo?.url || undefined
          });
        } else {
          cache[file.cacheKey] = { sha1: file.sha1 as string, projectId: null, checkedAt: now, cfChecked: true };
        }
      }
    } else {
      for (const file of unmatchedForCf) {
        cache[file.cacheKey] = { sha1: file.sha1 as string, projectId: null, checkedAt: now, cfChecked: false };
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
      for (const item of matched) {
        const { file, provider, versionId, projectId } = item;
        const existing = target.mods.find((mod) => mod.provider === provider && mod.projectId === projectId && (mod.projectType ?? "mod") === file.kind);
        if (existing) {
          const oldBase = existing.fileName ? stripDisabled(existing.fileName).base : "";
          const checkDirs = [
            path.join(target.directory, kindDirs[file.kind]),
            ...(file.kind === "datapack" ? worldDirs : [])
          ];
          const stillThere = oldBase !== "" && normalizeName(oldBase) !== normalizeName(file.fileName)
            && checkDirs.some((d) => existsSync(path.join(d, oldBase)) || existsSync(path.join(d, `${oldBase}${disabledSuffix}`)));
          if (stillThere) {
            continue;
          }
          existing.fileName = file.fileName;
          existing.versionId = versionId;
          continue;
        }
        target.mods.push({
          id: randomUUID(),
          provider,
          projectId,
          versionId,
          name: item.name || stripDisabled(file.fileName).base,
          slug: item.slug,
          fileName: file.fileName,
          iconUrl: item.iconUrl,
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

    const entries = await listZipEntries(fullPath);
    const found = entries.length ? ((kind === "mod" ? await readModIcon(fullPath, entries) : await readArchiveIcon(fullPath, entries, "pack.png")) ?? null) : null;

    if (found) {
      await mkdir(iconsDir, { recursive: true });
      await writeFile(path.join(iconsDir, `${cacheKey}${found.ext}`), found.data);
      return toDataUrl(found.ext, found.data);
    }

    return this.fetchModrinthIcon(instanceId, record);
  }

  private async fetchModrinthIcon(instanceId: string, record?: InstalledMod): Promise<string | undefined> {
    if (record?.provider === "curseforge") {
      if (!this.curseforge || !curseForgeAvailable || !/^\d+$/.test(record.projectId)) return undefined;
      const mods = await this.curseforge.getModsByIds([Number(record.projectId)]);
      const iconUrl = mods.get(Number(record.projectId))?.logo?.thumbnailUrl || mods.get(Number(record.projectId))?.logo?.url;
      if (!iconUrl) return undefined;
      await this.store.update((current) => {
        const target = current.instances.find((item) => item.id === instanceId);
        const entry = target?.mods.find((mod) => mod.id === record.id);
        if (entry) entry.iconUrl = iconUrl;
        return true;
      });
      return iconUrl;
    }
    const ref = record?.slug || record?.projectId;
    if (!ref) {
      return undefined;
    }

    try {
      const response = await fetch(`https://api.modrinth.com/v2/project/${ref}`, {
        headers: { "User-Agent": "lynapp/1.1.0-beta.7" }
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

  private async findRemainingDatapackName(instanceDir: string, fileName: string, excludeDir: string): Promise<string | null> {
    const { base } = stripDisabled(fileName);
    const dirs = [path.join(instanceDir, kindDirs.datapack), ...(await this.worldDatapackDirs(instanceDir)).map((item) => item.dir)];
    for (const dir of dirs) {
      if (path.resolve(dir) === path.resolve(excludeDir)) continue;
      for (const candidate of [base, `${base}${disabledSuffix}`]) {
        try {
          await stat(path.join(dir, candidate));
          return candidate;
        } catch {
        }
      }
    }
    return null;
  }

  private async findEntry(instanceDir: string, fileName: string, onlyKind?: LocalContentKind, world?: string): Promise<{ kind: LocalContentKind; dir: string; name: string } | null> {
    if (!fileName || fileName.includes("..") || fileName.includes("/") || fileName.includes("\\") || fileName.includes(":") || path.isAbsolute(fileName)) {
      throw new Error(tr(`Unsafe file name: ${fileName}`, `Недопустимое имя файла: ${fileName}`));
    }
    const { base, enabled } = stripDisabled(fileName);
    const variant = enabled ? `${fileName}${disabledSuffix}` : base;

    if (world !== undefined) {
      if (!world || world.includes("..") || world.includes("/") || world.includes("\\") || world.includes(":") || path.isAbsolute(world)) {
        throw new Error(tr(`Unsafe world name: ${world}`, `Недопустимое имя мира: ${world}`));
      }
      const worldDir = path.join(instanceDir, "saves", world, "datapacks");
      for (const candidate of [fileName, variant]) {
        const candidatePath = path.join(worldDir, candidate);
        if (path.resolve(candidatePath) === candidatePath && candidatePath.startsWith(worldDir + path.sep)) {
          try {
            await stat(candidatePath);
            return { kind: "datapack", dir: worldDir, name: candidate };
          } catch {
          }
        }
      }
      return null;
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

      const variantPath = path.join(dir, variant);

      try {
        await stat(variantPath);
        return { kind, dir, name: variant };
      } catch {
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
    await writeContentManifest(instance.directory, instance.mods);
  }
}
