import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InstallModPayload, ModSearchPayload } from "@shared/ipc";
import type { ContentUpdateInfo, LauncherInstance, ModrinthProjectType, ModSearchResponse, ModVersionInfo } from "@shared/types";
import { JsonStore } from "../store";
import { getLauncherRoot } from "../paths";
import { readUrlBytes, type BytesCallback } from "./transfer";
import { sha1Cached } from "./hashes";
import { tr } from "../i18n";

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
}

const modrinthHeaders = { "User-Agent": "lynapp/1.1.0-beta.2" };

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

function toVersionInfo(version: ModrinthVersion, instance: LauncherInstance, projectType: ModrinthProjectType): ModVersionInfo {
  const file = version.files.find((item) => item.primary) ?? version.files[0];
  const loaders = loadersFor(projectType, instance);
  const gameVersions = version.game_versions ?? [];
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
    compatible: gameVersions.includes(instance.gameVersion) && (!loaders.length || (version.loaders ?? []).some((loader) => loaders.includes(loader)))
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

function sanitizeFilePart(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").replace(/\s+/g, "-").trim().slice(0, 100) || "download";
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

async function targetDirectories(instance: LauncherInstance, projectType: ModrinthProjectType): Promise<string[]> {
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
  const { buffer } = await readUrlBytes(url, { "User-Agent": "lynapp/1.1.0-beta.2" }, undefined, (received, total) => onBytes?.(received, total), 15 * 60 * 1000);
  await writeFile(target, buffer);
}

export class ModService {
  private categoryCache: ModrinthCategoryTag[] | null = null;
  private readonly updateCache = new Map<string, { at: number; signature: string; result: ContentUpdateInfo[] }>();

  constructor(private readonly store: JsonStore) {}

  async getCategoryTags(projectType: ModrinthProjectType): Promise<string[]> {
    if (!this.categoryCache) {
      const response = await fetch("https://api.modrinth.com/v2/tag/category", {
        headers: { "User-Agent": "lynapp/1.1.0-beta.2" }
      });

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
      const versions = payload.versions?.length ? payload.versions : instance ? [instance.gameVersion] : [];
      if (versions.length) {
        facets.push(versions.map((version) => `versions:${version}`));
      }

      if (payload.projectType === "mod" || payload.projectType === "modpack") {
        const loaders = payload.loaders?.length
          ? payload.loaders
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

      const response = await fetch(url, { headers: { "User-Agent": "lynapp/1.1.0-beta.2" } });
      if (!response.ok) throw new Error(tr(`Modrinth returned ${response.status}`, `Modrinth вернул ошибку: ${response.status}`));
      const body = (await response.json()) as { hits: ModrinthHit[]; total_hits?: number };
      return {
        results: body.hits.map((hit) => ({
          id: hit.project_id,
          provider: "modrinth",
          projectType: hit.project_type ?? payload.projectType,
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

    let version: ModrinthVersion | undefined;
    if (payload.versionId) {
      version = await this.getVersionById(payload.versionId);
    } else {
      let versions = await this.getVersions(payload.projectId, instance, payload.projectType);
      if (!versions.some((item) => item.files.length) && (payload.gameVersions?.length || payload.loaders?.length)) {
        versions = await this.getVersions(payload.projectId, instance, payload.projectType, { gameVersions: payload.gameVersions, loaders: payload.loaders });
      }
      version = versions.find((item) => item.files.length) ?? versions[0];
    }
    const file = version?.files.find((item) => item.primary) ?? version?.files[0];
    if (!version || !file) throw new Error(tr(`No compatible Modrinth file for ${payload.name} (${instance.gameVersion})`, `На Modrinth нет подходящего файла для ${payload.name} (${instance.gameVersion})`));

    const previous = instance.mods.find((item) => item.provider === "modrinth" && item.projectId === payload.projectId && (item.projectType ?? "mod") === payload.projectType);
    const previousBase = previous?.fileName?.replace(/\.disabled$/i, "");
    const keepDisabled = Boolean(previous?.fileName && /\.disabled$/i.test(previous.fileName));
    const downloadedName = sanitizeFilePart(file.filename);
    const fileName = keepDisabled ? `${downloadedName}.disabled` : downloadedName;
    for (const destination of destinations) {
      const tmpPath = path.join(destination, `${downloadedName}.download`);
      await downloadFile(file.url, tmpPath, onBytes);
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
      const existing = target.mods.find((item) => item.provider === "modrinth" && item.projectId === payload.projectId && (item.projectType ?? "mod") === payload.projectType);
      if (existing) {
        existing.versionId = version.id;
        existing.fileName = fileName;
        existing.name = payload.name;
        existing.slug = payload.slug;
        existing.iconUrl = payload.iconUrl;
        existing.installedAt = new Date().toISOString();
        existing.status = "installed";
      } else {
        target.mods.push({ id: randomUUID(), provider: "modrinth", projectId: payload.projectId, versionId: version.id, name: payload.name, slug: payload.slug, fileName, iconUrl: payload.iconUrl, installedAt: new Date().toISOString(), status: "installed", projectType: payload.projectType });
      }
      target.updatedAt = new Date().toISOString();
      return target;
    });

    await writeFile(path.join(launcherDir, "content.json"), JSON.stringify(updated.mods, null, 2), "utf8");
    return updated;
  }

  async downloadModpackFile(instanceId: string, projectId: string, name: string, onBytes?: BytesCallback): Promise<string> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === instanceId);
    if (!instance) throw new Error(tr("Instance not found", "Инстанция не найдена"));
    const versions = await this.getVersions(projectId, instance, "modpack");
    const files = versions.flatMap((v) => v.files.map((f) => ({ version: v, file: f })));
    const picked = files.find((e) => e.file.primary && /\.mrpack$/i.test(e.file.filename)) ?? files.find((e) => /\.mrpack$/i.test(e.file.filename));
    if (!picked) throw new Error(tr(`No .mrpack file for ${name} (${instance.gameVersion})`, `Нет файла .mrpack для ${name} (${instance.gameVersion})`));
    const dir = path.join(getLauncherRoot(), "cache", "modpacks");
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, `download-${randomUUID()}.mrpack`);
    await downloadFile(picked.file.url, target, onBytes);
    return target;
  }

  async listVersions(instanceId: string, projectId: string, projectType: ModrinthProjectType): Promise<ModVersionInfo[]> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === instanceId);
    if (!instance) throw new Error(tr("Instance not found", "Инстанция не найдена"));
    const response = await fetch(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version`, { headers: modrinthHeaders });
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

    const tracked: Array<{ projectId: string; projectType: ModrinthProjectType; fileName: string; sha1: string }> = [];
    for (const mod of instance.mods) {
      const projectType = (mod.projectType ?? "mod") as ModrinthProjectType;
      if (mod.provider !== "modrinth" || !mod.fileName || projectType === "modpack") continue;
      const dirs = projectType === "datapack"
        ? [path.join(instance.directory, "datapacks"), ...(await targetDirectories(instance, "datapack"))]
        : [path.join(instance.directory, contentFolder(projectType))];
      const found = dirs.map((dir) => path.join(dir, mod.fileName as string)).find((candidate) => existsSync(candidate));
      if (!found) continue;
      const sha1 = await sha1Cached(found).catch(() => "");
      if (sha1) tracked.push({ projectId: mod.projectId, projectType, fileName: mod.fileName, sha1 });
    }
    if (!tracked.length) return [];

    const hashes = [...new Set(tracked.map((item) => item.sha1))];
    const signature = `${instance.gameVersion}|${instance.loader}|${tracked.map((item) => `${item.projectType}:${item.fileName}:${item.sha1}`).sort().join(",")}`;
    const cachedResult = this.updateCache.get(instanceId);
    if (cachedResult && cachedResult.signature === signature && Date.now() - cachedResult.at < 10 * 60 * 1000) {
      return cachedResult.result;
    }
    const current = await this.postVersionFiles("https://api.modrinth.com/v2/version_files", { hashes, algorithm: "sha1" });
    const latestByHash: Record<string, ModrinthVersion> = {};
    const types = [...new Set(tracked.map((item) => item.projectType))];
    for (const projectType of types) {
      const group = [...new Set(tracked.filter((item) => item.projectType === projectType).map((item) => item.sha1))];
      const loaders = loadersFor(projectType, instance);
      const result = await this.postVersionFiles("https://api.modrinth.com/v2/version_files/update", {
        hashes: group,
        algorithm: "sha1",
        loaders,
        game_versions: [instance.gameVersion]
      });
      Object.assign(latestByHash, result);
    }

    const result = tracked.map((item) => {
      const now = current[item.sha1];
      const latest = latestByHash[item.sha1];
      const newer = latest && now && latest.id !== now.id && (latest.date_published ?? "") > (now.date_published ?? "");
      return {
        projectId: item.projectId,
        projectType: item.projectType,
        fileName: item.fileName,
        currentVersionId: now?.id,
        currentVersionNumber: now?.version_number,
        latest: newer ? toVersionInfo(latest, instance, item.projectType) : null
      };
    });
    if (Object.keys(current).length) {
      this.updateCache.set(instanceId, { at: Date.now(), signature, result });
    }
    return result;
  }

  private async postVersionFiles(url: string, body: Record<string, unknown>): Promise<Record<string, ModrinthVersion>> {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { ...modrinthHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000)
      });
      if (!response.ok) return {};
      return (await response.json()) as Record<string, ModrinthVersion>;
    } catch {
      return {};
    }
  }

  private async getVersionById(versionId: string): Promise<ModrinthVersion | undefined> {
    const response = await fetch(`https://api.modrinth.com/v2/version/${encodeURIComponent(versionId)}`, { headers: modrinthHeaders });
    if (!response.ok) return undefined;
    return (await response.json()) as ModrinthVersion;
  }

  private async getVersions(projectId: string, instance: LauncherInstance, projectType: ModrinthProjectType, override?: { gameVersions?: string[]; loaders?: string[] }): Promise<ModrinthVersion[]> {
    const url = new URL(`https://api.modrinth.com/v2/project/${projectId}/version`);
    url.searchParams.set("game_versions", JSON.stringify(override?.gameVersions?.length ? override.gameVersions : [instance.gameVersion]));
    const loaders = (projectType === "mod" || projectType === "modpack")
      ? (override?.loaders?.length ? override.loaders : instance.loader !== "vanilla" ? [instance.loader] : [])
      : projectType === "datapack"
        ? ["datapack"]
        : projectType === "resourcepack"
          ? ["minecraft"]
          : [];
    if (loaders.length) url.searchParams.set("loaders", JSON.stringify(loaders));
    const response = await fetch(url, { headers: { "User-Agent": "lynapp/1.1.0-beta.2" } });
    if (!response.ok) return [];
    return (await response.json()) as ModrinthVersion[];
  }
}
