import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InstallModPayload, ModSearchPayload } from "@shared/ipc";
import type { LauncherInstance, ModLoader, ModrinthProjectType, ModSearchResponse, ModSearchResult, ModSortIndex } from "@shared/types";
import { writeContentManifest } from "./manifest";
import { JsonStore } from "../store";
import { getLauncherRoot } from "../paths";
import { readUrlBytes, type BytesCallback } from "./transfer";
import { sanitizeFilePart, targetDirectories } from "./mods";
import { tr } from "../i18n";

const API = "https://api.curseforge.com/v1";
const MINECRAFT_GAME_ID = 432;
const BUILTIN_API_KEY = String(import.meta.env.MAIN_VITE_CURSEFORGE_API_KEY ?? "").trim();

export const curseForgeAvailable = BUILTIN_API_KEY.length > 0;
const USER_AGENT = "lynapp/1.1.0-beta.4";

const CLASS_IDS: Record<ModrinthProjectType, number> = {
  mod: 6,
  resourcepack: 12,
  shader: 6552,
  datapack: 6945,
  modpack: 4471
};

const CLASS_FOLDERS: Record<number, string> = {
  6: "mods",
  12: "resourcepacks",
  6552: "shaderpacks",
  6945: "datapacks"
};

const SORT_FIELDS: Record<ModSortIndex, number> = {
  relevance: 1,
  downloads: 6,
  follows: 2,
  newest: 11,
  updated: 3
};

const LOADER_TYPES: Partial<Record<ModLoader | string, number>> = {
  forge: 1,
  fabric: 4,
  quilt: 5,
  neoforge: 6
};

interface CfMod {
  id: number;
  name: string;
  slug?: string;
  summary?: string;
  downloadCount?: number;
  thumbsUpCount?: number;
  dateModified?: string;
  dateReleased?: string;
  classId?: number;
  allowModDistribution?: boolean | null;
  logo?: { thumbnailUrl?: string; url?: string } | null;
  authors?: Array<{ name?: string }>;
  categories?: Array<{ id: number; name: string }>;
  links?: { websiteUrl?: string };
}

interface CfFile {
  id: number;
  modId: number;
  displayName?: string;
  fileName: string;
  releaseType?: number;
  fileDate?: string;
  fileLength?: number;
  downloadUrl?: string | null;
  gameVersions?: string[];
  hashes?: Array<{ value: string; algo: number }>;
}

interface CfCategory {
  id: number;
  name: string;
  classId?: number;
  isClass?: boolean;
}

interface ModrinthFile {
  url?: string;
  hashes?: { sha1?: string };
}

interface ModrinthVersion {
  files?: ModrinthFile[];
}

export interface CurseForgeManifest {
  manifestType?: string;
  name?: string;
  overrides?: string;
  minecraft?: { version?: string; modLoaders?: Array<{ id?: string; primary?: boolean }> };
  files?: Array<{ projectID?: number; fileID?: number; required?: boolean }>;
}

export interface ResolvedPackFile {
  path: string;
  url: string;
  sha1?: string;
  size?: number;
  projectId: string;
  fileId: string;
  name: string;
  slug?: string;
  iconUrl?: string;
  projectType: ModrinthProjectType;
}

export function curseForgeDependencies(manifest: CurseForgeManifest): Record<string, string> {
  const dependencies: Record<string, string> = {};
  const gameVersion = (manifest.minecraft?.version ?? "").trim();
  if (gameVersion) dependencies.minecraft = gameVersion;
  const loaders = manifest.minecraft?.modLoaders ?? [];
  const loader = loaders.find((item) => item.primary) ?? loaders[0];
  const id = (loader?.id ?? "").trim();
  const match = /^(forge|neoforge|fabric|quilt)-(.+)$/i.exec(id);
  if (match) {
    const kind = match[1].toLowerCase();
    const version = match[2];
    if (kind === "fabric") dependencies["fabric-loader"] = version;
    else if (kind === "quilt") dependencies["quilt-loader"] = version;
    else if (kind === "forge") dependencies.forge = version;
    else dependencies.neoforge = version.startsWith(`${gameVersion}-`) ? version.slice(gameVersion.length + 1) : version;
  }
  return dependencies;
}

