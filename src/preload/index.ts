import { contextBridge, ipcRenderer, webUtils } from "electron";
import { IPC, type LauncherApi } from "@shared/ipc";
import type { UpdateStatus } from "@shared/types";

const api: LauncherApi = {
  getFilePath: (file) => Promise.resolve(webUtils.getPathForFile(file)),
  getBootstrap: () => ipcRenderer.invoke(IPC.bootstrap),
  createInstance: (payload) => ipcRenderer.invoke(IPC.createInstance, payload),
  updateInstance: (payload) => ipcRenderer.invoke(IPC.updateInstance, payload),
  removeInstance: (id) => ipcRenderer.invoke(IPC.removeInstance, id),
  importMrpackStart: (filePath) => ipcRenderer.invoke(IPC.importMrpackStart, filePath),
  importMrpackFiles: (instanceId) => ipcRenderer.invoke(IPC.importMrpackFiles, instanceId),
  onMrpackProgress: (listener) => {
    const handler = (_event: unknown, update: { instanceId: string; done: number; total: number; fileName: string }) => listener(update);
    ipcRenderer.on(IPC.mrpackProgress, handler);
    return () => ipcRenderer.removeListener(IPC.mrpackProgress, handler);
  },
  launchInstance: (id) => ipcRenderer.invoke(IPC.launchInstance, id),
  getRunningInstances: () => ipcRenderer.invoke(IPC.getRunningInstances),
  stopInstance: (id) => ipcRenderer.invoke(IPC.stopInstance, id),
  cancelLaunch: (id) => ipcRenderer.invoke(IPC.cancelLaunch, id),
  getInstanceLogs: (id) => ipcRenderer.invoke(IPC.getInstanceLogs, id),
  listSkins: () => ipcRenderer.invoke(IPC.listSkins),
  elySkin: () => ipcRenderer.invoke(IPC.elySkin),
  addSkin: (payload) => ipcRenderer.invoke(IPC.addSkin, payload),
  updateSkin: (payload) => ipcRenderer.invoke(IPC.updateSkin, payload),
  removeSkin: (id) => ipcRenderer.invoke(IPC.removeSkin, id),
  activateSkin: (id) => ipcRenderer.invoke(IPC.activateSkin, id),
  listCapes: () => ipcRenderer.invoke(IPC.listCapes),
  equipCape: (capeId) => ipcRenderer.invoke(IPC.equipCape, capeId),
  downloadUpdate: () => ipcRenderer.invoke(IPC.updaterDownload),
  installUpdate: () => ipcRenderer.invoke(IPC.updaterInstall),
  onUpdateStatus: (listener) => {
    const handler = (_event: unknown, status: UpdateStatus) => listener(status);
    ipcRenderer.on(IPC.updaterStatus, handler);
    return () => ipcRenderer.removeListener(IPC.updaterStatus, handler);
  },
  minimizeWindow: () => ipcRenderer.invoke(IPC.windowMinimize),
  toggleMaximize: () => ipcRenderer.invoke(IPC.windowToggleMaximize),
  closeWindow: () => ipcRenderer.invoke(IPC.windowClose),
  isMaximized: () => ipcRenderer.invoke(IPC.windowIsMaximized),
  onMaximizedChange: (listener) => {
    const handler = (_event: unknown, maximized: boolean) => listener(maximized);
    ipcRenderer.on(IPC.windowMaximized, handler);
    return () => ipcRenderer.removeListener(IPC.windowMaximized, handler);
  },
  updateSettings: (patch) => ipcRenderer.invoke(IPC.updateSettings, patch),
  searchMods: (payload) => ipcRenderer.invoke(IPC.searchMods, payload),
  getCategoryTags: (projectType) => ipcRenderer.invoke(IPC.getCategoryTags, projectType),
  installMod: (payload) => ipcRenderer.invoke(IPC.installMod, payload),
  beginMicrosoftLogin: () => ipcRenderer.invoke(IPC.beginMicrosoftLogin),
  refreshSession: () => ipcRenderer.invoke(IPC.refreshSession),
  elyLogin: (username, password, totp) => ipcRenderer.invoke(IPC.elyLogin, username, password, totp),
  useOfflineProfile: (username) => ipcRenderer.invoke(IPC.useOfflineProfile, username),
  setActiveAccount: (id) => ipcRenderer.invoke(IPC.setActiveAccount, id),
  removeAccount: (id) => ipcRenderer.invoke(IPC.removeAccount, id),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  getJavaInstallations: () => ipcRenderer.invoke(IPC.getJavaInstallations),
  installJava: (major) => ipcRenderer.invoke(IPC.installJava, major),
  detectJava: (major) => ipcRenderer.invoke(IPC.detectJava, major),
  browseJava: (major) => ipcRenderer.invoke(IPC.browseJava, major),
  getGameVersions: () => ipcRenderer.invoke(IPC.getGameVersions),
  getLoaderSupport: () => ipcRenderer.invoke(IPC.getLoaderSupport),
  getLoaderVersions: (loader, gameVersion) => ipcRenderer.invoke(IPC.getLoaderVersions, loader, gameVersion),
  openInstanceFolder: (id) => ipcRenderer.invoke(IPC.openInstanceFolder, id),
  getLocalContent: (instanceId) => ipcRenderer.invoke(IPC.getLocalContent, instanceId),
  toggleLocalContent: (payload) => ipcRenderer.invoke(IPC.toggleLocalContent, payload),
  removeLocalContent: (payload) => ipcRenderer.invoke(IPC.removeLocalContent, payload)
};

contextBridge.exposeInMainWorld("launcher", api);
