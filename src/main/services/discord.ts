import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";
import type { LauncherInstance, LauncherSettings, ModLoader } from "@shared/types";
import { tr } from "../i18n";

const CLIENT_ID = "1561667019735302184";
const LOGO_URL = "https://raw.githubusercontent.com/L1ceX/lynapp/main/build/icon.png";
const PROJECT_URL = "https://github.com/L1ceX/lynapp";
const RETRY_MS = 15000;
const PIPE_COUNT = 10;

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

const LOADER_NAMES: Record<ModLoader, string> = {
  vanilla: "Vanilla",
  fabric: "Fabric",
  forge: "Forge",
  neoforge: "NeoForge",
  quilt: "Quilt"
};

interface GameSession {
  instance: LauncherInstance;
  startedAt: number | null;
}

function pipeCandidates(): string[] {
  if (process.platform === "win32") {
    return Array.from({ length: PIPE_COUNT }, (_, index) => `\\\\?\\pipe\\discord-ipc-${index}`);
  }
  const runtimeDir = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || "/tmp";
  const dirs = [
    runtimeDir,
    path.join(runtimeDir, "app", "com.discordapp.Discord"),
    path.join(runtimeDir, "app", "dev.vencord.Vesktop"),
    path.join(runtimeDir, "snap.discord"),
    "/tmp"
  ];
  const seen = new Set<string>();
  const existing: string[] = [];
  for (let index = 0; index < PIPE_COUNT; index += 1) {
    for (const dir of dirs) {
      const candidate = path.join(dir, `discord-ipc-${index}`);
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      if (existsSync(candidate)) {
        existing.push(candidate);
      }
    }
  }
  return existing;
}

function clip(value: string, max = 128): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export class DiscordPresence {
  private socket: net.Socket | null = null;
  private pendingSocket: net.Socket | null = null;
  private connectGen = 0;
  private connecting = false;
  private ready = false;
  private buffer = Buffer.alloc(0);
  private retryTimer: NodeJS.Timeout | null = null;
  private enabled = false;
  private hideInstance = false;
  private readonly sessions = new Map<string, GameSession>();
  private readonly launcherStartedAt = Date.now();

  applySettings(settings: Pick<LauncherSettings, "discordPresence" | "discordHideInstance">): void {
    this.hideInstance = settings.discordHideInstance;
    if (settings.discordPresence && !this.enabled) {
      this.enabled = true;
      this.connect();
    } else if (!settings.discordPresence && this.enabled) {
      this.enabled = false;
      this.disconnect();
    } else {
      this.push();
    }
  }

  gameStarted(instance: LauncherInstance, startedAt: number | null = Date.now()): void {
    this.sessions.delete(instance.id);
    this.sessions.set(instance.id, { instance, startedAt });
    this.push();
  }

  gameStopped(id: string): void {
    if (this.sessions.delete(id)) {
      this.push();
    }
  }

  syncRunning(runningIds: string[]): void {
    let changed = false;
    for (const id of [...this.sessions.keys()]) {
      if (!runningIds.includes(id)) {
        this.sessions.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.push();
    }
  }

  hasSessions(): boolean {
    return this.sessions.size > 0;
  }

  private connect(candidates?: string[], index = 0): void {
    if (!this.enabled) {
      this.connecting = false;
      return;
    }
    if (this.socket || (this.connecting && index === 0)) {
      return;
    }
    const list = candidates ?? pipeCandidates();
    if (index >= list.length) {
      this.pendingSocket = null;
      this.scheduleRetry();
      return;
    }
    const gen = this.connectGen;
    this.connecting = true;
    const socket = net.createConnection(list[index]);
    this.pendingSocket = socket;
    let opened = false;
    socket.once("connect", () => {
      opened = true;
      if (this.pendingSocket === socket) {
        this.pendingSocket = null;
      }
      this.connecting = false;
      if (!this.enabled || gen !== this.connectGen) {
        socket.destroy();
        return;
      }
      this.socket = socket;
      this.buffer = Buffer.alloc(0);
      this.write(OP_HANDSHAKE, { v: 1, client_id: CLIENT_ID });
    });
    socket.on("data", (chunk: Buffer) => {
      if (this.socket === socket) {
        this.receive(chunk);
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (this.pendingSocket === socket) {
        this.pendingSocket = null;
      }
      if (!opened) {
        if (this.enabled && gen === this.connectGen) {
          this.connect(list, index + 1);
        } else {
          this.connecting = false;
        }
        return;
      }
      if (this.socket === socket) {
        this.socket = null;
        this.ready = false;
        this.scheduleRetry();
      }
    });
  }

  private disconnect(): void {
    this.connectGen += 1;
    this.connecting = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const pending = this.pendingSocket;
    this.pendingSocket = null;
    pending?.destroy();
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    socket?.destroy();
  }

  private scheduleRetry(): void {
    this.connecting = false;
    if (!this.enabled || this.retryTimer) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, RETRY_MS);
    this.retryTimer.unref();
  }

  private write(op: number, payload: unknown): void {
    if (!this.socket || this.socket.destroyed) {
      return;
    }
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const header = Buffer.alloc(8);
    header.writeInt32LE(op, 0);
    header.writeInt32LE(body.length, 4);
    try {
      this.socket.write(Buffer.concat([header, body]));
    } catch {
      this.socket.destroy();
    }
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 8) {
      const op = this.buffer.readInt32LE(0);
      const length = this.buffer.readInt32LE(4);
      if (length < 0 || length > 1024 * 1024) {
        this.socket?.destroy();
        return;
      }
      if (this.buffer.length < 8 + length) {
        return;
      }
      const raw = this.buffer.subarray(8, 8 + length).toString("utf8");
      this.buffer = this.buffer.subarray(8 + length);
      let message: { evt?: string } | null = null;
      try {
        message = JSON.parse(raw) as { evt?: string };
      } catch {
        message = null;
      }
      if (op === OP_PING) {
        this.write(OP_PONG, message ?? {});
      } else if (op === OP_CLOSE) {
        this.socket?.destroy();
        return;
      } else if (op === OP_FRAME && message?.evt === "READY") {
        this.ready = true;
        this.push();
      }
    }
  }

  private push(): void {
    if (!this.ready || !this.socket) {
      return;
    }
    this.write(OP_FRAME, {
      cmd: "SET_ACTIVITY",
      args: { pid: process.pid, activity: this.buildActivity() },
      nonce: randomUUID()
    });
  }

  private buildActivity(): Record<string, unknown> {
    const base = {
      assets: { large_image: LOGO_URL, large_text: "lynapp" },
      buttons: [{ label: tr("Get lynapp", "Скачать lynapp"), url: PROJECT_URL }]
    };
    const current = [...this.sessions.values()].at(-1);
    if (!current) {
      return { ...base, details: tr("In the launcher", "В лаунчере"), timestamps: { start: this.launcherStartedAt } };
    }
    const { instance } = current;
    const version = `Minecraft ${instance.gameVersion}${instance.loader !== "vanilla" ? ` · ${LOADER_NAMES[instance.loader] ?? instance.loader}` : ""}`;
    const showName = !this.hideInstance && instance.name.trim().length >= 2;
    return {
      ...base,
      details: clip(showName ? instance.name.trim() : version),
      ...(showName ? { state: clip(version) } : {}),
      ...(current.startedAt ? { timestamps: { start: current.startedAt } } : {})
    };
  }
}
