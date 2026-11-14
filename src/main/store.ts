import { app, safeStorage } from "electron";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EFFECTS_DEFAULTS, VERSION_TYPES_DEFAULTS, type AccountState, type LauncherInstance, type LauncherSettings, type SkinMeta } from "@shared/types";
import { THEME_DEFAULTS } from "@shared/theme";
import { setMainLanguage, tr } from "./i18n";
import { getInstancesRoot, getLauncherRoot, getLegacyLauncherRoot, getStorePath } from "./paths";

const SECRET_PREFIX = "dpapi:v1:";
const SECRET_ACCOUNT_FIELDS = [
  "minecraftAccessToken",
  "microsoftRefreshToken",
  "elyAccessToken",
  "elyClientToken",
  "elyRefreshToken",
  "xboxUhs"
] as const;

function canEncryptSecrets(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function encryptAccountSecrets(account: AccountState): AccountState {
  if (!canEncryptSecrets()) return account;
  let copy: AccountState | null = null;
  for (const field of SECRET_ACCOUNT_FIELDS) {
    const value = account[field];
    if (typeof value !== "string" || !value || value.startsWith(SECRET_PREFIX)) continue;
    try {
      const encoded = safeStorage.encryptString(value).toString("base64");
      if (!copy) copy = { ...account };
      copy[field] = `${SECRET_PREFIX}${encoded}`;
    } catch {
    }
  }
  return copy ?? account;
}

function decryptAccounts(accounts: AccountState[]): boolean {
  const canEncrypt = canEncryptSecrets();
  let needsRewrite = false;
  for (const account of accounts) {
    let unreadable = false;
    for (const field of SECRET_ACCOUNT_FIELDS) {
      const value = account[field];
      if (typeof value !== "string" || !value) continue;
      if (value.startsWith(SECRET_PREFIX)) {
        if (!canEncrypt) continue;
        try {
          account[field] = safeStorage.decryptString(Buffer.from(value.slice(SECRET_PREFIX.length), "base64"));
        } catch {
          delete account[field];
          unreadable = true;
          needsRewrite = true;
        }
      } else if (canEncrypt) {
        needsRewrite = true;
      }
    }
    if (unreadable && account.status === "signed-in") {
      account.status = "signed-out";
      account.message = tr("Sign in again (device changed)", "Войдите снова (сменилось устройство или система)");
    }
  }
  return needsRewrite;
}

const RETRYABLE_FS_CODES = new Set(["EBUSY", "EPERM", "EACCES", "EMFILE", "ENFILE", "EAGAIN"]);

function isRetryableFsError(error: unknown): boolean {
  return RETRYABLE_FS_CODES.has((error as NodeJS.ErrnoException)?.code ?? "");
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function withFsRetry<T>(action: () => Promise<T>, attempts = 6): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (!isRetryableFsError(error) || attempt === attempts - 1) break;
      await delay(80 * (attempt + 1));
    }
  }
  throw lastError;
}

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
    concurrentDownloads: 8,
    afterLaunch: "keep",
    discordPresence: true,
    discordHideInstance: false,
    betaUpdates: app.getVersion().includes("-"),
    autoInstallDependencies: false,
    versionTypes: { ...VERSION_TYPES_DEFAULTS },
    microsoftClientId: "",
    language: "en",
    theme: { ...THEME_DEFAULTS },
    glowEnabled: true,
    glowSize: 100,
    glowSpeed: 100,
    animationsEnabled: true,
    animationSpeed: 100,
    effects: { ...EFFECTS_DEFAULTS },
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
    theme: { ...defaults.settings.theme, ...(input.settings?.theme ?? {}) },
    versionTypes: { ...defaults.settings.versionTypes, ...(input.settings?.versionTypes ?? {}) },
    effects: {
      ...defaults.settings.effects,
      ...((input.settings as { juice?: Partial<LauncherSettings["effects"]> } | undefined)?.juice ?? {}),
      ...(input.settings?.effects ?? {})
    }
  };
  delete (settings as Record<string, unknown>).juice;
  const legacyClose = (input.settings as { closeOnLaunch?: boolean } | undefined)?.closeOnLaunch;
  if (!input.settings?.afterLaunch && legacyClose) {
    settings.afterLaunch = "close";
  }
  if (!["keep", "hide", "close"].includes(settings.afterLaunch)) {
    settings.afterLaunch = "keep";
  }
  delete (settings as Record<string, unknown>).closeOnLaunch;
  delete (settings as Record<string, unknown>).minMemoryMb;
  const instances = Array.isArray(input.instances) ? input.instances : defaults.instances;
  for (const item of instances) {
    delete (item as unknown as Record<string, unknown>).minMemoryMb;
    delete item.javaPath;
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

export function getSystemMemoryMb(): number {
  return Math.max(1024, Math.round(os.totalmem() / (1024 * 1024)));
}

export function getMaxAllocatableMemoryMb(): number {
  return Math.max(1024, Math.floor(getSystemMemoryMb() / 256) * 256);
}

export function getActiveAccount(data: Pick<LauncherData, "accounts" | "activeAccountId">): AccountState | null {
  return data.accounts.find((item) => item.id === data.activeAccountId) ?? data.accounts[0] ?? null;
}

export class JsonStore {
  private data: LauncherData | null = null;
  private saveQueue: Promise<void> = Promise.resolve();
  private updateQueue: Promise<unknown> = Promise.resolve();
  private tmpCounter = 0;

  constructor(private readonly filePath = getStorePath()) {}

  private loading: Promise<LauncherData> | null = null;

  async load(): Promise<LauncherData> {
    if (this.data) {
      return this.data;
    }
    if (!this.loading) {
      this.loading = this.loadFromDisk().then((data) => {
        setMainLanguage(data.settings.language);
        return data;
      }).finally(() => {
        this.loading = null;
      });
    }
    return this.loading;
  }

  private async loadFromDisk(): Promise<LauncherData> {
    await app.whenReady();
    await migrateLegacyData();
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await mkdir(getInstancesRoot(), { recursive: true });

    if (!existsSync(this.filePath)) {
      this.data = createDefaultData();
      await this.save(this.data);
      return this.data;
    }

    let raw: string;
    try {
      raw = await withFsRetry(() => readFile(this.filePath, "utf8"));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(tr(`Could not read launcher data: ${reason}`, `Не удалось прочитать данные лаунчера: ${reason}`));
    }
    let parsed: LauncherData;
    try {
      parsed = mergeData(JSON.parse(raw) as Partial<LauncherData>);
    } catch {
      try {
        await rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      } catch {
      }
      this.data = createDefaultData();
      await this.save(this.data).catch(() => undefined);
      return this.data;
    }
    this.data = parsed;
    if (decryptAccounts(parsed.accounts)) {
      await this.save(parsed).catch(() => undefined);
    }
    return this.data;
  }

  async getData(): Promise<LauncherData> {
    return this.load();
  }

  update<T>(mutator: (data: LauncherData) => T | Promise<T>): Promise<T> {
    const task = this.updateQueue.then(() => this.runUpdate(mutator));
    this.updateQueue = task.catch(() => undefined);
    return task;
  }

  private async runUpdate<T>(mutator: (data: LauncherData) => T | Promise<T>): Promise<T> {
    const data = await this.load();
    const backup = structuredClone(data);
    let result: T;
    let snapshot: string;
    try {
      result = await mutator(data);
      data.updatedAt = new Date().toISOString();
      snapshot = this.serialize(data);
    } catch (error) {
      this.restore(data, backup);
      throw error;
    }
    const run = this.saveQueue.then(() => this.saveSnapshot(snapshot));
    this.saveQueue = run.catch(() => undefined);
    try {
      await run;
    } catch (error) {
      this.restore(data, backup);
      throw error;
    }
    return result;
  }

  private restore(data: LauncherData, backup: LauncherData): void {
    for (const key of Object.keys(data) as Array<keyof LauncherData>) {
      if (!(key in backup)) delete (data as unknown as Record<string, unknown>)[key];
    }
    Object.assign(data, backup);
  }

  private serialize(data: LauncherData): string {
    return JSON.stringify(
      {
        ...data,
        accounts: data.accounts.map(encryptAccountSecrets)
      },
      null,
      2
    );
  }

  private async saveSnapshot(snapshot: string): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${(this.tmpCounter += 1)}.tmp`;
    try {
      await withFsRetry(() => writeFile(tmpPath, snapshot, "utf8"));
      await withFsRetry(() => rename(tmpPath, this.filePath), 10);
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async save(data: LauncherData): Promise<void> {
    await this.saveSnapshot(this.serialize(data));
  }
}
