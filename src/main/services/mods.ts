import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InstallModPayload, ModSearchPayload, PrepareModInstallPayload } from "@shared/ipc";
import type { ContentIncompatibility, ContentUpdateInfo, LauncherInstance, ModDependencyItem, ModInstallPlan, ModLoader, ModProjectDetails, ModProvider, ModrinthProjectType, ModSearchResponse, ModVersionInfo } from "@shared/types";
import type { CfTrackedItem, CurseForgeService } from "./curseforge";
import { writeContentManifest } from "./manifest";
import { JsonStore } from "../store";
import { getLauncherRoot } from "../paths";
import { readUrlBytes, type BytesCallback } from "./transfer";
import { sha1Cached } from "./hashes";
import { tr } from "../i18n";

interface ModrinthDependencyRef {
  version_id?: string | null;
  project_id?: string | null;
  file_name?: string | null;
  dependency_type?: "required" | "optional" | "incompatible" | "embedded";
}

interface ModrinthVersion {
  id: string;
  project_id?: string;
  name?: string;
  version_number?: string;
  version_type?: "release" | "beta" | "alpha";
  date_published?: string;
  game_versions?: string[];
  files: Array<{ url: string; filename: string; primary?: boolean; size?: number }>;
  loaders?: string[];
  dependencies?: ModrinthDependencyRef[];
}

const modrinthHeaders = { "User-Agent": "lynapp/1.1.0-beta.6" };

async function fetchModrinth(input: string | URL, init: RequestInit = {}, timeoutMs = 12000): Promise<Response> {
  const headers = { ...modrinthHeaders, ...(init.headers as Record<string, string> | undefined) };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(input, {
        ...init,
        headers,
        signal: init.signal ?? AbortSignal.timeout(timeoutMs)
      });
      if (response.status < 500 || attempt === 1) return response;
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      if (init.signal?.aborted) throw error;
      if (attempt === 1) {
        if ((error as { name?: string })?.name === "TimeoutError") {
          throw new Error(tr(
            "Modrinth request timed out. Check your connection and try again.",
            "Превышено время ожидания ответа от Modrinth. Проверьте соединение и повторите попытку."
          ));
        }
        throw error;
      }
    }
  }
  throw new Error(tr("Modrinth request failed", "Не удалось выполнить запрос к Modrinth"));
}

function contentFolder(projectType: ModrinthProjectType): string {
  const folders: Record<ModrinthProjectType, string> = {
    mod: "mods",
    resourcepack: "resourcepacks",
    shader: "shaderpacks",
    datapack: "datapacks",
    modpack: "modpacks"
  };
  return folders[projectType];
}

function loadersFor(projectType: ModrinthProjectType, instance: LauncherInstance): string[] {
  if (projectType === "mod" || projectType === "modpack") {
    if (instance.loader === "vanilla") return [];
    return instance.loader === "quilt" ? ["quilt", "fabric"] : [instance.loader];
  }
  if (projectType === "datapack") return ["datapack"];
  if (projectType === "resourcepack") return ["minecraft"];
  return ["iris", "optifine", "canvas", "vanilla"];
}

function isAuxiliaryModJar(fileName: string): boolean {
  return /(?:^|[-_.+])(sources|javadoc|dev|deobf|preshadow)\.jar$/i.test(fileName);
}

function pickVersionFile(version: ModrinthVersion, projectType: ModrinthProjectType): { url: string; filename: string; primary?: boolean; size?: number } | undefined {
  const pool = projectType === "mod"
    ? (version.files.filter((item) => !isAuxiliaryModJar(item.filename)).length
        ? version.files.filter((item) => !isAuxiliaryModJar(item.filename))
        : version.files)
    : version.files;
  const ext = projectType === "mod" ? ".jar" : projectType === "modpack" ? ".mrpack" : ".zip";
  const matching = pool.filter((item) => item.filename.toLowerCase().endsWith(ext));
  if (matching.length) {
    return matching.find((item) => item.primary) ?? matching[0];
  }
  return pool.find((item) => item.primary) ?? pool[0];
}

function incompatibility(version: ModrinthVersion, instance: LauncherInstance): ContentIncompatibility | undefined {
  const supportedGameVersions = version.game_versions ?? [];
  const supportedLoaders = version.loaders ?? [];
  const loaders = loadersFor("mod", instance);
  const wrongGame = supportedGameVersions.length > 0 && !supportedGameVersions.includes(instance.gameVersion);
  const wrongLoader = instance.loader === "vanilla" || (loaders.length > 0 && supportedLoaders.length > 0 && !supportedLoaders.some((loader) => loaders.includes(loader)));
  if (!wrongGame && !wrongLoader) return undefined;
  return {
    gameVersion: wrongGame ? instance.gameVersion : undefined,
    loader: wrongLoader ? instance.loader : undefined,
    supportedGameVersions,
    supportedLoaders
  };
}

