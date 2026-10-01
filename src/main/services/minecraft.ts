import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AccountState, LauncherInstance, ModLoader } from "@shared/types";
import { getLauncherRoot } from "../paths";
import { getRequiredJavaMajor as fallbackJavaMajor } from "./java";

const execFileAsync = promisify(execFile);
const versionManifestUrl = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const assetObjectRoot = "https://resources.download.minecraft.net";

interface DownloadInfo {
  sha1?: string;
  size?: number;
  url: string;
  path?: string;
}

interface VersionManifest {
  versions: Array<{
    id: string;
    type: string;
    url: string;
    releaseTime: string;
  }>;
}

interface Rule {
  action: "allow" | "disallow";
  os?: {
    name?: string;
    arch?: string;
  };
  features?: Record<string, boolean>;
}

type ArgumentEntry =
  | string
  | {
      rules?: Rule[];
      value: string | string[];
    };

interface VersionJson {
  id: string;
  type: string;
  mainClass: string;
  inheritsFrom?: string;
  javaVersion?: {
    component?: string;
    majorVersion?: number;
  };
  assets?: string;
  assetIndex: {
    id: string;
    sha1?: string;
    url: string;
  };
  downloads: {
    client: DownloadInfo;
  };
  libraries: Array<{
    name?: string;
    url?: string;
    downloads?: {
      artifact?: DownloadInfo;
      classifiers?: Record<string, DownloadInfo>;
    };
    natives?: {
      windows?: string;
    };
    rules?: Rule[];
  }>;
  arguments?: {
    game?: ArgumentEntry[];
    jvm?: ArgumentEntry[];
  };
  minecraftArguments?: string;
}

interface AssetIndex {
  objects: Record<
    string,
    {
      hash: string;
      size: number;
    }
  >;
}

export interface PreparedMinecraftLaunch {
  mainClass: string;
  args: string[];
  classpath: string;
  nativesDir: string;
  logPath: string;
  warning?: string;
}

function getMinecraftRoot(): string {
  return path.join(getLauncherRoot(), "minecraft");
}

function getVersionsRoot(): string {
  return path.join(getMinecraftRoot(), "versions");
}

function getLibrariesRoot(): string {
  return path.join(getMinecraftRoot(), "libraries");
}

function getAssetsRoot(): string {
  return path.join(getMinecraftRoot(), "assets");
}

function getNativesRoot(versionId: string): string {
  return path.join(getMinecraftRoot(), "natives", versionId);
}

function getVersionDir(versionId: string): string {
  return path.join(getVersionsRoot(), versionId);
}

function pathExists(filePath: string): boolean {
  return existsSync(filePath);
}

async function sha1File(filePath: string): Promise<string> {
  const hash = createHash("sha1");
  hash.update(await readFile(filePath));
  return hash.digest("hex");
}

async function isValidDownload(filePath: string, expectedSha1?: string): Promise<boolean> {
  if (!pathExists(filePath)) {
    return false;
  }

  if (!expectedSha1) {
    return true;
  }

  return (await sha1File(filePath)).toLowerCase() === expectedSha1.toLowerCase();
}

