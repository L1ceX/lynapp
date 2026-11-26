import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { hideToTray, isHiddenForGame, restoreFromTray } from "./tray";
import { getMainWindow } from "./window";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { IPC } from "@shared/ipc";
import type { CreateInstancePayload, DownloadModpackPayload, InstallModPayload, LocalContentPayload, ModSearchPayload, PrepareModInstallPayload, SkinAddPayload, SkinUpdatePayload, UpdateInstancePayload } from "@shared/ipc";
import type { AccountsState, InstanceFolder, LauncherSettings, ModLoader, ModrinthProjectType, QuickPlayTarget } from "@shared/types";
import { setMainLanguage, tr } from "./i18n";
import { getLauncherRoot, getStorePath } from "./paths";
import { getMaxAllocatableMemoryMb, getSystemMemoryMb } from "./store";
import { AuthService } from "./services/auth";
import { ContentService } from "./services/content";
import { DiscordPresence } from "./services/discord";
import { ExternalImportService } from "./services/importer";
import { InstanceService } from "./services/instances";
import { JavaService } from "./services/java";
import { MinecraftService } from "./services/minecraft";
import { ModpackService } from "./services/modpacks";
import { ModService } from "./services/mods";
import { SkinService } from "./services/skins";
import { JsonStore } from "./store";
import { CurseForgeService, curseForgeAvailable } from "./services/curseforge";
import { ServerService } from "./services/servers";
import { WorldService } from "./services/worlds";
import { addCustomFont, listCustomFonts, listGoogleFonts, listSystemFonts, openFontsFolder, removeCustomFont } from "./services/fonts";
import { checkForUpdates, configureUpdater, downloadUpdate, installUpdate } from "./updater";
import { createThrottledEmitter } from "./services/transfer";

const INSTANCE_FOLDERS: Record<InstanceFolder, string> = {
  root: "",
  logs: path.join(".launcher", "logs"),
  saves: "saves",
  screenshots: "screenshots",
  mod: "mods",
  resourcepack: "resourcepacks",
  shader: "shaderpacks",
  datapack: "datapacks"
};

