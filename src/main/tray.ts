import { app, BrowserWindow, Menu, nativeImage, Tray } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { tr } from "./i18n";

let tray: Tray | null = null;
let hiddenForGame = false;

function trayIconPath(): string | null {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "icon.ico")]
    : [path.join(app.getAppPath(), "build", "icon.ico"), path.join(process.cwd(), "build", "icon.ico")];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function isHiddenForGame(): boolean {
  return hiddenForGame;
}

export function hideToTray(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  if (!tray) {
    const iconPath = trayIconPath();
    tray = new Tray(iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty());
    tray.setToolTip("lynapp");
    tray.on("click", () => restoreFromTray(window));
  }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: tr("Open lynapp", "Открыть lynapp"), click: () => restoreFromTray(window) },
    { type: "separator" },
    { label: tr("Quit", "Выход"), click: () => app.quit() }
  ]));
  hiddenForGame = true;
  window.hide();
}

export function restoreFromTray(window: BrowserWindow | null): void {
  hiddenForGame = false;
  if (window && !window.isDestroyed()) {
    window.show();
    if (window.isMinimized()) window.restore();
    window.focus();
  }
  tray?.destroy();
  tray = null;
}
