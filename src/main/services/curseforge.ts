import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InstallModPayload, ModSearchPayload, PrepareModInstallPayload } from "@shared/ipc";
import type { ContentIncompatibility, ContentUpdateInfo, LauncherInstance, ModDependencyItem, ModInstallPlan, ModLoader, ModProjectDetails, ModrinthProjectType, ModSearchResponse, ModSearchResult, ModSortIndex, ModVersionInfo } from "@shared/types";
import { writeContentManifest } from "./manifest";
import { JsonStore } from "../store";
import { getLauncherRoot } from "../paths";
import { readUrlBytes, type BytesCallback } from "./transfer";
import { cfFingerprintCached } from "./hashes";
import { sanitizeFilePart, targetDirectories } from "./mods";
import { tr } from "../i18n";

const API = "https://api.curseforge.com/v1";
const MINECRAFT_GAME_ID = 432;
const BUILTIN_API_KEY = String(import.meta.env.MAIN_VITE_CURSEFORGE_API_KEY ?? "").trim();

export const curseForgeAvailable = BUILTIN_API_KEY.length > 0;
const USER_AGENT = "lynapp/1.1.0-beta.8";

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

const LOADER_BY_TYPE: Record<number, ModLoader> = {
  1: "forge",
  4: "fabric",
  5: "quilt",
  6: "neoforge"
};

const NON_VERSION_TAGS = new Set([
  "client",
  "server",
  "forge",
  "fabric",
  "quilt",
  "neoforge",
  "rift",
  "liteloader",
  "cauldron",
  "bukkit",
  "spigot",
  "paper"
]);

export interface CfMod {
  id: number;
  name: string;
  slug?: string;
  summary?: string;
  downloadCount?: number;
  favoriteCount?: number;
  thumbsUpCount?: number;
  dateModified?: string;
  dateReleased?: string;
  classId?: number;
  allowModDistribution?: boolean | null;
  logo?: { thumbnailUrl?: string; url?: string } | null;
  authors?: Array<{ name?: string }>;
  categories?: Array<{ id: number; name: string }>;
  links?: { websiteUrl?: string; wikiUrl?: string; issuesUrl?: string; sourceUrl?: string };
  screenshots?: Array<{ id?: number; title?: string; description?: string; url?: string; thumbnailUrl?: string }>;
  latestFiles?: CfFile[];
  latestFilesIndexes?: Array<{ gameVersion?: string; fileId?: number; filename?: string; releaseType?: number; modLoader?: number }>;
}

export interface CfFile {
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
  dependencies?: Array<{ modId: number; relationType: number }>;
  modules?: Array<{ name: string; fingerprint?: number }>;
  fileFingerprint?: number;
  isServerPack?: boolean;
}

