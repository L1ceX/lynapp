import type {
  AccountsState,
  ContentImportResult,
  ContentUpdateInfo,
  ExternalImportProgress,
  ExternalImportResult,
  ExternalLauncher,
  GameVersionInfo,
  ModInstallPlan,
  ModProjectDetails,
  ModVersionInfo,
  QuickPlayTarget,
  ScreenshotInfo,
  ServerEntry,
  ServerPingResult,
  WorldInfo,
  BootstrapState,
  CapeInfo,
  InstanceFolder,
  JavaInstallation,
  LaunchResult,
  LauncherInstance,
  LauncherSettings,
  LocalContentItem,
  LocalContentKind,
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
  duplicateInstance: "instances:duplicate",
  scanExternalLaunchers: "import:scan",
  importExternalInstances: "import:run",
  pickExternalFolder: "import:pick-folder",
  externalImportProgress: "import:progress",
  importMrpackStart: "instances:import-mrpack-start",
  importMrpackStartToInstance: "instances:import-mrpack-start-to",
  importMrpackCancel: "instances:import-mrpack-cancel",
  exportMrpack: "instances:export-mrpack",
  listExportEntries: "instances:export-entries",
  importMrpackFiles: "instances:import-mrpack-files",
  mrpackProgress: "instances:mrpack-progress",
  transferProgress: "transfer:progress",
  launchInstance: "instances:launch",
  updateSettings: "settings:update",
  searchMods: "mods:search",
  installMod: "mods:install",
  prepareModInstall: "mods:prepare-install",
  downloadModpack: "mods:download-modpack",
  beginMicrosoftLogin: "auth:microsoft:begin",
  refreshSession: "auth:refresh",
  elyLogin: "auth:ely",
  useOfflineProfile: "auth:offline",
  setActiveAccount: "auth:set-active",
  removeAccount: "auth:remove",
  openExternal: "shell:open-external",
  openDataFolder: "app:open-data-folder",
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
  detectLocalContent: "content:detect",
  importLocalContent: "content:import",
  listModVersions: "mods:versions",
  getModDetails: "mods:details",
  checkContentUpdates: "mods:check-updates",
  listWorlds: "worlds:list",
  backupWorld: "worlds:backup",
  restoreWorldBackup: "worlds:restore",
  deleteWorldBackup: "worlds:delete-backup",
  deleteWorld: "worlds:delete",
  listServers: "servers:list",
  addServer: "servers:add",
  removeServer: "servers:remove",
  pingServer: "servers:ping",
  listScreenshots: "screenshots:list",
  copyScreenshot: "screenshots:copy",
  deleteScreenshot: "screenshots:delete",
  getRunningInstances: "instances:running",
  stopInstance: "instances:stop",
  cancelLaunch: "instances:cancel-launch",
  getInstanceLogs: "instances:logs",
  windowMinimize: "window:minimize",
  windowToggleMaximize: "window:toggle-maximize",
  windowClose: "window:close",
  windowIsMaximized: "window:is-maximized",
  windowMaximized: "window:maximized",
  listSkins: "skins:list",
  elySkin: "skins:ely",
  accountSkin: "skins:account",
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
  provider?: ModProvider;
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
  replaceModId?: string;
  name: string;
  slug?: string;
  iconUrl?: string;
  projectType: ModrinthProjectType;
  gameVersions?: string[];
  loaders?: string[];
}

export interface PrepareModInstallPayload {
  instanceId: string;
  provider: ModProvider;
  projectId: string;
  versionId?: string;
  projectType: ModrinthProjectType;
  gameVersions?: string[];
  loaders?: string[];
}

export interface LocalContentPayload {
  instanceId: string;
  fileName: string;
  kind?: LocalContentKind;
  world?: string;
}

export interface DownloadModpackPayload {
  provider?: ModProvider;
  instanceId: string;
  projectId: string;
  versionId?: string;
  name: string;
}

export interface SkinAddPayload {
  name: string;
  dataUrl: string;
  slim: boolean;
  accountId?: string | null;
}

export interface SkinUpdatePayload {
  id: string;
  patch: Partial<Pick<SkinInfo, "name" | "slim" | "accountId">>;
}

export interface SkinActivateResult {
  activeSkinId: string;
  uploaded: boolean;
}

export interface MrpackBeginResult {
  instance: LauncherInstance;
  totalFiles: number;
  skipped?: string[];
}

export interface MrpackTargetResult {
  totalFiles: number;
  packName: string;
  packGameVersion: string;
  packLoader: string;
  skipped?: string[];
}

export interface MrpackProgressUpdate {
  instanceId: string;
  done: number;
  total: number;
  fileName: string;
}

export interface TransferProgressUpdate {
  key: string;
  fileName: string;
  received: number;
  total: number | null;
  phase?: string;
  doneFiles?: number;
  totalFiles?: number;
}

export interface InstanceLogsResult {
  log: string;
  plan: string;
  hasLog: boolean;
  crash: { file: string; description: string; text: string } | null;
}

export interface SkinRemoveResult {
  skins: SkinInfo[];
  activeSkinId: string | null;
}