async function downloadFile(url: string, filePath: string, expectedSha1?: string): Promise<void> {
  if (await isValidDownload(filePath, expectedSha1)) {
    return;
  }

  await mkdir(path.dirname(filePath), { recursive: true });

  const response = await fetch(url, {
    headers: {
      "user-agent": "lynapp/1.0.0"
    }
  });

  if (!response.ok) {
    throw new Error(`Download failed with HTTP ${response.status}: ${url}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(filePath, buffer);

  if (!(await isValidDownload(filePath, expectedSha1))) {
    throw new Error(`Downloaded file checksum mismatch: ${filePath}`);
  }
}

async function downloadJson<T>(url: string, filePath: string, expectedSha1?: string): Promise<T> {
  await downloadFile(url, filePath, expectedSha1);
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "lynapp/1.0.0"
    }
  });

  if (!response.ok) {
    throw new Error(`Request failed with HTTP ${response.status}: ${url}`);
  }

  return response.text();
}

function parseMavenVersions(metadataXml: string): string[] {
  return [...metadataXml.matchAll(/<version>([^<]+)<\/version>/g)].map((match) => match[1]);
}

const loaderVersionsCache = new Map<string, { at: number; versions: string[] }>();

async function getCachedLoaderVersions(key: string, loader: () => Promise<string[]>): Promise<string[]> {
  const cached = loaderVersionsCache.get(key);
  if (cached && Date.now() - cached.at < manifestCacheTtlMs) {
    return cached.versions;
  }

  let versions: string[] = [];
  try {
    versions = await loader();
  } catch {
    versions = [];
  }
  loaderVersionsCache.set(key, { at: Date.now(), versions });
  return versions;
}

async function listFabricLoaderVersions(gameVersion: string): Promise<string[]> {
  const response = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${gameVersion}`, {
    headers: { "user-agent": "lynapp/1.0.0" }
  });
  if (!response.ok) {
    throw new Error(`Fabric loader versions returned ${response.status}`);
  }
  const list = (await response.json()) as Array<{ loader?: { version?: string } }>;
  return list.map((item) => item.loader?.version).filter((item): item is string => Boolean(item));
}

async function listQuiltLoaderVersions(gameVersion: string): Promise<string[]> {
  const response = await fetch(`https://meta.quiltmc.org/v3/versions/loader/${gameVersion}`, {
    headers: { "user-agent": "lynapp/1.0.0" }
  });
  if (!response.ok) {
    throw new Error(`Quilt loader versions returned ${response.status}`);
  }
  const list = (await response.json()) as Array<{ loader?: { version?: string }; version?: string }>;
  return list.map((item) => item.loader?.version ?? item.version).filter((item): item is string => Boolean(item));
}

async function listForgeLoaderVersions(gameVersion: string): Promise<string[]> {
  const metadata = await fetchText("https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml");
  return parseMavenVersions(metadata).filter((item) => item.startsWith(`${gameVersion}-`));
}

async function listNeoForgeLoaderVersions(gameVersion: string): Promise<string[]> {
  const prefix = neoForgePrefixForGameVersion(gameVersion);
  if (!prefix) {
    return [];
  }
  const metadata = await fetchText("https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml");
  return parseMavenVersions(metadata).filter((item) => item.startsWith(prefix));
}

function parseGameVersion(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version.trim());
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? "0")];
}

function isGameVersionAtLeast(version: string, major: number, minor: number, patch: number): boolean {
  const [a, b, c] = parseGameVersion(version);
  if (a !== major) return a > major;
  if (b !== minor) return b > minor;
  return c >= patch;
}

async function getFabricGameVersions(): Promise<string[]> {
  try {
    const response = await fetch("https://meta.fabricmc.net/v2/versions/game", {
      headers: { "user-agent": "lynapp/1.0.0" }
    });
    if (!response.ok) return [];
    const list = (await response.json()) as Array<{ version?: string }>;
    return list.map((item) => item.version).filter((item): item is string => Boolean(item));
  } catch {
    return [];
  }
}

async function getQuiltGameVersions(): Promise<string[]> {
  try {
    const response = await fetch("https://meta.quiltmc.org/v3/versions/game", {
      headers: { "user-agent": "lynapp/1.0.0" }
    });
    if (!response.ok) return [];
    const list = (await response.json()) as Array<{ version?: string }>;
    return list.map((item) => item.version).filter((item): item is string => Boolean(item));
  } catch {
    return [];
  }
}

async function getForgeGameVersions(releases: string[]): Promise<string[]> {
  try {
    const metadata = await fetchText("https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml");
    const forgeVersions = parseMavenVersions(metadata);
    return releases.filter((release) => forgeVersions.some((item) => item.startsWith(`${release}-`)));
  } catch {
    return [];
  }
}

async function getNeoForgeGameVersions(releases: string[]): Promise<string[]> {
  try {
    const metadata = await fetchText("https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml");
    const builds = parseMavenVersions(metadata);
    return releases.filter((release) => {
      const prefix = neoForgePrefixForGameVersion(release);
      return prefix ? builds.some((item) => item.startsWith(prefix)) : false;
    });
  } catch {
    return [];
  }
}

export type LoaderSupportMap = Record<Exclude<ModLoader, "vanilla">, string[]>;

let loaderSupportCache: { at: number; map: LoaderSupportMap } | null = null;

