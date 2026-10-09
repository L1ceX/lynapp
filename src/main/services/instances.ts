import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import type { CreateInstancePayload, UpdateInstancePayload } from "@shared/ipc";
import type { AccountState, LaunchResult, LauncherInstance } from "@shared/types";
import { getInstancesRoot } from "../paths";
import { JsonStore, getActiveAccount, type LauncherData } from "../store";
import type { AuthService } from "./auth";
import { JavaService } from "./java";
import { MinecraftService } from "./minecraft";

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

function parseJvmFlags(input: string | undefined): string[] {
  if (!input?.trim()) {
    return [];
  }
  return [...input.matchAll(/(?:[^\s"]+|"[^"]*")+/g)]
    .map((match) => match[0].replace(/^"|"$/g, "").trim())
    .filter(Boolean);
}

function redactLaunchArgs(args: string[]): string[] {  const secretKeys = new Set(["--accessToken", "--clientId", "--xuid", "--uuid"]);
  return args.map((arg, index) => (secretKeys.has(args[index - 1]) ? "<redacted>" : arg));
}

async function writeInstanceManifest(instance: LauncherInstance): Promise<void> {
  const launcherDir = path.join(instance.directory, ".launcher");
  await mkdir(launcherDir, { recursive: true });
  await writeFile(path.join(launcherDir, "instance.json"), JSON.stringify(instance, null, 2), "utf8");
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
      throw new Error("Could not pick a free folder for the instance");
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
    if (payload.patch.gameVersion !== undefined) {
      const gameVersion = payload.patch.gameVersion.trim() || "1.21.1";
      await this.minecraft.assertVersionExists(gameVersion);
      payload.patch.gameVersion = gameVersion;
    }

    const data = await this.store.getData();
    const current = data.instances.find((item) => item.id === payload.id);
    if (!current) {
      throw new Error("Instance not found");
    }
    await this.minecraft.assertLoaderCompatible(payload.patch.loader ?? current.loader, payload.patch.gameVersion ?? current.gameVersion);

    const updated = await this.store.update((data) => {
      const instance = data.instances.find((item) => item.id === payload.id);
      if (!instance) {
        throw new Error("Instance not found");
      }

      Object.assign(instance, payload.patch);
      instance.name = sanitizeFilePart(instance.name);
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
    if (pid !== undefined) {
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (error) {
        alive = (error as NodeJS.ErrnoException)?.code === "EPERM";
      }
      if (alive) {
        throw new Error(`${target.name} is running. Stop it before deleting.`);
      }
    }

    const directory = target.directory;
    const root = await realpath(getInstancesRoot()).catch(() => getInstancesRoot());
    const resolvedDir = await realpath(directory).catch(() => directory);
    if (resolvedDir === root || !resolvedDir.startsWith(root + path.sep)) {
      throw new Error("Refusing to delete a folder outside the instances directory");
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

  async launch(id: string): Promise<LaunchResult> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === id);

    if (!instance) {
      return {
        ok: false,
        message: "Instance not found"
      };
    }

    const existingPid = data.runningProcesses[id];
    if (existingPid !== undefined) {
      try {
        process.kill(existingPid, 0);
        return {
          ok: false,
          message: "already running"
        };
      } catch {
      }
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
        message: "Add an account first (Microsoft login or offline profile)"
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
        message: `Microsoft session for ${activeAccount.profileName ?? "account"} expired. Log in again via Add account.`
      };
    }

    const controller = new AbortController();
    this.launchAborts.set(id, controller);
    const signal = controller.signal;

    try {
      return await this.runLaunch(id, instance, data, activeAccount, signal);
    } catch (error) {
      if (signal.aborted) {
        return {
          ok: false,
          message: "launch cancelled"
        };
      }
      throw error;
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
        message: "Instance not found"
      };
    }

    const controller = this.launchAborts.get(id);
    if (controller) {
      controller.abort();
    }

    const pid = data.runningProcesses[id];
    if (pid !== undefined) {
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (error) {
        alive = (error as NodeJS.ErrnoException)?.code === "EPERM";
      }
      if (alive) {
        try {
          process.kill(pid);
        } catch {
        }
        await this.store.update((current) => {
          delete current.runningProcesses[id];
        });
        return {
          ok: true,
          message: "stopped"
        };
      }
    }

    return {
      ok: true,
      message: "launch cancelled"
    };
  }

  private async runLaunch(id: string, instance: LauncherInstance, data: LauncherData, activeAccount: AccountState, signal: AbortSignal): Promise<LaunchResult> {
    const requiredMajor = await this.minecraft.getRequiredJavaMajor(instance.gameVersion);
    const javaRuntime = await this.java.ensureRuntime(requiredMajor, [
      instance.javaPath,
      data.settings.javaPaths?.[String(requiredMajor)],
      data.settings.javaPath
    ], signal);
    const javaPath = javaRuntime.path;
    const rawMemory = instance.maxMemoryMb || data.settings.maxMemoryMb;
    const maxMemoryMb = Math.min(65536, Math.max(512, Math.round(rawMemory) || 4096));
    const extraJvmArgs = parseJvmFlags(instance.extraJvmArgs ?? data.settings.extraJvmArgs);

    const updatedInstance = await this.store.update((current) => {
      const target = current.instances.find((item) => item.id === id);

      if (!target) {
        throw new Error("Instance not found");
      }

      target.javaPath = javaPath;
      target.updatedAt = new Date().toISOString();
      return target;
    });

    await writeInstanceManifest(updatedInstance);

    const launch = await this.minecraft.prepareLaunch(updatedInstance, activeAccount, {
      memoryMb: maxMemoryMb,
      extraJvmArgs
    }, javaPath, signal);
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
    const child = spawn(javaPath, launch.args, {
      cwd: instance.directory,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: false
    });
    child.unref();
    closeSync(logFd);

    if (!child.pid) {
      return {
        ok: false,
        message: "Minecraft process failed to start"
      };
    }

    const startedPid = child.pid;
    child.on("exit", () => {
      void this.store
        .update((current) => {
          delete current.runningProcesses[id];
        })
        .catch(() => undefined);
    });

    await this.store.update((current) => {
      current.runningProcesses[id] = startedPid;
    });

    return {
      ok: true,
      message: `${javaRuntime.message}. Minecraft process started${launch.warning ? ` (${launch.warning})` : ""}.`,
      logPath: launch.logPath,
      pid: startedPid,
      java: javaRuntime
    };
  }

  async getRunning(): Promise<string[]> {
    const data = await this.store.getData();
    const alive: string[] = [];

    for (const [id, pid] of Object.entries(data.runningProcesses)) {
      try {
        process.kill(pid, 0);
        alive.push(id);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "EPERM") {
          alive.push(id);
        }
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
        message: "Instance not found"
      };
    }

    const pid = data.runningProcesses[id];
    if (pid === undefined) {
      return {
        ok: false,
        message: "not running"
      };
    }

    try {
      const { execFile: execFileCb } = await import("node:child_process");
      await new Promise<void>((resolve) => {
        execFileCb("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
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
      message: "stopped"
    };
  }

  async pruneRunning(): Promise<void> {
    await this.getRunning();
  }

  async getLogs(id: string): Promise<{ log: string; plan: string; hasLog: boolean }> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === id);
    if (!instance) {
      throw new Error("Instance not found");
    }
    const tailKb = 200 * 1024;
    const readTail = async (file: string): Promise<{ text: string; found: boolean }> => {
      try {
        const buf = await readFile(file);
        const slice = buf.length > tailKb ? buf.subarray(buf.length - tailKb) : buf;
        let text = slice.toString("utf8");
        if (buf.length > tailKb) {
          const cut = text.indexOf("\n");
          text = cut >= 0 ? text.slice(cut + 1) : text;
        }
        return { text, found: true };
      } catch {
        return { text: "", found: false };
      }
    };
    const logPath = path.join(instance.directory, ".launcher", "logs", "latest.log");
    const planPath = path.join(instance.directory, ".launcher", "logs", "latest-launch-plan.log");
    const log = await readTail(logPath);
    const plan = await readTail(planPath);
    return { log: log.text, plan: plan.text, hasLog: log.found };
  }
}
