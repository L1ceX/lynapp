import { app, BrowserWindow, crashReporter, dialog, Menu } from "electron";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { IPC } from "@shared/ipc";
import { registerIpcHandlers } from "./ipc";
import { getAppIconPath, getElectronUserDataDir, getLauncherRoot } from "./paths";
import { setupAutoUpdater } from "./updater";
import { restoreFromTray } from "./tray";
import { getMainWindow, setMainWindow } from "./window";

let mainWindow: BrowserWindow | null = null;

app.setName("lynapp");
app.setPath("userData", getElectronUserDataDir());
crashReporter.start({ submitURL: "", uploadToServer: false });
const disabledFeatures = ["AutofillServerCommunication", "PasswordManager", "PasswordGeneration"];
if (!app.isPackaged) {
  disabledFeatures.push("CalculateNativeWinOcclusion");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
}
app.commandLine.appendSwitch("disable-features", disabledFeatures.join(","));

const singleInstance = app.isPackaged ? app.requestSingleInstanceLock() : true;

if (!singleInstance) {
  app.quit();
} else {
  void cleanupLegacyRootFiles();
  app.on("second-instance", () => {
    const window = getMainWindow();
    if (window) {
      restoreFromTray(window);
    }
  });
  startApp();
}

function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function currentExecDir(): string {
  if (process.platform === "win32" && process.env.PORTABLE_EXECUTABLE_DIR) {
    return process.env.PORTABLE_EXECUTABLE_DIR;
  }
  return path.dirname(app.getPath("exe"));
}

function isRunningInsideDataDir(): boolean {
  try {
    const execDir = normalizeForCompare(currentExecDir());
    const root = normalizeForCompare(getLauncherRoot());
    return execDir === root || execDir.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
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
    icon: getAppIconPath(),
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
    setMainWindow(null);
  });
  setMainWindow(mainWindow);

  setupAutoUpdater(mainWindow);

  const notifyMaximized = (): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.windowMaximized, mainWindow.isMaximized());
    }
  };
  mainWindow.on("maximize", notifyMaximized);
  mainWindow.on("unmaximize", notifyMaximized);
}

function startApp(): void {
  if (isRunningInsideDataDir()) {
    const exampleDir = process.platform === "win32" ? "%LOCALAPPDATA%\\Programs\\lynapp" : "~/.local/bin";
    const runningDir = currentExecDir();
    app.whenReady().then(() => {
      dialog.showErrorBox(
        "lynapp is installed into its data folder / lynapp установлен в папку с данными",
        `This copy runs from:\n${runningDir}\n\nThat folder is reserved for instances and saves. Please reinstall lynapp into a different folder (for example ${exampleDir}).\n\nYour instances and worlds stay untouched.\n\n---\n\nЭта копия запущена из папки:\n${runningDir}\n\nЭта папка зарезервирована для инстанций и сохранений. Переустановите lynapp в другую папку (например, ${exampleDir}).\n\nВаши инстанции и миры останутся нетронутыми.`
      );
      app.quit();
    });
    return;
  }
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    registerIpcHandlers();
    createWindow();

    app.on("activate", () => {
      if (!getMainWindow()) {
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