function toVersionInfo(version: ModrinthVersion, instance: LauncherInstance, projectType: ModrinthProjectType): ModVersionInfo {
  const file = pickVersionFile(version, projectType);
  const loaders = loadersFor(projectType, instance);
  const gameVersions = version.game_versions ?? [];
  const loaderMatched = (projectType === "mod" || projectType === "modpack") && instance.loader === "vanilla"
    ? false
    : !loaders.length || (version.loaders ?? []).some((loader) => loaders.includes(loader));
  return {
    id: version.id,
    name: version.name ?? version.version_number ?? version.id,
    versionNumber: version.version_number ?? version.id,
    versionType: version.version_type ?? "release",
    datePublished: version.date_published ?? "",
    gameVersions,
    loaders: version.loaders ?? [],
    fileName: file?.filename ?? "",
    size: file?.size ?? 0,
    compatible: gameVersions.includes(instance.gameVersion) && loaderMatched,
    provider: "modrinth",
    projectId: version.project_id
  };
}

interface ModrinthHit {
  project_id: string;
  title: string;
  slug: string;
  author?: string;
  description: string;
  icon_url?: string;
  downloads?: number;
  follows?: number;
  date_created?: string;
  date_modified?: string;
  categories?: string[];
  project_type?: ModrinthProjectType;
}

interface ModrinthCategoryTag {
  name: string;
  project_type: ModrinthProjectType;
}

export function sanitizeFilePart(value: string): string {
  const cleaned = value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").replace(/\s+/g, "-").trim();
  if (!cleaned) return "download";
  if (cleaned.length <= 100) return cleaned;
  const disabledSuffix = /\.disabled$/i.test(cleaned) ? cleaned.slice(-9) : "";
  const stem = disabledSuffix ? cleaned.slice(0, -9) : cleaned;
  const lastDot = stem.lastIndexOf(".");
  const ext = lastDot > 0 && stem.length - lastDot <= 16 ? `${stem.slice(lastDot)}${disabledSuffix}` : disabledSuffix;
  if (ext) {
    const base = cleaned.slice(0, Math.max(1, 100 - ext.length));
    return `${base}${ext}`;
  }
  return cleaned.slice(0, 100);
}

function targetDirectory(instance: LauncherInstance, projectType: ModrinthProjectType): string {
  const folders: Record<ModrinthProjectType, string> = {
    mod: "mods",
    resourcepack: "resourcepacks",
    shader: "shaderpacks",
    datapack: "datapacks",
    modpack: "modpacks"
  };
  return path.join(instance.directory, folders[projectType]);
}

export async function targetDirectories(instance: LauncherInstance, projectType: ModrinthProjectType): Promise<string[]> {
  if (projectType !== "datapack") {
    return [targetDirectory(instance, projectType)];
  }
  const worlds: string[] = [];
  try {
    const entries = await readdir(path.join(instance.directory, "saves"), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        worlds.push(entry.name);
      }
    }
  } catch {
  }
  if (!worlds.length) {
    return [targetDirectory(instance, projectType)];
  }
  return worlds.map((world) => path.join(instance.directory, "saves", world, "datapacks"));
}

async function downloadFile(url: string, target: string, onBytes?: BytesCallback): Promise<void> {
  const { buffer } = await readUrlBytes(url, { "User-Agent": "lynapp/1.1.0-beta.6" }, undefined, (received, total) => onBytes?.(received, total), 15 * 60 * 1000);
  await writeFile(target, buffer);
}

export class ModService {
  private categoryCache: ModrinthCategoryTag[] | null = null;
  private readonly updateCache = new Map<string, { at: number; signature: string; result: ContentUpdateInfo[] }>();

  constructor(
    private readonly store: JsonStore,
    private readonly curseforge?: CurseForgeService
  ) {}

  async getCategoryTags(projectType: ModrinthProjectType): Promise<string[]> {
    if (!this.categoryCache) {
      const response = await fetchModrinth("https://api.modrinth.com/v2/tag/category");

      if (!response.ok) {
        throw new Error(tr(`Modrinth categories returned ${response.status}`, `Modrinth вернул ошибку при загрузке категорий: ${response.status}`));
      }

      this.categoryCache = (await response.json()) as ModrinthCategoryTag[];
    }

    return this.categoryCache.filter((tag) => tag.project_type === projectType).map((tag) => tag.name);
  }