async function getLoaderSupportMap(): Promise<LoaderSupportMap> {
  if (loaderSupportCache && Date.now() - loaderSupportCache.at < manifestCacheTtlMs) {
    return loaderSupportCache.map;
  }

  const manifest = await getManifest();
  const releases = manifest.versions.filter((item) => item.type === "release").map((item) => item.id);
  const [fabricLive, quiltLive, forgeLive, neoforgeLive] = await Promise.all([
    getFabricGameVersions(),
    getQuiltGameVersions(),
    getForgeGameVersions(releases),
    getNeoForgeGameVersions(releases)
  ]);

  const fabricSet = new Set(fabricLive);
  const quiltSet = new Set(quiltLive);
  const map: LoaderSupportMap = {
    fabric: fabricLive.length ? releases.filter((item) => fabricSet.has(item)) : releases.filter((item) => isGameVersionAtLeast(item, 1, 14, 0)),
    quilt: quiltLive.length ? releases.filter((item) => quiltSet.has(item)) : releases.filter((item) => isGameVersionAtLeast(item, 1, 14, 0)),
    forge: forgeLive.length ? forgeLive : releases,
    neoforge: neoforgeLive.length ? neoforgeLive : releases.filter((item) => isGameVersionAtLeast(item, 1, 20, 1))
  };

  loaderSupportCache = { at: Date.now(), map };
  return map;
}

async function mapLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
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

const enabledFeatures: Record<string, boolean> = {
  is_demo_user: false,
  has_custom_resolution: false,
  has_quick_plays_support: false,
  is_quick_play_singleplayer: false,
  is_quick_play_multiplayer: false,
  is_quick_play_realms: false
};

function ruleApplies(rule: Rule): boolean {
  if (rule.os) {
    if (rule.os.name && rule.os.name !== "windows") {
      return false;
    }

    if (rule.os.arch && rule.os.arch !== process.arch) {
      return false;
    }
  }

  if (rule.features) {
    for (const [feature, expected] of Object.entries(rule.features)) {
      if ((enabledFeatures[feature] ?? false) !== expected) {
        return false;
      }
    }
  }

  return true;
}

function isAllowed(rules?: Rule[]): boolean {
  if (!rules?.length) {
    return true;
  }

  let allowed = false;

  for (const rule of rules) {
    if (ruleApplies(rule)) {
      allowed = rule.action === "allow";
    }
  }

  return allowed;
}

function normalizePath(input: string): string {
  return input.replace(/\//g, path.sep);
}

function mavenPath(name: string): string {
  const [group, artifact, version, classifierWithExt] = name.split(":");
  const classifier = classifierWithExt?.replace("@jar", "");
  const fileName = `${artifact}-${version}${classifier ? `-${classifier}` : ""}.jar`;
  return path.join(...group.split("."), artifact, version, fileName);
}

function mavenUrl(baseUrl: string, name: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${mavenPath(name).replace(/\\/g, "/")}`;
}

const legacyLibrariesRoot = "https://libraries.minecraft.net";

function mavenClassifierPath(name: string, classifier: string): string {
  const [group, artifact, version] = name.split(":");
  const fileName = `${artifact}-${version}-${classifier}.jar`;
  return path.join(...group.split("."), artifact, version, fileName);
}

function legacyMavenUrl(name: string, classifier?: string): string {
  const rel = classifier ? mavenClassifierPath(name, classifier) : mavenPath(name);
  return `${legacyLibrariesRoot}/${rel.replace(/\\/g, "/")}`;
}

function libraryIdentity(library: VersionJson["libraries"][number]): string | null {
  if (!library.name) {
    return null;
  }

  const [group, artifact, , classifierWithExt] = library.name.split(":");
  if (!group || !artifact) {
    return null;
  }

  const classifier = classifierWithExt?.replace(/@.+$/, "");
  return `${group}:${artifact}${classifier ? `:${classifier}` : ""}`;
}

function mergeLoaderLibraries(
  vanillaLibraries: VersionJson["libraries"],
  loaderLibraries: VersionJson["libraries"]
): VersionJson["libraries"] {
  const result = [...vanillaLibraries];
  const indexes = new Map<string, number>();

  result.forEach((library, index) => {
    const identity = libraryIdentity(library);
    if (identity) {
      indexes.set(identity, index);
    }
  });

  for (const library of loaderLibraries) {
    const identity = libraryIdentity(library);
    const existingIndex = identity ? indexes.get(identity) : undefined;

    if (existingIndex === undefined) {
      if (identity) {
        indexes.set(identity, result.length);
      }
      result.push(library);
      continue;
    }

    result[existingIndex] = library;
  }

  return result;
}

function getNativesClassifier(template?: string): string | null {
  if (!template) {
    return null;
  }

  return template.replace("${arch}", process.arch === "ia32" ? "32" : "64");
}

async function extractNativeJar(jarPath: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });

  try {
    await execFileAsync("tar.exe", ["-xf", jarPath, "-C", destination], {
      windowsHide: true,
      timeout: 60000
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Native library extraction failed: ${message}`);
  }
}

function addArgument(target: string[], value: string | string[], variables: Record<string, string>): void {
  const values = Array.isArray(value) ? value : [value];

  for (const item of values) {
    target.push(replaceVariables(item, variables));
  }
}

