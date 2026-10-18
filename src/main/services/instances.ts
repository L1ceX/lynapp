import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, open, readFile, realpath, readdir, rm, stat, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { CreateInstancePayload, UpdateInstancePayload } from "@shared/ipc";
import type { AccountState, LaunchResult, LauncherInstance } from "@shared/types";
import { getInstancesRoot } from "../paths";
import { JsonStore, getActiveAccount, type LauncherData } from "../store";
import type { AuthService } from "./auth";
import { JavaService } from "./java";
import { MinecraftService } from "./minecraft";
import { tr } from "../i18n";

function sanitizeFilePart(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64) || "Instance";
}

function toFolderPart(value: string): string {
  return sanitizeFilePart(value).replace(/\s+/g, "-");
}

function buildInstanceFolderName(payload: CreateInstancePayload, uniqueSuffix: string): string {
  const name = toFolderPart(payload.name || `${payload.loader} ${payload.gameVersion}`);
  const loader = toFolderPart(payload.loader || "vanilla").toLowerCase();
  const version = toFolderPart(payload.gameVersion || "1.21.1");
  const loaderVersion = payload.loaderVersion?.trim() ? `-${toFolderPart(payload.loaderVersion)}` : "";
  const suffix = `-${uniqueSuffix}`;
  const base = `${name}-${loader}-${version}${loaderVersion}`;
  return `${base.slice(0, Math.max(1, 80 - suffix.length))}${suffix}`;
}

function parseJvmFlags(input: string | undefined): string[] {  if (!input?.trim()) {
    return [];
  }
  return [...input.matchAll(/(?:[^\s"]+|"[^"]*")+/g)]
    .map((match) => match[0].replace(/^"|"$/g, "").trim())
    .filter(Boolean);
}

async function readNewestCrash(instanceDir: string): Promise<{ file: string; description: string } | null> {
  let entries: Array<{ name: string; mtime: number }> = [];
  try {
    const dir = path.join(instanceDir, "crash-reports");
    const names = await readdir(dir);
    for (const name of names) {
      if (!/^crash-.*\.(txt|log)$/i.test(name)) continue;
      try {
        const st = await stat(path.join(dir, name));
        entries.push({ name, mtime: st.mtimeMs });
      } catch {
      }
    }
  } catch {
    return null;
  }
  if (!entries.length) return null;
  entries.sort((a, b) => b.mtime - a.mtime);
  const newest = entries[0];
  try {
    const text = await readFile(path.join(instanceDir, "crash-reports", newest.name), "utf8");
    const head = text.slice(0, 20000);
    const desc = head.match(/^Description:\s*(.+)$/im)?.[1]?.trim() ?? "";
    const exc = head.match(/^([a-zA-Z0-9_.$]+(?:Exception|Error)(?::\s*(.+))?)$/im);
    const mixin = head.match(/Callback method \S+ in \S+?:(\S+) from mod (\S+) failed injection/i);
    const sinytra = /sinytra connector is present/i.test(head);
    const parts = [
      mixin ? `Mod '${mixin[2]}' mixin crash (${mixin[1]})` : desc,
      mixin ? "Remove or update the mod, or drop Sinytra Connector test" : exc?.[0]?.trim(),
      !mixin && sinytra ? "Sinytra Connector is present, verify it is not the cause" : ""
    ].filter(Boolean);
    return { file: newest.name, description: parts.slice(0, 2).join(" / ").slice(0, 220) || "Crash report saved" };
  } catch {
    return null;
  }
}

function redactLaunchArgs(args: string[]): string[] {  const secretKeys = new Set(["--accessToken", "--clientId", "--xuid", "--uuid", "--session"]);
  return args.map((arg, index) => (secretKeys.has(args[index - 1]) ? "<redacted>" : arg));
}

async function writeInstanceManifest(instance: LauncherInstance): Promise<void> {
  const launcherDir = path.join(instance.directory, ".launcher");
  await mkdir(launcherDir, { recursive: true });
  await writeFile(path.join(launcherDir, "instance.json"), JSON.stringify(instance, null, 2), "utf8");
}

const execFileAsync = promisify(execFile);

async function isJavaProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
  if (process.platform !== "win32") {
    return true;
  }
  try {
    const { stdout } = await execFileAsync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], { windowsHide: true, timeout: 5000 });
    const image = (stdout.split(",")[0] ?? "").replace(/"/g, "").trim().toLowerCase();
    return image === "java.exe" || image === "javaw.exe";
  } catch {
    return true;
  }
}