function projectTypeForClass(classId: number | undefined, fallback: ModrinthProjectType): ModrinthProjectType {
  const entry = Object.entries(CLASS_IDS).find(([, id]) => id === classId);
  return entry ? (entry[0] as ModrinthProjectType) : fallback;
}

function sha1Of(file: CfFile): string | undefined {
  return file.hashes?.find((hash) => hash.algo === 1)?.value?.toLowerCase();
}

function pickFile(files: CfFile[]): CfFile | undefined {
  const sorted = [...files].sort((a, b) => (b.fileDate ?? "").localeCompare(a.fileDate ?? ""));
  return sorted.find((file) => file.releaseType === 1) ?? sorted[0];
}

function blockedMessage(name: string, websiteUrl?: string): string {
  return tr(
    `The author of ${name} does not allow downloads through other launchers. Download it from the CurseForge website${websiteUrl ? `: ${websiteUrl}` : ""} and drop the file onto the Files tab.`,
    `Автор ${name} запретил скачивание через сторонние лаунчеры. Скачайте файл на сайте CurseForge${websiteUrl ? `: ${websiteUrl}` : ""} и перетащите его на вкладку «Файлы».`
  );
}

export class CurseForgeService {
  private readonly categoryCache = new Map<number, CfCategory[]>();

  constructor(private readonly store: JsonStore) {}

