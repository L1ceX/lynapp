import { app } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";

let tarPath: string | null = null;
export function getTarPath(): string {
  if (tarPath === null) {
    const system = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    tarPath = existsSync(system) ? system : "tar.exe";
  }
  return tarPath;
}

export function getAppIconPath(): string | undefined {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "icon.ico")]
    : [path.join(app.getAppPath(), "build", "icon.ico"), path.join(process.cwd(), "build", "icon.ico")];
  return candidates.find((candidate) => existsSync(candidate));
}

export function getLauncherRoot(): string {
  return path.join(app.getPath("appData"), "lynapp");
}

export function getElectronUserDataDir(): string {
  return path.join(getLauncherRoot(), "app");
}

export function getLegacyLauncherRoot(): string {
  return path.join(app.getPath("appData"), "LianLauncher");
}

export function getInstancesRoot(): string {
  return path.join(getLauncherRoot(), "instances");
}

export function getStorePath(): string {
  return path.join(getLauncherRoot(), "launcher-data.json");
}

export function getWindowsJavaCandidates(): string[] {
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const localAppData = process.env.LOCALAPPDATA ?? "";

  return [
    path.join(programFiles, "Java", "jdk-21", "bin", "javaw.exe"),
    path.join(programFiles, "Eclipse Adoptium", "jdk-21.0.0.0-hotspot", "bin", "javaw.exe"),
    path.join(programFiles, "Microsoft", "jdk-21.0.0.0-hotspot", "bin", "javaw.exe"),
    path.join(programFilesX86, "Minecraft Launcher", "runtime", "java-runtime-gamma", "windows-x64", "java-runtime-gamma", "bin", "javaw.exe"),
    localAppData ? path.join(localAppData, "Programs", "Eclipse Adoptium", "jdk-21", "bin", "javaw.exe") : ""
  ].filter(Boolean);
}
