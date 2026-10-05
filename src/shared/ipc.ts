import type {
  AccountsState,
  BootstrapState,
  CapeInfo,
  JavaInstallation,
  LaunchResult,
  LauncherInstance,
  LauncherSettings,
  LocalContentItem,
  LoginStartResult,
  ModLoader,
  ModProvider,
  ModrinthProjectType,
  ModSearchResponse,
  ModSortIndex,
  SkinInfo,
  UpdateStatus
} from "./types";

export const IPC = {
  bootstrap: "launcher:bootstrap",
  createInstance: "instances:create",
  updateInstance: "instances:update",
  removeInstance: "instances:remove",
  importMrpackStart: "instances:import-mrpack-start",
  importMrpackFiles: "instances:import-mrpack-files",
  mrpackProgress: "instances:mrpack-progress",
  launchInstance: "instances:launch",
  updateSettings: "settings:update",
  searchMods: "mods:search",
  installMod: "mods:install",
  beginMicrosoftLogin: "auth:microsoft:begin",
  refreshSession: "auth:refresh",
  elyLogin: "auth:ely",
  useOfflineProfile: "auth:offline",
  setActiveAccount: "auth:set-active",
  removeAccount: "auth:remove",
  openExternal: "shell:open-external",
  getJavaInstallations: "java:list",
  installJava: "java:install",
  detectJava: "java:detect",
  browseJava: "java:browse",
  getGameVersions: "versions:list",
  getCategoryTags: "tags:categories",
  getLoaderSupport: "loaders:support",
  getLoaderVersions: "loaders:versions",
  openInstanceFolder: "instances:open-folder",
  getLocalContent: "content:list",
  toggleLocalContent: "content:toggle",
  removeLocalContent: "content:remove",
  getRunningInstances: "instances:running",
  stopInstance: "instances:stop",
  cancelLaunch: "instances:cancel-launch",
  windowMinimize: "window:minimize",
  windowToggleMaximize: "window:toggle-maximize",
  windowClose: "window:close",
  windowIsMaximized: "window:is-maximized",
  windowMaximized: "window:maximized",
  listSkins: "skins:list",
  elySkin: "skins:ely",
  addSkin: "skins:add",
  updateSkin: "skins:update",
  removeSkin: "skins:remove",
  activateSkin: "skins:activate",
  listCapes: "skins:capes",
  equipCape: "skins:equip-cape",
  updaterDownload: "updater:download",
  updaterInstall: "updater:install",
  updaterStatus: "updater:status"
} as const;

export interface CreateInstancePayload {
  name: string;
  gameVersion: string;
  loader: ModLoader;
  loaderVersion?: string;
}

export interface UpdateInstancePayload {
  id: string;
  patch: Partial<Pick<LauncherInstance, "name" | "gameVersion" | "loader" | "javaPath" | "maxMemoryMb" | "extraJvmArgs" | "loaderVersion">>;
}

export interface ModSearchPayload {
  query: string;
  instanceId?: string;
  projectType: ModrinthProjectType;
  sort?: ModSortIndex;
  limit?: number;
  offset?: number;
  categories?: string[];
  versions?: string[];
  loaders?: string[];
}

export interface InstallModPayload {
  instanceId: string;
  provider: ModProvider;
  projectId: string;
  versionId?: string;
  name: string;
  slug?: string;
  iconUrl?: string;
  projectType: ModrinthProjectType;
}

export interface LocalContentPayload {
  instanceId: string;
  fileName: string;
}

export interface SkinAddPayload {
  name: string;
  dataUrl: string;
  slim: boolean;
}

export interface SkinUpdatePayload {
  id: string;
  patch: Partial<Pick<SkinInfo, "name" | "slim">>;
}

export interface SkinActivateResult {
  activeSkinId: string;
  uploaded: boolean;
}

export interface MrpackBeginResult {
  instance: LauncherInstance;
  totalFiles: number;
}

export interface MrpackProgressUpdate {
  instanceId: string;
  done: number;
  total: number;
  fileName: string;
}

export interface SkinRemoveResult {
  skins: SkinInfo[];
  activeSkinId: string | null;
}

export interface ElySkinResult {
  dataUrl: string;
  slim: boolean;
}

export interface LauncherApi {
  getFilePath(file: File): Promise<string>;
  getBootstrap(): Promise<BootstrapState>;
  createInstance(payload: CreateInstancePayload): Promise<LauncherInstance>;
  updateInstance(payload: UpdateInstancePayload): Promise<LauncherInstance>;
  removeInstance(id: string): Promise<boolean>;
  importMrpackStart(filePath: string): Promise<MrpackBeginResult>;
  importMrpackFiles(instanceId: string): Promise<LauncherInstance>;
  onMrpackProgress(listener: (update: MrpackProgressUpdate) => void): () => void;
  launchInstance(id: string): Promise<LaunchResult>;
  updateSettings(patch: Partial<LauncherSettings>): Promise<LauncherSettings>;
  searchMods(payload: ModSearchPayload): Promise<ModSearchResponse>;
  getCategoryTags(projectType: ModrinthProjectType): Promise<string[]>;
  installMod(payload: InstallModPayload): Promise<LauncherInstance>;
  beginMicrosoftLogin(): Promise<LoginStartResult>;
  refreshSession(): Promise<AccountsState>;
  elyLogin(username: string, password: string, totp?: string): Promise<AccountsState>;
  useOfflineProfile(username: string): Promise<AccountsState>;
  setActiveAccount(id: string): Promise<AccountsState>;
  removeAccount(id: string): Promise<AccountsState>;
  openExternal(url: string): Promise<boolean>;
  getJavaInstallations(): Promise<JavaInstallation[]>;
  installJava(major: number): Promise<JavaInstallation>;
  detectJava(major: number): Promise<JavaInstallation>;
  browseJava(major: number): Promise<JavaInstallation | null>;
  getGameVersions(): Promise<string[]>;
  getLoaderSupport(): Promise<Record<string, string[]>>;
  getLoaderVersions(loader: ModLoader, gameVersion: string): Promise<string[]>;
  openInstanceFolder(id: string): Promise<string>;
  getLocalContent(instanceId: string): Promise<LocalContentItem[]>;
  toggleLocalContent(payload: LocalContentPayload): Promise<LocalContentItem[]>;
  removeLocalContent(payload: LocalContentPayload): Promise<LocalContentItem[]>;
  getRunningInstances(): Promise<string[]>;
  stopInstance(id: string): Promise<LaunchResult>;
  cancelLaunch(id: string): Promise<LaunchResult>;
  listSkins(): Promise<SkinInfo[]>;
  elySkin(): Promise<ElySkinResult | null>;
  addSkin(payload: SkinAddPayload): Promise<SkinInfo[]>;
  updateSkin(payload: SkinUpdatePayload): Promise<SkinInfo[]>;
  removeSkin(id: string): Promise<SkinRemoveResult>;
  activateSkin(id: string): Promise<SkinActivateResult>;
  listCapes(): Promise<CapeInfo[]>;
  equipCape(capeId: string | null): Promise<CapeInfo[]>;
  downloadUpdate(): Promise<void>;
  installUpdate(): Promise<void>;
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void;
  minimizeWindow(): Promise<void>;
  toggleMaximize(): Promise<void>;
  closeWindow(): Promise<void>;
  isMaximized(): Promise<boolean>;
  onMaximizedChange(listener: (maximized: boolean) => void): () => void;
}
