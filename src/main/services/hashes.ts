import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

const sha1Cache = new Map<string, { size: number; mtimeMs: number; sha1: string }>();

export async function sha1Cached(filePath: string): Promise<string> {
  const fileStat = await stat(filePath);
  const cached = sha1Cache.get(filePath);
  if (cached && cached.size === fileStat.size && cached.mtimeMs === fileStat.mtimeMs) {
    return cached.sha1;
  }
  const sha1 = createHash("sha1").update(await readFile(filePath)).digest("hex");
  sha1Cache.set(filePath, { size: fileStat.size, mtimeMs: fileStat.mtimeMs, sha1 });
  return sha1;
}