  async search(payload: ModSearchPayload): Promise<ModSearchResponse> {
    const query = payload.query.trim();

    const data = await this.store.getData();
    const instance = payload.instanceId ? data.instances.find((item) => item.id === payload.instanceId) : undefined;
    if (payload.instanceId && !instance) throw new Error(tr("Instance not found", "Инстанция не найдена"));

    try {
      const limit = Math.min(Math.max(payload.limit ?? 20, 5), 100);
      const offset = Math.max(payload.offset ?? 0, 0);
      const url = new URL("https://api.modrinth.com/v2/search");
      url.searchParams.set("query", query);
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("index", payload.sort ?? "relevance");

      const facets: string[][] = [[`project_type:${payload.projectType}`]];
      const explicitVersions = (payload.versions ?? []).filter((v) => v && v !== "*");
      const explicitWildcardVersion = payload.versions?.includes("*") ?? false;
      const versions = explicitWildcardVersion
        ? []
        : explicitVersions.length
          ? explicitVersions
          : payload.projectType === "modpack"
            ? []
            : instance
              ? [instance.gameVersion]
              : [];
      if (versions.length) {
        facets.push(versions.map((version) => `versions:${version}`));
      }

      if (payload.projectType === "mod" || payload.projectType === "modpack") {
        const explicitLoaders = (payload.loaders ?? []).filter((l) => l && l !== "*");
        const explicitWildcardLoader = payload.loaders?.includes("*") ?? false;
        const loaders = explicitWildcardLoader
          ? []
          : explicitLoaders.length
            ? explicitLoaders
            : payload.projectType === "modpack"
              ? []
              : instance && instance.loader !== "vanilla"
                ? [instance.loader]
                : [];
        if (loaders.length) {
          facets.push(loaders.map((loader) => `categories:${loader}`));
        }
      }

      if (payload.categories?.length) {
        facets.push(payload.categories.map((category) => `categories:${category}`));
      }

      url.searchParams.set("facets", JSON.stringify(facets));

      const response = await fetchModrinth(url);
      if (!response.ok) throw new Error(tr(`Modrinth returned ${response.status}`, `Modrinth вернул ошибку: ${response.status}`));
      const body = (await response.json()) as { hits: ModrinthHit[]; total_hits?: number };
      return {
        results: body.hits.map((hit) => ({
          id: hit.project_id,
          provider: "modrinth",
          projectType: payload.projectType,
          title: hit.title,
          slug: hit.slug,
          author: hit.author,
          summary: hit.description,
          iconUrl: hit.icon_url,
          downloads: hit.downloads,
          follows: hit.follows,
          dateModified: hit.date_modified ?? hit.date_created,
          categories: hit.categories ?? []
        })),
        totalHits: body.total_hits ?? body.hits.length
      };
    } catch (error) {
      return {
        results: [{
          id: "modrinth-search-error",
          provider: "modrinth",
          projectType: payload.projectType,
          title: tr("Modrinth search unavailable", "Поиск Modrinth недоступен"),
          summary: error instanceof Error ? error.message : tr("Unknown search error", "Неизвестная ошибка поиска"),
          categories: ["error"]
        }],
        totalHits: 0
      };
    }
  }