export class InstanceService {
  constructor(
    private readonly store: JsonStore,
    private readonly java: JavaService,
    private readonly minecraft: MinecraftService,
    private readonly auth?: AuthService
  ) {}

  private readonly launchAborts = new Map<string, AbortController>();

  async list(): Promise<LauncherInstance[]> {
    const data = await this.store.getData();
    return data.instances;
  }

  async create(payload: CreateInstancePayload): Promise<LauncherInstance> {
    const gameVersion = payload.gameVersion?.trim() || "1.21.1";
    const loader = payload.loader || "vanilla";
    await this.minecraft.assertVersionExists(gameVersion);
    await this.minecraft.assertLoaderCompatible(loader, gameVersion);
    const now = new Date().toISOString();
    const id = randomUUID();
    const name = sanitizeFilePart(payload.name || `${payload.loader} ${gameVersion}`);
    let folderName = buildInstanceFolderName({ ...payload, gameVersion }, id.slice(0, 6));
    let directory = path.join(getInstancesRoot(), folderName);
    for (let n = 2; n < 100 && existsSync(directory); n += 1) {
      folderName = buildInstanceFolderName({ ...payload, gameVersion }, `${id.slice(0, 6)}-${n}`);
      directory = path.join(getInstancesRoot(), folderName);
    }
    if (existsSync(directory)) {
      throw new Error(tr("Could not pick a free folder for the instance", "Не удалось подобрать свободную папку для инстанции"));
    }

    const instance: LauncherInstance = {
      id,
      name,
      gameVersion,
      loader: payload.loader || "vanilla",
      loaderVersion: payload.loaderVersion?.trim() || undefined,
      directory,
      icon: payload.loader === "vanilla" ? "grass" : "anvil",
      createdAt: now,
      updatedAt: now,
      mods: []
    };

    await mkdir(path.join(directory, "mods"), { recursive: true });
    await mkdir(path.join(directory, "resourcepacks"), { recursive: true });
    await mkdir(path.join(directory, "shaderpacks"), { recursive: true });
    await mkdir(path.join(directory, "datapacks"), { recursive: true });
    await mkdir(path.join(directory, "modpacks"), { recursive: true });
    await mkdir(path.join(directory, "config"), { recursive: true });
    await mkdir(path.join(directory, "saves"), { recursive: true });
    await writeInstanceManifest(instance);

    return this.store.update((data) => {
      data.instances.unshift(instance);
      data.activeInstanceId = instance.id;
      return instance;
    });
  }

  async updateInstance(payload: UpdateInstancePayload): Promise<LauncherInstance> {
    const data = await this.store.getData();
    const current = data.instances.find((item) => item.id === payload.id);
    if (!current) {
      throw new Error(tr("Instance not found", "Инстанция не найдена"));
    }
    const nextGameVersion = payload.patch.gameVersion !== undefined
      ? payload.patch.gameVersion.trim() || "1.21.1"
      : current.gameVersion;
    const nextLoader = payload.patch.loader ?? current.loader;
    const versionChanged = nextGameVersion !== current.gameVersion;
    const loaderKindChanged = nextLoader !== current.loader;
    const loaderChanged = loaderKindChanged
      || (payload.patch.loaderVersion ?? current.loaderVersion) !== current.loaderVersion;
    if (payload.patch.gameVersion !== undefined) {
      payload.patch.gameVersion = nextGameVersion;
    }
    if ((versionChanged || loaderKindChanged) && payload.patch.loaderVersion === undefined) {
      payload.patch.loaderVersion = "";
    }
    if (versionChanged || loaderChanged) {
      await this.minecraft.assertVersionExists(nextGameVersion);
      await this.minecraft.assertLoaderCompatible(nextLoader, nextGameVersion);
    }

    const updated = await this.store.update((data) => {
      const instance = data.instances.find((item) => item.id === payload.id);
      if (!instance) {
        throw new Error(tr("Instance not found", "Инстанция не найдена"));
      }

      Object.assign(instance, payload.patch);
      instance.name = sanitizeFilePart(instance.name);
      instance.loaderVersion = instance.loaderVersion?.trim() || undefined;
      instance.updatedAt = new Date().toISOString();
      return instance;
    });

    await writeInstanceManifest(updated);
    return updated;
  }

