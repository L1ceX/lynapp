import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { rm } from "node:fs/promises";
import path from "node:path";
import { IPC } from "@shared/ipc";
import type { CreateInstancePayload, InstallModPayload, LocalContentPayload, ModSearchPayload, SkinAddPayload, SkinUpdatePayload, UpdateInstancePayload } from "@shared/ipc";
import type { LauncherSettings, ModLoader, ModrinthProjectType } from "@shared/types";
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

export function registerIpcHandlers(): void {
  const store = new JsonStore();
  const java = new JavaService();
  const minecraft = new MinecraftService();
  const instances = new InstanceService(store, java, minecraft);
  const mods = new ModService(store);
  const skins = new SkinService(store);
  const content = new ContentService(store);
  const auth = new AuthService(store);
  const modpacks = new ModpackService(store, instances, minecraft);

  void instances.pruneRunning().catch(() => undefined);
  void rm(path.join(getLauncherRoot(), "cache", "modpacks"), { recursive: true, force: true }).catch(() => undefined);

  ipcMain.handle(IPC.bootstrap, async () => {
    const data = await store.getData();
    return {
      settings: data.settings,
      instances: data.instances,
      activeInstanceId: data.activeInstanceId,
      accounts: data.accounts,
      activeAccountId: data.activeAccountId,
      storagePath: getStorePath(),
      javaCandidates: await java.listCandidatePaths([data.settings.javaPath])
    };
  });

  ipcMain.handle(IPC.createInstance, (_event, payload: CreateInstancePayload) => instances.create(payload));  ipcMain.handle(IPC.updateInstance, (_event, payload: UpdateInstancePayload) => instances.updateInstance(payload));
  ipcMain.handle(IPC.removeInstance, (_event, id: string) => instances.remove(id));
  ipcMain.handle(IPC.importMrpackStart, (_event, filePath: string) => modpacks.beginImport(filePath));
  ipcMain.handle(IPC.importMrpackFiles, (event, instanceId: string) => modpacks.finishImport(instanceId, event.sender));
  ipcMain.handle(IPC.launchInstance, (_event, id: string) => instances.launch(id));
  ipcMain.handle(IPC.getRunningInstances, () => instances.getRunning());
  ipcMain.handle(IPC.stopInstance, (_event, id: string) => instances.stop(id));
  ipcMain.handle(IPC.listSkins, () => skins.list());
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
  ipcMain.handle(IPC.toggleLocalContent, (_event, payload: LocalContentPayload) => content.toggle(payload.instanceId, payload.fileName));
  ipcMain.handle(IPC.removeLocalContent, (_event, payload: LocalContentPayload) => content.remove(payload.instanceId, payload.fileName));

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
  ipcMain.handle(IPC.installMod, (_event, payload: InstallModPayload) => mods.install(payload));
  ipcMain.handle(IPC.beginMicrosoftLogin, (event) => auth.beginMicrosoftLogin(BrowserWindow.fromWebContents(event.sender)));
  ipcMain.handle(IPC.useOfflineProfile, (_event, username: string) => auth.useOfflineProfile(username));
  ipcMain.handle(IPC.setActiveAccount, (_event, id: string) => auth.setActiveAccount(id));
  ipcMain.handle(IPC.removeAccount, (_event, id: string) => auth.removeAccount(id));

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
