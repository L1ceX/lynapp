import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32, createDeflateRaw, createInflateRaw, deflateRawSync, inflateRaw } from "node:zlib";
import { promisify } from "node:util";

const inflateRawAsync = promisify(inflateRaw);

async function readExact(handle: FileHandle, buffer: Buffer, length: number, position: number): Promise<number> {
  let total = 0;
  while (total < length) {
    const { bytesRead } = await handle.read(buffer, total, length - total, position + total);
    if (bytesRead <= 0) break;
    total += bytesRead;
  }
  return total;
}

const SIG_LFH = 0x04034b50;
const SIG_DD = 0x08074b50;
const SIG_CDH = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const ZIP64_LIMIT = 0xffffffff;
const FLAG_UTF8 = 0x0800;
const FLAG_DATA_DESCRIPTOR = 0x0008;

export interface ZipEntryMeta {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compSize: number;
  uncompSize: number;
  localOffset: number;
  isDir: boolean;
  posixMode: number | null;
}

export interface ExtractZipOptions {
  skipEntry?: (entryPath: string) => boolean;
}

export interface CreateZipOptions {
  entries?: string[];
  skipLocked?: boolean;
  level?: number;
  filter?: (fullPath: string, relPath: string) => boolean;
}

function decodeEntryName(rawName: Buffer, flags: number): string {
  const raw = (flags & FLAG_UTF8) !== 0 ? rawName.toString("utf8") : rawName.toString("latin1");
  return raw.replace(/\\/g, "/").replace(/^\.\//, "");
}

function readZip64Extra(extra: Buffer, compSize: number, uncompSize: number, localOffset: number): { compSize: number; uncompSize: number; localOffset: number } {
  let pos = 0;
  let cSize = compSize;
  let uSize = uncompSize;
  let lOff = localOffset;
  while (pos + 4 <= extra.length) {
    const headerId = extra.readUInt16LE(pos);
    const dataSize = extra.readUInt16LE(pos + 2);
    const dataStart = pos + 4;
    if (dataStart + dataSize > extra.length) break;
    if (headerId === 0x0001) {
      let cur = dataStart;
      if (uSize === ZIP64_LIMIT && cur + 8 <= dataStart + dataSize) {
        uSize = Number(extra.readBigUInt64LE(cur));
        cur += 8;
      }
      if (cSize === ZIP64_LIMIT && cur + 8 <= dataStart + dataSize) {
        cSize = Number(extra.readBigUInt64LE(cur));
        cur += 8;
      }
      if (lOff === ZIP64_LIMIT && cur + 8 <= dataStart + dataSize) {
        lOff = Number(extra.readBigUInt64LE(cur));
      }
      break;
    }
    pos = dataStart + dataSize;
  }
  return { compSize: cSize, uncompSize: uSize, localOffset: lOff };
}

async function readCentralDirectory(handle: FileHandle, fileSize: number): Promise<{ valid: boolean; entries: ZipEntryMeta[] }> {
  if (fileSize < 22) return { valid: false, entries: [] };
  const tailSize = Math.min(fileSize, 65557);
  const tailStart = fileSize - tailSize;
  const tail = Buffer.alloc(tailSize);
  if ((await readExact(handle, tail, tailSize, tailStart)) < tailSize) {
    return { valid: false, entries: [] };
  }

  let eocd = -1;
  for (let i = tailSize - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === SIG_EOCD && i + 22 + tail.readUInt16LE(i + 20) === tailSize) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    for (let i = tailSize - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === SIG_EOCD) {
        eocd = i;
        break;
      }
    }
  }
  if (eocd < 0) return { valid: false, entries: [] };

  let count = tail.readUInt16LE(eocd + 10);
  let dirSize = tail.readUInt32LE(eocd + 12);
  let dirOffset = tail.readUInt32LE(eocd + 16);

  if (count === 0xffff || dirSize === ZIP64_LIMIT || dirOffset === ZIP64_LIMIT) {
    const locatorOffset = tailStart + eocd - 20;
    if (locatorOffset < 0) return { valid: false, entries: [] };
    const locator = Buffer.alloc(20);
    if ((await readExact(handle, locator, 20, locatorOffset)) < 20 || locator.readUInt32LE(0) !== SIG_ZIP64_LOCATOR) {
      return { valid: false, entries: [] };
    }
    const z64Offset = Number(locator.readBigUInt64LE(8));
    if (z64Offset < 0 || z64Offset + 56 > fileSize) return { valid: false, entries: [] };
    const z64 = Buffer.alloc(56);
    if ((await readExact(handle, z64, 56, z64Offset)) < 56 || z64.readUInt32LE(0) !== SIG_ZIP64_EOCD) {
      return { valid: false, entries: [] };
    }
    count = Number(z64.readBigUInt64LE(32));
    dirSize = Number(z64.readBigUInt64LE(40));
    dirOffset = Number(z64.readBigUInt64LE(48));
  }

  if (count === 0 && dirSize === 0) return { valid: true, entries: [] };
  if (dirOffset < 0 || dirSize <= 0 || dirOffset + dirSize > fileSize) return { valid: false, entries: [] };

  const dir = Buffer.alloc(dirSize);
  if ((await readExact(handle, dir, dirSize, dirOffset)) < dirSize) {
    return { valid: false, entries: [] };
  }
  if (count > 0 && (dir.length < 4 || dir.readUInt32LE(0) !== SIG_CDH)) {
    return { valid: false, entries: [] };
  }

  const entries: ZipEntryMeta[] = [];
  let pos = 0;
  for (let i = 0; i < count && pos + 46 <= dir.length; i += 1) {
    if (dir.readUInt32LE(pos) !== SIG_CDH) break;
    const madeBy = dir.readUInt16LE(pos + 4);
    const flags = dir.readUInt16LE(pos + 8);
    const method = dir.readUInt16LE(pos + 10);
    const crc = dir.readUInt32LE(pos + 16);
    const rawCompSize = dir.readUInt32LE(pos + 20);
    const rawUncompSize = dir.readUInt32LE(pos + 24);
    const nameLength = dir.readUInt16LE(pos + 28);
    const extraLength = dir.readUInt16LE(pos + 30);
    const commentLength = dir.readUInt16LE(pos + 32);
    const extAttr = dir.readUInt32LE(pos + 38);
    const rawLocalOffset = dir.readUInt32LE(pos + 42);
    if (pos + 46 + nameLength + extraLength > dir.length) break;

    const rawName = dir.subarray(pos + 46, pos + 46 + nameLength);
    const extra = dir.subarray(pos + 46 + nameLength, pos + 46 + nameLength + extraLength);
    const name = decodeEntryName(rawName, flags);
    const resolved =
      rawCompSize === ZIP64_LIMIT || rawUncompSize === ZIP64_LIMIT || rawLocalOffset === ZIP64_LIMIT
        ? readZip64Extra(extra, rawCompSize, rawUncompSize, rawLocalOffset)
        : { compSize: rawCompSize, uncompSize: rawUncompSize, localOffset: rawLocalOffset };

    const hostOs = madeBy >> 8;
    const unixMode = hostOs === 3 ? (extAttr >>> 16) & 0o177777 : null;
    const isDir = name.endsWith("/") || (extAttr & 0x10) !== 0 || (unixMode !== null && (unixMode & 0o170000) === 0o040000);

    entries.push({
      name,
      flags,
      method,
      crc,
      compSize: resolved.compSize,
      uncompSize: resolved.uncompSize,
      localOffset: resolved.localOffset,
      isDir,
      posixMode: unixMode !== null ? unixMode & 0o777 : null
    });

    pos += 46 + nameLength + extraLength + commentLength;
  }
  return { valid: true, entries };
}

