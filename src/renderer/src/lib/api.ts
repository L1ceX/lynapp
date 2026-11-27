import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type {
  CreateInstancePayload,
  DownloadModpackPayload,
  ElySkinResult,
  ExportEntry,
  InstallModPayload,
  InstanceLogsResult,
  LauncherApi,
  LocalContentPayload,
  ModSearchPayload,
  MrpackBeginResult,
  MrpackProgressUpdate,
  MrpackTargetResult,
  PrepareModInstallPayload,
  SkinActivateResult,
  SkinAddPayload,
  SkinRemoveResult,
  SkinUpdatePayload,
  TransferProgressUpdate,
  UpdateInstancePayload
} from "@shared/ipc";
import type {
  AccountsState,
  AddCustomFontResult,
  BootstrapState,
  CapeInfo,
  ContentImportResult,
  ContentUpdateInfo,
  CustomFontInfo,
  ExternalImportProgress,
  ExternalImportResult,
  ExternalLauncher,
  GameVersionInfo,
  GoogleFontInfo,
  InstanceFolder,
  JavaInstallation,
  LaunchResult,
  LauncherInstance,
  LauncherSettings,
  LocalContentItem,
  LoginStartResult,
  ModInstallPlan,
  ModLoader,
  ModProjectDetails,
  ModProvider,
  ModSearchResponse,
  ModVersionInfo,
  ModrinthProjectType,
  QuickPlayTarget,
  ScreenshotInfo,
  ServerEntry,
  ServerPingResult,
  SkinInfo,
  UpdateEdition,
  UpdateStatus,
  WorldInfo
} from "@shared/types";

function subscribe<T>(eventName: string, listener: (payload: T) => void): () => void {
  let active = true;
  let unlisten: UnlistenFn | null = null;
  void listen<T>(eventName, (event) => {
    if (active) listener(event.payload);
  }).then((fn) => {
    if (active) unlisten = fn;
    else fn();
  });
  return () => {
    active = false;
    unlisten?.();
  };
}