export interface ExportEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string | null;
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
  duplicateInstance(id: string): Promise<LauncherInstance>;
  scanExternalLaunchers(extraRoots?: string[]): Promise<ExternalLauncher[]>;
  importExternalInstances(keys: string[], extraRoots?: string[]): Promise<ExternalImportResult>;
  pickExternalFolder(): Promise<{ folder: string; launcher: ExternalLauncher | null } | null>;
  onExternalImportProgress(listener: (update: ExternalImportProgress) => void): () => void;
  importMrpackStart(filePath: string): Promise<MrpackBeginResult>;
  importMrpackStartToInstance(filePath: string, instanceId: string): Promise<MrpackTargetResult>;
  importMrpackCancel(instanceId: string): Promise<void>;
  exportMrpack(instanceId: string, include?: string[]): Promise<string | null>;
  listExportEntries(instanceId: string): Promise<ExportEntry[]>;
  importMrpackFiles(instanceId: string): Promise<LauncherInstance>;
  onMrpackProgress(listener: (update: MrpackProgressUpdate) => void): () => void;
  onDownloadProgress(listener: (update: TransferProgressUpdate) => void): () => void;
  launchInstance(id: string, quickPlay?: QuickPlayTarget): Promise<LaunchResult>;
  updateSettings(patch: Partial<LauncherSettings>): Promise<LauncherSettings>;
  searchMods(payload: ModSearchPayload): Promise<ModSearchResponse>;
  getCategoryTags(projectType: ModrinthProjectType, provider?: ModProvider): Promise<string[]>;
  installMod(payload: InstallModPayload): Promise<LauncherInstance>;
  prepareModInstall(payload: PrepareModInstallPayload): Promise<ModInstallPlan>;
  downloadModpack(payload: DownloadModpackPayload): Promise<string>;
  beginMicrosoftLogin(): Promise<LoginStartResult>;
  refreshSession(): Promise<AccountsState>;
  elyLogin(): Promise<AccountsState>;
  useOfflineProfile(username: string): Promise<AccountsState>;
  setActiveAccount(id: string): Promise<AccountsState>;
  removeAccount(id: string): Promise<AccountsState>;
  openExternal(url: string): Promise<boolean>;
  openDataFolder(): Promise<string>;
  getJavaInstallations(): Promise<JavaInstallation[]>;
  installJava(major: number): Promise<JavaInstallation>;
  detectJava(major: number): Promise<JavaInstallation>;
  browseJava(major: number): Promise<JavaInstallation | null>;
  getGameVersions(): Promise<GameVersionInfo[]>;
  getLoaderSupport(): Promise<Record<string, string[]>>;
  getLoaderVersions(loader: ModLoader, gameVersion: string): Promise<string[]>;
  openInstanceFolder(id: string, folder?: InstanceFolder): Promise<string>;
  getLocalContent(instanceId: string): Promise<LocalContentItem[]>;
  toggleLocalContent(payload: LocalContentPayload): Promise<LocalContentItem[]>;
  removeLocalContent(payload: LocalContentPayload): Promise<LocalContentItem[]>;
  detectLocalContent(instanceId: string): Promise<LauncherInstance>;
  importLocalContent(instanceId: string, paths: string[]): Promise<ContentImportResult>;
  listModVersions(instanceId: string, projectId: string, projectType: ModrinthProjectType, provider?: ModProvider): Promise<ModVersionInfo[]>;
  getModDetails(projectId: string, projectType: ModrinthProjectType, provider: ModProvider): Promise<ModProjectDetails>;
  checkContentUpdates(instanceId: string): Promise<ContentUpdateInfo[]>;
  listWorlds(instanceId: string): Promise<WorldInfo[]>;
  backupWorld(instanceId: string, folderName: string): Promise<WorldInfo[]>;
  restoreWorldBackup(instanceId: string, folderName: string, backupId: string): Promise<WorldInfo[]>;
  deleteWorldBackup(instanceId: string, folderName: string, backupId: string): Promise<WorldInfo[]>;
  deleteWorld(instanceId: string, folderName: string): Promise<WorldInfo[]>;
  listServers(instanceId: string): Promise<ServerEntry[]>;
  addServer(instanceId: string, name: string, ip: string): Promise<ServerEntry[]>;
  removeServer(instanceId: string, ip: string): Promise<ServerEntry[]>;
  pingServer(ip: string): Promise<ServerPingResult>;
  listScreenshots(instanceId: string): Promise<ScreenshotInfo[]>;
  copyScreenshot(instanceId: string, fileName: string): Promise<boolean>;
  deleteScreenshot(instanceId: string, fileName: string): Promise<ScreenshotInfo[]>;
  getRunningInstances(): Promise<string[]>;
  stopInstance(id: string): Promise<LaunchResult>;
  cancelLaunch(id: string): Promise<LaunchResult>;
  getInstanceLogs(id: string): Promise<InstanceLogsResult>;
  listSkins(): Promise<SkinInfo[]>;
  elySkin(): Promise<ElySkinResult | null>;
  accountSkin(): Promise<ElySkinResult | null>;
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