  async remove(id: string): Promise<boolean> {
    const data = await this.store.getData();
    const target = data.instances.find((item) => item.id === id);
    if (!target) {
      return false;
    }

    const pid = data.runningProcesses[id];
    if (pid !== undefined && (await isJavaProcessAlive(pid))) {
      throw new Error(tr(`${target.name} is running. Stop it before deleting.`, `${target.name} запущена. Остановите её перед удалением.`));
    }

    const directory = target.directory;
    const root = await realpath(getInstancesRoot()).catch(() => getInstancesRoot());
    const resolvedDir = await realpath(directory).catch(() => directory);
    if (resolvedDir === root || !resolvedDir.startsWith(root + path.sep)) {
      throw new Error(tr("Refusing to delete a folder outside the instances directory", "Удаление отменено: папка находится вне каталога инстанций"));
    }
    await rm(directory, { recursive: true, force: true });

    return this.store.update((current) => {
      const before = current.instances.length;
      current.instances = current.instances.filter((item) => item.id !== id);
      delete current.runningProcesses[id];

      if (current.activeInstanceId === id) {
        current.activeInstanceId = current.instances[0]?.id ?? null;
      }

      return current.instances.length !== before;
    });
  }

  async launch(id: string, onProgress?: (progress: import("./minecraft").LaunchProgress) => void): Promise<LaunchResult> {
    if (this.launchAborts.has(id)) {
      return {
        ok: false,
        message: tr("already launching", "уже запускается")
      };
    }
    const controller = new AbortController();
    this.launchAborts.set(id, controller);
    const signal = controller.signal;

    try {
      const data = await this.store.getData();
      const instance = data.instances.find((item) => item.id === id);

      if (!instance) {
        return {
          ok: false,
          message: tr("Instance not found", "Инстанция не найдена")
        };
      }

      const existingPid = data.runningProcesses[id];
      if (existingPid !== undefined && (await isJavaProcessAlive(existingPid))) {
        return {
          ok: false,
          message: tr("already running", "уже запущена")
        };
      }
      if (existingPid !== undefined) {
        const stale = existingPid;
        await this.store.update((current) => {
          if (current.runningProcesses[id] === stale) {
            delete current.runningProcesses[id];
          }
        }).catch(() => undefined);
      }

      try {
        await mkdir(path.join(instance.directory, ".launcher", "logs"), { recursive: true });
        await writeFile(path.join(instance.directory, ".launcher", "logs", "latest.log"), `lynapp Minecraft log\nStarted: ${new Date().toISOString()}\nInstance: ${instance.name}\n`, "utf8");
      } catch {
      }

      let activeAccount = getActiveAccount(data);
      if (!activeAccount) {
        return {
          ok: false,
          message: tr("Add an account first (Microsoft login or offline profile)", "Сначала добавьте аккаунт (вход через Microsoft или офлайн-профиль)")
        };
      }
      if (this.auth && activeAccount.kind !== "offline") {
        const exp = activeAccount.expiresAt ? Date.parse(activeAccount.expiresAt) : NaN;
        const needsMicrosoftRefresh = activeAccount.kind === "microsoft" && (Number.isNaN(exp) || exp - Date.now() < 5 * 60 * 1000);
        if (needsMicrosoftRefresh || activeAccount.kind === "ely") {
          const fresh = await this.auth.ensureFreshSession().catch(() => null);
          if (fresh) {
            activeAccount = fresh;
          }
        }
      }
      if (
        activeAccount.kind === "microsoft" &&
        activeAccount.expiresAt &&
        !Number.isNaN(Date.parse(activeAccount.expiresAt)) &&
        Date.parse(activeAccount.expiresAt) < Date.now()
      ) {
        return {
          ok: false,
          message: tr(`Microsoft session for ${activeAccount.profileName ?? "account"} expired. Log in again via Add account.`, `Сессия Microsoft для ${activeAccount.profileName ?? "аккаунта"} истекла. Войдите снова через «Добавить аккаунт».`)
        };
      }

      try {
        return await this.runLaunch(id, instance, data, activeAccount, signal, onProgress);
      } catch (error) {
        if (signal.aborted) {
          return {
            ok: false,
            message: tr("launch cancelled", "запуск отменён")
          };
        }
        throw error;
      }
    } finally {
      if (this.launchAborts.get(id) === controller) {
        this.launchAborts.delete(id);
      }
    }
  }