async function resolveDataStart(handle: FileHandle, fileSize: number, entry: ZipEntryMeta): Promise<number | null> {
  if (entry.localOffset < 0 || entry.localOffset + 30 > fileSize) return null;
  const localHdr = Buffer.alloc(30);
  if ((await readExact(handle, localHdr, 30, entry.localOffset)) < 30) return null;
  if (localHdr.readUInt32LE(0) !== SIG_LFH) return null;
  const lNameLen = localHdr.readUInt16LE(26);
  const lExtraLen = localHdr.readUInt16LE(28);
  const dataStart = entry.localOffset + 30 + lNameLen + lExtraLen;
  if (dataStart + entry.compSize > fileSize) return null;
  return dataStart;
}

async function readEntryToBuffer(handle: FileHandle, fileSize: number, entry: ZipEntryMeta): Promise<Buffer | null> {
  if (entry.isDir) return Buffer.alloc(0);
  const dataStart = await resolveDataStart(handle, fileSize, entry);
  if (dataStart === null) return null;
  const compBuf = Buffer.alloc(entry.compSize);
  if (entry.compSize > 0 && (await readExact(handle, compBuf, entry.compSize, dataStart)) < entry.compSize) {
    return null;
  }
  if (entry.method === 0) return compBuf;
  if (entry.method === 8) {
    return await inflateRawAsync(compBuf);
  }
  throw new Error(`Unsupported ZIP compression method: ${entry.method}`);
}

