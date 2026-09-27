import { app } from "electron";
import path from "node:path";

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