const tauriApi: LauncherApi = {
  getFilePath: async (file: File) => (file as unknown as { path?: string }).path ?? "",
  getBootstrap: () => invoke<BootstrapState>("launcher_bootstrap"),
  createInstance: (payload: CreateInstancePayload) => invoke<LauncherInstance>("create_instance", { payload }),
  updateInstance: (payload: UpdateInstancePayload) => invoke<LauncherInstance>("update_instance", { payload }),
  removeInstance: (id: string) => invoke<boolean>("remove_instance", { id }),
  duplicateInstance: (id: string) => invoke<LauncherInstance>("duplicate_instance", { id }),
  scanExternalLaunchers: (extraRoots?: string[]) => invoke<ExternalLauncher[]>("scan_external_launchers", { extraRoots: extraRoots ?? [] }),
  importExternalInstances: (keys: string[], extraRoots?: string[]) => invoke<ExternalImportResult>("import_external_instances", { keys, extraRoots: extraRoots ?? [] }),
  pickExternalFolder: () => invoke<{ folder: string; launcher: ExternalLauncher | null } | null>("pick_external_folder"),
  onExternalImportProgress: (listener: (update: ExternalImportProgress) => void) => subscribe("import:progress", listener),
  importMrpackStart: (filePath: string) => invoke<MrpackBeginResult>("import_mrpack_start", { filePath }),
  importMrpackStartToInstance: (filePath: string, instanceId: string) => invoke<MrpackTargetResult>("import_mrpack_start_to_instance", { filePath, instanceId }),
  importMrpackCancel: (instanceId: string) => invoke<void>("import_mrpack_cancel", { instanceId }),
  exportMrpack: (instanceId: string, include?: string[]) => invoke<string | null>("export_mrpack", { instanceId, include: include ?? null }),
  listExportEntries: (instanceId: string) => invoke<ExportEntry[]>("list_export_entries", { instanceId }),
  importMrpackFiles: (instanceId: string) => invoke<LauncherInstance>("import_mrpack_files", { instanceId }),
  onMrpackProgress: (listener: (update: MrpackProgressUpdate) => void) => subscribe("instances:mrpack-progress", listener),
  onDownloadProgress: (listener: (update: TransferProgressUpdate) => void) => subscribe("transfer:progress", listener),
  launchInstance: (id: string, quickPlay?: QuickPlayTarget) => invoke<LaunchResult>("launch_instance", { id, quickPlay: quickPlay ?? null }),
  updateSettings: (patch: Partial<LauncherSettings>) => {
    const cleanPatch = Object.fromEntries(
      Object.entries(patch).map(([k, v]) => [k, v === undefined ? null : v])
    );
    return invoke<LauncherSettings>("update_settings", { patch: cleanPatch });
  },
  searchMods: (payload: ModSearchPayload) => invoke<ModSearchResponse>("search_mods", { payload }),
  getCategoryTags: (projectType: ModrinthProjectType, provider?: ModProvider) => invoke<string[]>("get_category_tags", { projectType, provider: provider ?? null }),
  installMod: (payload: InstallModPayload) => invoke<LauncherInstance>("install_mod", { payload }),
  prepareModInstall: (payload: PrepareModInstallPayload) => invoke<ModInstallPlan>("prepare_mod_install", { payload }),
  downloadModpack: (payload: DownloadModpackPayload) => invoke<string>("download_modpack", { payload }),
  beginMicrosoftLogin: () => invoke<LoginStartResult>("begin_microsoft_login"),
  refreshSession: () => invoke<AccountsState>("refresh_session"),
  elyLogin: () => invoke<AccountsState>("ely_login"),
  useOfflineProfile: (username: string) => invoke<AccountsState>("use_offline_profile", { username }),
  setActiveAccount: (id: string) => invoke<AccountsState>("set_active_account", { id }),
  removeAccount: (id: string) => invoke<AccountsState>("remove_account", { id }),
  openExternal: (url: string) => invoke<boolean>("open_external", { url }),
  openDataFolder: () => invoke<string>("open_data_folder"),
  getJavaInstallations: () => invoke<JavaInstallation[]>("get_java_installations"),
  installJava: (major: number) => invoke<JavaInstallation>("install_java", { major }),
  detectJava: (major: number) => invoke<JavaInstallation>("detect_java", { major }),
  browseJava: (major: number) => invoke<JavaInstallation | null>("browse_java", { major }),
  getGameVersions: () => invoke<GameVersionInfo[]>("get_game_versions"),
  getLoaderSupport: () => invoke<Record<string, string[]>>("get_loader_support"),
  getLoaderVersions: (loader: ModLoader, gameVersion: string) => invoke<string[]>("get_loader_versions", { loader, gameVersion }),
  openInstanceFolder: (id: string, folder?: InstanceFolder) => invoke<string>("open_instance_folder", { id, folder: folder ?? "root" }),
  getLocalContent: (instanceId: string) => invoke<LocalContentItem[]>("get_local_content", { instanceId }),
  toggleLocalContent: (payload: LocalContentPayload) => invoke<LocalContentItem[]>("toggle_local_content", { payload }),
  removeLocalContent: (payload: LocalContentPayload) => invoke<LocalContentItem[]>("remove_local_content", { payload }),
  detectLocalContent: (instanceId: string) => invoke<LauncherInstance>("detect_local_content", { instanceId }),
  importLocalContent: (instanceId: string, paths: string[]) => invoke<ContentImportResult>("import_local_content", { instanceId, paths }),
  listModVersions: (instanceId: string, projectId: string, projectType: ModrinthProjectType, provider?: ModProvider) =>
    invoke<ModVersionInfo[]>("list_mod_versions", { instanceId, projectId, projectType, provider: provider ?? null }),
  getModDetails: (projectId: string, projectType: ModrinthProjectType, provider: ModProvider) =>
    invoke<ModProjectDetails>("get_mod_details", { projectId, projectType, provider }),
  checkContentUpdates: (instanceId: string) => invoke<ContentUpdateInfo[]>("check_content_updates", { instanceId }),
  listWorlds: (instanceId: string) => invoke<WorldInfo[]>("list_worlds", { instanceId }),
  backupWorld: (instanceId: string, folderName: string) => invoke<WorldInfo[]>("backup_world", { instanceId, folderName }),
  restoreWorldBackup: (instanceId: string, folderName: string, backupId: string) => invoke<WorldInfo[]>("restore_world_backup", { instanceId, folderName, backupId }),
  deleteWorldBackup: (instanceId: string, folderName: string, backupId: string) => invoke<WorldInfo[]>("delete_world_backup", { instanceId, folderName, backupId }),
  deleteWorld: (instanceId: string, folderName: string) => invoke<WorldInfo[]>("delete_world", { instanceId, folderName }),
  listServers: (instanceId: string) => invoke<ServerEntry[]>("list_servers", { instanceId }),
  addServer: (instanceId: string, name: string, ip: string) => invoke<ServerEntry[]>("add_server", { instanceId, name, ip }),
  removeServer: (instanceId: string, ip: string) => invoke<ServerEntry[]>("remove_server", { instanceId, ip }),
  pingServer: (ip: string) => invoke<ServerPingResult>("ping_server", { ip }),
  listScreenshots: (instanceId: string) => invoke<ScreenshotInfo[]>("list_screenshots", { instanceId }),
  copyScreenshot: (instanceId: string, fileName: string) => invoke<boolean>("copy_screenshot", { instanceId, fileName }),
  deleteScreenshot: (instanceId: string, fileName: string) => invoke<ScreenshotInfo[]>("delete_screenshot", { instanceId, fileName }),
  getRunningInstances: () => invoke<string[]>("get_running_instances"),
  stopInstance: (id: string) => invoke<LaunchResult>("stop_instance", { id }),
  cancelLaunch: (id: string) => invoke<LaunchResult>("cancel_launch", { id }),
  getInstanceLogs: (id: string) => invoke<InstanceLogsResult>("get_instance_logs", { id }),
  listSkins: () => invoke<SkinInfo[]>("list_skins"),
  elySkin: () => invoke<ElySkinResult | null>("ely_skin"),
  accountSkin: () => invoke<ElySkinResult | null>("account_skin"),
  addSkin: (payload: SkinAddPayload) => invoke<SkinInfo[]>("add_skin", { payload }),
  updateSkin: (payload: SkinUpdatePayload) => invoke<SkinInfo[]>("update_skin", { payload }),
  removeSkin: (id: string) => invoke<SkinRemoveResult>("remove_skin", { id }),
  activateSkin: (id: string) => invoke<SkinActivateResult>("activate_skin", { id }),
  listCapes: () => invoke<CapeInfo[]>("list_capes"),
  equipCape: (capeId: string | null) => invoke<CapeInfo[]>("equip_cape", { capeId }),
  listCustomFonts: () => invoke<CustomFontInfo[]>("list_custom_fonts"),
  addCustomFont: () => invoke<AddCustomFontResult | null>("add_custom_font"),
  removeCustomFont: (fileName: string) => invoke<CustomFontInfo[]>("remove_custom_font", { fileName }),
  openFontsFolder: () => invoke<string>("open_fonts_folder"),
  listSystemFonts: () => invoke<string[]>("list_system_fonts"),
  listGoogleFonts: () => invoke<GoogleFontInfo[]>("list_google_fonts"),
  checkUpdates: (force?: boolean) => invoke<UpdateStatus | null>("updater_check", { force: force ?? false }),
  downloadUpdate: (edition?: UpdateEdition) => invoke<void>("updater_download", { edition: edition ?? null }),
  installUpdate: () => invoke<void>("updater_install"),
  onUpdateStatus: (listener: (status: UpdateStatus) => void) => subscribe("updater:status", listener),
  minimizeWindow: () => getCurrentWindow().minimize(),
  toggleMaximize: () => getCurrentWindow().toggleMaximize(),
  closeWindow: () => getCurrentWindow().close(),
  isMaximized: () => getCurrentWindow().isMaximized(),
  onMaximizedChange: (listener: (maximized: boolean) => void) => {
    let active = true;
    let unlisten: UnlistenFn | null = null;
    const win = getCurrentWindow();
    void win.onResized(() => {
      if (!active) return;
      void win.isMaximized().then((value) => {
        if (active) listener(value);
      });
    }).then((fn) => {
      if (active) unlisten = fn;
      else fn();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }
};

export function getLauncherApi(): LauncherApi {
  return tauriApi;
}
