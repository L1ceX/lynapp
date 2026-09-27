import { app, BrowserWindow, dialog, Menu } from "electron";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { IPC } from "@shared/ipc";
import { registerIpcHandlers } from "./ipc";
import { getElectronUserDataDir, getLauncherRoot } from "./paths";
import { setupAutoUpdater } from "./updater";

let mainWindow: BrowserWindow | null = null;

app.setName("lynapp");
app.setPath("userData", getElectronUserDataDir());
void cleanupLegacyRootFiles();


function isRunningInsideDataDir(): boolean {
  try {
    const execDir = path.dirname(app.getPath("exe"));
    const root = getLauncherRoot();
    return execDir === root || execDir.startsWith(root + path.sep);
  } catch {
    return false;
  }
}


async function cleanupLegacyRootFiles(): Promise<void> {
  const root = getLauncherRoot();
  const junk = [
    "blob_storage",
    "Cache",
    "Code Cache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "GPUCache",
    "Local Storage",
    "Session Storage",
    "Network",
    "Shared Dictionary",
    "DIPS",
    "DIPS-wal",
    "Local State",
    "Preferences",
    "SharedStorage",
    "SharedStorage-wal"
  ];

  for (const name of junk) {
    const target = path.join(root, name);

    if (!existsSync(target)) {
      continue;
    }

    try {
      await rm(target, { recursive: true, force: true });
    } catch {
    }
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 780,
    minWidth: 1040,
    minHeight: 680,
    title: "lynapp",
    backgroundColor: "#0b111d",
    autoHideMenuBar: true,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;

  if (rendererUrl) {
    mainWindow.loadURL(rendererUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  setupAutoUpdater(mainWindow);

  const notifyMaximized = (): void => {
    if (mainWindow) mainWindow.webContents.send(IPC.windowMaximized, mainWindow.isMaximized());
  };
  mainWindow.on("maximize", notifyMaximized);
  mainWindow.on("unmaximize", notifyMaximized);
}

if (isRunningInsideDataDir()) {
  app.whenReady().then(() => {
    dialog.showErrorBox(
      "lynapp is installed into its data folder",
      `This copy runs from:\n${path.dirname(app.getPath("exe"))}\n\nThat folder is reserved for instances and saves. Please reinstall lynapp into a different folder (for example %APPDATA%\\Programs\\lynapp).\n\nYour instances and worlds stay untouched.`
    );
    app.quit();
  });
} else {
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    registerIpcHandlers();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
