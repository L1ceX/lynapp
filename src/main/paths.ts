import { app } from "electron";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let tarPath: string | null = null;
export function getTarPath(): string {
  if (tarPath === null) {
    if (process.platform === "win32") {
      const system = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
      tarPath = existsSync(system) ? system : "tar.exe";
    } else if (existsSync("/usr/bin/tar")) {
      tarPath = "/usr/bin/tar";
    } else if (existsSync("/bin/tar")) {
      tarPath = "/bin/tar";
    } else {
      tarPath = "tar";
    }
  }
  return tarPath;
}

export function getAppIconPath(): string | undefined {
  const fileName = process.platform === "win32" ? "icon.ico" : "icon.png";
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, fileName)]
    : [path.join(app.getAppPath(), "build", fileName), path.join(process.cwd(), "build", fileName)];
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

export function getFontsRoot(): string {
  return path.join(getLauncherRoot(), "fonts");
}

function collectJavaBinsInDirs(roots: string[], binaryName: string): string[] {
  const found: string[] = [];
  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const bin = path.join(root, entry.name, "bin", binaryName);
        if (existsSync(bin)) found.push(bin);
      }
    } catch {
    }
  }
  return found;
}

export function getSystemJavaCandidates(): string[] {
  const javaHome = process.env.JAVA_HOME ?? "";
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const localAppData = process.env.LOCALAPPDATA ?? "";

    return [
      javaHome ? path.join(javaHome, "bin", "javaw.exe") : "",
      path.join(programFiles, "Java", "jdk-21", "bin", "javaw.exe"),
      path.join(programFiles, "Eclipse Adoptium", "jdk-21.0.0.0-hotspot", "bin", "javaw.exe"),
      path.join(programFiles, "Microsoft", "jdk-21.0.0.0-hotspot", "bin", "javaw.exe"),
      path.join(programFilesX86, "Minecraft Launcher", "runtime", "java-runtime-gamma", "windows-x64", "java-runtime-gamma", "bin", "javaw.exe"),
      localAppData ? path.join(localAppData, "Programs", "Eclipse Adoptium", "jdk-21", "bin", "javaw.exe") : ""
    ].filter(Boolean);
  }

  const home = os.homedir();
  const subdirs = [
    "/usr/lib/jvm",
    "/usr/lib64/jvm",
    "/usr/java",
    "/opt/java",
    path.join(home, ".jdks"),
    path.join(home, ".sdkman", "candidates", "java")
  ];
  return [
    javaHome ? path.join(javaHome, "bin", "java") : "",
    ...collectJavaBinsInDirs(subdirs, "java"),
    "/usr/bin/java",
    "/usr/local/bin/java"
  ].filter(Boolean);
}