  private async request<T>(pathAndQuery: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const key = BUILTIN_API_KEY;
    if (!key) {
      throw new Error(tr("CurseForge is not available in this build", "CurseForge недоступен в этой сборке"));
    }
    const response = await fetch(`${API}${pathAndQuery}`, {
      method: init?.method ?? "GET",
      headers: {
        "x-api-key": key,
        accept: "application/json",
        "user-agent": USER_AGENT,
        ...(init?.body !== undefined ? { "content-type": "application/json" } : {})
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(30000)
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error(tr(`CurseForge rejected the API key (HTTP ${response.status})`, `CurseForge не принял ключ API (HTTP ${response.status})`));
    }
    if (!response.ok) {
      throw new Error(tr(`CurseForge returned HTTP ${response.status}`, `CurseForge вернул ошибку: HTTP ${response.status}`));
    }
    return (await response.json()) as T;
  }

  private async categories(projectType: ModrinthProjectType): Promise<CfCategory[]> {
    const classId = CLASS_IDS[projectType];
    const cached = this.categoryCache.get(classId);
    if (cached) return cached;
    const body = await this.request<{ data: CfCategory[] }>(`/categories?gameId=${MINECRAFT_GAME_ID}&classId=${classId}`);
    const list = (body.data ?? []).filter((item) => !item.isClass).sort((a, b) => a.name.localeCompare(b.name));
    this.categoryCache.set(classId, list);
    return list;
  }

  async getCategoryTags(projectType: ModrinthProjectType): Promise<string[]> {
    return (await this.categories(projectType)).map((item) => item.name);
  }

  async search(payload: ModSearchPayload): Promise<ModSearchResponse> {
    const data = await this.store.getData();
    const instance = payload.instanceId ? data.instances.find((item) => item.id === payload.instanceId) : undefined;
    if (payload.instanceId && !instance) throw new Error(tr("Instance not found", "Инстанция не найдена"));

    const pageSize = Math.min(Math.max(payload.limit ?? 20, 5), 50);
    const index = Math.min(Math.max(payload.offset ?? 0, 0), 10000 - pageSize);
    const url = new URLSearchParams({
      gameId: String(MINECRAFT_GAME_ID),
      classId: String(CLASS_IDS[payload.projectType]),
      sortField: String(SORT_FIELDS[payload.sort ?? "relevance"]),
      sortOrder: "desc",
      index: String(index),
      pageSize: String(pageSize)
    });
    const query = payload.query.trim();
    if (query) url.set("searchFilter", query);
    const gameVersion = payload.versions?.[0] ?? instance?.gameVersion;
    if (gameVersion) url.set("gameVersion", gameVersion);
    if (payload.projectType === "mod" || payload.projectType === "modpack") {
      const loader = payload.loaders?.[0] ?? (instance && instance.loader !== "vanilla" ? instance.loader : undefined);
      const loaderType = loader ? LOADER_TYPES[loader === "quilt" && payload.projectType === "mod" ? "fabric" : loader] : undefined;
      if (loaderType) url.set("modLoaderType", String(loaderType));
    }
    if (payload.categories?.length) {
      const known = await this.categories(payload.projectType);
      const ids = payload.categories.map((name) => known.find((item) => item.name === name)?.id).filter((id): id is number => typeof id === "number").slice(0, 10);
      if (ids.length) url.set("categoryIds", JSON.stringify(ids));
    }

    const body = await this.request<{ data: CfMod[]; pagination?: { totalCount?: number } }>(`/mods/search?${url.toString()}`);
    const results: ModSearchResult[] = (body.data ?? []).map((mod) => ({
      id: String(mod.id),
      provider: "curseforge",
      projectType: projectTypeForClass(mod.classId, payload.projectType),
      title: mod.name,
      slug: mod.slug,
      author: mod.authors?.[0]?.name,
      summary: mod.summary ?? "",
      iconUrl: mod.logo?.thumbnailUrl || mod.logo?.url || undefined,
      downloads: mod.downloadCount,
      follows: mod.thumbsUpCount,
      dateModified: mod.dateModified ?? mod.dateReleased,
      categories: (mod.categories ?? []).map((category) => category.name),
      websiteUrl: mod.links?.websiteUrl,
      distributionBlocked: mod.allowModDistribution === false
    }));
    return { results, totalHits: Math.min(body.pagination?.totalCount ?? results.length, 10000) };
  }

  private async filesFor(modId: string, gameVersion: string | undefined, loaders: string[]): Promise<CfFile[]> {
    const attempts = loaders.length ? loaders : [""];
    for (const loader of attempts) {
      const query = new URLSearchParams({ pageSize: "50" });
      if (gameVersion) query.set("gameVersion", gameVersion);
      const loaderType = loader ? LOADER_TYPES[loader] : undefined;
      if (loaderType) query.set("modLoaderType", String(loaderType));
      const body = await this.request<{ data: CfFile[] }>(`/mods/${encodeURIComponent(modId)}/files?${query.toString()}`);
      if (body.data?.length) return body.data;
    }
    return [];
  }

  private async mod(modId: string): Promise<CfMod | null> {
    try {
      return (await this.request<{ data: CfMod }>(`/mods/${encodeURIComponent(modId)}`)).data;
    } catch {
      return null;
    }
  }

  async install(payload: InstallModPayload, onBytes?: BytesCallback): Promise<LauncherInstance> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === payload.instanceId);
    if (!instance) throw new Error(tr("Instance not found", "Инстанция не найдена"));
    if (payload.projectType === "mod" && instance.loader === "vanilla") {
      throw new Error(tr("Choose Fabric, Forge, Quilt, or NeoForge before installing mods.", "Перед установкой модов выберите Fabric, Forge, Quilt или NeoForge."));
    }

    const gameVersion = payload.gameVersions?.[0] ?? instance.gameVersion;
    const loader = payload.loaders?.[0] ?? instance.loader;
    const loaders = payload.projectType === "mod" ? (loader === "quilt" ? ["quilt", "fabric"] : loader === "vanilla" ? [] : [loader]) : [];
    let file: CfFile | undefined;
    if (payload.versionId) {
      file = (await this.request<{ data: CfFile }>(`/mods/${encodeURIComponent(payload.projectId)}/files/${encodeURIComponent(payload.versionId)}`)).data;
    } else {
      file = pickFile(await this.filesFor(payload.projectId, gameVersion, loaders));
    }
    if (!file) throw new Error(tr(`No compatible CurseForge file for ${payload.name} (${gameVersion})`, `На CurseForge нет подходящего файла для ${payload.name} (${gameVersion})`));
    if (!file.downloadUrl) {
      const mod = await this.mod(payload.projectId);
      throw new Error(blockedMessage(payload.name, mod?.links?.websiteUrl));
    }

    const destinations = await targetDirectories(instance, payload.projectType);
    for (const destination of destinations) await mkdir(destination, { recursive: true });
    const launcherDir = path.join(instance.directory, ".launcher");
    await mkdir(launcherDir, { recursive: true });

    const previous = instance.mods.find((item) => item.provider === "curseforge" && item.projectId === payload.projectId && (item.projectType ?? "mod") === payload.projectType);
    const previousBase = previous?.fileName?.replace(/\.disabled$/i, "");
    const keepDisabled = Boolean(previous?.fileName && /\.disabled$/i.test(previous.fileName));
    const downloadedName = sanitizeFilePart(file.fileName);
    const fileName = keepDisabled ? `${downloadedName}.disabled` : downloadedName;
    const { buffer } = await readUrlBytes(file.downloadUrl, { "User-Agent": USER_AGENT }, undefined, (received, total) => onBytes?.(received, total), 15 * 60 * 1000);
    for (const destination of destinations) {
      const tmpPath = path.join(destination, `${downloadedName}.download`);
      await writeFile(tmpPath, buffer);
      if (previousBase && previousBase.toLowerCase() !== downloadedName.toLowerCase()) {
        await rm(path.join(destination, previousBase), { force: true }).catch(() => undefined);
        await rm(path.join(destination, `${previousBase}.disabled`), { force: true }).catch(() => undefined);
      }
      await rm(path.join(destination, downloadedName), { force: true }).catch(() => undefined);
      await rm(path.join(destination, `${downloadedName}.disabled`), { force: true }).catch(() => undefined);
      await rename(tmpPath, path.join(destination, fileName));
    }

    const updated = await this.store.update((current) => {
      const target = current.instances.find((item) => item.id === payload.instanceId);
      if (!target) throw new Error(tr("Instance not found", "Инстанция не найдена"));
      const existing = target.mods.find((item) => item.provider === "curseforge" && item.projectId === payload.projectId && (item.projectType ?? "mod") === payload.projectType);
      const now = new Date().toISOString();
      if (existing) {
        existing.versionId = String(file.id);
        existing.fileName = fileName;
        existing.name = payload.name;
        existing.slug = payload.slug;
        existing.iconUrl = payload.iconUrl;
        existing.installedAt = now;
        existing.status = "installed";
      } else {
        target.mods.push({ id: randomUUID(), provider: "curseforge", projectId: payload.projectId, versionId: String(file.id), name: payload.name, slug: payload.slug, fileName, iconUrl: payload.iconUrl, installedAt: now, status: "installed", projectType: payload.projectType });
      }
      target.updatedAt = now;
      return target;
    });
    await writeContentManifest(updated.directory, updated.mods);
    return updated;
  }