function collectArguments(entries: ArgumentEntry[] | undefined, variables: Record<string, string>): string[] {
  const result: string[] = [];

  for (const entry of entries ?? []) {
    if (typeof entry === "string") {
      addArgument(result, entry, variables);
      continue;
    }

    if (isAllowed(entry.rules)) {
      addArgument(result, entry.value, variables);
    }
  }

  return result;
}

function replaceVariables(input: string, variables: Record<string, string>): string {
  return input.replace(/\$\{([^}]+)\}/g, (_match, key: string) => variables[key] ?? "");
}

function getOfflineUuid(name: string): string {
  const bytes = createHash("md5").update(`OfflinePlayer:${name}`).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes.toString("hex");
}

function getPlayerName(account: AccountState): string {
  return account.profileName || "Player";
}

function getAccessToken(account: AccountState): string {
  if (account.status === "offline") {
    return "0";
  }

  if (account.status !== "signed-in" || !account.minecraftAccessToken) {
    throw new Error("Sign in with Microsoft or select an offline profile before launching Minecraft.");
  }

  return account.minecraftAccessToken;
}

const manifestCacheTtlMs = 6 * 60 * 60 * 1000;

async function getManifest(): Promise<VersionManifest> {
  const manifestPath = path.join(getVersionsRoot(), "version_manifest_v2.json");

  try {
    const response = await fetch(versionManifestUrl, {
      headers: {
        "user-agent": "lynapp/1.0.0"
      }
    });
    if (!response.ok) {
      throw new Error(`Version manifest returned HTTP ${response.status}`);
    }
    const manifest = (await response.json()) as VersionManifest;
    if (!Array.isArray(manifest.versions)) {
      throw new Error("Version manifest has an unexpected shape");
    }
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    return manifest;
  } catch {
    try {
      return JSON.parse(await readFile(manifestPath, "utf8")) as VersionManifest;
    } catch {
      throw new Error("Could not load the Minecraft version list (offline and no cache yet)");
    }
  }
}

async function getVersionJson(gameVersion: string): Promise<VersionJson> {
  const manifest = await getManifest();
  const version = manifest.versions.find((item) => item.id === gameVersion);

  if (!version) {
    throw new Error(`Minecraft version not found in Mojang manifest: ${gameVersion}`);
  }

  return downloadJson<VersionJson>(version.url, path.join(getVersionDir(gameVersion), `${gameVersion}.json`));
}

async function prepareClientJar(version: VersionJson): Promise<string> {
  const clientPath = path.join(getVersionDir(version.id), `${version.id}.jar`);
  await downloadFile(version.downloads.client.url, clientPath, version.downloads.client.sha1);
  return clientPath;
}

async function prepareLibraries(version: VersionJson, nativesDir: string): Promise<string[]> {
  const classpath: string[] = [];

  for (const library of version.libraries) {
    if (!isAllowed(library.rules)) {
      continue;
    }

    const artifact = library.downloads?.artifact;

    if (artifact?.path) {
      const artifactPath = path.join(getLibrariesRoot(), normalizePath(artifact.path));
      await downloadFile(artifact.url, artifactPath, artifact.sha1);
      classpath.push(artifactPath);
    } else if (library.name && library.url) {
      const artifactPath = path.join(getLibrariesRoot(), mavenPath(library.name));
      await downloadFile(mavenUrl(library.url, library.name), artifactPath);
      classpath.push(artifactPath);
    } else if (library.name && !library.natives) {
      const artifactPath = path.join(getLibrariesRoot(), mavenPath(library.name));
      if (!pathExists(artifactPath)) {
        await downloadFile(legacyMavenUrl(library.name), artifactPath);
      }
      classpath.push(artifactPath);
    }

    const classifier = getNativesClassifier(library.natives?.windows);
    const nativeDownload = classifier ? library.downloads?.classifiers?.[classifier] : undefined;

    if (classifier && nativeDownload && (nativeDownload.path || nativeDownload.url)) {
      const nativePath = nativeDownload.path
        ? path.join(getLibrariesRoot(), normalizePath(nativeDownload.path))
        : path.join(getLibrariesRoot(), mavenClassifierPath(library.name ?? "", classifier));
      if (!nativeDownload.path && !library.name) {
        throw new Error(`Native library is missing and has no download URL (${classifier})`);
      }
      const nativeUrl = nativeDownload.url ?? legacyMavenUrl(library.name ?? "", classifier);
      await downloadFile(nativeUrl, nativePath, nativeDownload.sha1);
      await extractNativeJar(nativePath, nativesDir);
    }
  }

  return classpath;
}

