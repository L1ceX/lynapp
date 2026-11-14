import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

const sha1Cache = new Map<string, { size: number; mtimeMs: number; sha1: string }>();
const cfFpCache = new Map<string, { size: number; mtimeMs: number; fp: number }>();

export function cfFingerprintBuffer(buf: Buffer): number {
  let len = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const b = buf[i];
    if (b !== 9 && b !== 10 && b !== 13 && b !== 32) len += 1;
  }
  const m = 0x5bd1e995;
  let h = (1 ^ len) >>> 0;
  let k = 0;
  let shift = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const b = buf[i];
    if (b === 9 || b === 10 || b === 13 || b === 32) continue;
    k |= b << shift;
    shift += 8;
    if (shift === 32) {
      k = Math.imul(k, m) >>> 0;
      k = (k ^ (k >>> 24)) >>> 0;
      k = Math.imul(k, m) >>> 0;
      h = (Math.imul(h, m) ^ k) >>> 0;
      k = 0;
      shift = 0;
    }
  }
  if (shift > 0) {
    h = (h ^ k) >>> 0;
    h = Math.imul(h, m) >>> 0;
  }
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, m) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h >>> 0;
}

export async function sha1Cached(filePath: string): Promise<string> {
  const fileStat = await stat(filePath);
  const cached = sha1Cache.get(filePath);
  if (cached && cached.size === fileStat.size && cached.mtimeMs === fileStat.mtimeMs) {
    return cached.sha1;
  }
  const sha1 = createHash("sha1").update(await readFile(filePath)).digest("hex");
  if (sha1Cache.size > 4000) sha1Cache.clear();
  sha1Cache.set(filePath, { size: fileStat.size, mtimeMs: fileStat.mtimeMs, sha1 });
  return sha1;
}

export async function cfFingerprintCached(filePath: string): Promise<number> {
  const fileStat = await stat(filePath);
  const cached = cfFpCache.get(filePath);
  if (cached && cached.size === fileStat.size && cached.mtimeMs === fileStat.mtimeMs) {
    return cached.fp;
  }
  const fp = cfFingerprintBuffer(await readFile(filePath));
  if (cfFpCache.size > 4000) cfFpCache.clear();
  cfFpCache.set(filePath, { size: fileStat.size, mtimeMs: fileStat.mtimeMs, fp });
  return fp;
}
