import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AccountState, LauncherInstance, LauncherSettings, SkinMeta } from "@shared/types";
import { THEME_DEFAULTS } from "@shared/theme";
import { getInstancesRoot, getLauncherRoot, getLegacyLauncherRoot, getStorePath } from "./paths";

export interface LauncherData {
  settings: LauncherSettings;
  instances: LauncherInstance[];
  activeInstanceId: string | null;
  accounts: AccountState[];
  activeAccountId: string | null;
  runningProcesses: Record<string, number>;
  skins: SkinMeta[];
  updatedAt: string;
}

function defaultSettings(): LauncherSettings {
  return {
    javaPath: "",
    javaPaths: {},
    maxMemoryMb: 4096,
    extraJvmArgs: "",
    launcherDataDir: getLauncherRoot(),
    concurrentDownloads: 4,
    closeOnLaunch: false,
    microsoftClientId: "",
    theme: { ...THEME_DEFAULTS },
    glowEnabled: true,
    glowSize: 100,
    glowSpeed: 100,
    animationsEnabled: true,
    activeSkinId: null
  };
}

function createDefaultData(): LauncherData {
  return {
    settings: defaultSettings(),
    instances: [],
    activeInstanceId: null,
    skins: [],
    accounts: [],
    activeAccountId: null,
    runningProcesses: {},
    updatedAt: new Date().toISOString()
  };
}

async function migrateLegacyData(): Promise<void> {
  const nextRoot = getLauncherRoot();
  const oldRoot = getLegacyLauncherRoot();

  if (existsSync(nextRoot) || !existsSync(oldRoot)) {
    return;
  }

  await mkdir(path.dirname(nextRoot), { recursive: true });
  await cp(oldRoot, nextRoot, { recursive: true });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EPERM") {
      return true;
    }
    return false;
  }
}

function pruneDeadProcesses(running: Record<string, number> | undefined): Record<string, number> {
  const alive: Record<string, number> = {};

  for (const [id, pid] of Object.entries(running ?? {})) {
    if (typeof pid === "number" && isProcessAlive(pid)) {
      alive[id] = pid;
    }
  }

  return alive;
}

function mergeData(input: Partial<LauncherData>): LauncherData {
  const defaults = createDefaultData();
  const settings = {
    ...defaults.settings,
    ...(input.settings ?? {}),
    theme: { ...defaults.settings.theme, ...(input.settings?.theme ?? {}) }
  };
  delete (settings as Record<string, unknown>).minMemoryMb;
  const instances = Array.isArray(input.instances) ? input.instances : defaults.instances;
  for (const item of instances) {
    delete (item as unknown as Record<string, unknown>).minMemoryMb;
  }

  let accounts = Array.isArray(input.accounts) ? input.accounts : [...defaults.accounts];
  let activeAccountId = input.activeAccountId ?? defaults.activeAccountId;
  const legacy = (input as Partial<LauncherData> & { account?: AccountState }).account;
  if (!accounts.length && legacy && (legacy.profileName || legacy.minecraftAccessToken || legacy.minecraftUuid)) {
    const entry: AccountState = {
      id: legacy.minecraftUuid || legacy.profileName || `legacy-${Date.now()}`,
      kind: legacy.status === "offline" ? "offline" : "microsoft",
      status: legacy.status === "pending" || legacy.status === "signed-out" ? "signed-out" : legacy.status,
      profileName: legacy.profileName,
      minecraftUuid: legacy.minecraftUuid,
      expiresAt: legacy.expiresAt,
      message: legacy.message,
      minecraftAccessToken: legacy.minecraftAccessToken,
      microsoftRefreshToken: legacy.microsoftRefreshToken,
      activeSkinId: settings.activeSkinId ?? null,
      addedAt: new Date().toISOString()
    };
    accounts = [entry];
    activeAccountId = entry.id;
  }
  if (!accounts.some((item) => item.id === activeAccountId)) {
    activeAccountId = accounts[0]?.id ?? null;
  }
  const active = accounts.find((item) => item.id === activeAccountId) ?? null;
  if (!active || active.status !== "signed-in") {
    settings.activeSkinId = active?.activeSkinId ?? null;
  }

  return {
    settings,
    instances,
    skins: Array.isArray(input.skins) ? input.skins : defaults.skins,
    activeInstanceId: input.activeInstanceId ?? defaults.activeInstanceId,
    accounts,
    activeAccountId,
    runningProcesses: pruneDeadProcesses(input.runningProcesses),
    updatedAt: input.updatedAt ?? defaults.updatedAt
  };
}

export function getActiveAccount(data: Pick<LauncherData, "accounts" | "activeAccountId">): AccountState | null {
  return data.accounts.find((item) => item.id === data.activeAccountId) ?? data.accounts[0] ?? null;
}

export class JsonStore {
  private data: LauncherData | null = null;
  private saveQueue: Promise<void> = Promise.resolve();
  private tmpCounter = 0;

  constructor(private readonly filePath = getStorePath()) {}

  async load(): Promise<LauncherData> {
    if (this.data) {
      return this.data;
    }

    await migrateLegacyData();
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await mkdir(getInstancesRoot(), { recursive: true });

    if (!existsSync(this.filePath)) {
      this.data = createDefaultData();
      await this.save(this.data);
      return this.data;
    }

    const raw = await readFile(this.filePath, "utf8");
    this.data = mergeData(JSON.parse(raw) as Partial<LauncherData>);
    return this.data;
  }

  async getData(): Promise<LauncherData> {
    return this.load();
  }

  async update<T>(mutator: (data: LauncherData) => T | Promise<T>): Promise<T> {
    const data = await this.load();
    const result = await mutator(data);
    data.updatedAt = new Date().toISOString();
    const snapshot = JSON.stringify(data, null, 2);
    const run = this.saveQueue.then(() => this.saveSnapshot(snapshot));
    this.saveQueue = run.catch(() => undefined);
    await run;
    return result;
  }

  private async saveSnapshot(snapshot: string): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${(this.tmpCounter += 1)}.tmp`;
    await writeFile(tmpPath, snapshot, "utf8");
    await rename(tmpPath, this.filePath);
  }

  private async save(data: LauncherData): Promise<void> {
    await this.saveSnapshot(JSON.stringify(data, null, 2));
  }
}