type PartialVersionJson = Partial<VersionJson> & {
  id?: string;
  inheritsFrom?: string;
  libraries?: VersionJson["libraries"];
};

function mergeArguments(
  parent?: VersionJson["arguments"],
  child?: VersionJson["arguments"]
): VersionJson["arguments"] | undefined {
  if (!parent && !child) {
    return undefined;
  }

  return {
    game: [...(parent?.game ?? []), ...(child?.game ?? [])],
    jvm: [...(parent?.jvm ?? []), ...(child?.jvm ?? [])]
  };
}

function mergeVersionProfile(parent: VersionJson, profile: PartialVersionJson, id: string): VersionJson {
  return {
    ...parent,
    id,
    type: profile.type ?? parent.type,
    mainClass: profile.mainClass ?? parent.mainClass,
    assets: profile.assets ?? parent.assets,
    assetIndex: profile.assetIndex ?? parent.assetIndex,
    downloads: profile.downloads ?? parent.downloads,
    libraries: mergeLoaderLibraries(parent.libraries, profile.libraries ?? []),
    arguments: mergeArguments(parent.arguments, profile.arguments),
    minecraftArguments: profile.minecraftArguments ?? parent.minecraftArguments,
    inheritsFrom: profile.inheritsFrom ?? parent.inheritsFrom
  };
}

async function getFabricLoaderVersion(requested?: string): Promise<string> {
  if (requested?.trim()) {
    return requested.trim();
  }

  const response = await fetch("https://meta.fabricmc.net/v2/versions/loader", {
    headers: { "user-agent": "lynapp/1.0.0" }
  });
  if (!response.ok) {
    throw new Error(`Fabric loader versions returned ${response.status}`);
  }

  const versions = (await response.json()) as Array<{ version: string; stable: boolean }>;
  const latest = versions.find((item) => item.stable) ?? versions[0];
  if (!latest) {
    throw new Error("Fabric loader version list is empty.");
  }

  return latest.version;
}

async function applyFabricProfile(version: VersionJson, instance: LauncherInstance): Promise<VersionJson> {
  const loaderVersion = await getFabricLoaderVersion(instance.loaderVersion);
  const profileUrl = `https://meta.fabricmc.net/v2/versions/loader/${instance.gameVersion}/${loaderVersion}/profile/json`;
  const profilePath = path.join(getVersionsRoot(), `fabric-${instance.gameVersion}-${loaderVersion}.json`);
  const profile = await downloadJson<PartialVersionJson>(profileUrl, profilePath);

  return mergeVersionProfile(version, profile, `fabric-${instance.gameVersion}-${loaderVersion}`);
}

async function getQuiltLoaderVersion(gameVersion: string, requested?: string): Promise<string> {
  if (requested?.trim()) {
    return requested.trim();
  }

  const response = await fetch(`https://meta.quiltmc.org/v3/versions/loader/${gameVersion}`, {
    headers: { "user-agent": "lynapp/1.0.0" }
  });
  if (!response.ok) {
    throw new Error(`Quilt loader versions returned ${response.status}`);
  }

  const versions = (await response.json()) as Array<{ loader?: { version?: string }; version?: string }>;
  const all = versions.map((item) => item.loader?.version ?? item.version).filter((item): item is string => Boolean(item));
  const latest = all.find((item) => !item.includes("-")) ?? all[0];
  if (!latest) {
    throw new Error(`No Quilt loader found for Minecraft ${gameVersion}.`);
  }

  return latest;
}

async function applyQuiltProfile(version: VersionJson, instance: LauncherInstance): Promise<VersionJson> {
  const loaderVersion = await getQuiltLoaderVersion(instance.gameVersion, instance.loaderVersion);
  const profileUrl = `https://meta.quiltmc.org/v3/versions/loader/${instance.gameVersion}/${loaderVersion}/profile/json`;
  const profilePath = path.join(getVersionsRoot(), `quilt-${instance.gameVersion}-${loaderVersion}.json`);
  const profile = await downloadJson<PartialVersionJson>(profileUrl, profilePath);

  return mergeVersionProfile(version, profile, `quilt-${instance.gameVersion}-${loaderVersion}`);
}

function consoleJavaPath(javaPath: string): string {
  if (path.basename(javaPath).toLowerCase() !== "javaw.exe") {
    return javaPath;
  }

  const candidate = path.join(path.dirname(javaPath), "java.exe");
  return pathExists(candidate) ? candidate : javaPath;
}