  async cancelLaunch(id: string): Promise<LaunchResult> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === id);

    if (!instance) {
      return {
        ok: false,
        message: tr("Instance not found", "Инстанция не найдена")
      };
    }

    const controller = this.launchAborts.get(id);
    if (controller) {
      controller.abort();
    }

    const pid = data.runningProcesses[id];
    if (pid !== undefined) {
      if (await isJavaProcessAlive(pid)) {
        try {
          process.kill(pid);
        } catch {
        }
        await this.store.update((current) => {
          delete current.runningProcesses[id];
        });
        return {
          ok: true,
          message: tr("stopped", "остановлена")
        };
      }
      const stalePid = pid;
      await this.store.update((current) => {
        if (current.runningProcesses[id] === stalePid) {
          delete current.runningProcesses[id];
        }
      }).catch(() => undefined);
    }

    return {
      ok: true,
      message: tr("launch cancelled", "запуск отменён")
    };
  }

  private async runLaunch(id: string, instance: LauncherInstance, data: LauncherData, activeAccount: AccountState, signal: AbortSignal, onProgress?: (progress: import("./minecraft").LaunchProgress) => void): Promise<LaunchResult> {
    const requiredMajor = await this.minecraft.getRequiredJavaMajor(instance.gameVersion);
    const javaRuntime = await this.java.ensureRuntime(requiredMajor, [
      data.settings.javaPaths?.[String(requiredMajor)],
      data.settings.javaPath
    ], signal, (received, total) => onProgress?.({ phase: "java", done: 0, total: 0, received, totalBytes: total }));
    const javaPath = javaRuntime.path;
    const rawMemory = instance.maxMemoryMb || data.settings.maxMemoryMb;
    const maxMemoryMb = Math.min(65536, Math.max(512, Math.round(rawMemory) || 4096));
    const extraJvmArgs = parseJvmFlags(instance.extraJvmArgs?.trim() ? instance.extraJvmArgs : data.settings.extraJvmArgs);

    const updatedInstance = await this.store.update((current) => {
      const target = current.instances.find((item) => item.id === id);

      if (!target) {
        throw new Error(tr("Instance not found", "Инстанция не найдена"));
      }

      target.updatedAt = new Date().toISOString();
      return target;
    });

    await writeInstanceManifest(updatedInstance);

    const launch = await this.minecraft.prepareLaunch(updatedInstance, activeAccount, {
      memoryMb: maxMemoryMb,
      extraJvmArgs
    }, javaPath, signal, onProgress, data.settings.concurrentDownloads);
    const launchPlanPath = path.join(instance.directory, ".launcher", "logs", "latest-launch-plan.log");
    await mkdir(path.dirname(launchPlanPath), { recursive: true });
    await writeFile(
      launchPlanPath,
      [
        `Instance: ${instance.name}`,
        `Game version: ${instance.gameVersion}`,
        `Loader: ${instance.loader}${instance.loaderVersion ? ` ${instance.loaderVersion}` : ""}`,
        `Java: ${javaRuntime.message}`,
        `Java path: ${javaPath}`,
        `Main class: ${launch.mainClass}`,
        `Natives: ${launch.nativesDir}`,
        `Working directory: ${instance.directory}`,
        `Command: "${javaPath}" ${redactLaunchArgs(launch.args).map((arg) => (arg.includes(" ") ? `"${arg}"` : arg)).join(" ")}`,
        launch.warning ? `Warning: ${launch.warning}` : ""
      ].join("\n"),
      "utf8"
    );

    const logHeader = [
      `lynapp Minecraft log`,
      `Started: ${new Date().toISOString()}`,
      `Instance: ${instance.name}`,
      `Game version: ${instance.gameVersion}`,
      `Java: ${javaPath}`,
      launch.warning ? `Warning: ${launch.warning}` : "",
      ""
    ].join("\n");
    await writeFile(launch.logPath, logHeader, "utf8");

    const logFd = openSync(launch.logPath, "a");
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(javaPath, launch.args, {
        cwd: instance.directory,
        detached: true,
        stdio: ["ignore", logFd, logFd],
        windowsHide: false
      });
    } catch (error) {
      closeSync(logFd);
      return {
        ok: false,
        message: error instanceof Error ? tr(`Could not start Java: ${error.message}`, `Не удалось запустить Java: ${error.message}`) : tr("Could not start Java", "Не удалось запустить Java")
      };
    }
    child.unref();
    closeSync(logFd);

    if (!child.pid) {
      return {
        ok: false,
        message: tr("Minecraft process failed to start", "Не удалось запустить процесс Minecraft")
      };
    }

    const startedPid = child.pid;
    const startedChild = child;
    startedChild.on("error", () => {
      void this.store
        .update((current) => {
          if (current.runningProcesses[id] === startedPid) {
            delete current.runningProcesses[id];
          }
        })
        .catch(() => undefined);
    });
    startedChild.on("exit", () => {
      void this.store
        .update((current) => {
          if (current.runningProcesses[id] === startedPid) {
            delete current.runningProcesses[id];
          }
        })
        .catch(() => undefined);
    });

    await this.store.update((current) => {
      current.runningProcesses[id] = startedPid;
    });

    return {
      ok: true,
      message: tr(`${javaRuntime.message}. Minecraft process started${launch.warning ? ` (${launch.warning})` : ""}.`, `${javaRuntime.message}. Процесс Minecraft запущен${launch.warning ? ` (${launch.warning})` : ""}.`),
      logPath: launch.logPath,
      pid: startedPid,
      java: javaRuntime
    };
  }

  async getRunning(): Promise<string[]> {
    const data = await this.store.getData();
    const alive: string[] = [];

    for (const [id, pid] of Object.entries(data.runningProcesses)) {
      if (await isJavaProcessAlive(pid)) {
        alive.push(id);
      }
    }

    const dead = Object.keys(data.runningProcesses).filter((id) => !alive.includes(id));
    if (dead.length) {
      await this.store.update((current) => {
        for (const id of dead) {
          delete current.runningProcesses[id];
        }
      });
    }

    return alive;
  }

  async stop(id: string): Promise<LaunchResult> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === id);

    if (!instance) {
      return {
        ok: false,
        message: tr("Instance not found", "Инстанция не найдена")
      };
    }

    const pid = data.runningProcesses[id];
    if (pid === undefined || !(await isJavaProcessAlive(pid))) {
      await this.store.update((current) => {
        delete current.runningProcesses[id];
      }).catch(() => undefined);
      return {
        ok: false,
        message: tr("not running", "не запущена")
      };
    }

    try {
      await new Promise<void>((resolve) => {
        execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
      });
      try {
        process.kill(pid);
      } catch {
      }
    } catch {
    }

    await this.store.update((current) => {
      delete current.runningProcesses[id];
    });

    return {
      ok: true,
      message: tr("stopped", "остановлена")
    };
  }

  async pruneRunning(): Promise<void> {
    await this.getRunning();
  }

  async getLogs(id: string): Promise<{ log: string; plan: string; hasLog: boolean; crash: { file: string; description: string } | null }> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === id);
    if (!instance) {
      throw new Error(tr("Instance not found", "Инстанция не найдена"));
    }
    const tailKb = 200 * 1024;
    const readTail = async (file: string): Promise<{ text: string; found: boolean }> => {
      let handle: import("node:fs/promises").FileHandle | null = null;
      try {
        handle = await open(file, "r");
        const size = (await handle.stat()).size;
        if (size <= 0) {
          return { text: "", found: true };
        }
        const start = Math.max(0, size - tailKb);
        const buf = Buffer.alloc(Math.min(size, tailKb));
        await handle.read(buf, 0, buf.length, start);
        let text = buf.toString("utf8");
        if (start > 0) {
          const cut = text.indexOf("\n");
          text = cut >= 0 ? text.slice(cut + 1) : text;
        }
        return { text, found: true };
      } catch {
        return { text: "", found: false };
      } finally {
        await handle?.close().catch(() => undefined);
      }
    };
    const logPath = path.join(instance.directory, ".launcher", "logs", "latest.log");
    const planPath = path.join(instance.directory, ".launcher", "logs", "latest-launch-plan.log");
    const log = await readTail(logPath);
    const plan = await readTail(planPath);
    return { log: log.text, plan: plan.text, hasLog: log.found, crash: await readNewestCrash(instance.directory) };
  }
}