export async function listZipEntries(filePath: string): Promise<string[]> {
  try {
    const handle = await open(filePath, "r");
    try {
      const size = (await handle.stat()).size;
      const { valid, entries } = await readCentralDirectory(handle, size);
      if (!valid) return [];
      return entries.map((entry) => entry.name).filter(Boolean);
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
}

export async function readZipEntry(filePath: string, internalPath: string): Promise<Buffer | null> {
  const wanted = internalPath.replace(/\\/g, "/").replace(/^\.\//, "");
  try {
    const handle = await open(filePath, "r");
    try {
      const size = (await handle.stat()).size;
      const { valid, entries } = await readCentralDirectory(handle, size);
      if (!valid) return null;
      const exact = entries.find((entry) => entry.name === wanted) ?? entries.find((entry) => entry.name.toLowerCase() === wanted.toLowerCase());
      if (!exact || exact.compSize > 32 * 1024 * 1024 || exact.uncompSize > 64 * 1024 * 1024) return null;
      return await readEntryToBuffer(handle, size, exact);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

export async function readZipFiles(filePath: string, wantedLower: Set<string>): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  const handle = await open(filePath, "r");
  try {
    const size = (await handle.stat()).size;
    const { valid, entries } = await readCentralDirectory(handle, size);
    if (!valid) return result;
    for (const entry of entries) {
      const lower = entry.name.toLowerCase();
      if (!wantedLower.has(lower) || entry.compSize > 2 * 1024 * 1024 || entry.uncompSize > 4 * 1024 * 1024) continue;
      try {
        const buf = await readEntryToBuffer(handle, size, entry);
        if (buf) result.set(lower, buf);
      } catch {
      }
    }
    return result;
  } finally {
    await handle.close();
  }
}

function resolveExtractTarget(destRoot: string, entryName: string): string | null {
  const cleaned = entryName.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!cleaned) return null;
  if (/^[a-zA-Z]:/.test(cleaned) || cleaned.startsWith("/")) {
    throw new Error(`Unsafe archive path: ${entryName}`);
  }
  const segments = cleaned.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Unsafe archive path: ${entryName}`);
  }
  const target = path.resolve(destRoot, ...segments);
  const rootWithSep = destRoot.endsWith(path.sep) ? destRoot : destRoot + path.sep;
  if (target !== destRoot && !target.startsWith(rootWithSep)) {
    throw new Error(`Unsafe archive path: ${entryName}`);
  }
  return target;
}

export async function extractZip(zipPath: string, destination: string, options?: ExtractZipOptions): Promise<void> {
  const destRoot = path.resolve(destination);
  await mkdir(destRoot, { recursive: true });
  const handle = await open(zipPath, "r");
  try {
    const size = (await handle.stat()).size;
    const { valid, entries } = await readCentralDirectory(handle, size);
    if (!valid) {
      throw new Error("Invalid or corrupted ZIP archive");
    }
    for (const entry of entries) {
      if (options?.skipEntry?.(entry.name)) continue;
      const targetPath = resolveExtractTarget(destRoot, entry.name);
      if (!targetPath) continue;
      if (entry.isDir) {
        await mkdir(targetPath, { recursive: true });
        continue;
      }
      await mkdir(path.dirname(targetPath), { recursive: true });
      const dataStart = await resolveDataStart(handle, size, entry);
      if (dataStart === null) {
        throw new Error(`Corrupted archive entry: ${entry.name}`);
      }
      if (entry.compSize === 0) {
        const out = await open(targetPath, "w");
        await out.close();
      } else if (entry.method === 0) {
        await pipeline(
          createReadStream(zipPath, { start: dataStart, end: dataStart + entry.compSize - 1 }),
          createWriteStream(targetPath)
        );
      } else if (entry.method === 8) {
        await pipeline(
          createReadStream(zipPath, { start: dataStart, end: dataStart + entry.compSize - 1 }),
          createInflateRaw(),
          createWriteStream(targetPath)
        );
      } else {
        throw new Error(`Unsupported ZIP compression method: ${entry.method}`);
      }
      if (process.platform !== "win32" && entry.posixMode !== null && (entry.posixMode & 0o111) !== 0) {
        await chmod(targetPath, entry.posixMode & 0o777).catch(() => undefined);
      }
    }
  } finally {
    await handle.close();
  }
}

interface CollectItem {
  relPath: string;
  fullPath: string;
  isDir: boolean;
  size: number;
  mtime: Date;
  mode: number;
}

async function collectDirectoryItems(
  baseDir: string,
  currentDir: string,
  relPrefix: string,
  items: CollectItem[],
  filter?: (fullPath: string, relPath: string) => boolean
): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(currentDir, entry.name);
    const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (filter && !filter(fullPath, relPath)) continue;
    let info;
    try {
      info = await lstat(fullPath);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      items.push({ relPath: `${relPath}/`, fullPath, isDir: true, size: 0, mtime: info.mtime, mode: info.mode });
      await collectDirectoryItems(baseDir, fullPath, relPath, items, filter);
    } else if (entry.isFile()) {
      items.push({ relPath, fullPath, isDir: false, size: info.size, mtime: info.mtime, mode: info.mode });
    }
  }
}

function toDosTimeDate(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  return { dosTime, dosDate };
}

interface WrittenRecord {
  nameBuf: Buffer;
  method: number;
  flags: number;
  dosTime: number;
  dosDate: number;
  crc: number;
  compSize: number;
  uncompSize: number;
  localOffset: number;
  externalAttr: number;
}

function buildZip64Extra(uncompSize: number, compSize: number, localOffset: number, includeUncomp: boolean, includeComp: boolean, includeOffset: boolean): Buffer {
  const fields: Buffer[] = [];
  if (includeUncomp) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(uncompSize), 0);
    fields.push(b);
  }
  if (includeComp) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(compSize), 0);
    fields.push(b);
  }
  if (includeOffset) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(localOffset), 0);
    fields.push(b);
  }
  if (fields.length === 0) return Buffer.alloc(0);
  const body = Buffer.concat(fields);
  const hdr = Buffer.alloc(4);
  hdr.writeUInt16LE(0x0001, 0);
  hdr.writeUInt16LE(body.length, 2);
  return Buffer.concat([hdr, body]);
}

async function writeChunk(stream: ReturnType<typeof createWriteStream>, chunk: Buffer): Promise<void> {
  if (!stream.write(chunk)) {
    await new Promise<void>((resolve, reject) => {
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const onErr = (err: Error): void => {
        cleanup();
        reject(err);
      };
      const cleanup = (): void => {
        stream.off("drain", onDrain);
        stream.off("error", onErr);
      };
      stream.once("drain", onDrain);
      stream.once("error", onErr);
    });
  }
}

export async function createZipFromDir(sourceDir: string, zipPath: string, options?: CreateZipOptions): Promise<void> {
  const rootDir = path.resolve(sourceDir);
  await mkdir(path.dirname(path.resolve(zipPath)), { recursive: true });

  const items: CollectItem[] = [];
  if (options?.entries) {
    for (const rel of options.entries) {
      const fullPath = path.join(rootDir, rel);
      const normalizedRel = rel.replace(/\\/g, "/").replace(/\/+$/, "");
      if (options.filter && !options.filter(fullPath, normalizedRel)) continue;
      let info;
      try {
        info = await lstat(fullPath);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        items.push({ relPath: `${normalizedRel}/`, fullPath, isDir: true, size: 0, mtime: info.mtime, mode: info.mode });
        await collectDirectoryItems(rootDir, fullPath, normalizedRel, items, options.filter);
      } else if (info.isFile()) {
        items.push({ relPath: rel.replace(/\\/g, "/"), fullPath, isDir: false, size: info.size, mtime: info.mtime, mode: info.mode });
      }
    }
  } else {
    await collectDirectoryItems(rootDir, rootDir, "", items, options?.filter);
  }

  const level = options?.level ?? 1;
  const out = createWriteStream(zipPath);
  const records: WrittenRecord[] = [];
  let offset = 0;

  try {
    for (const item of items) {
      const nameBuf = Buffer.from(item.relPath, "utf8");
      const { dosTime, dosDate } = toDosTimeDate(item.mtime);

      if (item.isDir) {
        const lfh = Buffer.alloc(30);
        lfh.writeUInt32LE(SIG_LFH, 0);
        lfh.writeUInt16LE(20, 4);
        lfh.writeUInt16LE(FLAG_UTF8, 6);
        lfh.writeUInt16LE(0, 8);
        lfh.writeUInt16LE(dosTime, 10);
        lfh.writeUInt16LE(dosDate, 12);
        lfh.writeUInt32LE(0, 14);
        lfh.writeUInt32LE(0, 18);
        lfh.writeUInt32LE(0, 22);
        lfh.writeUInt16LE(nameBuf.length, 26);
        lfh.writeUInt16LE(0, 28);
        await writeChunk(out, lfh);
        await writeChunk(out, nameBuf);
        records.push({
          nameBuf,
          method: 0,
          flags: FLAG_UTF8,
          dosTime,
          dosDate,
          crc: 0,
          compSize: 0,
          uncompSize: 0,
          localOffset: offset,
          externalAttr: 0x10 | (((0o40755) << 16) >>> 0)
        });
        offset += lfh.length + nameBuf.length;
        continue;
      }

      if (options?.skipLocked) {
        try {
          const probe = await open(item.fullPath, "r");
          await probe.close();
        } catch {
          continue;
        }
      }

      const externalAttr = (((0o100000 | (item.mode & 0o777)) << 16) >>> 0);
      const localOffset = offset;

      if (item.size <= 16 * 1024 * 1024) {
        let raw: Buffer;
        try {
          const fh = await open(item.fullPath, "r");
          try {
            raw = await fh.readFile();
          } finally {
            await fh.close();
          }
        } catch (error) {
          if (options?.skipLocked) continue;
          throw error;
        }
        const crc = raw.length ? crc32(raw) : 0;
        const deflated = raw.length ? deflateRawSync(raw, { level }) : Buffer.alloc(0);
        const useStore = deflated.length >= raw.length;
        const payload = useStore ? raw : deflated;
        const method = useStore ? 0 : 8;

        const lfh = Buffer.alloc(30);
        lfh.writeUInt32LE(SIG_LFH, 0);
        lfh.writeUInt16LE(20, 4);
        lfh.writeUInt16LE(FLAG_UTF8, 6);
        lfh.writeUInt16LE(method, 8);
        lfh.writeUInt16LE(dosTime, 10);
        lfh.writeUInt16LE(dosDate, 12);
        lfh.writeUInt32LE(crc >>> 0, 14);
        lfh.writeUInt32LE(payload.length, 18);
        lfh.writeUInt32LE(raw.length, 22);
        lfh.writeUInt16LE(nameBuf.length, 26);
        lfh.writeUInt16LE(0, 28);

        await writeChunk(out, lfh);
        await writeChunk(out, nameBuf);
        if (payload.length > 0) await writeChunk(out, payload);

        records.push({
          nameBuf,
          method,
          flags: FLAG_UTF8,
          dosTime,
          dosDate,
          crc: crc >>> 0,
          compSize: payload.length,
          uncompSize: raw.length,
          localOffset,
          externalAttr
        });
        offset += lfh.length + nameBuf.length + payload.length;
      } else {
        let fh: FileHandle;
        try {
          fh = await open(item.fullPath, "r");
        } catch (error) {
          if (options?.skipLocked) continue;
          throw error;
        }
        const flags = FLAG_UTF8 | FLAG_DATA_DESCRIPTOR;
        const needZip64Header = item.size >= ZIP64_LIMIT;
        const lfhExtra = needZip64Header ? buildZip64Extra(0, 0, 0, true, true, false) : Buffer.alloc(0);
        const lfh = Buffer.alloc(30);
        lfh.writeUInt32LE(SIG_LFH, 0);
        lfh.writeUInt16LE(needZip64Header ? 45 : 20, 4);
        lfh.writeUInt16LE(flags, 6);
        lfh.writeUInt16LE(8, 8);
        lfh.writeUInt16LE(dosTime, 10);
        lfh.writeUInt16LE(dosDate, 12);
        lfh.writeUInt32LE(0, 14);
        lfh.writeUInt32LE(needZip64Header ? ZIP64_LIMIT : 0, 18);
        lfh.writeUInt32LE(needZip64Header ? ZIP64_LIMIT : 0, 22);
        lfh.writeUInt16LE(nameBuf.length, 26);
        lfh.writeUInt16LE(lfhExtra.length, 28);

        await writeChunk(out, lfh);
        await writeChunk(out, nameBuf);
        if (lfhExtra.length > 0) await writeChunk(out, lfhExtra);
        offset += lfh.length + nameBuf.length + lfhExtra.length;

        let crc = 0;
        let uncompSize = 0;
        let compSize = 0;
        const crcPass = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            crc = crc32(chunk, crc);
            uncompSize += chunk.length;
            callback(null, chunk);
          }
        });
        const deflater = createDeflateRaw({ level });
        const counter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            compSize += chunk.length;
            callback(null, chunk);
          }
        });
        try {
          await pipeline(fh.createReadStream(), crcPass, deflater, counter, out, { end: false });
        } finally {
          await fh.close().catch(() => undefined);
        }
        offset += compSize;

        const useZip64Dd = needZip64Header || compSize >= ZIP64_LIMIT || uncompSize >= ZIP64_LIMIT;
        const dd = Buffer.alloc(useZip64Dd ? 24 : 16);
        dd.writeUInt32LE(SIG_DD, 0);
        dd.writeUInt32LE(crc >>> 0, 4);
        if (useZip64Dd) {
          dd.writeBigUInt64LE(BigInt(compSize), 8);
          dd.writeBigUInt64LE(BigInt(uncompSize), 16);
        } else {
          dd.writeUInt32LE(compSize, 8);
          dd.writeUInt32LE(uncompSize, 12);
        }
        await writeChunk(out, dd);
        offset += dd.length;

        records.push({
          nameBuf,
          method: 8,
          flags,
          dosTime,
          dosDate,
          crc: crc >>> 0,
          compSize,
          uncompSize,
          localOffset,
          externalAttr
        });
      }
    }

    const cdOffset = offset;
    let cdSize = 0;
    for (const rec of records) {
      const needUncomp64 = rec.uncompSize >= ZIP64_LIMIT;
      const needComp64 = rec.compSize >= ZIP64_LIMIT;
      const needOffset64 = rec.localOffset >= ZIP64_LIMIT;
      const z64Extra = buildZip64Extra(rec.uncompSize, rec.compSize, rec.localOffset, needUncomp64, needComp64, needOffset64);
      const versionNeeded = z64Extra.length > 0 ? 45 : 20;

      const cdh = Buffer.alloc(46);
      cdh.writeUInt32LE(SIG_CDH, 0);
      cdh.writeUInt16LE((3 << 8) | 45, 4);
      cdh.writeUInt16LE(versionNeeded, 6);
      cdh.writeUInt16LE(rec.flags, 8);
      cdh.writeUInt16LE(rec.method, 10);
      cdh.writeUInt16LE(rec.dosTime, 12);
      cdh.writeUInt16LE(rec.dosDate, 14);
      cdh.writeUInt32LE(rec.crc, 16);
      cdh.writeUInt32LE(needComp64 ? ZIP64_LIMIT : rec.compSize, 20);
      cdh.writeUInt32LE(needUncomp64 ? ZIP64_LIMIT : rec.uncompSize, 24);
      cdh.writeUInt16LE(rec.nameBuf.length, 28);
      cdh.writeUInt16LE(z64Extra.length, 30);
      cdh.writeUInt16LE(0, 32);
      cdh.writeUInt16LE(0, 34);
      cdh.writeUInt16LE(0, 36);
      cdh.writeUInt32LE(rec.externalAttr, 38);
      cdh.writeUInt32LE(needOffset64 ? ZIP64_LIMIT : rec.localOffset, 42);

      await writeChunk(out, cdh);
      await writeChunk(out, rec.nameBuf);
      if (z64Extra.length > 0) await writeChunk(out, z64Extra);
      cdSize += cdh.length + rec.nameBuf.length + z64Extra.length;
    }

    const needZip64Eocd = records.length >= 0xffff || cdSize >= ZIP64_LIMIT || cdOffset >= ZIP64_LIMIT;
    if (needZip64Eocd) {
      const z64EocdOffset = cdOffset + cdSize;
      const z64Eocd = Buffer.alloc(56);
      z64Eocd.writeUInt32LE(SIG_ZIP64_EOCD, 0);
      z64Eocd.writeBigUInt64LE(44n, 4);
      z64Eocd.writeUInt16LE((3 << 8) | 45, 12);
      z64Eocd.writeUInt16LE(45, 14);
      z64Eocd.writeUInt32LE(0, 16);
      z64Eocd.writeUInt32LE(0, 20);
      z64Eocd.writeBigUInt64LE(BigInt(records.length), 24);
      z64Eocd.writeBigUInt64LE(BigInt(records.length), 32);
      z64Eocd.writeBigUInt64LE(BigInt(cdSize), 40);
      z64Eocd.writeBigUInt64LE(BigInt(cdOffset), 48);
      await writeChunk(out, z64Eocd);

      const z64Loc = Buffer.alloc(20);
      z64Loc.writeUInt32LE(SIG_ZIP64_LOCATOR, 0);
      z64Loc.writeUInt32LE(0, 4);
      z64Loc.writeBigUInt64LE(BigInt(z64EocdOffset), 8);
      z64Loc.writeUInt32LE(1, 16);
      await writeChunk(out, z64Loc);
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(records.length >= 0xffff ? 0xffff : records.length, 8);
    eocd.writeUInt16LE(records.length >= 0xffff ? 0xffff : records.length, 10);
    eocd.writeUInt32LE(cdSize >= ZIP64_LIMIT ? ZIP64_LIMIT : cdSize, 12);
    eocd.writeUInt32LE(cdOffset >= ZIP64_LIMIT ? ZIP64_LIMIT : cdOffset, 16);
    eocd.writeUInt16LE(0, 20);
    await writeChunk(out, eocd);

    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  } catch (error) {
    out.destroy();
    throw error;
  }
}
