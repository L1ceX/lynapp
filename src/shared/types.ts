export type ModLoader = "vanilla" | "fabric" | "forge" | "quilt" | "neoforge";

export type ModProvider = "modrinth";

export type ModrinthProjectType = "mod" | "resourcepack" | "shader" | "datapack" | "modpack";

export interface InstalledMod {
  id: string;
  provider: ModProvider;
  projectId: string;
  versionId?: string;
  name: string;
  slug?: string;
  fileName?: string;
  iconUrl?: string;
  installedAt: string;
  status: "installed" | "queued" | "failed";
  projectType?: ModrinthProjectType;
}

export interface LauncherInstance {
  id: string;
  name: string;
  gameVersion: string;
  loader: ModLoader;
  loaderVersion?: string;
  directory: string;
  icon: string;
  javaPath?: string;
  maxMemoryMb?: number;
  extraJvmArgs?: string;
  createdAt: string;
  updatedAt: string;
  mods: InstalledMod[];
}

export interface LauncherSettings {
  javaPath: string;
  javaPaths: Record<string, string>;
  maxMemoryMb: number;
  extraJvmArgs: string;
  launcherDataDir: string;
  concurrentDownloads: number;
  closeOnLaunch: boolean;
  microsoftClientId: string;
  theme: Record<string, string>;
  glowEnabled: boolean;
  glowSize: number;
  glowSpeed: number;
  animationsEnabled: boolean;
  activeSkinId: string | null;
}

export interface SkinMeta {
  id: string;
  name: string;
  slim: boolean;
  addedAt: string;
}

export interface SkinInfo extends SkinMeta {
  dataUrl: string;
}

export interface CapeInfo {
  id: string;
  alias: string;
  url: string;
  active: boolean;
}

export interface AccountState {
  id: string;
  kind: "microsoft" | "offline" | "ely";
  status: "signed-out" | "pending" | "signed-in" | "offline";
  profileName?: string;
  minecraftUuid?: string;
  expiresAt?: string;
  message?: string;
  userCode?: string;
  verificationUri?: string;
  loginExpiresAt?: string;
  minecraftAccessToken?: string;
  microsoftRefreshToken?: string;
  elyAccessToken?: string;
  elyClientToken?: string;
  activeSkinId?: string | null;
  addedAt?: string;
}

export interface AccountsState {
  accounts: AccountState[];
  activeAccountId: string | null;
}

export type UpdateStatusKind = "available" | "downloading" | "ready" | "error";

export interface UpdateStatus {
  kind: UpdateStatusKind;
  version?: string;
  percent?: number;
  message?: string;
}

export interface BootstrapState {
  settings: LauncherSettings;
  instances: LauncherInstance[];
  activeInstanceId: string | null;
  accounts: AccountState[];
  activeAccountId: string | null;
  storagePath: string;
  javaCandidates: string[];
}

export interface JavaRuntimeState {
  requiredMajor: number;
  major: number;
  path: string;
  source: "configured" | "system" | "downloaded";
  installedNow: boolean;
  message: string;
}

export interface JavaInstallation {
  major: number;
  path: string;
  valid: boolean;
  source: "configured" | "system" | "downloaded" | "missing";
  message: string;
}

export type LocalContentKind = "mod" | "resourcepack" | "shader" | "datapack";

export interface LocalContentItem {
  kind: LocalContentKind;
  fileName: string;
  displayName: string;
  iconUrl?: string;
  size: number;
  modified: string;
  enabled: boolean;
  source: "modrinth" | "manual" | "missing";
}

export interface ModSearchResult {
  id: string;
  provider: ModProvider;
  title: string;
  slug?: string;
  author?: string;
  summary: string;
  iconUrl?: string;
  downloads?: number;
  follows?: number;
  dateModified?: string;
  categories: string[];
  projectType: ModrinthProjectType;
}

export type ModSortIndex = "relevance" | "downloads" | "follows" | "newest" | "updated";

export interface ModSearchResponse {
  results: ModSearchResult[];
  totalHits: number;
}

export interface LoginStartResult {
  status: "missing-client-id" | "signed-in" | "failed";
  message: string;
}

export interface LaunchResult {
  ok: boolean;
  message: string;
  logPath?: string;
  pid?: number;
  java?: JavaRuntimeState;
}
