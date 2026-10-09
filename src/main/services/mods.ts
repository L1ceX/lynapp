import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InstallModPayload, ModSearchPayload } from "@shared/ipc";
import type { LauncherInstance, ModrinthProjectType, ModSearchResponse } from "@shared/types";
import { JsonStore } from "../store";

interface ModrinthVersion {
  id: string;
  files: Array<{ url: string; filename: string; primary?: boolean }>;
  loaders?: string[];
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

async function downloadFile(url: string, target: string): Promise<void> {
  const response = await fetch(url, { headers: { "User-Agent": "lynapp/1.0.3" } });
  if (!response.ok) throw new Error(`Modrinth download failed with HTTP ${response.status}`);
  await writeFile(target, Buffer.from(await response.arrayBuffer()));
}

export class ModService {
  private categoryCache: ModrinthCategoryTag[] | null = null;

  constructor(private readonly store: JsonStore) {}

  async getCategoryTags(projectType: ModrinthProjectType): Promise<string[]> {
    if (!this.categoryCache) {
      const response = await fetch("https://api.modrinth.com/v2/tag/category", {
        headers: { "User-Agent": "lynapp/1.0.3" }
      });

      if (!response.ok) {
        throw new Error(`Modrinth categories returned ${response.status}`);
      }

      this.categoryCache = (await response.json()) as ModrinthCategoryTag[];
    }

    return this.categoryCache.filter((tag) => tag.project_type === projectType).map((tag) => tag.name);
  }

  async search(payload: ModSearchPayload): Promise<ModSearchResponse> {
    const query = payload.query.trim();

    const data = await this.store.getData();
    const instance = payload.instanceId ? data.instances.find((item) => item.id === payload.instanceId) : undefined;
    if (payload.instanceId && !instance) throw new Error("Instance not found");

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

      if (payload.projectType === "mod") {
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

      const response = await fetch(url, { headers: { "User-Agent": "lynapp/1.0.3" } });
      if (!response.ok) throw new Error(`Modrinth returned ${response.status}`);
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
          title: "Modrinth search unavailable",
          summary: error instanceof Error ? error.message : "Unknown search error",
          categories: ["error"]
        }],
        totalHits: 0
      };
    }
  }

  async install(payload: InstallModPayload): Promise<LauncherInstance> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === payload.instanceId);
    if (!instance) throw new Error("Instance not found");

    if (payload.projectType === "mod" && instance.loader === "vanilla") {
      throw new Error("Choose Fabric, Forge, Quilt, or NeoForge before installing mods.");
    }
    if ((payload.projectType === "shader" || payload.projectType === "modpack") && instance.loader === "vanilla") {
      throw new Error("Shaders and modpacks need Fabric, Forge, Quilt, or NeoForge. Vanilla supports resource and data packs.");
    }

    const destination = targetDirectory(instance, payload.projectType);
    const launcherDir = path.join(instance.directory, ".launcher");
    await mkdir(destination, { recursive: true });
    await mkdir(launcherDir, { recursive: true });

    const versions = await this.getVersions(payload.projectId, instance, payload.projectType);
    const version = versions.find((item) => item.files.length) ?? versions[0];
    const file = version?.files.find((item) => item.primary) ?? version?.files[0];
    if (!file) throw new Error(`No compatible Modrinth file for ${payload.name} (${instance.gameVersion})`);

    const installedFile = path.join(destination, sanitizeFilePart(file.filename));
    await downloadFile(file.url, installedFile);

    const updated = await this.store.update((current) => {
      const target = current.instances.find((item) => item.id === payload.instanceId);
      if (!target) throw new Error("Instance not found");
      const existing = target.mods.find((item) => item.provider === "modrinth" && item.projectId === payload.projectId && (item.projectType ?? "mod") === payload.projectType);
      if (!existing) {
        target.mods.push({ id: randomUUID(), provider: "modrinth", projectId: payload.projectId, versionId: version.id, name: payload.name, slug: payload.slug, fileName: path.basename(installedFile), iconUrl: payload.iconUrl, installedAt: new Date().toISOString(), status: "installed", projectType: payload.projectType });
      }
      target.updatedAt = new Date().toISOString();
      return target;
    });

    await writeFile(path.join(launcherDir, "content.json"), JSON.stringify(updated.mods, null, 2), "utf8");
    return updated;
  }

  private async getVersions(projectId: string, instance: LauncherInstance, projectType: ModrinthProjectType): Promise<ModrinthVersion[]> {
    const url = new URL(`https://api.modrinth.com/v2/project/${projectId}/version`);
    url.searchParams.set("game_versions", JSON.stringify([instance.gameVersion]));
    if (projectType === "mod" && instance.loader !== "vanilla") url.searchParams.set("loaders", JSON.stringify([instance.loader]));
    const response = await fetch(url, { headers: { "User-Agent": "lynapp/1.0.3" } });
    if (!response.ok) return [];
    return (await response.json()) as ModrinthVersion[];
  }
}
