import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { WorldBackupInfo, WorldInfo } from "@shared/types";
import { tr } from "../i18n";
import { getLauncherRoot } from "../paths";
import { JsonStore } from "../store";
import { parseNbt, type NbtCompound } from "./nbt";

const execFileAsync = promisify(execFile);

async function runZipPs(command: string, envVars: Record<string, string>): Promise<void> {
  await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", command], {
    windowsHide: true,
    timeout: 180000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...envVars }
  });
}

async function createZipFromDir(sourceDir: string, zipPath: string): Promise<void> {
  await runZipPs(
    "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:LYNAPP_SRC, $env:LYNAPP_DST, [System.IO.Compression.CompressionLevel]::Fastest, $false, [System.Text.Encoding]::UTF8)",
    { LYNAPP_SRC: sourceDir, LYNAPP_DST: zipPath }
  );
}

async function extractZipToDir(zipPath: string, destination: string): Promise<void> {
  await runZipPs(
    "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:LYNAPP_SRC, $env:LYNAPP_DST, [System.Text.Encoding]::UTF8)",
    { LYNAPP_SRC: zipPath, LYNAPP_DST: destination }
  );
}

async function isPidAlive(pid: number): Promise<boolean> {
  let accessDenied = false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EPERM") {
      return false;
    }
    accessDenied = true;
  }
  if (process.platform !== "win32") return true;
  try {
    const { stdout } = await execFileAsync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], { windowsHide: true, timeout: 5000 });
    const image = (stdout.split(",")[0] ?? "").replace(/"/g, "").trim().toLowerCase();
    return image === "java.exe" || image === "javaw.exe";
  } catch {
    return !accessDenied;
  }
}

async function assertWorldWritable(store: JsonStore, instanceId: string, worldDir: string): Promise<void> {
  const data = await store.getData();
  const pid = data.runningProcesses[instanceId];
  if (pid !== undefined && (await isPidAlive(pid))) {
    throw new Error(tr("Stop the running Minecraft instance before modifying worlds.", "Остановите запущенную инстанцию Minecraft перед изменением миров."));
  }
  const lockPath = path.join(worldDir, "session.lock");
  if (existsSync(lockPath)) {
    try {
      const handle = await open(lockPath, "r+");
      await handle.close();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "EBUSY" || code === "EACCES" || code === "EPERM") {
        throw new Error(tr("This world is currently open in Minecraft.", "Этот мир сейчас открыт в Minecraft."));
      }
    }
  }
}

async function folderSize(dir: string): Promise<number> {
  let total = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += await folderSize(full);
      } else if (entry.isFile()) {
        const st = await stat(full).catch(() => null);
        if (st) total += st.size;
      }
    }
  } catch {
  }
  return total;
}

function safeSegment(name: string): string {
  const base = path.basename(name);
  if (!base || base === "." || base === ".." || base !== name) {
    throw new Error(tr("Invalid world folder name", "Некорректное имя папки мира"));
  }
  return base;
}

export class WorldService {
  constructor(private readonly store: JsonStore) {}