async function ensureLauncherProfiles(): Promise<void> {
  const profilePath = path.join(getMinecraftRoot(), "launcher_profiles.json");
  if (pathExists(profilePath)) {
    try {
      JSON.parse(await readFile(profilePath, "utf8"));
      return;
    } catch {
    }
  }

  await mkdir(getMinecraftRoot(), { recursive: true });
  await writeFile(
    profilePath,
    JSON.stringify(
      {
        profiles: {},
        settings: {},
        version: 3
      },
      null,
      2
    ),
    "utf8"
  );
}

function installerErrorDetails(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const richError = error as Error & { stdout?: string; stderr?: string };
  const output = `${richError.stdout ?? ""}\n${richError.stderr ?? ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return output.slice(-20).join("\n") || error.message;
}

async function runClientInstaller(javaPath: string, installerPath: string, loader: "forge" | "neoforge"): Promise<void> {
  await mkdir(getMinecraftRoot(), { recursive: true });
  await ensureLauncherProfiles();

  const installFlag = loader === "neoforge" ? "--install-client" : "--installClient";
  try {
    await execFileAsync(consoleJavaPath(javaPath), ["-jar", installerPath, installFlag, getMinecraftRoot()], {
      cwd: getMinecraftRoot(),
      windowsHide: true,
      timeout: 15 * 60 * 1000,
      maxBuffer: 20 * 1024 * 1024
    });
  } catch (error) {
    throw new Error(`${loader} client installer failed:\n${installerErrorDetails(error)}`);
  }
}

function scoreInstalledProfile(
  loader: "forge" | "neoforge",
  gameVersion: string,
  loaderVersion: string,
  id: string,
  profile: PartialVersionJson
): number {
  const text = `${id} ${profile.inheritsFrom ?? ""}`.toLowerCase();
  const lowerLoaderVersion = loaderVersion.toLowerCase();
  const shortLoaderVersion = lowerLoaderVersion.includes("-")
    ? lowerLoaderVersion.split("-").slice(1).join("-")
    : lowerLoaderVersion;

  if (loader === "forge") {
    if (!text.includes("forge") || text.includes("neoforge")) {
      return -1;
    }
  } else if (!text.includes("neoforge")) {
    return -1;
  }

  if (profile.inheritsFrom && profile.inheritsFrom !== gameVersion) {
    return -1;
  }

  let score = 0;
  if (text.includes(gameVersion.toLowerCase())) score += 20;
  if (text.includes(lowerLoaderVersion)) score += 30;
  if (shortLoaderVersion && text.includes(shortLoaderVersion)) score += 15;
  if (profile.mainClass) score += 5;

  return score;
}

async function loadInstalledLoaderProfile(
  loader: "forge" | "neoforge",
  gameVersion: string,
  loaderVersion: string,
  vanillaVersion: VersionJson
): Promise<VersionJson> {
  await mkdir(getVersionsRoot(), { recursive: true });
  const entries = await readdir(getVersionsRoot(), { withFileTypes: true });
  let best: { id: string; profile: PartialVersionJson; score: number; mtimeMs: number } | null = null;

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const jsonPath = path.join(getVersionsRoot(), entry.name, `${entry.name}.json`);
    if (!pathExists(jsonPath)) {
      continue;
    }

    try {
      const profile = JSON.parse(await readFile(jsonPath, "utf8")) as PartialVersionJson;
      const id = profile.id ?? entry.name;
      const score = scoreInstalledProfile(loader, gameVersion, loaderVersion, id, profile);
      const fileStat = await stat(jsonPath);

      if (score >= 0 && (!best || score > best.score || (score === best.score && fileStat.mtimeMs > best.mtimeMs))) {
        best = { id, profile, score, mtimeMs: fileStat.mtimeMs };
      }
    } catch {
      continue;
    }
  }

  if (!best) {
    throw new Error(`${loader} installed profile was not found after installer finished.`);
  }

  const parent = best.profile.inheritsFrom ? await getVersionJson(best.profile.inheritsFrom) : vanillaVersion;
  return mergeVersionProfile(parent, best.profile, best.id);
}

async function getForgeLoaderVersion(gameVersion: string, requested?: string): Promise<string> {
  if (requested?.trim()) {
    const value = requested.trim();
    return value.startsWith(`${gameVersion}-`) ? value : `${gameVersion}-${value}`;
  }

  const metadata = await fetchText("https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml");
  const versions = parseMavenVersions(metadata).filter((version) => version.startsWith(`${gameVersion}-`));
  const latest = versions[versions.length - 1];
  if (!latest) {
    throw new Error(`No Forge loader found for Minecraft ${gameVersion}.`);
  }

  return latest;
}

async function applyForgeProfile(version: VersionJson, instance: LauncherInstance, javaPath: string): Promise<VersionJson> {
  const loaderVersion = await getForgeLoaderVersion(instance.gameVersion, instance.loaderVersion);
  const installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${loaderVersion}/forge-${loaderVersion}-installer.jar`;
  const installerPath = path.join(getMinecraftRoot(), "installers", `forge-${loaderVersion}-installer.jar`);

  await downloadFile(installerUrl, installerPath);
  await runClientInstaller(javaPath, installerPath, "forge");
  return loadInstalledLoaderProfile("forge", instance.gameVersion, loaderVersion, version);
}