export interface CfFingerprintMatch {
  id: number;
  file: CfFile;
  latestFiles?: CfFile[];
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

export interface CfTrackedItem {
  provider?: "modrinth" | "curseforge";
  projectId?: string;
  versionId?: string;
  projectType: ModrinthProjectType;
  fileName: string;
  foundPath: string;
  sha1?: string;
  currentVersionNumber?: string;
  installedDate?: string;
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

export function projectTypeForClass(classId: number | undefined, fallback: ModrinthProjectType): ModrinthProjectType {
  const entry = Object.entries(CLASS_IDS).find(([, id]) => id === classId);
  return entry ? (entry[0] as ModrinthProjectType) : fallback;
}

function sha1Of(file: CfFile): string | undefined {
  return file.hashes?.find((hash) => hash.algo === 1)?.value?.toLowerCase();
}

function isPreNeoForgeVersion(ver: string): boolean {
  if (/^(?:b1\.|a1\.|inf|c0\.|rd-)/i.test(ver)) return true;
  const match = /^1\.(\d+)(?:\.(\d+))?$/.exec(ver.trim());
  if (!match) return false;
  const minor = Number(match[1]);
  const patch = Number(match[2] ?? "0");
  if (minor < 20) return true;
  if (minor === 20 && patch <= 1) return true;
  return false;
}

function extractVersionsFromText(text: string): string[] {
  const found = new Set<string>();
  const regex = /(?:^|[^0-9.])(1\.(?:7\.10|8\.9|9\.4|10\.2|11\.2|12(?:\.[12])?|13\.2|14(?:\.[2-4])?|15\.2|16(?:\.[1-5])?|17\.1|18(?:\.[12])?|19(?:\.[1-4])?|20(?:\.[1-6])?|21(?:\.\d{1,2})?)|2[6-9]\.\d{1,2}(?:\.\d{1,2})?)(?![0-9.])/g;
  for (const match of text.matchAll(regex)) {
    if (match[1]) found.add(match[1]);
  }
  return [...found];
}

export function inferFileGameVersions(file: CfFile, fallbackVersions: string[] = []): string[] {
  const direct = (file.gameVersions ?? [])
    .map((v) => v.trim())
    .filter((v) => v.length > 0 && !NON_VERSION_TAGS.has(v.toLowerCase()) && !/^java\s/i.test(v));
  if (direct.length) return direct;
  const fromText = extractVersionsFromText(`${file.fileName} ${file.displayName ?? ""}`);
  if (fromText.length) return fromText;
  return fallbackVersions;
}

export function inferFileLoaders(file: CfFile, fallbackLoaders: ModLoader[] = []): ModLoader[] {
  const modules = new Set((file.modules ?? []).map((m) => m.name.toLowerCase()));
  const hasQuiltJson = modules.has("quilt.mod.json") || modules.has("quilt.json");
  const hasFabricJson = modules.has("fabric.mod.json");
  const hasMcmodInfo = modules.has("mcmod.info");
  const hasMetaInf = modules.has("meta-inf");

  const text = `${file.fileName} ${file.displayName ?? ""}`.toLowerCase();
  const nameHasNeoForge = /\bneoforg(?:e|ed)\b|[-_+.]neoforg(?:e|ed)(?:[-_+.]|$)/.test(text);
  const stripped = text.replace(/neoforg(?:e|ed)/g, "");
  const nameHasForge = /(?:^|[^a-z])forge(?:[^a-z]|$)/.test(stripped);
  const nameHasFabric = /(?:^|[^a-z])fabric(?:[^a-z]|$)/.test(text);
  const nameHasQuilt = /(?:^|[^a-z])quilt(?:[^a-z]|$)/.test(text);

  const gvSet = new Set((file.gameVersions ?? []).map((v) => v.toLowerCase()));
  const gvForge = gvSet.has("forge");
  const gvNeoForge = gvSet.has("neoforge");
  const gvFabric = gvSet.has("fabric");
  const gvQuilt = gvSet.has("quilt");
  const allFourTagged = gvForge && gvNeoForge && gvFabric && gvQuilt;

  const depIds = new Set((file.dependencies ?? []).map((d) => d.modId));
  const depFabric = depIds.has(306612) || depIds.has(308769);
  const depQuilt = depIds.has(634179) || depIds.has(720410);

  if (modules.size > 0) {
    if (hasQuiltJson || hasFabricJson) {
      const explicitNonFabric = (nameHasNeoForge || nameHasForge) && !nameHasFabric && !nameHasQuilt && !depFabric && !depQuilt;
      const taggedNonFabric = !allFourTagged && (gvNeoForge || gvForge) && !gvFabric && !gvQuilt && !depFabric && !depQuilt;
      if (!explicitNonFabric && !taggedNonFabric) {
        const out = new Set<ModLoader>();
        if (hasQuiltJson || (gvQuilt && !allFourTagged) || nameHasQuilt || depQuilt) out.add("quilt");
        if (hasFabricJson || (gvFabric && !allFourTagged) || nameHasFabric || depFabric) out.add("fabric");
        if (hasMcmodInfo || nameHasForge || (gvForge && !allFourTagged && !nameHasFabric && !nameHasQuilt)) out.add("forge");
        if (nameHasNeoForge || (gvNeoForge && !allFourTagged && !nameHasFabric && !nameHasQuilt)) out.add("neoforge");
        return [...out];
      }
    }
    if (hasMetaInf || hasMcmodInfo) {
      if (hasMcmodInfo) return ["forge"];
      if (nameHasNeoForge && !nameHasForge) return ["neoforge"];
      if (nameHasForge && !nameHasNeoForge) return ["forge"];
      const versions = inferFileGameVersions(file);
      if (versions.length > 0 && versions.every(isPreNeoForgeVersion)) return ["forge"];
      if (!allFourTagged) {
        const tagged: ModLoader[] = [];
        if (gvForge) tagged.push("forge");
        if (gvNeoForge) tagged.push("neoforge");
        if (tagged.length) return tagged;
      }
      const fb = fallbackLoaders.filter((l): l is ModLoader => l === "forge" || l === "neoforge");
      return fb.length ? fb : ["forge", "neoforge"];
    }
  }

  const explicit = new Set<ModLoader>();
  if (nameHasQuilt || depQuilt || (gvQuilt && !allFourTagged)) explicit.add("quilt");
  if (nameHasFabric || depFabric || (gvFabric && !allFourTagged)) explicit.add("fabric");
  if (nameHasNeoForge || (gvNeoForge && !allFourTagged)) explicit.add("neoforge");
  if (nameHasForge || (gvForge && !allFourTagged)) explicit.add("forge");
  if (explicit.size > 0) {
    const versions = inferFileGameVersions(file);
    if (explicit.has("neoforge") && !nameHasNeoForge && versions.length > 0 && versions.every(isPreNeoForgeVersion)) {
      explicit.delete("neoforge");
      explicit.add("forge");
    }
    return [...explicit];
  }

  const versions = inferFileGameVersions(file);
  if (versions.length > 0 && versions.every((v) => /^1\.(?:[0-9]|1[0-3])(?:\.|$)/.test(v))) {
    return ["forge"];
  }
  return fallbackLoaders;
}

function inferModLoaders(files: CfFile[], mod?: CfMod | null): ModLoader[] {
  const counts = new Map<ModLoader, number>();
  for (const idx of mod?.latestFilesIndexes ?? []) {
    const loader = idx.modLoader ? LOADER_BY_TYPE[idx.modLoader] : undefined;
    if (loader) counts.set(loader, (counts.get(loader) ?? 0) + 1);
  }
  for (const file of files) {
    for (const loader of inferFileLoaders(file, [])) {
      counts.set(loader, (counts.get(loader) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([loader]) => loader);
}

function inferModGameVersions(files: CfFile[], mod?: CfMod | null): string[] {
  const counts = new Map<string, number>();
  for (const idx of mod?.latestFilesIndexes ?? []) {
    if (idx.gameVersion) counts.set(idx.gameVersion, (counts.get(idx.gameVersion) ?? 0) + 1);
  }
  for (const file of files) {
    for (const ver of inferFileGameVersions(file, [])) {
      counts.set(ver, (counts.get(ver) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([ver]) => ver);
}

function targetLoadersFor(projectType: ModrinthProjectType, loader: ModLoader | string | undefined): ModLoader[] {
  if (projectType !== "mod" && projectType !== "modpack") return [];
  if (!loader || loader === "vanilla" || loader === "*") return [];
  if (loader === "quilt" && projectType === "mod") return ["quilt", "fabric"];
  return [loader as ModLoader];
}

function fileMatchesVersion(file: CfFile, gameVersion: string | undefined, fallbackVersions: string[]): boolean {
  if (!gameVersion || gameVersion === "*") return true;
  const versions = inferFileGameVersions(file, fallbackVersions);
  return versions.includes(gameVersion);
}

function fileMatchesLoaders(file: CfFile, wantedLoaders: ModLoader[], fallbackLoaders: ModLoader[]): boolean {
  if (!wantedLoaders.length) return true;
  const loaders = inferFileLoaders(file, fallbackLoaders);
  if (!loaders.length) return true;
  return loaders.some((loader) => wantedLoaders.includes(loader));
}

function pickFile(files: CfFile[]): CfFile | undefined {
  if (!files.length) return undefined;
  const sorted = [...files].sort((a, b) => (b.fileDate ?? "").localeCompare(a.fileDate ?? "") || b.id - a.id);
  const newest = sorted[0];
  const newestDay = (newest.fileDate ?? "").slice(0, 10);
  if (newest.releaseType !== 1 && newestDay) {
    const sameDayRelease = sorted.find((file) => file.releaseType === 1 && (file.fileDate ?? "").slice(0, 10) === newestDay);
    if (sameDayRelease) return sameDayRelease;
  }
  return newest;
}

function cleanVersionNumber(file: CfFile): string {
  const base = file.fileName.replace(/\.(?:jar|zip|mrpack)$/i, "");
  return file.displayName?.trim() || base || String(file.id);
}

function isUsableCfFile(file: CfFile, projectType: ModrinthProjectType): boolean {
  if (file.isServerPack) return false;
  const lower = file.fileName.toLowerCase();
  if (projectType === "mod") {
    if (!lower.endsWith(".jar")) return false;
    if (/(?:^|[-_.+])(sources|javadoc|dev|deobf|preshadow)\.jar$/i.test(lower)) return false;
    return true;
  }
  if (projectType === "modpack" || projectType === "resourcepack" || projectType === "shader" || projectType === "datapack") {
    return lower.endsWith(".zip");
  }
  return true;
}

function extractCoreVersionToken(raw: string | undefined): string {
  if (!raw) return "";
  let text = raw
    .toLowerCase()
    .replace(/\.(?:jar|zip|mrpack)$/i, "")
    .replace(/\b(?:fabric|forge|neoforge|neoforged|quilt|mc|minecraft)\b/g, " ");
  const matches = [...text.matchAll(/(?:^|[^0-9a-z])v?(\d+\.\d+(?:\.\d+)?(?:[-+._a-z0-9]*)?)/g)].map((m) => m[1]);
  const nonMc = matches.filter((v) => !/^1\.(?:7\.10|8\.9|9\.4|10\.2|11\.2|12(?:\.[12])?|13\.2|14(?:\.[2-4])?|15\.2|16(?:\.[1-5])?|17\.1|18(?:\.[12])?|19(?:\.[1-4])?|20(?:\.[1-6])?|21(?:\.\d{1,2})?)$/.test(v));
  if (nonMc.length) {
    return nonMc[nonMc.length - 1].replace(/[-+._](?:1\.\d+(?:\.\d+)?)$/g, "");
  }
  return text.replace(/[^a-z0-9.]+/g, " ").trim();
}

function isSameReleaseVersion(candidate: CfFile, currentFile: CfFile | undefined, modrinthVersion?: string): boolean {
  const candClean = cleanVersionNumber(candidate).trim().replace(/^v(?=\d)/i, "").toLowerCase();
  if (currentFile) {
    const curClean = cleanVersionNumber(currentFile).trim().replace(/^v(?=\d)/i, "").toLowerCase();
    if (candClean && candClean === curClean) return true;
  }
  if (modrinthVersion) {
    const mrClean = modrinthVersion.trim().replace(/^v(?=\d)/i, "").toLowerCase();
    if (mrClean && (candClean === mrClean || extractCoreVersionToken(candidate.fileName) === mrClean || extractCoreVersionToken(candClean) === extractCoreVersionToken(mrClean))) {
      return true;
    }
  }
  return false;
}

function cfFilePageUrl(modWebsiteUrl: string | undefined, fileId: number): string | undefined {
  if (!modWebsiteUrl) return undefined;
  return `${modWebsiteUrl.replace(/\/+$/, "")}/files/${fileId}`;
}

function toCfVersionInfo(
  file: CfFile,
  instance: LauncherInstance,
  projectType: ModrinthProjectType,
  fallbackLoaders: ModLoader[],
  fallbackVersions: string[],
  extra?: { distributionBlocked?: boolean; websiteUrl?: string }
): ModVersionInfo {
  const usable = isUsableCfFile(file, projectType);
  const gameVersions = inferFileGameVersions(file, fallbackVersions);
  const effectiveFallbackLoaders = fallbackLoaders.length <= 1 ? fallbackLoaders : [];
  const loaders = projectType === "mod" || projectType === "modpack" ? inferFileLoaders(file, effectiveFallbackLoaders) : [];
  const wantedLoaders = targetLoadersFor(projectType, instance.loader);
  const versionOk = !gameVersions.length || gameVersions.includes(instance.gameVersion);
  const loaderOk = (projectType === "mod" || projectType === "modpack") && instance.loader === "vanilla"
    ? false
    : !wantedLoaders.length
      ? true
      : loaders.length > 0
        ? loaders.some((loader) => wantedLoaders.includes(loader))
        : fallbackLoaders.length <= 1;
  const versionType = file.releaseType === 3 ? "alpha" : file.releaseType === 2 ? "beta" : "release";
  return {
    id: String(file.id),
    name: file.displayName?.trim() || file.fileName,
    versionNumber: cleanVersionNumber(file),
    versionType,
    datePublished: file.fileDate ?? "",
    gameVersions,
    loaders,
    fileName: file.fileName,
    size: file.fileLength ?? 0,
    compatible: usable && versionOk && loaderOk,
    provider: "curseforge",
    projectId: String(file.modId),
    ...(extra?.distributionBlocked ? { distributionBlocked: true, websiteUrl: extra.websiteUrl } : {})
  };
}

function cfIncompatibility(
  file: CfFile,
  instance: LauncherInstance,
  fallbackLoaders: ModLoader[],
  fallbackVersions: string[]
): ContentIncompatibility | undefined {
  const supportedGameVersions = inferFileGameVersions(file, fallbackVersions);
  const supportedLoaders = inferFileLoaders(file, fallbackLoaders);
  const wantedLoaders = targetLoadersFor("mod", instance.loader);
  const wrongGame = supportedGameVersions.length > 0 && !supportedGameVersions.includes(instance.gameVersion);
  const wrongLoader = instance.loader === "vanilla" || (wantedLoaders.length > 0 && supportedLoaders.length > 0 && !supportedLoaders.some((loader) => wantedLoaders.includes(loader)));
  if (!wrongGame && !wrongLoader) return undefined;
  return {
    gameVersion: wrongGame ? instance.gameVersion : undefined,
    loader: wrongLoader ? instance.loader : undefined,
    supportedGameVersions,
    supportedLoaders
  };
}

function blockedMessage(name: string, websiteUrl?: string): string {
  return tr(
    `The author of ${name} does not allow downloads through other launchers. Download it from the CurseForge website${websiteUrl ? `: ${websiteUrl}` : ""} and drop the file onto the Files tab.`,
    `Автор ${name} запретил скачивание через сторонние лаунчеры. Скачайте файл на сайте CurseForge${websiteUrl ? `: ${websiteUrl}` : ""} и перетащите его на вкладку «Файлы».`
  );
}

function latestModDate(mod: CfMod): string | undefined {
  const candidates = [
    mod.dateModified,
    mod.dateReleased,
    ...(mod.latestFiles ?? []).map((f) => f.fileDate)
  ].filter((d): d is string => Boolean(d));
  if (!candidates.length) return undefined;
  return candidates.sort((a, b) => b.localeCompare(a))[0];
}

function titleMatchRank(mod: CfMod, query: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const qSlug = q.replace(/\s+/g, "-");
  const name = (mod.name ?? "").toLowerCase().trim();
  const slug = (mod.slug ?? "").toLowerCase().trim();
  if (name === q || slug === q || slug === qSlug) return 4;
  if (name.startsWith(q) || slug.startsWith(qSlug)) return 3;
  if (name.includes(q) || slug.includes(qSlug)) return 2;
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((tok) => name.includes(tok) || slug.includes(tok))) return 1;
  return 0;
}

function modMatchesUntaggedSearch(mod: CfMod, projectType: ModrinthProjectType, gameVersion: string | undefined, wantedLoaders: ModLoader[]): boolean {
  const files = mod.latestFiles ?? [];
  const fallbackLoaders = inferModLoaders(files, mod);
  const fallbackVersions = inferModGameVersions(files, mod);
  if (projectType === "modpack") {
    if (!gameVersion || gameVersion === "*") return true;
    const indexHasVersion = (mod.latestFilesIndexes ?? []).some((idx) => idx.gameVersion === gameVersion);
    if (indexHasVersion) return true;
    return files.some((file) => fileMatchesVersion(file, gameVersion, fallbackVersions));
  }
  const indexMatchesVersion = !gameVersion || gameVersion === "*" || (mod.latestFilesIndexes ?? []).some((idx) => idx.gameVersion === gameVersion);
  const matchingFiles = files.filter((file) => fileMatchesVersion(file, gameVersion, fallbackVersions));
  if (matchingFiles.length > 0) {
    return matchingFiles.some((file) => fileMatchesLoaders(file, wantedLoaders, fallbackLoaders));
  }
  if (!indexMatchesVersion) return false;
  if (!wantedLoaders.length) return true;
  return !fallbackLoaders.length || fallbackLoaders.some((loader) => wantedLoaders.includes(loader));
}

export class CurseForgeService {
  private readonly categoryCache = new Map<number, CfCategory[]>();
  private readonly filesCache = new Map<string, { at: number; files: CfFile[] }>();

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

  private toSearchResult(mod: CfMod, fallbackType: ModrinthProjectType): ModSearchResult {
    return {
      id: String(mod.id),
      provider: "curseforge",
      projectType: fallbackType,
      title: mod.name,
      slug: mod.slug,
      author: mod.authors?.[0]?.name,
      summary: mod.summary ?? "",
      iconUrl: mod.logo?.thumbnailUrl || mod.logo?.url || undefined,
      downloads: mod.downloadCount,
      follows: mod.favoriteCount ?? mod.thumbsUpCount,
      dateModified: latestModDate(mod),
      categories: (mod.categories ?? []).map((category) => category.name),
      websiteUrl: mod.links?.websiteUrl,
      distributionBlocked: mod.allowModDistribution === false
    };
  }

  async search(payload: ModSearchPayload): Promise<ModSearchResponse> {
    const data = await this.store.getData();
    const instance = payload.instanceId ? data.instances.find((item) => item.id === payload.instanceId) : undefined;
    if (payload.instanceId && !instance) throw new Error(tr("Instance not found", "Инстанция не найдена"));

    const pageSize = Math.min(Math.max(payload.limit ?? 20, 5), 50);
    const index = Math.min(Math.max(payload.offset ?? 0, 0), 10000 - pageSize);
    const query = payload.query.trim();
    const sortKey = payload.sort ?? "relevance";
    const sortField = sortKey === "relevance" && query ? SORT_FIELDS.follows : SORT_FIELDS[sortKey];

    const baseParams = new URLSearchParams({
      gameId: String(MINECRAFT_GAME_ID),
      classId: String(CLASS_IDS[payload.projectType]),
      sortField: String(sortField),
      sortOrder: "desc",
      index: String(index),
      pageSize: String(pageSize)
    });
    if (query) baseParams.set("searchFilter", query);

    if (payload.categories?.length) {
      const known = await this.categories(payload.projectType);
      const ids = payload.categories.map((name) => known.find((item) => item.name === name)?.id).filter((id): id is number => typeof id === "number").slice(0, 10);
      if (ids.length) baseParams.set("categoryIds", JSON.stringify(ids));
    }

    const explicitVersion = payload.versions?.[0];
    const gameVersion = explicitVersion === "*"
      ? undefined
      : explicitVersion ?? (payload.projectType === "modpack" ? undefined : instance?.gameVersion);

    const explicitLoader = payload.loaders?.[0];
    const rawLoader = explicitLoader === "*"
      ? undefined
      : explicitLoader ?? (payload.projectType === "mod" && instance && instance.loader !== "vanilla" ? instance.loader : undefined);
    const loaderType = rawLoader ? LOADER_TYPES[rawLoader === "quilt" && payload.projectType === "mod" ? "fabric" : rawLoader] : undefined;
    const wantedLoaders = targetLoadersFor(payload.projectType, rawLoader);

    const primaryParams = new URLSearchParams(baseParams);
    if (gameVersion) primaryParams.set("gameVersion", gameVersion);
    if (loaderType && payload.projectType === "mod") primaryParams.set("modLoaderType", String(loaderType));
    else if (loaderType && payload.projectType === "modpack" && explicitLoader && explicitLoader !== "*") {
      primaryParams.set("modLoaderType", String(loaderType));
    }

    const shouldProbeUntagged = index === 0 && Boolean(
      (primaryParams.has("modLoaderType") && (query || sortKey === "updated" || sortKey === "newest")) ||
      (payload.projectType === "mod" && query && gameVersion)
    );

    const fallbackParams = new URLSearchParams(baseParams);
    if (gameVersion && !(payload.projectType === "modpack" && query && !explicitVersion)) {
      fallbackParams.set("gameVersion", gameVersion);
    }

    const [primaryBody, fallbackBody] = await Promise.all([
      this.request<{ data: CfMod[]; pagination?: { totalCount?: number } }>(`/mods/search?${primaryParams.toString()}`),
      shouldProbeUntagged && fallbackParams.toString() !== primaryParams.toString()
        ? this.request<{ data: CfMod[]; pagination?: { totalCount?: number } }>(`/mods/search?${fallbackParams.toString()}`).catch(() => null)
        : Promise.resolve(null)
    ]);

    let mods = [...(primaryBody.data ?? [])];
    let totalCount = primaryBody.pagination?.totalCount ?? mods.length;

    if (fallbackBody?.data?.length) {
      const seen = new Set(mods.map((m) => m.id));
      const extras = fallbackBody.data.filter((m) => !seen.has(m.id) && modMatchesUntaggedSearch(m, payload.projectType, gameVersion, wantedLoaders));
      if (extras.length) {
        mods = [...mods, ...extras];
        if (sortKey === "updated" || sortKey === "newest") {
          mods.sort((a, b) => (latestModDate(b) ?? "").localeCompare(latestModDate(a) ?? ""));
        } else if (sortKey === "downloads") {
          mods.sort((a, b) => (b.downloadCount ?? 0) - (a.downloadCount ?? 0));
        }
        mods = mods.slice(0, pageSize);
        totalCount = Math.max(totalCount, mods.length);
      }
    }

    if (mods.length === 0 && query && gameVersion) {
      const broadParams = new URLSearchParams(baseParams);
      const broadBody = await this.request<{ data: CfMod[] }>(`/mods/search?${broadParams.toString()}`).catch(() => null);
      if (broadBody?.data?.length) {
        const matched = broadBody.data.filter((m) => modMatchesUntaggedSearch(m, payload.projectType, gameVersion, wantedLoaders));
        if (matched.length) {
          mods = matched.slice(0, pageSize);
          totalCount = matched.length;
        }
      }
    }

    if (sortKey === "relevance" && query && mods.length > 1) {
      mods.sort((a, b) => titleMatchRank(b, query) - titleMatchRank(a, query));
      mods = mods.slice(0, pageSize);
    }

    const results = mods.map((mod) => this.toSearchResult(mod, payload.projectType));
    return { results, totalHits: Math.min(totalCount, 10000) };
  }

  private async fetchFilePages(modId: string, extraParams: Record<string, string>, maxPages = 5): Promise<CfFile[]> {
    const out: CfFile[] = [];
    for (let page = 0; page < maxPages; page += 1) {
      const params = new URLSearchParams({ pageSize: "50", index: String(page * 50), ...extraParams });
      const body = await this.request<{ data: CfFile[]; pagination?: { index?: number; pageSize?: number; resultCount?: number; totalCount?: number } }>(
        `/mods/${encodeURIComponent(modId)}/files?${params.toString()}`
      );
      const batch = body.data ?? [];
      out.push(...batch);
      const total = body.pagination?.totalCount ?? out.length;
      if (batch.length < 50 || (page + 1) * 50 >= total) break;
    }
    return out;
  }

  private async allFilesFor(modId: string, gameVersion?: string, forceFresh = false): Promise<CfFile[]> {
    const cacheKey = `${modId}|${gameVersion ?? ""}`;
    const cached = this.filesCache.get(cacheKey);
    if (!forceFresh && cached && Date.now() - cached.at < 2 * 60 * 1000) {
      return cached.files;
    }

    const byId = new Map<number, CfFile>();
    const recentBody = await this.request<{ data: CfFile[]; pagination?: { totalCount?: number } }>(
      `/mods/${encodeURIComponent(modId)}/files?pageSize=50`
    );
    for (const file of recentBody.data ?? []) byId.set(file.id, file);

    const totalRecent = recentBody.pagination?.totalCount ?? byId.size;
    if (gameVersion && gameVersion !== "*") {
      const recentList = [...byId.values()];
      const fallbackVersions = inferModGameVersions(recentList);
      const hasVersionInRecent = recentList.some((file) => fileMatchesVersion(file, gameVersion, fallbackVersions));
      if (!hasVersionInRecent || totalRecent > 50) {
        const versionFiles = await this.fetchFilePages(modId, { gameVersion }, 5);
        for (const file of versionFiles) byId.set(file.id, file);
      }
    } else if (totalRecent > 50) {
      const moreFiles = await this.fetchFilePages(modId, {}, 5);
      for (const file of moreFiles) byId.set(file.id, file);
    }

    const files = [...byId.values()].sort((a, b) => (b.fileDate ?? "").localeCompare(a.fileDate ?? "") || b.id - a.id);
    if (files.length) {
      this.filesCache.set(cacheKey, { at: Date.now(), files });
    }
    return files;
  }

  private async filesFor(modId: string, gameVersion: string | undefined, loaders: string[], forceFresh = false, projectType: ModrinthProjectType = "mod"): Promise<CfFile[]> {
    const rawFiles = await this.allFilesFor(modId, gameVersion, forceFresh);
    const allFiles = rawFiles.filter((file) => isUsableCfFile(file, projectType));
    if (!allFiles.length) return [];
    const fallbackLoaders = inferModLoaders(allFiles);
    const effectiveFallbackLoaders = fallbackLoaders.length <= 1 ? fallbackLoaders : [];
    const fallbackVersions = inferModGameVersions(allFiles);
    const wantedLoaders = loaders.filter((l): l is ModLoader => Boolean(l && l !== "vanilla" && l !== "*"));

    const versionMatched = gameVersion && gameVersion !== "*"
      ? allFiles.filter((file) => fileMatchesVersion(file, gameVersion, fallbackVersions))
      : allFiles;

    const loaderMatched = wantedLoaders.length
      ? versionMatched.filter((file) => {
          const inferred = inferFileLoaders(file, effectiveFallbackLoaders);
          if (!inferred.length) return fallbackLoaders.length <= 1;
          return inferred.some((loader) => wantedLoaders.includes(loader));
        })
      : versionMatched;

    return wantedLoaders.length ? loaderMatched : versionMatched;
  }

  private async mod(modId: string): Promise<CfMod | null> {
    try {
      return (await this.request<{ data: CfMod }>(`/mods/${encodeURIComponent(modId)}`)).data;
    } catch {
      return null;
    }
  }

  async getModsByIds(modIds: number[]): Promise<Map<number, CfMod>> {
    const out = new Map<number, CfMod>();
    if (!curseForgeAvailable || !modIds.length) return out;
    const unique = [...new Set(modIds)];
    for (let start = 0; start < unique.length; start += 500) {
      try {
        const body = await this.request<{ data: CfMod[] }>("/mods", {
          method: "POST",
          body: { modIds: unique.slice(start, start + 500), filterPcOnly: true }
        });
        for (const mod of body.data ?? []) out.set(mod.id, mod);
      } catch {
      }
    }
    return out;
  }

  async matchFingerprints(fingerprints: number[], onApiError?: () => void): Promise<Map<number, CfFingerprintMatch>> {
    const out = new Map<number, CfFingerprintMatch>();
    if (!curseForgeAvailable || !fingerprints.length) return out;
    const unique = [...new Set(fingerprints.filter((fp) => fp > 0))];
    for (let start = 0; start < unique.length; start += 500) {
      try {
        const body = await this.request<{ data?: { exactMatches?: CfFingerprintMatch[] } }>(`/fingerprints/${MINECRAFT_GAME_ID}`, {
          method: "POST",
          body: { fingerprints: unique.slice(start, start + 500) }
        });
        for (const match of body.data?.exactMatches ?? []) {
          const fp = match.file?.fileFingerprint;
          if (typeof fp === "number" && match.id && match.file) {
            out.set(fp, match);
          }
        }
      } catch {
        onApiError?.();
      }
    }
    return out;
  }

  async listVersions(instanceId: string, projectId: string, projectType: ModrinthProjectType): Promise<ModVersionInfo[]> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === instanceId);
    if (!instance) throw new Error(tr("Instance not found", "Инстанция не найдена"));

    const rawFiles = await this.allFilesFor(projectId, instance.gameVersion, true);
    const allFiles = rawFiles.filter((file) => isUsableCfFile(file, projectType));
    const fallbackLoaders = inferModLoaders(allFiles);
    const fallbackVersions = inferModGameVersions(allFiles);
    const missingUrlSha1s = allFiles
      .filter((file) => !file.downloadUrl)
      .map((file) => sha1Of(file))
      .filter((s): s is string => Boolean(s));
    const [mrUrls, modMeta] = missingUrlSha1s.length || allFiles.some((file) => !file.downloadUrl)
      ? await Promise.all([
          missingUrlSha1s.length ? this.modrinthUrlsBySha1(missingUrlSha1s) : Promise.resolve(new Map<string, string>()),
          this.mod(projectId)
        ])
      : [new Map<string, string>(), null];
    return allFiles.map((file) => {
      const sha1 = sha1Of(file);
      const blocked = !file.downloadUrl && !(sha1 && mrUrls.has(sha1));
      return toCfVersionInfo(file, instance, projectType, fallbackLoaders, fallbackVersions, blocked ? {
        distributionBlocked: true,
        websiteUrl: cfFilePageUrl(modMeta?.links?.websiteUrl, file.id) ?? modMeta?.links?.websiteUrl
      } : undefined);
    });
  }

  async checkUpdatesForItems(instance: LauncherInstance, items: CfTrackedItem[], onApiError?: () => void): Promise<Map<string, ContentUpdateInfo>> {
    const out = new Map<string, ContentUpdateInfo>();
    if (!curseForgeAvailable || !items.length) return out;

    const fpByKey = new Map<string, number>();
    for (const item of items) {
      const fp = await cfFingerprintCached(item.foundPath).catch(() => 0);
      if (fp > 0) fpByKey.set(`${item.projectType}:${item.fileName}`, fp);
    }
    const matchesByFp = await this.matchFingerprints([...fpByKey.values()], onApiError);

    const tasks = items.map((item) => {
      const key = `${item.projectType}:${item.fileName}`;
      const fp = fpByKey.get(key) ?? 0;
      const match = fp > 0 ? matchesByFp.get(fp) : undefined;
      const modId = item.projectId && /^\d+$/.test(item.projectId)
        ? item.projectId
        : match?.id
          ? String(match.id)
          : undefined;
      return { item, key, fp, match, modId };
    }).filter((task): task is { item: CfTrackedItem; key: string; fp: number; match: CfFingerprintMatch | undefined; modId: string } => Boolean(task.modId));

    let index = 0;
    const worker = async (): Promise<void> => {
      while (index < tasks.length) {
        const current = tasks[index];
        index += 1;
        try {
          const rawFiles = await this.allFilesFor(current.modId, instance.gameVersion);
          const usableFiles = rawFiles.filter((f) => isUsableCfFile(f, current.item.projectType));
          if (!usableFiles.length) continue;
          const fallbackLoaders = inferModLoaders(usableFiles);
          const fallbackVersions = inferModGameVersions(usableFiles);
          const baseName = current.item.fileName.replace(/\.disabled$/i, "").toLowerCase();
          const itemSha1 = current.item.sha1?.toLowerCase();
          const matchedSelf = current.match?.file && String(current.match.id) === current.modId ? current.match.file : undefined;
          const now = matchedSelf
            ?? (current.fp > 0 ? rawFiles.find((f) => f.fileFingerprint === current.fp) : undefined)
            ?? (itemSha1 ? rawFiles.find((f) => sha1Of(f) === itemSha1) : undefined)
            ?? (current.item.versionId ? rawFiles.find((f) => String(f.id) === current.item.versionId) : undefined)
            ?? rawFiles.find((f) => f.fileName.toLowerCase() === baseName || sanitizeFilePart(f.fileName).toLowerCase() === baseName);

          const canUpdate = !(current.item.projectType === "mod" && instance.loader === "vanilla");
          const compatibleFiles = canUpdate
            ? usableFiles.filter((f) => toCfVersionInfo(f, instance, current.item.projectType, fallbackLoaders, fallbackVersions).compatible)
            : [];
          const latestFile = pickFile(compatibleFiles);
          const nowInfo = now ? toCfVersionInfo(now, instance, current.item.projectType, fallbackLoaders, fallbackVersions) : undefined;
          const nowCompatible = nowInfo ? nowInfo.compatible : true;
          const baselineDate = now?.fileDate ?? current.item.installedDate ?? "";

          const sameQuiltSibling = Boolean(
            now &&
            latestFile &&
            nowCompatible &&
            instance.loader === "quilt" &&
            current.item.projectType === "mod" &&
            nowInfo?.loaders.includes("quilt") &&
            !toCfVersionInfo(latestFile, instance, current.item.projectType, fallbackLoaders, fallbackVersions).loaders.includes("quilt") &&
            isSameReleaseVersion(latestFile, now, current.item.currentVersionNumber)
          );
          const sameVersionAlreadyInstalled = Boolean(
            latestFile &&
            nowCompatible &&
            (now || current.item.currentVersionNumber) &&
            isSameReleaseVersion(latestFile, now, current.item.currentVersionNumber)
          );

          let isNewer = Boolean(
            latestFile &&
            !sameQuiltSibling &&
            !sameVersionAlreadyInstalled &&
            (now ? latestFile.id !== now.id : sanitizeFilePart(latestFile.fileName).toLowerCase() !== baseName) &&
            (!nowCompatible || !baselineDate || (latestFile.fileDate ?? "") > baselineDate)
          );

          let blockedExtra: { distributionBlocked: true; websiteUrl?: string } | undefined;
          if (isNewer && latestFile && !latestFile.downloadUrl) {
            const latestSha1 = sha1Of(latestFile);
            const mrUrl = latestSha1 ? (await this.modrinthUrlsBySha1([latestSha1])).get(latestSha1) : undefined;
            if (!mrUrl) {
              if (current.item.provider === "modrinth") {
                isNewer = false;
              } else {
                const modMeta = await this.mod(current.modId);
                blockedExtra = {
                  distributionBlocked: true,
                  websiteUrl: cfFilePageUrl(modMeta?.links?.websiteUrl, latestFile.id) ?? modMeta?.links?.websiteUrl
                };
              }
            }
          }

          out.set(current.key, {
            projectId: current.modId,
            projectType: current.item.projectType,
            fileName: current.item.fileName,
            currentVersionId: now ? String(now.id) : current.item.versionId,
            currentVersionNumber: now ? cleanVersionNumber(now) : current.item.currentVersionNumber,
            latest: isNewer && latestFile ? toCfVersionInfo(latestFile, instance, current.item.projectType, fallbackLoaders, fallbackVersions, blockedExtra) : null,
            incompatible: now && current.item.projectType === "mod" ? cfIncompatibility(now, instance, fallbackLoaders, fallbackVersions) : undefined
          });
        } catch {
          onApiError?.();
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(4, tasks.length) }, () => worker()));
    return out;
  }

  async install(payload: InstallModPayload, onBytes?: BytesCallback): Promise<LauncherInstance> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === payload.instanceId);
    if (!instance) throw new Error(tr("Instance not found", "Инстанция не найдена"));
    if (payload.projectType === "mod" && instance.loader === "vanilla") {
      throw new Error(tr("Choose Fabric, Forge, Quilt, or NeoForge before installing mods.", "Перед установкой модов выберите Fabric, Forge, Quilt или NeoForge."));
    }

    const rawVersion = payload.gameVersions?.[0];
    const wildcardVersion = rawVersion === "*";
    const gameVersion = rawVersion && rawVersion !== "*" ? rawVersion : instance.gameVersion;
    const rawLoader = payload.loaders?.[0];
    const wildcardLoader = rawLoader === "*";
    const loader = rawLoader && rawLoader !== "*" ? rawLoader : instance.loader;
    const loaders = payload.projectType === "mod" ? (loader === "quilt" ? ["quilt", "fabric"] : loader === "vanilla" ? [] : [loader]) : [];
    let file: CfFile | undefined;
    if (payload.versionId) {
      file = (await this.request<{ data: CfFile }>(`/mods/${encodeURIComponent(payload.projectId)}/files/${encodeURIComponent(payload.versionId)}`)).data;
    } else {
      let candidates = await this.filesFor(payload.projectId, gameVersion, wildcardLoader ? [] : loaders, true, payload.projectType);
      if (!candidates.length && wildcardVersion) {
        candidates = await this.filesFor(payload.projectId, undefined, wildcardLoader ? [] : loaders, false, payload.projectType);
        if (!candidates.length && !wildcardLoader) {
          candidates = await this.filesFor(payload.projectId, undefined, [], false, payload.projectType);
        }
      }
      file = pickFile(candidates);
    }
    if (!file) throw new Error(tr(`No compatible CurseForge file for ${payload.name} (${gameVersion})`, `На CurseForge нет подходящего файла для ${payload.name} (${gameVersion})`));

    let downloadUrl = file.downloadUrl ?? undefined;
    if (!downloadUrl) {
      const sha1 = sha1Of(file);
      if (sha1) {
        downloadUrl = (await this.modrinthUrlsBySha1([sha1])).get(sha1);
      }
    }
    if (!downloadUrl) {
      const mod = await this.mod(payload.projectId);
      throw new Error(blockedMessage(payload.name, mod?.links?.websiteUrl));
    }

    const destinations = await targetDirectories(instance, payload.projectType);
    for (const destination of destinations) await mkdir(destination, { recursive: true });
    const launcherDir = path.join(instance.directory, ".launcher");
    await mkdir(launcherDir, { recursive: true });

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
    const downloadedName = sanitizeFilePart(file.fileName);
    const fileName = keepDisabled ? `${downloadedName}.disabled` : downloadedName;
    const { buffer } = await readUrlBytes(downloadUrl, { "User-Agent": USER_AGENT }, undefined, (received, total) => onBytes?.(received, total), 15 * 60 * 1000);
    for (const destination of destinations) {
      const tmpPath = path.join(destination, `${downloadedName}.${randomUUID()}.download`);
      const targetPath = path.join(destination, fileName);
      try {
        await writeFile(tmpPath, buffer);
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
      const now = new Date().toISOString();
      if (existing) {
        existing.provider = "curseforge";
        existing.projectId = payload.projectId;
        existing.versionId = String(file.id);
        existing.fileName = fileName;
        existing.name = payload.name;
        existing.slug = payload.slug ?? existing.slug;
        existing.iconUrl = payload.iconUrl ?? existing.iconUrl;
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

  async downloadModpackFile(instanceId: string, projectId: string, name: string, onBytes?: BytesCallback, versionId?: string): Promise<string> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === instanceId);
    if (!instance) throw new Error(tr("Instance not found", "Инстанция не найдена"));
    let file: CfFile | undefined;
    if (versionId) {
      try {
        file = (await this.request<{ data: CfFile }>(`/mods/${encodeURIComponent(projectId)}/files/${encodeURIComponent(versionId)}`)).data;
      } catch {
      }
    }
    if (!file) {
      let files = (await this.filesFor(projectId, instance.gameVersion, [], true, "modpack")).filter((item) => /\.zip$/i.test(item.fileName));
      if (!files.length) {
        files = (await this.allFilesFor(projectId, undefined, true)).filter((item) => /\.zip$/i.test(item.fileName));
      }
      file = pickFile(files);
    }
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

  async prepareInstall(payload: PrepareModInstallPayload): Promise<ModInstallPlan> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === payload.instanceId);
    if (!instance) throw new Error(tr("Instance not found", "Инстанция не найдена"));

    const rawFiles = await this.allFilesFor(payload.projectId, instance.gameVersion, true);
    const allFiles = rawFiles.filter((file) => isUsableCfFile(file, payload.projectType));
    const fallbackLoaders = inferModLoaders(allFiles);
    const fallbackVersions = inferModGameVersions(allFiles);
    const versions = allFiles.map((file) => toCfVersionInfo(file, instance, payload.projectType, fallbackLoaders, fallbackVersions));
    const hasCompatibleVersion = versions.some((v) => v.compatible);

    let targetFile: CfFile | undefined;
    if (payload.versionId) {
      targetFile = allFiles.find((f) => String(f.id) === payload.versionId);
      if (!targetFile) {
        try {
          targetFile = (await this.request<{ data: CfFile }>(`/mods/${encodeURIComponent(payload.projectId)}/files/${encodeURIComponent(payload.versionId)}`)).data;
        } catch {
        }
      }
    } else {
      const compatibleFiles = allFiles.filter((_, idx) => versions[idx].compatible);
      targetFile = pickFile(compatibleFiles);
    }

    if (!targetFile) {
      let enriched = versions;
      if (allFiles.some((file) => !file.downloadUrl)) {
        const missingSha1s = allFiles.filter((file) => !file.downloadUrl).map((file) => sha1Of(file)).filter((s): s is string => Boolean(s));
        const [mrUrls, modMeta] = await Promise.all([
          missingSha1s.length ? this.modrinthUrlsBySha1(missingSha1s) : Promise.resolve(new Map<string, string>()),
          this.mod(payload.projectId)
        ]);
        enriched = allFiles.map((file, idx) => {
          const sha1 = sha1Of(file);
          const blocked = !file.downloadUrl && !(sha1 && mrUrls.has(sha1));
          return blocked ? {
            ...versions[idx],
            distributionBlocked: true,
            websiteUrl: cfFilePageUrl(modMeta?.links?.websiteUrl, file.id) ?? modMeta?.links?.websiteUrl
          } : versions[idx];
        });
      }
      return {
        targetVersion: null,
        hasCompatibleVersion,
        versions: enriched,
        dependencies: []
      };
    }

    const targetVersion = toCfVersionInfo(targetFile, instance, payload.projectType, fallbackLoaders, fallbackVersions);
    if (payload.projectType !== "mod") {
      return {
        targetVersion,
        hasCompatibleVersion,
        versions,
        dependencies: []
      };
    }

    const rawDeps = (targetFile.dependencies ?? []).filter((d) => d.relationType === 3 || d.relationType === 2);
    if (!rawDeps.length) {
      return {
        targetVersion,
        hasCompatibleVersion,
        versions,
        dependencies: []
      };
    }

    const depMap = new Map<number, "required" | "optional">();
    for (const d of rawDeps) {
      if (!d.modId || String(d.modId) === payload.projectId) continue;
      const depType = d.relationType === 3 ? "required" : "optional";
      const prev = depMap.get(d.modId);
      if (!prev || (prev === "optional" && depType === "required")) {
        depMap.set(d.modId, depType);
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

    const fileVers = inferFileGameVersions(targetFile, fallbackVersions);
    const effectiveGameVersion = fileVers.includes(instance.gameVersion) ? instance.gameVersion : fileVers[0] ?? instance.gameVersion;
    const fileLoaders = inferFileLoaders(targetFile, fallbackLoaders);
    const wantedLoaders = targetLoadersFor("mod", instance.loader);
    const effectiveLoaders = wantedLoaders.some((l) => fileLoaders.includes(l)) ? wantedLoaders : fileLoaders.length ? fileLoaders : wantedLoaders;

    const chosenFileByMod = new Map<number, CfFile>();
    const expandedRequired = new Set<number>();
    let wave = [...depMap.keys()];
    for (let depth = 0; depth < 6 && wave.length > 0; depth += 1) {
      const toFetch = wave.filter((id) => !chosenFileByMod.has(id));
      await Promise.all(toFetch.map(async (modId) => {
        try {
          const files = await this.filesFor(String(modId), effectiveGameVersion, effectiveLoaders);
          const chosen = pickFile(files);
          if (chosen) chosenFileByMod.set(modId, chosen);
        } catch {
        }
      }));

      const nextWave = new Set<number>();
      for (const modId of wave) {
        if (depMap.get(modId) !== "required" || expandedRequired.has(modId)) continue;
        expandedRequired.add(modId);
        const chosen = chosenFileByMod.get(modId);
        if (!chosen) continue;
        for (const sub of chosen.dependencies ?? []) {
          if (sub.relationType !== 3 || !sub.modId || String(sub.modId) === payload.projectId) continue;
          const prev = depMap.get(sub.modId);
          if (!prev) {
            depMap.set(sub.modId, "required");
            nextWave.add(sub.modId);
          } else if (prev === "optional") {
            depMap.set(sub.modId, "required");
            if (!expandedRequired.has(sub.modId)) nextWave.add(sub.modId);
          }
        }
      }
      wave = [...nextWave];
    }

    const allModIds = [...depMap.keys()];
    const modsById = await this.getModsByIds(allModIds);

    const blockedSha1s: string[] = [];
    for (const modId of allModIds) {
      const f = chosenFileByMod.get(modId);
      if (f && !f.downloadUrl) {
        const s = sha1Of(f);
        if (s) blockedSha1s.push(s);
      }
    }
    const mrFallbackUrls = blockedSha1s.length ? await this.modrinthUrlsBySha1(blockedSha1s) : new Map<string, string>();

    const modsDir = path.join(instance.directory, "mods");
    const dependencies: ModDependencyItem[] = allModIds.map((modId) => {
      const mod = modsById.get(modId);
      const depType = depMap.get(modId)!;
      const chosen = chosenFileByMod.get(modId);
      const slug = mod?.slug;
      const installed = instance.mods.some((m) => {
        if ((m.projectType ?? "mod") !== "mod") return false;
        if (m.projectId !== String(modId) && !(slug && m.slug && m.slug.toLowerCase() === slug.toLowerCase())) return false;
        if (!m.fileName) return true;
        const baseName = m.fileName.replace(/\.disabled$/i, "");
        return existsSync(path.join(modsDir, m.fileName)) || existsSync(path.join(modsDir, baseName)) || existsSync(path.join(modsDir, `${baseName}.disabled`));
      });
      const sha1 = chosen ? sha1Of(chosen) : undefined;
      const hasDownload = Boolean(chosen?.downloadUrl || (sha1 && mrFallbackUrls.has(sha1)));
      const distributionBlocked = Boolean(chosen && !hasDownload && mod?.allowModDistribution === false);
      return {
        projectId: String(modId),
        provider: "curseforge",
        versionId: chosen ? String(chosen.id) : undefined,
        versionNumber: chosen ? cleanVersionNumber(chosen) : undefined,
        title: mod?.name ?? slug ?? String(modId),
        slug,
        author: mod?.authors?.[0]?.name,
        summary: mod?.summary ?? "",
        iconUrl: mod?.logo?.thumbnailUrl || mod?.logo?.url || undefined,
        dependencyType: depType,
        installed,
        compatible: Boolean(chosen),
        distributionBlocked,
        websiteUrl: mod?.links?.websiteUrl
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

  async getProjectDetails(projectId: string, projectType: ModrinthProjectType): Promise<ModProjectDetails> {
    const [modRes, descRes] = await Promise.all([
      this.request<{ data: CfMod }>(`/mods/${encodeURIComponent(projectId)}`),
      this.request<{ data: string }>(`/mods/${encodeURIComponent(projectId)}/description`).catch(() => ({ data: "" }))
    ]);
    const mod = modRes.data;
    const versionsSet = new Set<string>();
    const loadersSet = new Set<string>();
    for (const idx of mod.latestFilesIndexes ?? []) {
      if (idx.gameVersion) versionsSet.add(idx.gameVersion);
      if (idx.modLoader && LOADER_BY_TYPE[idx.modLoader]) loadersSet.add(LOADER_BY_TYPE[idx.modLoader]);
    }
    for (const f of mod.latestFiles ?? []) {
      for (const v of inferFileGameVersions(f, [])) versionsSet.add(v);
      for (const l of inferFileLoaders(f, [])) loadersSet.add(l);
    }
    return {
      id: String(mod.id),
      provider: "curseforge",
      projectType,
      title: mod.name,
      slug: mod.slug,
      author: mod.authors?.[0]?.name,
      summary: mod.summary ?? "",
      body: descRes.data || mod.summary || "",
      bodyFormat: "html",
      iconUrl: mod.logo?.thumbnailUrl || mod.logo?.url || undefined,
      downloads: mod.downloadCount,
      follows: mod.favoriteCount ?? mod.thumbsUpCount,
      datePublished: mod.dateReleased,
      dateModified: latestModDate(mod),
      categories: (mod.categories ?? []).map((c) => c.name).filter(Boolean),
      gameVersions: [...versionsSet],
      loaders: [...loadersSet],
      gallery: (mod.screenshots ?? [])
        .map((s) => ({ url: s.url || s.thumbnailUrl || "", title: s.title || undefined, description: s.description || undefined }))
        .filter((s) => Boolean(s.url)),
      websiteUrl: mod.links?.websiteUrl || undefined,
      sourceUrl: mod.links?.sourceUrl || undefined,
      issuesUrl: mod.links?.issuesUrl || undefined,
      wikiUrl: mod.links?.wikiUrl || undefined,
      distributionBlocked: mod.allowModDistribution === false
    };
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
    const mods = await this.getModsByIds(modIds);
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