  private async getInstanceDir(instanceId: string): Promise<string> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === instanceId);
    if (!instance) {
      throw new Error(tr("Instance not found", "Инстанция не найдена"));
    }
    return instance.directory;
  }

  private backupsDir(instanceDir: string, folderName: string): string {
    return path.join(instanceDir, ".launcher", "backups", folderName);
  }

  private async listBackupsForWorld(instanceDir: string, folderName: string): Promise<WorldBackupInfo[]> {
    const dir = this.backupsDir(instanceDir, folderName);
    if (!existsSync(dir)) return [];
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const out: WorldBackupInfo[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".zip")) continue;
        const st = await stat(path.join(dir, entry.name)).catch(() => null);
        if (!st) continue;
        out.push({
          id: entry.name,
          fileName: entry.name,
          size: st.size,
          createdAt: st.mtime.toISOString()
        });
      }
      out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return out;
    } catch {
      return [];
    }
  }

  async list(instanceId: string): Promise<WorldInfo[]> {
    const instanceDir = await this.getInstanceDir(instanceId);
    const savesDir = path.join(instanceDir, "saves");
    if (!existsSync(savesDir)) return [];
    const entries = await readdir(savesDir, { withFileTypes: true }).catch(() => []);
    const worlds: WorldInfo[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const worldDir = path.join(savesDir, entry.name);
      const levelDatPath = path.join(worldDir, "level.dat");
      if (!existsSync(levelDatPath)) continue;

      let name = entry.name;
      let lastPlayed: string | null = null;
      let gameMode: WorldInfo["gameMode"] = "survival";
      let hardcore = false;
      let cheats = false;
      let versionName: string | undefined;

      try {
        const raw = await readFile(levelDatPath);
        const root = parseNbt(raw);
        const data = (root.Data as NbtCompound | undefined) ?? root;
        if (typeof data.LevelName === "string" && data.LevelName.trim()) {
          name = data.LevelName.trim();
        }
        if (typeof data.LastPlayed === "bigint" && data.LastPlayed > 0n) {
          lastPlayed = new Date(Number(data.LastPlayed)).toISOString();
        }
        const gt = Number(data.GameType ?? 0);
        gameMode = gt === 1 ? "creative" : gt === 2 ? "adventure" : gt === 3 ? "spectator" : "survival";
        hardcore = Number(data.hardcore ?? 0) === 1;
        cheats = Number(data.allowCommands ?? 0) === 1;
        const ver = data.Version as NbtCompound | undefined;
        if (ver && typeof ver.Name === "string") {
          versionName = ver.Name;
        }
      } catch {
      }

      if (!lastPlayed) {
        const st = await stat(levelDatPath).catch(() => null);
        if (st) lastPlayed = st.mtime.toISOString();
      }

      let iconDataUrl: string | undefined;
      const iconPath = path.join(worldDir, "icon.png");
      if (existsSync(iconPath)) {
        try {
          const buf = await readFile(iconPath);
          iconDataUrl = `data:image/png;base64,${buf.toString("base64")}`;
        } catch {
        }
      }

      const [size, backups] = await Promise.all([
        folderSize(worldDir),
        this.listBackupsForWorld(instanceDir, entry.name)
      ]);

      worlds.push({
        folderName: entry.name,
        name,
        lastPlayed,
        gameMode,
        hardcore,
        cheats,
        versionName,
        size,
        iconDataUrl,
        backups
      });
    }

    worlds.sort((a, b) => (b.lastPlayed ?? "").localeCompare(a.lastPlayed ?? ""));
    return worlds;
  }

  async backup(instanceId: string, folderName: string): Promise<WorldInfo[]> {
    const safeFolder = safeSegment(folderName);
    const instanceDir = await this.getInstanceDir(instanceId);
    const worldDir = path.join(instanceDir, "saves", safeFolder);
    if (!existsSync(worldDir)) {
      throw new Error(tr("World folder not found", "Папка мира не найдена"));
    }
    const backupsDir = this.backupsDir(instanceDir, safeFolder);
    await mkdir(backupsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    let zipName = `${safeFolder}-${stamp}.zip`;
    let zipPath = path.join(backupsDir, zipName);
    if (existsSync(zipPath)) {
      zipName = `${safeFolder}-${stamp}-${Date.now() % 10000}.zip`;
      zipPath = path.join(backupsDir, zipName);
    }
    const tmpStage = path.join(getLauncherRoot(), "cache", `world-backup-${randomUUID()}`);

    try {
      await mkdir(path.dirname(tmpStage), { recursive: true });
      await cp(worldDir, tmpStage, {
        recursive: true,
        filter: (src) => path.basename(src).toLowerCase() !== "session.lock"
      });
      await createZipFromDir(tmpStage, zipPath);
    } finally {
      await rm(tmpStage, { recursive: true, force: true }).catch(() => undefined);
    }

    return this.list(instanceId);
  }

  async restore(instanceId: string, folderName: string, backupId: string): Promise<WorldInfo[]> {
    const safeFolder = safeSegment(folderName);
    const safeBackup = safeSegment(backupId);
    const instanceDir = await this.getInstanceDir(instanceId);
    const zipPath = path.join(this.backupsDir(instanceDir, safeFolder), safeBackup);
    if (!existsSync(zipPath)) {
      throw new Error(tr("Backup file not found", "Файл резервной копии не найден"));
    }
    const worldDir = path.join(instanceDir, "saves", safeFolder);
    await assertWorldWritable(this.store, instanceId, worldDir);

    const tmpExtract = path.join(getLauncherRoot(), "cache", `world-restore-${randomUUID()}`);
    const backupOld = path.join(instanceDir, ".launcher", "tmp", `world-restore-old-${randomUUID()}`);
    let movedOld = false;

    try {
      await mkdir(tmpExtract, { recursive: true });
      await extractZipToDir(zipPath, tmpExtract);
      const levelDatPath = path.join(tmpExtract, "level.dat");
      if (!existsSync(levelDatPath)) {
        throw new Error(tr("Backup archive does not contain level.dat", "В архиве резервной копии отсутствует level.dat"));
      }
      try {
        parseNbt(await readFile(levelDatPath));
      } catch {
        throw new Error(tr("Backup archive contains a corrupt level.dat", "В архиве резервной копии повреждён файл level.dat"));
      }
      await mkdir(path.dirname(worldDir), { recursive: true });
      if (existsSync(worldDir)) {
        await mkdir(path.dirname(backupOld), { recursive: true });
        await rename(worldDir, backupOld);
        movedOld = true;
      }
      try {
        await cp(tmpExtract, worldDir, { recursive: true });
      } catch (error) {
        await rm(worldDir, { recursive: true, force: true }).catch(() => undefined);
        if (movedOld && existsSync(backupOld)) {
          await rename(backupOld, worldDir).catch(() => undefined);
          movedOld = false;
        }
        throw error;
      }
      if (movedOld) {
        await rm(backupOld, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }).catch(() => undefined);
      }
    } finally {
      await rm(tmpExtract, { recursive: true, force: true }).catch(() => undefined);
    }

    return this.list(instanceId);
  }

  async deleteBackup(instanceId: string, folderName: string, backupId: string): Promise<WorldInfo[]> {
    const safeFolder = safeSegment(folderName);
    const safeBackup = safeSegment(backupId);
    const instanceDir = await this.getInstanceDir(instanceId);
    const zipPath = path.join(this.backupsDir(instanceDir, safeFolder), safeBackup);
    await rm(zipPath, { force: true });
    return this.list(instanceId);
  }

  async deleteWorld(instanceId: string, folderName: string): Promise<WorldInfo[]> {
    const safeFolder = safeSegment(folderName);
    const instanceDir = await this.getInstanceDir(instanceId);
    const worldDir = path.join(instanceDir, "saves", safeFolder);
    await assertWorldWritable(this.store, instanceId, worldDir);
    await rm(worldDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    return this.list(instanceId);
  }
}
