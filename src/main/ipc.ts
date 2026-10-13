import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { rm } from "node:fs/promises";
import path from "node:path";
import { IPC } from "@shared/ipc";
import type { CreateInstancePayload, DownloadModpackPayload, InstallModPayload, LocalContentPayload, ModSearchPayload, SkinAddPayload, SkinUpdatePayload, UpdateInstancePayload } from "@shared/ipc";
import type { AccountsState, LauncherSettings, ModLoader, ModrinthProjectType } from "@shared/types";
import { getLauncherRoot, getStorePath } from "./paths";
import { AuthService } from "./services/auth";
import { ContentService } from "./services/content";
import { InstanceService } from "./services/instances";
import { JavaService } from "./services/java";
import { MinecraftService } from "./services/minecraft";
import { ModpackService } from "./services/modpacks";
import { ModService } from "./services/mods";
import { SkinService } from "./services/skins";
import { JsonStore } from "./store";
import { downloadUpdate, installUpdate } from "./updater";
import { createThrottledEmitter } from "./services/transfer";

export function registerIpcHandlers(): void {
  const store = new JsonStore();
  const java = new JavaService();
  const minecraft = new MinecraftService();
  const auth = new AuthService(store);
  const instances = new InstanceService(store, java, minecraft, auth);
  const mods = new ModService(store);
  const skins = new SkinService(store, auth);
  const content = new ContentService(store);
  const modpacks = new ModpackService(store, instances, minecraft);

  void instances.pruneRunning().catch(() => undefined);
  void rm(path.join(getLauncherRoot(), "cache", "modpacks"), { recursive: true, force: true }).catch(() => undefined);

  function publicAccounts(state: AccountsState): AccountsState {
    return {
      activeAccountId: state.activeAccountId,
      accounts: state.accounts.map(({ minecraftAccessToken, microsoftRefreshToken, elyAccessToken, elyClientToken, xboxUhs, ...rest }) => rest)
    };
  }

  ipcMain.handle(IPC.bootstrap, async () => {
    const data = await store.getData();
    return {
      settings: data.settings,
      instances: data.instances,
      activeInstanceId: data.activeInstanceId,
      ...publicAccounts({ accounts: data.accounts, activeAccountId: data.activeAccountId }),
      storagePath: getStorePath(),
      javaCandidates: await java.listCandidatePaths([data.settings.javaPath])
    };
  });

  ipcMain.handle(IPC.createInstance, (_event, payload: CreateInstancePayload) => instances.create(payload));  ipcMain.handle(IPC.updateInstance, (_event, payload: UpdateInstancePayload) => instances.updateInstance(payload));
  ipcMain.handle(IPC.removeInstance, (_event, id: string) => instances.remove(id));
  ipcMain.handle(IPC.importMrpackStart, (_event, filePath: string) => modpacks.beginImport(filePath));
  ipcMain.handle(IPC.importMrpackStartToInstance, (_event, filePath: string, instanceId: string) => modpacks.beginImportToInstance(filePath, instanceId));
  ipcMain.handle(IPC.importMrpackCancel, (_event, instanceId: string) => modpacks.cancelImport(instanceId));
  ipcMain.handle(IPC.exportMrpack, async (event, instanceId: string, include?: string[]) => {
    const data = await store.getData();
    const instance = data.instances.find((item) => item.id === instanceId);
    if (!instance) {
      throw new Error("Instance not found");
    }
    const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const saveOptions = {
      title: "Export modpack",
      defaultPath: `${instance.name}.mrpack`,
      filters: [{ name: "Modrinth modpack", extensions: ["mrpack"] }]
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
  ipcMain.handle(IPC.launchInstance, (event, id: string) => {
    const sender = event.sender;
    const emit = createThrottledEmitter((update) => {
      if (!sender.isDestroyed()) {
        sender.send(IPC.transferProgress, update);
      }
    });
    return instances.launch(id, (progress) => {
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
    });
  });
  ipcMain.handle(IPC.getRunningInstances, () => instances.getRunning());
  ipcMain.handle(IPC.stopInstance, (_event, id: string) => instances.stop(id));
  ipcMain.handle(IPC.cancelLaunch, (_event, id: string) => instances.cancelLaunch(id));
  ipcMain.handle(IPC.getInstanceLogs, (_event, id: string) => instances.getLogs(id));
  ipcMain.handle(IPC.listSkins, () => skins.list());
  ipcMain.handle(IPC.elySkin, () => skins.elySkin());
  ipcMain.handle(IPC.addSkin, (_event, payload: SkinAddPayload) => skins.add(payload));
  ipcMain.handle(IPC.updateSkin, (_event, payload: SkinUpdatePayload) => skins.update(payload));
  ipcMain.handle(IPC.removeSkin, (_event, id: string) => skins.remove(id));
  ipcMain.handle(IPC.activateSkin, (_event, id: string) => skins.activate(id));
  ipcMain.handle(IPC.listCapes, () => skins.listCapes());
  ipcMain.handle(IPC.equipCape, (_event, capeId: string | null) => skins.equipCape(capeId));
  ipcMain.handle(IPC.updaterDownload, () => downloadUpdate());
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
  ipcMain.handle(IPC.getGameVersions, () => minecraft.listReleaseVersions());
  ipcMain.handle(IPC.getLoaderSupport, () => minecraft.getLoaderSupport());
  ipcMain.handle(IPC.getLoaderVersions, (_event, loader: ModLoader, gameVersion: string) => minecraft.listLoaderVersions(loader, gameVersion));
  ipcMain.handle(IPC.openInstanceFolder, async (_event, id: string) => {
    const data = await store.getData();
    const instance = data.instances.find((item) => item.id === id);
    if (!instance) {
      throw new Error("Instance not found");
    }
    return shell.openPath(instance.directory);
  });
  ipcMain.handle(IPC.getLocalContent, (_event, instanceId: string) => content.list(instanceId));
  ipcMain.handle(IPC.toggleLocalContent, (_event, payload: LocalContentPayload) => content.toggle(payload.instanceId, payload.fileName, payload.kind));
  ipcMain.handle(IPC.removeLocalContent, (_event, payload: LocalContentPayload) => content.remove(payload.instanceId, payload.fileName, payload.kind));

  ipcMain.handle(IPC.updateSettings, (_event, patch: Partial<LauncherSettings>) => {
    return store.update((data) => {
      data.settings = {
        ...data.settings,
        ...patch
      };
      return data.settings;
    });
  });

  ipcMain.handle(IPC.searchMods, (_event, payload: ModSearchPayload) => mods.search(payload));
  ipcMain.handle(IPC.getCategoryTags, (_event, projectType: ModrinthProjectType) => mods.getCategoryTags(projectType));
  ipcMain.handle(IPC.installMod, (event, payload: InstallModPayload) => {
    const sender = event.sender;
    const emit = createThrottledEmitter((update) => {
      if (!sender.isDestroyed()) {
        sender.send(IPC.transferProgress, update);
      }
    });
    return mods.install(payload, (received, total) => emit(`mod:${payload.projectId}`, payload.name, received, total));
  });
  ipcMain.handle(IPC.downloadModpack, (event, payload: DownloadModpackPayload) => {
    const sender = event.sender;
    const emit = createThrottledEmitter((update) => {
      if (!sender.isDestroyed()) {
        sender.send(IPC.transferProgress, update);
      }
    });
    return mods.downloadModpackFile(payload.instanceId, payload.projectId, payload.name, (received, total) =>
      emit(`modpack:${payload.projectId}`, payload.name, received, total)
    );
  });
  ipcMain.handle(IPC.beginMicrosoftLogin, (event) => auth.beginMicrosoftLogin(BrowserWindow.fromWebContents(event.sender)));
  ipcMain.handle(IPC.refreshSession, async () => publicAccounts(await auth.trySilentRefresh()));
  ipcMain.handle(IPC.elyLogin, async (_event, username: string, password: string, totp?: string) => publicAccounts(await auth.elyLogin(username, password, totp)));
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
      return { ...described, message: `No Java ${major} found on this PC` };
    }

    await store.update((data) => {
      data.settings.javaPaths = { ...(data.settings.javaPaths ?? {}), [String(major)]: found };
    });
    return java.describeInstallation(major, found);
  });

  ipcMain.handle(IPC.browseJava, async (event, major: number) => {
    const parent = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined;
    const dialogOptions = {
      title: `Select javaw.exe for Java ${major}`,
      filters: [{ name: "Java executable", extensions: ["exe"] }],
      properties: ["openFile"] as Array<"openFile">
    };
    const picked = parent ? await dialog.showOpenDialog(parent, dialogOptions) : await dialog.showOpenDialog(dialogOptions);

    if (picked.canceled || !picked.filePaths[0]) {
      return null;
    }

    const inspected = await java.inspectPickedPath(picked.filePaths[0]);

    if (inspected.major !== major) {
      throw new Error(`Selected Java is version ${inspected.major ?? "unknown"}, but Java ${major} is needed here.`);
    }

    await store.update((data) => {
      data.settings.javaPaths = { ...(data.settings.javaPaths ?? {}), [String(major)]: inspected.javawPath };
    });
    return java.describeInstallation(major, inspected.javawPath);
  });

  ipcMain.handle(IPC.openExternal, async (_event, url: string) => {
    if (!url.startsWith("https://")) {
      throw new Error("Only https URLs can be opened");
    }

    await shell.openExternal(url);
    return true;
  });
}