function neoForgePrefixForGameVersion(gameVersion: string): string | null {
  const known: Record<string, string> = {
    "1.20.1": "47.1.",
    "1.20.2": "20.2."
  };
  if (known[gameVersion]) {
    return known[gameVersion];
  }

  const legacy = /^1\.(\d+)\.(\d+)$/.exec(gameVersion);

  if (legacy) {
    return `${legacy[1]}.${legacy[2]}.`;
  }

  const modern = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(gameVersion.trim());

  if (modern) {
    return `${modern[1]}.${modern[2]}.`;
  }

  return null;
}

async function getNeoForgeLoaderVersion(gameVersion: string, requested?: string): Promise<string> {
  if (requested?.trim()) {
    return requested.trim();
  }

  const prefix = neoForgePrefixForGameVersion(gameVersion);
  if (!prefix) {
    throw new Error(`NeoForge version mapping is unknown for Minecraft ${gameVersion}.`);
  }

  const metadata = await fetchText("https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml");
  const versions = parseMavenVersions(metadata).filter((version) => version.startsWith(prefix));
  const latest = versions[versions.length - 1];
  if (!latest) {
    throw new Error(`No NeoForge loader found for Minecraft ${gameVersion}.`);
  }

  return latest;
}

async function applyNeoForgeProfile(version: VersionJson, instance: LauncherInstance, javaPath: string): Promise<VersionJson> {
  const loaderVersion = await getNeoForgeLoaderVersion(instance.gameVersion, instance.loaderVersion);
  const installerUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`;
  const installerPath = path.join(getMinecraftRoot(), "installers", `neoforge-${loaderVersion}-installer.jar`);

  await downloadFile(installerUrl, installerPath);
  await runClientInstaller(javaPath, installerPath, "neoforge");
  return loadInstalledLoaderProfile("neoforge", instance.gameVersion, loaderVersion, version);
}

async function applyLoaderProfile(version: VersionJson, instance: LauncherInstance, javaPath: string): Promise<VersionJson> {
  switch (instance.loader) {
    case "vanilla":
      return version;
    case "fabric":
      return applyFabricProfile(version, instance);
    case "quilt":
      return applyQuiltProfile(version, instance);
    case "forge":
      return applyForgeProfile(version, instance, javaPath);
    case "neoforge":
      return applyNeoForgeProfile(version, instance, javaPath);
    default:
      return version;
  }
}

async function prepareAssets(version: VersionJson): Promise<void> {
  const indexesDir = path.join(getAssetsRoot(), "indexes");
  const objectsDir = path.join(getAssetsRoot(), "objects");
  const indexPath = path.join(indexesDir, `${version.assetIndex.id}.json`);
  const assetIndex = await downloadJson<AssetIndex>(version.assetIndex.url, indexPath, version.assetIndex.sha1);

  await mapLimit(Object.values(assetIndex.objects), 12, async (asset) => {
    const prefix = asset.hash.slice(0, 2);
    const assetPath = path.join(objectsDir, prefix, asset.hash);
    const url = `${assetObjectRoot}/${prefix}/${asset.hash}`;
    await downloadFile(url, assetPath, asset.hash);
  });
}

function buildLaunchArgs(
  version: VersionJson,
  instance: LauncherInstance,
  account: AccountState,
  javaMemory: { memoryMb: number },
  paths: {
    classpath: string;
    nativesDir: string;
  }
): string[] {
  const playerName = getPlayerName(account);
  const uuid = account.minecraftUuid || getOfflineUuid(playerName);
  const accessToken = getAccessToken(account);
  const offline = account.status === "offline";
  const variables: Record<string, string> = {
    auth_player_name: playerName,
    version_name: version.id,
    game_directory: instance.directory,
    assets_root: getAssetsRoot(),
    assets_index_name: version.assetIndex.id || version.assets || version.id,
    auth_uuid: uuid,
    auth_access_token: accessToken,
    clientid: offline ? "" : "lynapp",
    auth_xuid: offline ? "" : "0",
    user_type: offline ? "legacy" : "msa",
    version_type: version.type,
    natives_directory: paths.nativesDir,
    launcher_name: "lynapp",
    launcher_version: "1.0.0",
    classpath: paths.classpath,
    classpath_separator: ";",
    library_directory: getLibrariesRoot(),
    user_properties: "{}",
    game_assets: getAssetsRoot(),
    auth_session: accessToken
  };
  const jvmArgs = version.arguments?.jvm
    ? collectArguments(version.arguments.jvm, variables)
    : ["-Djava.library.path=${natives_directory}", "-cp", "${classpath}"].map((item) => replaceVariables(item, variables));
  const gameArgs = version.arguments?.game
    ? collectArguments(version.arguments.game, variables)
    : (version.minecraftArguments ?? "").split(" ").filter(Boolean).map((item) => replaceVariables(item, variables));

  return [`-Xms${javaMemory.memoryMb}M`, `-Xmx${javaMemory.memoryMb}M`, ...jvmArgs, version.mainClass, ...gameArgs];
}

export class MinecraftService {
  
  async getRequiredJavaMajor(gameVersion: string): Promise<number> {
    try {
      const version = await getVersionJson(gameVersion);
      const major = version.javaVersion?.majorVersion;
      if (typeof major === "number" && Number.isFinite(major) && major >= 8 && major <= 30) {
        return Math.floor(major);
      }
    } catch {
    }
    return fallbackJavaMajor(gameVersion);
  }

  async listReleaseVersions(): Promise<string[]> {
    const manifest = await getManifest();
    return manifest.versions.filter((item) => item.type === "release").map((item) => item.id);
  }

  async assertVersionExists(gameVersion: string): Promise<void> {
    const manifest = await getManifest();

    if (!manifest.versions.some((item) => item.id === gameVersion)) {
      throw new Error(`Minecraft version "${gameVersion}" does not exist. Pick one from the list.`);
    }
  }

  async getLoaderSupport(): Promise<LoaderSupportMap> {
    return getLoaderSupportMap();
  }

  async listLoaderVersions(loader: ModLoader, gameVersion: string): Promise<string[]> {
    switch (loader) {
      case "fabric":
        return getCachedLoaderVersions(`fabric:${gameVersion}`, () => listFabricLoaderVersions(gameVersion));
      case "quilt":
        return getCachedLoaderVersions(`quilt:${gameVersion}`, () => listQuiltLoaderVersions(gameVersion));
      case "forge":
        return getCachedLoaderVersions(`forge:${gameVersion}`, () => listForgeLoaderVersions(gameVersion));
      case "neoforge":
        return getCachedLoaderVersions(`neoforge:${gameVersion}`, () => listNeoForgeLoaderVersions(gameVersion));
      default:
        return [];
    }
  }

  async assertLoaderCompatible(loader: ModLoader, gameVersion: string): Promise<void> {
    if (loader === "vanilla") return;
    const support = await getLoaderSupportMap();

    if (!support[loader]?.includes(gameVersion)) {
      throw new Error(`Loader "${loader}" does not support Minecraft ${gameVersion}. Pick a compatible combination.`);
    }

    const versions = await this.listLoaderVersions(loader, gameVersion);
    if (!versions.length) {
      throw new Error(`No ${loader} releases for Minecraft ${gameVersion} yet. Try another loader or version.`);
    }
  }

  async prepareLaunch(
    instance: LauncherInstance,
    account: AccountState,
    javaMemory: { memoryMb: number },
    javaPath: string
  ): Promise<PreparedMinecraftLaunch> {
    await mkdir(instance.directory, { recursive: true });

    const vanillaVersion = await getVersionJson(instance.gameVersion);
    const version = await applyLoaderProfile(vanillaVersion, instance, javaPath);
    const nativesDir = getNativesRoot(version.id);
    const clientJar = await prepareClientJar(vanillaVersion);
    const libraryClasspath = await prepareLibraries(version, nativesDir);
    await prepareAssets(version);

    const classpath = [...libraryClasspath, clientJar].join(";");
    const args = buildLaunchArgs(version, instance, account, javaMemory, {
      classpath,
      nativesDir
    });
    const logPath = path.join(instance.directory, ".launcher", "logs", "latest.log");
    await mkdir(path.dirname(logPath), { recursive: true });

    return {
      mainClass: version.mainClass,
      args,
      classpath,
      nativesDir,
      logPath
    };
  }
}