  async downloadModpackFile(instanceId: string, projectId: string, name: string, onBytes?: BytesCallback): Promise<string> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === instanceId);
    if (!instance) throw new Error(tr("Instance not found", "Инстанция не найдена"));
    let files = await this.filesFor(projectId, instance.gameVersion, []);
    if (!files.length) files = await this.filesFor(projectId, undefined, []);
    const file = pickFile(files.filter((item) => /\.zip$/i.test(item.fileName)));
    if (!file) throw new Error(tr(`No modpack file for ${name} on CurseForge`, `На CurseForge нет файла сборки ${name}`));
    if (!file.downloadUrl) {
      const mod = await this.mod(projectId);
      throw new Error(blockedMessage(name, mod?.links?.websiteUrl));
    }
    const dir = path.join(getLauncherRoot(), "cache", "modpacks");
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, `download-${randomUUID()}.zip`);
    const { buffer } = await readUrlBytes(file.downloadUrl, { "User-Agent": USER_AGENT }, undefined, (received, total) => onBytes?.(received, total), 15 * 60 * 1000);
    await writeFile(target, buffer);
    return target;
  }

  private async modrinthUrlsBySha1(hashes: string[]): Promise<Map<string, string>> {
    const urls = new Map<string, string>();
    if (!hashes.length) return urls;
    try {
      const response = await fetch("https://api.modrinth.com/v2/version_files", {
        method: "POST",
        headers: { "user-agent": USER_AGENT, accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ hashes, algorithm: "sha1" }),
        signal: AbortSignal.timeout(30000)
      });
      if (!response.ok) return urls;
      const body = (await response.json()) as Record<string, ModrinthVersion>;
      for (const version of Object.values(body ?? {})) {
        for (const file of version?.files ?? []) {
          const sha1 = file.hashes?.sha1?.toLowerCase();
          if (sha1 && file.url) urls.set(sha1, file.url);
        }
      }
    } catch {
    }
    return urls;
  }

  async resolveManifest(manifest: CurseForgeManifest): Promise<{ files: ResolvedPackFile[]; skipped: string[] }> {
    const entries = (manifest.files ?? []).filter((item) => typeof item.projectID === "number" && typeof item.fileID === "number" && item.required !== false);
    if (!entries.length) return { files: [], skipped: [] };
    const cfFiles: CfFile[] = [];
    const fileIds = entries.map((item) => item.fileID as number);
    for (let start = 0; start < fileIds.length; start += 500) {
      const body = await this.request<{ data: CfFile[] }>("/mods/files", { method: "POST", body: { fileIds: fileIds.slice(start, start + 500) } });
      cfFiles.push(...(body.data ?? []));
    }
    const modIds = [...new Set(entries.map((item) => item.projectID as number))];
    const mods = new Map<number, CfMod>();
    for (let start = 0; start < modIds.length; start += 500) {
      const body = await this.request<{ data: CfMod[] }>("/mods", { method: "POST", body: { modIds: modIds.slice(start, start + 500), filterPcOnly: true } });
      for (const mod of body.data ?? []) mods.set(mod.id, mod);
    }
    const byId = new Map(cfFiles.map((file) => [file.id, file]));
    const blockedHashes = [
      ...new Set(
        entries
          .map((entry) => byId.get(entry.fileID as number))
          .filter((file): file is CfFile => Boolean(file && !file.downloadUrl))
          .map((file) => sha1Of(file))
          .filter((hash): hash is string => Boolean(hash))
      )
    ];
    const fallbackUrls = await this.modrinthUrlsBySha1(blockedHashes);
    const files: ResolvedPackFile[] = [];
    const skipped: string[] = [];
    for (const entry of entries) {
      const file = byId.get(entry.fileID as number);
      const mod = mods.get(entry.projectID as number);
      const label = mod?.name ?? file?.displayName ?? `#${entry.projectID}`;
      if (!file) {
        skipped.push(label);
        continue;
      }
      const sha1 = sha1Of(file);
      const url = file.downloadUrl ?? (sha1 ? fallbackUrls.get(sha1) : undefined);
      if (!url) {
        skipped.push(`${label} (${file.fileName})`);
        continue;
      }
      const folder = CLASS_FOLDERS[mod?.classId ?? 6] ?? "mods";
      files.push({
        path: `${folder}/${sanitizeFilePart(file.fileName)}`,
        url,
        sha1,
        size: file.fileLength,
        projectId: String(entry.projectID),
        fileId: String(file.id),
        name: label,
        slug: mod?.slug,
        iconUrl: mod?.logo?.thumbnailUrl || undefined,
        projectType: projectTypeForClass(mod?.classId, "mod")
      });
    }
    return { files, skipped };
  }
}