  async install(payload: InstallModPayload, onBytes?: BytesCallback): Promise<LauncherInstance> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === payload.instanceId);
    if (!instance) throw new Error(tr("Instance not found", "Инстанция не найдена"));

    if (payload.projectType === "mod" && instance.loader === "vanilla") {
      throw new Error(tr("Choose Fabric, Forge, Quilt, or NeoForge before installing mods.", "Перед установкой модов выберите Fabric, Forge, Quilt или NeoForge."));
    }
    if ((payload.projectType === "shader" || payload.projectType === "modpack") && instance.loader === "vanilla") {
      throw new Error(tr("Shaders and modpacks need Fabric, Forge, Quilt, or NeoForge. Vanilla supports resource and data packs.", "Для шейдеров и модпаков нужен Fabric, Forge, Quilt или NeoForge. Ванильная версия поддерживает только ресурспаки и датапаки."));
    }

    const destinations = await targetDirectories(instance, payload.projectType);
    const launcherDir = path.join(instance.directory, ".launcher");
    for (const destination of destinations) {
      await mkdir(destination, { recursive: true });
    }
    await mkdir(launcherDir, { recursive: true });

    const wildcardVersion = payload.gameVersions?.includes("*") ?? false;
    const wildcardLoader = payload.loaders?.includes("*") ?? false;
    const overrideVersions = (payload.gameVersions ?? []).filter((v) => v && v !== "*");
    const overrideLoaders = (payload.loaders ?? []).filter((l) => l && l !== "*");

    let version: ModrinthVersion | undefined;
    if (payload.versionId) {
      version = await this.getVersionById(payload.versionId);
    } else {
      let versions = await this.getVersions(payload.projectId, instance, payload.projectType);
      if (!versions.some((item) => item.files.length) && (overrideVersions.length || overrideLoaders.length || wildcardVersion || wildcardLoader)) {
        versions = await this.getVersions(payload.projectId, instance, payload.projectType, {
          gameVersions: overrideVersions,
          loaders: overrideLoaders,
          anyVersion: wildcardVersion,
          anyLoader: wildcardLoader
        });
      }
      version = versions.find((item) => item.files.length) ?? versions[0];
    }
    const file = version ? pickVersionFile(version, payload.projectType) : undefined;
    if (!version || !file) throw new Error(tr(`No compatible Modrinth file for ${payload.name} (${instance.gameVersion})`, `На Modrinth нет подходящего файла для ${payload.name} (${instance.gameVersion})`));

    const slugLower = payload.slug?.toLowerCase();
    const previous = instance.mods.find(
      (item) =>
        ((payload.replaceModId && item.id === payload.replaceModId) ||
          item.projectId === payload.projectId ||
          Boolean(slugLower && item.slug?.toLowerCase() === slugLower)) &&
        (item.projectType ?? "mod") === payload.projectType
    );
    const previousBase = previous?.fileName?.replace(/\.disabled$/i, "");
    const keepDisabled = Boolean(previous?.fileName && /\.disabled$/i.test(previous.fileName));
    const downloadedName = sanitizeFilePart(file.filename);
    const fileName = keepDisabled ? `${downloadedName}.disabled` : downloadedName;
    const tmpDownload = path.join(getLauncherRoot(), "cache", `${downloadedName}.${randomUUID()}.download`);
    await mkdir(path.dirname(tmpDownload), { recursive: true });
    try {
      await downloadFile(file.url, tmpDownload, onBytes);
      for (const destination of destinations) {
        const tmpPath = path.join(destination, `${downloadedName}.${randomUUID()}.download`);
        const targetPath = path.join(destination, fileName);
        try {
          await copyFile(tmpDownload, tmpPath);
          await rename(tmpPath, targetPath);
        } catch (error) {
          await rm(tmpPath, { force: true }).catch(() => undefined);
          throw error;
        }
        if (previousBase && previousBase.toLowerCase() !== fileName.toLowerCase()) {
          await rm(path.join(destination, previousBase), { force: true }).catch(() => undefined);
          if (`${previousBase}.disabled`.toLowerCase() !== fileName.toLowerCase()) {
            await rm(path.join(destination, `${previousBase}.disabled`), { force: true }).catch(() => undefined);
          }
        }
        if (downloadedName.toLowerCase() !== fileName.toLowerCase()) {
          await rm(path.join(destination, downloadedName), { force: true }).catch(() => undefined);
        }
        if (`${downloadedName}.disabled`.toLowerCase() !== fileName.toLowerCase()) {
          await rm(path.join(destination, `${downloadedName}.disabled`), { force: true }).catch(() => undefined);
        }
      }
    } finally {
      await rm(tmpDownload, { force: true }).catch(() => undefined);
    }

    const updated = await this.store.update((current) => {
      const target = current.instances.find((item) => item.id === payload.instanceId);
      if (!target) throw new Error(tr("Instance not found", "Инстанция не найдена"));
      const existing = target.mods.find(
        (item) =>
          ((payload.replaceModId && item.id === payload.replaceModId) ||
            item.projectId === payload.projectId ||
            Boolean(slugLower && item.slug?.toLowerCase() === slugLower) ||
            (previous && item.id === previous.id)) &&
          (item.projectType ?? "mod") === payload.projectType
      );
      if (existing) {
        existing.provider = "modrinth";
        existing.projectId = payload.projectId;
        existing.versionId = version.id;
        existing.fileName = fileName;
        existing.name = payload.name;
        existing.slug = payload.slug ?? existing.slug;
        existing.iconUrl = payload.iconUrl ?? existing.iconUrl;
        existing.installedAt = new Date().toISOString();
        existing.status = "installed";
      } else {
        target.mods.push({ id: randomUUID(), provider: "modrinth", projectId: payload.projectId, versionId: version.id, name: payload.name, slug: payload.slug, fileName, iconUrl: payload.iconUrl, installedAt: new Date().toISOString(), status: "installed", projectType: payload.projectType });
      }
      target.updatedAt = new Date().toISOString();
      return target;
    });

    await writeContentManifest(updated.directory, updated.mods);
    return updated;
  }

  async downloadModpackFile(instanceId: string, projectId: string, name: string, onBytes?: BytesCallback, versionId?: string): Promise<string> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === instanceId);
    if (!instance) throw new Error(tr("Instance not found", "Инстанция не найдена"));
    let picked: { version: ModrinthVersion; file: { url: string; filename: string; primary?: boolean; size?: number } } | undefined;
    if (versionId) {
      const ver = await this.getVersionById(versionId);
      const file = ver?.files.find((f) => f.primary && /\.mrpack$/i.test(f.filename)) ?? ver?.files.find((f) => /\.mrpack$/i.test(f.filename));
      if (ver && file) picked = { version: ver, file };
    }
    if (!picked) {
      let versions = await this.getVersions(projectId, instance, "modpack");
      let files = versions.flatMap((v) => v.files.map((f) => ({ version: v, file: f })));
      picked = files.find((e) => e.file.primary && /\.mrpack$/i.test(e.file.filename)) ?? files.find((e) => /\.mrpack$/i.test(e.file.filename));
      if (!picked) {
        const allResponse = await fetchModrinth(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version`);
        if (allResponse.ok) {
          versions = (await allResponse.json()) as ModrinthVersion[];
          files = versions.flatMap((v) => v.files.map((f) => ({ version: v, file: f })));
          picked = files.find((e) => e.file.primary && /\.mrpack$/i.test(e.file.filename)) ?? files.find((e) => /\.mrpack$/i.test(e.file.filename));
        }
      }
    }
    if (!picked) throw new Error(tr(`No .mrpack file for ${name}`, `Нет файла .mrpack для ${name}`));
    const dir = path.join(getLauncherRoot(), "cache", "modpacks");
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, `download-${randomUUID()}.mrpack`);
    await downloadFile(picked.file.url, target, onBytes);
    return target;
  }

  async prepareInstall(payload: PrepareModInstallPayload): Promise<ModInstallPlan> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === payload.instanceId);
    if (!instance) throw new Error(tr("Instance not found", "Инстанция не найдена"));

    const response = await fetchModrinth(`https://api.modrinth.com/v2/project/${encodeURIComponent(payload.projectId)}/version`);
    if (!response.ok) {
      throw new Error(tr(`Modrinth returned ${response.status}`, `Modrinth вернул ошибку: ${response.status}`));
    }
    const rawVersions = ((await response.json()) as ModrinthVersion[])
      .filter((v) => v.files.length)
      .sort((a, b) => (b.date_published ?? "").localeCompare(a.date_published ?? ""));
    const versions = rawVersions.map((v) => toVersionInfo(v, instance, payload.projectType));
    const hasCompatibleVersion = versions.some((v) => v.compatible);

    let targetRaw: ModrinthVersion | undefined;
    if (payload.versionId) {
      targetRaw = rawVersions.find((v) => v.id === payload.versionId) ?? await this.getVersionById(payload.versionId);
    } else {
      const idx = versions.findIndex((v) => v.compatible);
      if (idx >= 0) targetRaw = rawVersions[idx];
    }

    if (!targetRaw) {
      return {
        targetVersion: null,
        hasCompatibleVersion,
        versions,
        dependencies: []
      };
    }

    const targetVersion = toVersionInfo(targetRaw, instance, payload.projectType);
    if (payload.projectType !== "mod") {
      return {
        targetVersion,
        hasCompatibleVersion,
        versions,
        dependencies: []
      };
    }

    const rawDeps = (targetRaw.dependencies ?? []).filter(
      (d): d is ModrinthDependencyRef & { dependency_type: "required" | "optional" } =>
        d.dependency_type === "required" || d.dependency_type === "optional"
    );
    if (!rawDeps.length) {
      return {
        targetVersion,
        hasCompatibleVersion,
        versions,
        dependencies: []
      };
    }

    const fetchBatch = async <T>(baseUrl: string, ids: string[]): Promise<T[]> => {
      const out: T[] = [];
      const chunks: string[][] = [];
      for (let i = 0; i < ids.length; i += 60) {
        chunks.push(ids.slice(i, i + 60));
      }
      await Promise.all(chunks.map(async (chunk) => {
        try {
          const res = await fetchModrinth(`${baseUrl}?ids=${encodeURIComponent(JSON.stringify(chunk))}`);
          if (res.ok) {
            const list = (await res.json()) as T[];
            if (Array.isArray(list)) out.push(...list);
          }
        } catch {
        }
      }));
      return out;
    };

    const missingVerIds = [...new Set(rawDeps.filter((d) => !d.project_id && d.version_id).map((d) => d.version_id as string))];
    const verToProj = new Map<string, string>();
    if (missingVerIds.length) {
      for (const v of await fetchBatch<ModrinthVersion>("https://api.modrinth.com/v2/versions", missingVerIds)) {
        if (v.id && v.project_id) verToProj.set(v.id, v.project_id);
      }
    }

    const depMap = new Map<string, { type: "required" | "optional"; pinnedVersionId?: string }>();
    for (const d of rawDeps) {
      const projId = d.project_id ?? (d.version_id ? verToProj.get(d.version_id) : undefined);
      if (!projId || projId === payload.projectId) continue;
      const prev = depMap.get(projId);
      if (!prev || (prev.type === "optional" && d.dependency_type === "required")) {
        depMap.set(projId, { type: d.dependency_type, pinnedVersionId: d.version_id ?? undefined });
      }
    }

    if (!depMap.size) {
      return {
        targetVersion,
        hasCompatibleVersion,
        versions,
        dependencies: []
      };
    }

    const effectiveGameVersion = (targetRaw.game_versions ?? []).includes(instance.gameVersion)
      ? instance.gameVersion
      : targetRaw.game_versions?.[0] ?? instance.gameVersion;
    const validLoaders: ModLoader[] = ["fabric", "forge", "quilt", "neoforge"];
    const effectiveLoader: ModLoader = (targetRaw.loaders ?? []).includes(instance.loader)
      ? instance.loader
      : ((targetRaw.loaders ?? []).find((l): l is ModLoader => validLoaders.includes(l as ModLoader)) ?? instance.loader);
    const depInstance: LauncherInstance = { ...instance, gameVersion: effectiveGameVersion, loader: effectiveLoader };

    const chosenVersionByProj = new Map<string, ModrinthVersion>();
    const expandedRequired = new Set<string>();
    let wave = [...depMap.keys()];
    for (let depth = 0; depth < 6 && wave.length > 0; depth += 1) {
      const toFetch = wave.filter((id) => !chosenVersionByProj.has(id));
      await Promise.all(toFetch.map(async (projId) => {
        try {
          const list = await this.getVersions(projId, depInstance, "mod");
          const pinnedId = depMap.get(projId)?.pinnedVersionId;
          let chosen = pinnedId ? list.find((v) => v.id === pinnedId && v.files.length) : undefined;
          if (!chosen && pinnedId) {
            const pinned = await this.getVersionById(pinnedId);
            if (pinned?.files.length) chosen = pinned;
          }
          if (!chosen) {
            chosen = list.find((v) => v.files.length) ?? list[0];
          }
          if (chosen) chosenVersionByProj.set(projId, chosen);
        } catch {
        }
      }));

      const rawSubDeps: Array<{ projectId?: string | null; versionId?: string | null }> = [];
      for (const projId of wave) {
        if (depMap.get(projId)?.type !== "required" || expandedRequired.has(projId)) continue;
        expandedRequired.add(projId);
        const chosen = chosenVersionByProj.get(projId);
        if (!chosen) continue;
        for (const sub of chosen.dependencies ?? []) {
          if (sub.dependency_type === "required") {
            rawSubDeps.push({ projectId: sub.project_id, versionId: sub.version_id });
          }
        }
      }

      const missingSubVerIds = [...new Set(rawSubDeps.filter((d) => !d.projectId && d.versionId && !verToProj.has(d.versionId)).map((d) => d.versionId as string))];
      if (missingSubVerIds.length) {
        for (const v of await fetchBatch<ModrinthVersion>("https://api.modrinth.com/v2/versions", missingSubVerIds)) {
          if (v.id && v.project_id) verToProj.set(v.id, v.project_id);
        }
      }

      const nextWave = new Set<string>();
      for (const sub of rawSubDeps) {
        const subProjId = sub.projectId ?? (sub.versionId ? verToProj.get(sub.versionId) : undefined);
        if (!subProjId || subProjId === payload.projectId) continue;
        const existing = depMap.get(subProjId);
        if (!existing) {
          depMap.set(subProjId, { type: "required", pinnedVersionId: sub.versionId ?? undefined });
          nextWave.add(subProjId);
        } else if (existing.type === "optional") {
          existing.type = "required";
          if (!existing.pinnedVersionId && sub.versionId) existing.pinnedVersionId = sub.versionId;
          if (!expandedRequired.has(subProjId)) nextWave.add(subProjId);
        }
      }
      wave = [...nextWave];
    }

    const allProjIds = [...depMap.keys()];
    const projMeta = new Map<string, { title?: string; slug?: string; description?: string; icon_url?: string }>();
    for (const p of await fetchBatch<{ id: string; title?: string; slug?: string; description?: string; icon_url?: string }>("https://api.modrinth.com/v2/projects", allProjIds)) {
      projMeta.set(p.id, p);
    }

    const modsDir = path.join(instance.directory, contentFolder("mod"));
    const dependencies: ModDependencyItem[] = allProjIds.map((projId) => {
      const meta = projMeta.get(projId);
      const info = depMap.get(projId)!;
      const chosen = chosenVersionByProj.get(projId);
      const slug = meta?.slug;
      const installed = instance.mods.some((m) => {
        if ((m.projectType ?? "mod") !== "mod") return false;
        if (m.projectId !== projId && !(slug && m.slug && m.slug.toLowerCase() === slug.toLowerCase())) return false;
        if (!m.fileName) return true;
        const baseName = m.fileName.replace(/\.disabled$/i, "");
        return existsSync(path.join(modsDir, m.fileName)) || existsSync(path.join(modsDir, baseName)) || existsSync(path.join(modsDir, `${baseName}.disabled`));
      });
      return {
        projectId: projId,
        provider: "modrinth",
        versionId: chosen?.id ?? info.pinnedVersionId,
        versionNumber: chosen?.version_number ?? chosen?.name,
        title: meta?.title ?? slug ?? projId,
        slug,
        summary: meta?.description ?? "",
        iconUrl: meta?.icon_url,
        dependencyType: info.type,
        installed,
        compatible: Boolean(chosen)
      };
    });

    dependencies.sort((a, b) => {
      if (a.dependencyType !== b.dependencyType) return a.dependencyType === "required" ? -1 : 1;
      if (a.installed !== b.installed) return a.installed ? 1 : -1;
      return a.title.localeCompare(b.title);
    });

    return {
      targetVersion,
      hasCompatibleVersion,
      versions,
      dependencies
    };
  }

  async getProjectDetails(projectId: string, projectType: ModrinthProjectType): Promise<ModProjectDetails> {
    const response = await fetchModrinth(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}`);
    if (!response.ok) {
      throw new Error(tr(`Modrinth returned ${response.status}`, `Modrinth вернул ошибку: ${response.status}`));
    }
    const proj = (await response.json()) as {
      id: string;
      slug?: string;
      title?: string;
      description?: string;
      body?: string;
      icon_url?: string;
      downloads?: number;
      followers?: number;
      published?: string;
      updated?: string;
      license?: { id?: string; name?: string } | null;
      categories?: string[];
      game_versions?: string[];
      loaders?: string[];
      gallery?: Array<{ url?: string; raw_url?: string; title?: string; description?: string }>;
      source_url?: string | null;
      issues_url?: string | null;
      wiki_url?: string | null;
      discord_url?: string | null;
    };
    const slug = proj.slug ?? proj.id;
    const typePath = projectType === "resourcepack" ? "resourcepack" : projectType === "shader" ? "shader" : projectType === "datapack" ? "datapack" : projectType === "modpack" ? "modpack" : "mod";
    return {
      id: proj.id,
      provider: "modrinth",
      projectType,
      title: proj.title ?? slug,
      slug: proj.slug,
      summary: proj.description ?? "",
      body: proj.body ?? proj.description ?? "",
      bodyFormat: "markdown",
      iconUrl: proj.icon_url ?? undefined,
      downloads: proj.downloads,
      follows: proj.followers,
      datePublished: proj.published,
      dateModified: proj.updated,
      license: proj.license?.name || proj.license?.id || undefined,
      categories: proj.categories ?? [],
      gameVersions: proj.game_versions ?? [],
      loaders: proj.loaders ?? [],
      gallery: (proj.gallery ?? [])
        .map((g) => ({ url: g.url || g.raw_url || "", title: g.title || undefined, description: g.description || undefined }))
        .filter((g) => Boolean(g.url)),
      websiteUrl: `https://modrinth.com/${typePath}/${slug}`,
      sourceUrl: proj.source_url ?? undefined,
      issuesUrl: proj.issues_url ?? undefined,
      wikiUrl: proj.wiki_url ?? undefined,
      discordUrl: proj.discord_url ?? undefined
    };
  }

  async listVersions(instanceId: string, projectId: string, projectType: ModrinthProjectType): Promise<ModVersionInfo[]> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === instanceId);
    if (!instance) throw new Error(tr("Instance not found", "Инстанция не найдена"));
    const response = await fetchModrinth(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version`);
    if (!response.ok) {
      throw new Error(tr(`Modrinth returned ${response.status}`, `Modrinth вернул ошибку: ${response.status}`));
    }
    const versions = (await response.json()) as ModrinthVersion[];
    return versions
      .filter((version) => version.files.length)
      .map((version) => toVersionInfo(version, instance, projectType))
      .sort((a, b) => b.datePublished.localeCompare(a.datePublished));
  }

  async checkUpdates(instanceId: string): Promise<ContentUpdateInfo[]> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === instanceId);
    if (!instance) throw new Error(tr("Instance not found", "Инстанция не найдена"));

    const tracked: Array<{
      provider: ModProvider;
      projectId: string;
      versionId?: string;
      projectType: ModrinthProjectType;
      fileName: string;
      foundPath: string;
      sha1: string;
      installedAt: string;
    }> = [];

    for (const mod of instance.mods) {
      const projectType = (mod.projectType ?? "mod") as ModrinthProjectType;
      if (!mod.fileName || projectType === "modpack") continue;
      const dirs = projectType === "datapack"
        ? [path.join(instance.directory, "datapacks"), ...(await targetDirectories(instance, "datapack"))]
        : [path.join(instance.directory, contentFolder(projectType))];
      const baseName = mod.fileName.replace(/\.disabled$/i, "");
      const candidates = [baseName, mod.fileName, `${baseName}.disabled`];
      let found: string | undefined;
      for (const name of candidates) {
        const hit = dirs.map((dir) => path.join(dir, name)).find((candidate) => existsSync(candidate));
        if (hit) {
          found = hit;
          break;
        }
      }
      if (!found) continue;
      const sha1 = await sha1Cached(found).catch(() => "");
      if (sha1) {
        tracked.push({
          provider: mod.provider,
          projectId: mod.projectId,
          versionId: mod.versionId,
          projectType,
          fileName: mod.fileName,
          foundPath: found,
          sha1,
          installedAt: mod.installedAt
        });
      }
    }
    if (!tracked.length) return [];

    const signature = `${instance.gameVersion}|${instance.loader}|${tracked.map((item) => `${item.provider}:${item.projectType}:${item.fileName}:${item.sha1}`).sort().join(",")}`;
    const cachedResult = this.updateCache.get(instanceId);
    if (cachedResult && cachedResult.signature === signature && Date.now() - cachedResult.at < 5 * 60 * 1000) {
      return cachedResult.result;
    }

    const mrTracked = tracked.filter((item) => item.provider === "modrinth");
    const hashes = [...new Set(mrTracked.map((item) => item.sha1))];
    let anyApiFailure = false;
    let current: Record<string, ModrinthVersion> = {};
    if (hashes.length) {
      const currentRes = await this.postVersionFiles("https://api.modrinth.com/v2/version_files", { hashes, algorithm: "sha1" });
      current = currentRes.data;
      if (!currentRes.ok) anyApiFailure = true;
    }
    const latestByHash: Record<string, ModrinthVersion> = {};
    const types = [...new Set(mrTracked.map((item) => item.projectType))];
    for (const projectType of types) {
      if (projectType === "mod" && instance.loader === "vanilla") continue;
      const group = [...new Set(mrTracked.filter((item) => item.projectType === projectType).map((item) => item.sha1))];
      const loaders = loadersFor(projectType, instance);
      const res = await this.postVersionFiles("https://api.modrinth.com/v2/version_files/update", {
        hashes: group,
        algorithm: "sha1",
        loaders,
        game_versions: [instance.gameVersion]
      });
      if (!res.ok) anyApiFailure = true;
      Object.assign(latestByHash, res.data);
    }

    const byKey = new Map<string, ContentUpdateInfo>();
    const cfProbeItems: CfTrackedItem[] = [];

    for (const item of tracked) {
      const key = `${item.projectType}:${item.fileName}`;
      if (item.provider === "modrinth") {
        const now = current[item.sha1];
        const canUpdate = !(item.projectType === "mod" && instance.loader === "vanilla");
        const latest = canUpdate ? latestByHash[item.sha1] : undefined;
        const nowCompatible = now ? toVersionInfo(now, instance, item.projectType).compatible : true;
        const sameQuiltSibling = Boolean(
          now &&
          latest &&
          nowCompatible &&
          instance.loader === "quilt" &&
          item.projectType === "mod" &&
          (now.loaders ?? []).includes("quilt") &&
          !(latest.loaders ?? []).includes("quilt") &&
          (now.version_number ?? "").trim().replace(/^v/i, "").toLowerCase() === (latest.version_number ?? "").trim().replace(/^v/i, "").toLowerCase()
        );
        const newer = canUpdate && !sameQuiltSibling && latest && now && latest.id !== now.id && (!nowCompatible || (latest.date_published ?? "") > (now.date_published ?? ""));
        const info: ContentUpdateInfo = {
          projectId: item.projectId,
          projectType: item.projectType,
          fileName: item.fileName,
          currentVersionId: now?.id,
          currentVersionNumber: now?.version_number,
          latest: newer ? toVersionInfo(latest, instance, item.projectType) : null,
          incompatible: now && item.projectType === "mod" ? incompatibility(now, instance) : undefined
        };
        byKey.set(key, info);
        if (!info.latest && canUpdate) {
          cfProbeItems.push({
            provider: "modrinth",
            projectType: item.projectType,
            fileName: item.fileName,
            foundPath: item.foundPath,
            sha1: item.sha1,
            currentVersionNumber: now?.version_number,
            installedDate: now?.date_published ?? item.installedAt
          });
        }
      } else {
        cfProbeItems.push({
          provider: "curseforge",
          projectId: item.projectId,
          versionId: item.versionId,
          projectType: item.projectType,
          fileName: item.fileName,
          foundPath: item.foundPath,
          sha1: item.sha1,
          installedDate: item.installedAt
        });
      }
    }

    if (this.curseforge && cfProbeItems.length) {
      const cfUpdates = await this.curseforge.checkUpdatesForItems(instance, cfProbeItems, () => {
        anyApiFailure = true;
      });
      for (const [key, cfInfo] of cfUpdates) {
        const existing = byKey.get(key);
        if (!existing) {
          byKey.set(key, cfInfo);
        } else if (!existing.latest && cfInfo.latest) {
          existing.latest = cfInfo.latest;
        }
      }
    }

    const result = [...byKey.values()];
    if (result.length && !anyApiFailure) {
      this.updateCache.set(instanceId, { at: Date.now(), signature, result });
    }
    return result;
  }

  private async postVersionFiles(url: string, body: Record<string, unknown>): Promise<{ data: Record<string, ModrinthVersion>; ok: boolean }> {
    try {
      const response = await fetchModrinth(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }, 20000);
      if (!response.ok) return { data: {}, ok: false };
      return { data: (await response.json()) as Record<string, ModrinthVersion>, ok: true };
    } catch {
      return { data: {}, ok: false };
    }
  }

  private async getVersionById(versionId: string): Promise<ModrinthVersion | undefined> {
    const response = await fetchModrinth(`https://api.modrinth.com/v2/version/${encodeURIComponent(versionId)}`);
    if (!response.ok) return undefined;
    return (await response.json()) as ModrinthVersion;
  }

  private async getVersions(projectId: string, instance: LauncherInstance, projectType: ModrinthProjectType, override?: { gameVersions?: string[]; loaders?: string[]; anyVersion?: boolean; anyLoader?: boolean }): Promise<ModrinthVersion[]> {
    const url = new URL(`https://api.modrinth.com/v2/project/${projectId}/version`);
    const gameVersions = override?.gameVersions?.length ? override.gameVersions : override?.anyVersion ? [] : [instance.gameVersion];
    if (gameVersions.length) url.searchParams.set("game_versions", JSON.stringify(gameVersions));
    const loaders = (projectType === "mod" || projectType === "modpack")
      ? (override?.loaders?.length ? override.loaders : override?.anyLoader ? [] : loadersFor(projectType, instance))
      : projectType === "datapack"
        ? ["datapack"]
        : projectType === "resourcepack"
          ? ["minecraft"]
          : [];
    if (loaders.length) url.searchParams.set("loaders", JSON.stringify(loaders));
    const response = await fetchModrinth(url);
    if (!response.ok) return [];
    return (await response.json()) as ModrinthVersion[];
  }
}
