import { randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import { existsSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { ServerEntry, ServerPingResult } from "@shared/types";
import { tr } from "../i18n";
import { JsonStore } from "../store";
import { parseNbt, writeServersDat, type NbtCompound, type RawServerNbtEntry } from "./nbt";

function encodeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (true) {
    if ((v & ~0x7f) === 0) {
      bytes.push(v);
      break;
    }
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  return Buffer.from(bytes);
}

function decodeVarInt(buf: Buffer, offset: number): { value: number; length: number } | null {
  let numRead = 0;
  let result = 0;
  while (true) {
    if (offset + numRead >= buf.length) return null;
    const read = buf[offset + numRead];
    const value = read & 0x7f;
    result |= value << (7 * numRead);
    numRead += 1;
    if (numRead > 5) throw new Error("VarInt too big");
    if ((read & 0x80) === 0) break;
  }
  return { value: result, length: numRead };
}

function encodeMcString(str: string): Buffer {
  const bytes = Buffer.from(str, "utf8");
  return Buffer.concat([encodeVarInt(bytes.length), bytes]);
}

function flattenMotd(desc: unknown): string {
  if (!desc) return "";
  if (typeof desc === "string") return desc;
  if (typeof desc === "object") {
    const obj = desc as { text?: string; extra?: unknown[] };
    let out = typeof obj.text === "string" ? obj.text : "";
    if (Array.isArray(obj.extra)) {
      for (const child of obj.extra) {
        out += flattenMotd(child);
      }
    }
    return out;
  }
  return "";
}

function cleanMotd(raw: string): string {
  return raw
    .replace(/\u00a7[0-9a-fk-orx]/gi, "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function parseAddress(rawIp: string): { host: string; port: number; explicitPort: boolean } {
  const trimmed = rawIp.trim();
  const bracketed = trimmed.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    if (bracketed[2]) {
      const port = Number(bracketed[2]);
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        return { host: bracketed[1], port, explicitPort: true };
      }
    }
    return { host: bracketed[1], port: 25565, explicitPort: false };
  }
  const colonCount = (trimmed.match(/:/g) ?? []).length;
  if (colonCount === 1) {
    const lastColon = trimmed.lastIndexOf(":");
    const portPart = Number(trimmed.slice(lastColon + 1));
    if (lastColon > 0 && Number.isInteger(portPart) && portPart > 0 && portPart <= 65535) {
      return { host: trimmed.slice(0, lastColon), port: portPart, explicitPort: true };
    }
  }
  return { host: stripBrackets(trimmed), port: 25565, explicitPort: false };
}

async function resolveMinecraftAddress(rawIp: string): Promise<{ connectHost: string; connectPort: number; handshakeHost: string }> {
  const parsed = parseAddress(rawIp);
  if (parsed.explicitPort) {
    return { connectHost: parsed.host, connectPort: parsed.port, handshakeHost: parsed.host };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const records = await Promise.race([
      dns.resolveSrv(`_minecraft._tcp.${parsed.host}`),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), 1500);
      })
    ]);
    if (Array.isArray(records) && records.length > 0) {
      const top = records.sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0];
      if (top?.name && top?.port) {
        return { connectHost: top.name.replace(/\.$/, ""), connectPort: top.port, handshakeHost: parsed.host };
      }
    }
  } catch {
  } finally {
    if (timer) clearTimeout(timer);
  }
  return { connectHost: parsed.host, connectPort: parsed.port, handshakeHost: parsed.host };
}