export function registerIpcHandlers(): void {
  const store = new JsonStore();
  const java = new JavaService();
  const minecraft = new MinecraftService();
  const auth = new AuthService(store);
  const instances = new InstanceService(store, java, minecraft, auth);
  const curseforge = new CurseForgeService(store);
  const mods = new ModService(store, curseforge);
  const skins = new SkinService(store, auth);
  const content = new ContentService(store, curseforge);
  const worlds = new WorldService(store);
  const servers = new ServerService(store);
  const modpacks = new ModpackService(store, instances, minecraft, curseforge);
  const discord = new DiscordPresence();
  const importer = new ExternalImportService(instances, content, minecraft);

  void instances.getRunning().then(async (running) => {
    const data = await store.getData();
    for (const id of running) {
      const instance = data.instances.find((item) => item.id === id);
      if (instance) discord.gameStarted(instance, null);
    }
    discord.applySettings(data.settings);
  }).catch(() => undefined);
  void store.getData().then((data) => configureUpdater(data.settings.betaUpdates, data.settings.updateEdition)).catch(() => undefined);
  setInterval(() => {
    if (!discord.hasSessions()) return;
    void instances.getRunning().then((running) => discord.syncRunning(running)).catch(() => undefined);
  }, 30000).unref();
  const startupMs = Date.now();
  void (async () => {
    const cacheDir = path.join(getLauncherRoot(), "cache", "modpacks");
    const entries = await readdir(cacheDir).catch(() => [] as string[]);
    for (const entry of entries) {
      const full = path.join(cacheDir, entry);
      const info = await stat(full).catch(() => null);
      if (info && info.mtimeMs < startupMs - 1000) {
        await rm(full, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  })();

  function publicAccounts(state: AccountsState): AccountsState {
    return {
      activeAccountId: state.activeAccountId,
      accounts: state.accounts.map(({ minecraftAccessToken, microsoftRefreshToken, elyAccessToken, elyClientToken, elyRefreshToken, xboxUhs, ...rest }) => rest)
    };
  }

  ipcMain.handle(IPC.bootstrap, async () => {
    const data = await store.getData();
    configureUpdater(data.settings.betaUpdates, data.settings.updateEdition);
    void checkForUpdates();
    return {
      settings: data.settings,
      instances: data.instances,
      activeInstanceId: data.activeInstanceId,
      ...publicAccounts({ accounts: data.accounts, activeAccountId: data.activeAccountId }),
      storagePath: getStorePath(),
      appVersion: app.getVersion(),
      curseforgeAvailable: curseForgeAvailable,
      systemMemoryMb: getSystemMemoryMb(),
      maxMemoryMb: getMaxAllocatableMemoryMb(),
      javaCandidates: await java.listCandidatePaths([data.settings.javaPath])
    };
  });

  ipcMain.handle(IPC.createInstance, (_event, payload: CreateInstancePayload) => instances.create(payload));  ipcMain.handle(IPC.updateInstance, (_event, payload: UpdateInstancePayload) => instances.updateInstance(payload));
  ipcMain.handle(IPC.removeInstance, (_event, id: string) => instances.remove(id));
  ipcMain.handle(IPC.duplicateInstance, (_event, id: string) => instances.duplicate(id));
  const stringList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  ipcMain.handle(IPC.scanExternalLaunchers, (_event, extraRoots?: string[]) => importer.scan(stringList(extraRoots)));
  ipcMain.handle(IPC.pickExternalFolder, async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options = { title: tr("Choose a launcher or instances folder", "Выберите папку лаунчера или инстанций"), properties: ["openDirectory"] as Array<"openDirectory"> };
    const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    if (picked.canceled || !picked.filePaths[0]) return null;
    return { folder: picked.filePaths[0], launcher: await importer.scanFolder(picked.filePaths[0]) };
  });
  ipcMain.handle(IPC.importExternalInstances, (event, keys: string[], extraRoots?: string[]) => {
    const sender = event.sender;
    return importer.importInstances(stringList(keys), stringList(extraRoots), (update) => {
      if (!sender.isDestroyed()) sender.send(IPC.externalImportProgress, update);
    });
  });
  ipcMain.handle(IPC.importMrpackStart, (_event, filePath: string) => modpacks.beginImport(filePath));
  ipcMain.handle(IPC.importMrpackStartToInstance, (_event, filePath: string, instanceId: string) => modpacks.beginImportToInstance(filePath, instanceId));
  ipcMain.handle(IPC.importMrpackCancel, (_event, instanceId: string) => modpacks.cancelImport(instanceId));
  ipcMain.handle(IPC.exportMrpack, async (event, instanceId: string, include?: string[]) => {
    const data = await store.getData();
    const instance = data.instances.find((item) => item.id === instanceId);
    if (!instance) {
      throw new Error(tr("Instance not found", "Инстанция не найдена"));
    }
    const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const saveOptions = {
      title: tr("Export modpack", "Экспорт модпака"),
      defaultPath: `${instance.name}.mrpack`,
      filters: [{ name: tr("Modrinth modpack", "Модпак Modrinth"), extensions: ["mrpack"] }]
    };
    const picked = parent
      ? await dialog.showSaveDialog(parent, saveOptions)
      : await dialog.showSaveDialog(saveOptions);
    if (picked.canceled || !picked.filePath) {
      return null;
    }
    return modpacks.exportInstance(instanceId, picked.filePath, include);
  });
  ipcMain.handle(IPC.listExportEntries, (_event, instanceId: string) => modpacks.listExportEntries(instanceId));
  ipcMain.handle(IPC.importMrpackFiles, (event, instanceId: string) => modpacks.finishImport(instanceId, event.sender));
  const afterLaunchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const clearAfterLaunch = (id: string): void => {
    const timer = afterLaunchTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      afterLaunchTimers.delete(id);
    }
  };
  instances.onGameExit = (id) => {
    clearAfterLaunch(id);
    discord.gameStopped(id);
    if (!isHiddenForGame()) return;
    void instances.getRunning().then((running) => {
      if (!running.length) restoreFromTray(getMainWindow());
    }).catch(() => undefined);
  };

  ipcMain.handle(IPC.launchInstance, async (event, id: string, quickPlay?: QuickPlayTarget) => {
    const sender = event.sender;
    const window = BrowserWindow.fromWebContents(sender);
    const emit = createThrottledEmitter((update) => {
      if (!sender.isDestroyed()) {
        sender.send(IPC.transferProgress, update);
      }
    });
    const result = await instances.launch(id, (progress) => {
      if (progress.phase === "java") {
        emit(`launch:${id}`, "Java", progress.received ?? 0, progress.totalBytes ?? null, {
          phase: "java",
          doneFiles: 0,
          totalFiles: 0
        });
        return;
      }
      emit(`launch:${id}`, progress.phase === "assets" ? "assets" : progress.phase === "loader" ? "loader" : "libraries", progress.done, progress.total, {
        phase: progress.phase,
        doneFiles: progress.done,
        totalFiles: progress.total
      });
    }, quickPlay);
    if (result.ok && result.pid) {
      const data = await store.getData();
      const launched = data.instances.find((item) => item.id === id);
      if (launched) discord.gameStarted(launched);
      const action = data.settings.afterLaunch;
      if (action === "hide" || action === "close") {
        clearAfterLaunch(id);
        const timer = setTimeout(() => {
          afterLaunchTimers.delete(id);
          void instances.getRunning().then((running) => {
            if (!running.includes(id)) return;
            if (action === "hide") {
              const target = window && !window.isDestroyed() ? window : getMainWindow();
              if (target) hideToTray(target);
            } else {
              app.quit();
            }
          }).catch(() => undefined);
        }, action === "hide" ? 1200 : 2000);
        afterLaunchTimers.set(id, timer);
      }
    }
    return result;
  });
  ipcMain.handle(IPC.getRunningInstances, () => instances.getRunning());
  ipcMain.handle(IPC.stopInstance, (_event, id: string) => instances.stop(id));
  ipcMain.handle(IPC.cancelLaunch, (_event, id: string) => instances.cancelLaunch(id));
  ipcMain.handle(IPC.getInstanceLogs, (_event, id: string) => instances.getLogs(id));
  ipcMain.handle(IPC.listSkins, () => skins.list());
  ipcMain.handle(IPC.elySkin, () => skins.elySkin());
  ipcMain.handle(IPC.accountSkin, () => skins.accountSkin());
  ipcMain.handle(IPC.addSkin, (_event, payload: SkinAddPayload) => skins.add(payload));
  ipcMain.handle(IPC.updateSkin, (_event, payload: SkinUpdatePayload) => skins.update(payload));
  ipcMain.handle(IPC.removeSkin, (_event, id: string) => skins.remove(id));
  ipcMain.handle(IPC.activateSkin, (_event, id: string) => skins.activate(id));
  ipcMain.handle(IPC.listCapes, () => skins.listCapes());
  ipcMain.handle(IPC.equipCape, (_event, capeId: string | null) => skins.equipCape(capeId));
  ipcMain.handle(IPC.listCustomFonts, () => listCustomFonts());
  ipcMain.handle(IPC.addCustomFont, (event) => addCustomFont(BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined));
  ipcMain.handle(IPC.removeCustomFont, (_event, fileName: string) => removeCustomFont(fileName));
  ipcMain.handle(IPC.openFontsFolder, () => openFontsFolder());
  ipcMain.handle(IPC.listSystemFonts, () => listSystemFonts());
  ipcMain.handle(IPC.listGoogleFonts, () => listGoogleFonts());
  ipcMain.handle(IPC.updaterDownload, (_event, edition?: "tauri" | "electron") => downloadUpdate(edition));
  ipcMain.handle(IPC.updaterInstall, () => installUpdate());
  ipcMain.handle(IPC.windowMinimize, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.handle(IPC.windowToggleMaximize, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win?.isMaximized()) win.unmaximize();
    else win?.maximize();
  });
  ipcMain.handle(IPC.windowClose, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  ipcMain.handle(IPC.windowIsMaximized, (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
  });
  ipcMain.handle(IPC.getGameVersions, () => minecraft.listGameVersions());
  ipcMain.handle(IPC.getLoaderSupport, () => minecraft.getLoaderSupport());
  ipcMain.handle(IPC.getLoaderVersions, (_event, loader: ModLoader, gameVersion: string) => minecraft.listLoaderVersions(loader, gameVersion));
  ipcMain.handle(IPC.openInstanceFolder, async (_event, id: string, folder: InstanceFolder = "root") => {
    const data = await store.getData();
    const instance = data.instances.find((item) => item.id === id);
    if (!instance) {
      throw new Error(tr("Instance not found", "Инстанция не найдена"));
    }
    const relative = INSTANCE_FOLDERS[folder] ?? "";
    const target = path.join(instance.directory, relative);
    if (relative) await mkdir(target, { recursive: true }).catch(() => undefined);
    return shell.openPath(target);
  });
  ipcMain.handle(IPC.getLocalContent, (_event, instanceId: string) => content.list(instanceId));
  ipcMain.handle(IPC.toggleLocalContent, (_event, payload: LocalContentPayload) => content.toggle(payload.instanceId, payload.fileName, payload.kind, payload.world));
  ipcMain.handle(IPC.listModVersions, (_event, instanceId: string, projectId: string, projectType: ModrinthProjectType, provider?: string) => (provider === "curseforge" ? curseforge.listVersions(instanceId, projectId, projectType) : mods.listVersions(instanceId, projectId, projectType)));
  ipcMain.handle(IPC.checkContentUpdates, (_event, instanceId: string) => mods.checkUpdates(instanceId));
  ipcMain.handle(IPC.importLocalContent, (_event, instanceId: string, paths: string[]) => content.importFiles(instanceId, paths));
  ipcMain.handle(IPC.detectLocalContent, (_event, instanceId: string) => content.detectFromModrinth(instanceId));
  ipcMain.handle(IPC.removeLocalContent, (_event, payload: LocalContentPayload) => content.remove(payload.instanceId, payload.fileName, payload.kind, payload.world));
  ipcMain.handle(IPC.listWorlds, (_event, instanceId: string) => worlds.list(instanceId));
  ipcMain.handle(IPC.backupWorld, (_event, instanceId: string, folderName: string) => worlds.backup(instanceId, folderName));
  ipcMain.handle(IPC.restoreWorldBackup, (_event, instanceId: string, folderName: string, backupId: string) => worlds.restore(instanceId, folderName, backupId));
  ipcMain.handle(IPC.deleteWorldBackup, (_event, instanceId: string, folderName: string, backupId: string) => worlds.deleteBackup(instanceId, folderName, backupId));
  ipcMain.handle(IPC.deleteWorld, (_event, instanceId: string, folderName: string) => worlds.deleteWorld(instanceId, folderName));
  ipcMain.handle(IPC.listServers, (_event, instanceId: string) => servers.list(instanceId));
  ipcMain.handle(IPC.addServer, (_event, instanceId: string, name: string, ip: string) => servers.add(instanceId, name, ip));
  ipcMain.handle(IPC.removeServer, (_event, instanceId: string, ip: string) => servers.remove(instanceId, ip));
  ipcMain.handle(IPC.pingServer, (_event, ip: string) => servers.ping(ip));
  ipcMain.handle(IPC.listScreenshots, (_event, instanceId: string) => content.listScreenshots(instanceId));
  ipcMain.handle(IPC.copyScreenshot, (_event, instanceId: string, fileName: string) => content.copyScreenshot(instanceId, fileName));
  ipcMain.handle(IPC.deleteScreenshot, (_event, instanceId: string, fileName: string) => content.deleteScreenshot(instanceId, fileName));

  ipcMain.handle(IPC.updateSettings, async (_event, patch: Partial<LauncherSettings>) => {
    const settings = await store.update((data) => {
      const current = data.settings;
      data.settings = {
        ...current,
        ...patch,
        theme: { ...current.theme, ...(patch.theme ?? {}) },
        effects: { ...current.effects, ...(patch.effects ?? {}) },
        versionTypes: { ...current.versionTypes, ...(patch.versionTypes ?? {}) },
        javaPaths: { ...(current.javaPaths ?? {}), ...(patch.javaPaths ?? {}) }
      };
      setMainLanguage(data.settings.language);
      return data.settings;
    });
    discord.applySettings(settings);
    configureUpdater(settings.betaUpdates, settings.updateEdition);
    return settings;
  });

  ipcMain.handle(IPC.searchMods, (_event, payload: ModSearchPayload) => (payload.provider === "curseforge" ? curseforge.search(payload) : mods.search(payload)));
  ipcMain.handle(IPC.getModDetails, (_event, projectId: string, projectType: ModrinthProjectType, provider?: string) => (provider === "curseforge" ? curseforge.getProjectDetails(projectId, projectType) : mods.getProjectDetails(projectId, projectType)));
  ipcMain.handle(IPC.getCategoryTags, (_event, projectType: ModrinthProjectType, provider?: string) => (provider === "curseforge" ? curseforge.getCategoryTags(projectType) : mods.getCategoryTags(projectType)));
  ipcMain.handle(IPC.prepareModInstall, (_event, payload: PrepareModInstallPayload) => (payload.provider === "curseforge" ? curseforge.prepareInstall(payload) : mods.prepareInstall(payload)));
  ipcMain.handle(IPC.installMod, (event, payload: InstallModPayload) => {
    const sender = event.sender;
    const emit = createThrottledEmitter((update) => {
      if (!sender.isDestroyed()) {
        sender.send(IPC.transferProgress, update);
      }
    });
    const onBytes = (received: number, total: number | null): void => emit(`mod:${payload.projectId}`, payload.name, received, total);
    return payload.provider === "curseforge" ? curseforge.install(payload, onBytes) : mods.install(payload, onBytes);
  });
  ipcMain.handle(IPC.downloadModpack, (event, payload: DownloadModpackPayload) => {
    const sender = event.sender;
    const emit = createThrottledEmitter((update) => {
      if (!sender.isDestroyed()) {
        sender.send(IPC.transferProgress, update);
      }
    });
    const onBytes = (received: number, total: number | null): void => emit(`modpack:${payload.projectId}`, payload.name, received, total);
    return payload.provider === "curseforge"
      ? curseforge.downloadModpackFile(payload.instanceId, payload.projectId, payload.name, onBytes, payload.versionId)
      : mods.downloadModpackFile(payload.instanceId, payload.projectId, payload.name, onBytes, payload.versionId);
  });
  ipcMain.handle(IPC.beginMicrosoftLogin, (event) => auth.beginMicrosoftLogin(BrowserWindow.fromWebContents(event.sender)));
  ipcMain.handle(IPC.refreshSession, async () => publicAccounts(await auth.trySilentRefresh()));
  ipcMain.handle(IPC.elyLogin, async () => publicAccounts(await auth.elyLogin()));
  ipcMain.handle(IPC.useOfflineProfile, async (_event, username: string) => publicAccounts(await auth.useOfflineProfile(username)));
  ipcMain.handle(IPC.setActiveAccount, async (_event, id: string) => publicAccounts(await auth.setActiveAccount(id)));
  ipcMain.handle(IPC.removeAccount, async (_event, id: string) => publicAccounts(await auth.removeAccount(id)));

  ipcMain.handle(IPC.getJavaInstallations, async () => {
    const data = await store.getData();
    return java.getInstallations(data.settings.javaPaths ?? {});
  });

  ipcMain.handle(IPC.installJava, async (_event, major: number) => {
    const javawPath = await java.installMajor(major);
    await store.update((data) => {
      data.settings.javaPaths = { ...(data.settings.javaPaths ?? {}), [String(major)]: javawPath };
    });
    const data = await store.getData();
    return java.describeInstallation(major, data.settings.javaPaths?.[String(major)]);
  });

  ipcMain.handle(IPC.detectJava, async (_event, major: number) => {
    const found = await java.findCompatiblePath(major);

    if (!found) {
      const data = await store.getData();
      const described = await java.describeInstallation(major, data.settings.javaPaths?.[String(major)]);
      return { ...described, message: tr(`No Java ${major} found on this PC`, `Java ${major} на этом компьютере не найдена`) };
    }

    await store.update((data) => {
      data.settings.javaPaths = { ...(data.settings.javaPaths ?? {}), [String(major)]: found };
    });
    return java.describeInstallation(major, found);
  });

  ipcMain.handle(IPC.browseJava, async (event, major: number) => {
    const parent = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined;
    const isWin = process.platform === "win32";
    const dialogOptions = {
      title: tr(`Select ${isWin ? "javaw.exe" : "java"} for Java ${major}`, `Выберите ${isWin ? "javaw.exe" : "java"} для Java ${major}`),
      ...(isWin ? { filters: [{ name: tr("Java executable", "Исполняемый файл Java"), extensions: ["exe"] }] } : {}),
      properties: ["openFile"] as Array<"openFile">
    };
    const picked = parent ? await dialog.showOpenDialog(parent, dialogOptions) : await dialog.showOpenDialog(dialogOptions);

    if (picked.canceled || !picked.filePaths[0]) {
      return null;
    }

    const inspected = await java.inspectPickedPath(picked.filePaths[0]);

    if (inspected.major !== major) {
      throw new Error(tr(`Selected Java is version ${inspected.major ?? "unknown"}, but Java ${major} is needed here.`, `Выбрана Java ${inspected.major ?? "неизвестной версии"}, а здесь нужна Java ${major}.`));
    }

    await store.update((data) => {
      data.settings.javaPaths = { ...(data.settings.javaPaths ?? {}), [String(major)]: inspected.javawPath };
    });
    return java.describeInstallation(major, inspected.javawPath);
  });

  ipcMain.handle(IPC.openDataFolder, () => shell.openPath(path.dirname(getStorePath())));
  ipcMain.handle(IPC.openExternal, async (_event, url: string) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(tr("Invalid URL", "Некорректная ссылка"));
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(tr("Only http and https URLs can be opened", "Можно открывать только ссылки http и https"));
    }

    await shell.openExternal(parsed.toString());
    return true;
  });
}
