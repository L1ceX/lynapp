import { app, type BrowserWindow } from "electron";
import electronUpdater from "electron-updater";
import { IPC } from "@shared/ipc";
import type { UpdateStatus } from "@shared/types";
import { tr } from "./i18n";

const { autoUpdater } = electronUpdater;

let mainWindow: BrowserWindow | null = null;
let listening = false;
let allowBeta: boolean | null = null;

function check(): void {
  if (!app.isPackaged || !listening || allowBeta === null) {
    return;
  }
  autoUpdater.allowPrerelease = allowBeta;
  void autoUpdater.checkForUpdates().catch(() => undefined);
}

export function setBetaUpdates(enabled: boolean): void {
  if (allowBeta === enabled) {
    return;
  }
  allowBeta = enabled;
  check();
}

function send(status: UpdateStatus): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.updaterStatus, status);
  }
}

export function setupAutoUpdater(window: BrowserWindow): void {
  mainWindow = window;

  if (!app.isPackaged || listening) {
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;

  autoUpdater.on("update-available", (info) => {
    send({ kind: "available", version: info.version });
  });
  autoUpdater.on("download-progress", (progress) => {
    send({ kind: "downloading", percent: Math.round(progress.percent) });
  });
  autoUpdater.on("update-downloaded", (info) => {
    send({ kind: "ready", version: info.version });
  });
  autoUpdater.on("error", (error: unknown) => {
    send({
      kind: "error",
      message: error instanceof Error ? error.message : String(error)
    });
  });

  listening = true;
  check();
}

export async function downloadUpdate(): Promise<void> {
  if (!app.isPackaged) {
    throw new Error(tr("Self-update works only in installed builds", "Автообновление работает только в установленной версии"));
  }
  await autoUpdater.downloadUpdate();
}

export function installUpdate(): void {
  autoUpdater.quitAndInstall(false, true);
}