const MAX_PING_BYTES = 2 * 1024 * 1024;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class ServerService {
  private readonly writeQueues = new Map<string, Promise<void>>();

  constructor(private readonly store: JsonStore) {}

  private enqueueWrite<T>(instanceDir: string, task: () => Promise<T>): Promise<T> {
    const prev = this.writeQueues.get(instanceDir) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(task);
    const tail = run.then(() => undefined, () => undefined);
    this.writeQueues.set(instanceDir, tail);
    void tail.finally(() => {
      if (this.writeQueues.get(instanceDir) === tail) {
        this.writeQueues.delete(instanceDir);
      }
    });
    return run;
  }

  private async getInstanceDir(instanceId: string): Promise<string> {
    const data = await this.store.getData();
    const instance = data.instances.find((item) => item.id === instanceId);
    if (!instance) {
      throw new Error(tr("Instance not found", "Инстанция не найдена"));
    }
    return instance.directory;
  }

  private async readRawEntries(instanceDir: string): Promise<RawServerNbtEntry[]> {
    const file = path.join(instanceDir, "servers.dat");
    if (!existsSync(file)) return [];
    let buf: Buffer | null = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        buf = await readFile(file);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if ((code === "EBUSY" || code === "EPERM" || code === "EACCES") && attempt < 4) {
          await delay(80 * (attempt + 1));
          continue;
        }
        throw new Error(tr("Could not read servers.dat (file is locked)", "Не удалось прочитать servers.dat (файл занят)"));
      }
    }
    if (!buf) return [];
    let root: NbtCompound;
    try {
      root = parseNbt(buf);
    } catch {
      throw new Error(tr("servers.dat is corrupt and cannot be parsed", "Файл servers.dat повреждён и не может быть прочитан"));
    }
    const list = Array.isArray(root.servers) ? root.servers : [];
    const out: RawServerNbtEntry[] = [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const compound = item as NbtCompound;
      const ip = typeof compound.ip === "string" ? compound.ip.trim() : "";
      if (!ip) continue;
      const name = typeof compound.name === "string" && compound.name.trim() ? compound.name.trim() : ip;
      const icon = typeof compound.icon === "string" && compound.icon.trim() ? compound.icon.trim() : undefined;
      const acceptTextures = typeof compound.acceptTextures === "number" ? compound.acceptTextures : undefined;
      const hidden = typeof compound.hidden === "number" ? compound.hidden : undefined;
      out.push({ name, ip, icon, acceptTextures, hidden });
    }
    return out;
  }

  private async writeEntriesAtomic(instanceDir: string, entries: RawServerNbtEntry[]): Promise<void> {
    const file = path.join(instanceDir, "servers.dat");
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, writeServersDat(entries));
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          await rename(tmp, file);
          return;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException)?.code;
          if ((code === "EBUSY" || code === "EPERM" || code === "EACCES") && attempt < 5) {
            await delay(80 * (attempt + 1));
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private toServerEntries(raw: RawServerNbtEntry[]): ServerEntry[] {
    return raw.map((item) => ({
      name: item.name,
      ip: item.ip,
      iconDataUrl: item.icon
        ? item.icon.startsWith("data:image/")
          ? item.icon
          : `data:image/png;base64,${item.icon}`
        : undefined
    }));
  }

  async list(instanceId: string): Promise<ServerEntry[]> {
    const instanceDir = await this.getInstanceDir(instanceId);
    return this.toServerEntries(await this.readRawEntries(instanceDir));
  }

  async add(instanceId: string, name: string, ip: string): Promise<ServerEntry[]> {
    const cleanIp = ip.trim();
    if (!cleanIp) {
      throw new Error(tr("Enter a server address", "Введите адрес сервера"));
    }
    const cleanName = name.trim() || cleanIp;
    const instanceDir = await this.getInstanceDir(instanceId);
    return this.enqueueWrite(instanceDir, async () => {
      const existing = await this.readRawEntries(instanceDir);
      const idx = existing.findIndex((item) => item.ip.toLowerCase() === cleanIp.toLowerCase());
      if (idx >= 0) {
        existing[idx] = { ...existing[idx], name: cleanName, ip: cleanIp };
      } else {
        existing.push({ name: cleanName, ip: cleanIp });
      }
      await this.writeEntriesAtomic(instanceDir, existing);
      return this.toServerEntries(existing);
    });
  }

  async remove(instanceId: string, ip: string): Promise<ServerEntry[]> {
    const instanceDir = await this.getInstanceDir(instanceId);
    return this.enqueueWrite(instanceDir, async () => {
      const existing = await this.readRawEntries(instanceDir);
      const next = existing.filter((item) => item.ip.toLowerCase() !== ip.trim().toLowerCase());
      await this.writeEntriesAtomic(instanceDir, next);
      return this.toServerEntries(next);
    });
  }

  async ping(rawIp: string): Promise<ServerPingResult> {
    const ip = rawIp.trim();
    if (!ip) return { ip, online: false };
    const { connectHost, connectPort, handshakeHost } = await resolveMinecraftAddress(ip);
    const startedAt = Date.now();

    return new Promise<ServerPingResult>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (res: ServerPingResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        socket.destroy();
        resolve(res);
      };

      const socket = net.createConnection({ host: connectHost, port: connectPort });
      let latencyMs: number | undefined;
      let acc = Buffer.alloc(0);

      timer = setTimeout(() => {
        finish({ ip, online: false });
      }, 4500);

      socket.on("connect", () => {
        latencyMs = Date.now() - startedAt;
        const portBuf = Buffer.alloc(2);
        portBuf.writeUInt16BE(connectPort, 0);
        const handshakePayload = Buffer.concat([
          encodeVarInt(0x00),
          encodeVarInt(767),
          encodeMcString(handshakeHost),
          portBuf,
          encodeVarInt(1)
        ]);
        const handshakePacket = Buffer.concat([encodeVarInt(handshakePayload.length), handshakePayload]);
        const statusRequestPacket = Buffer.from([0x01, 0x00]);
        socket.write(Buffer.concat([handshakePacket, statusRequestPacket]));
      });

      socket.on("data", (chunk: Buffer) => {
        if (acc.length + chunk.length > MAX_PING_BYTES) {
          finish({ ip, online: false });
          return;
        }
        acc = Buffer.concat([acc, chunk]);
        try {
          const pktLen = decodeVarInt(acc, 0);
          if (!pktLen) return;
          if (pktLen.value <= 0 || pktLen.value > MAX_PING_BYTES) {
            finish({ ip, online: false });
            return;
          }
          if (acc.length < pktLen.length + pktLen.value) return;
          const pktId = decodeVarInt(acc, pktLen.length);
          if (!pktId || pktId.value !== 0x00) {
            finish({ ip, online: false });
            return;
          }
          const strLenOffset = pktLen.length + pktId.length;
          const strLen = decodeVarInt(acc, strLenOffset);
          if (!strLen) return;
          if (strLen.value < 0 || strLen.value > pktLen.value) {
            finish({ ip, online: false });
            return;
          }
          const jsonStart = strLenOffset + strLen.length;
          if (acc.length < jsonStart + strLen.value) return;
          const jsonStr = acc.toString("utf8", jsonStart, jsonStart + strLen.value);
          const parsed = JSON.parse(jsonStr) as {
            version?: { name?: string };
            players?: { max?: number; online?: number };
            description?: unknown;
            favicon?: string;
          };
          const versionName = parsed.version?.name ? cleanMotd(parsed.version.name) : undefined;
          const motd = cleanMotd(flattenMotd(parsed.description));
          const proxyOffline = Boolean((versionName && /\boffline\b/i.test(versionName)) || /\bthis server is offline\b/i.test(motd));
          finish({
            ip,
            online: !proxyOffline,
            latencyMs,
            playersOnline: typeof parsed.players?.online === "number" ? parsed.players.online : undefined,
            playersMax: typeof parsed.players?.max === "number" ? parsed.players.max : undefined,
            versionName: proxyOffline ? undefined : versionName,
            motd,
            iconDataUrl: typeof parsed.favicon === "string" && parsed.favicon.startsWith("data:image/") ? parsed.favicon : undefined
          });
        } catch {
          finish({ ip, online: false });
        }
      });

      socket.on("error", () => {
        finish({ ip, online: false });
      });

      socket.on("timeout", () => {
        finish({ ip, online: false });
      });
    });
  }
}
