import { gunzipSync } from "node:zlib";

export type NbtValue = number | bigint | string | Buffer | NbtValue[] | NbtCompound;

export interface NbtCompound {
  [key: string]: NbtValue;
}

function decodeModifiedUtf8(buf: Buffer, start: number, len: number): string {
  const chars: string[] = [];
  let i = start;
  const end = start + len;
  while (i < end) {
    const c = buf[i];
    if ((c & 0x80) === 0) {
      i += 1;
      chars.push(String.fromCharCode(c));
    } else if ((c & 0xe0) === 0xc0) {
      if (i + 1 >= end) throw new Error("Malformed MUTF-8 string");
      const c2 = buf[i + 1];
      if ((c2 & 0xc0) !== 0x80) throw new Error("Malformed MUTF-8 string");
      chars.push(String.fromCharCode(((c & 0x1f) << 6) | (c2 & 0x3f)));
      i += 2;
    } else if ((c & 0xf0) === 0xe0) {
      if (i + 2 >= end) throw new Error("Malformed MUTF-8 string");
      const c2 = buf[i + 1];
      const c3 = buf[i + 2];
      if ((c2 & 0xc0) !== 0x80 || (c3 & 0xc0) !== 0x80) throw new Error("Malformed MUTF-8 string");
      chars.push(String.fromCharCode(((c & 0x0f) << 12) | ((c2 & 0x3f) << 6) | (c3 & 0x3f)));
      i += 3;
    } else if ((c & 0xf8) === 0xf0) {
      if (i + 3 >= end) throw new Error("Malformed MUTF-8 string");
      const c2 = buf[i + 1];
      const c3 = buf[i + 2];
      const c4 = buf[i + 3];
      if ((c2 & 0xc0) !== 0x80 || (c3 & 0xc0) !== 0x80 || (c4 & 0xc0) !== 0x80) throw new Error("Malformed MUTF-8 string");
      chars.push(String.fromCodePoint(((c & 0x07) << 18) | ((c2 & 0x3f) << 12) | ((c3 & 0x3f) << 6) | (c4 & 0x3f)));
      i += 4;
    } else {
      throw new Error("Malformed MUTF-8 string");
    }
  }
  return chars.join("");
}

function encodeModifiedUtf8(str: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i += 1) {
    const c = str.charCodeAt(i);
    if (c >= 0x0001 && c <= 0x007f) {
      bytes.push(c);
    } else if (c > 0x07ff) {
      bytes.push(0xe0 | ((c >> 12) & 0x0f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      bytes.push(0xc0 | ((c >> 6) & 0x1f), 0x80 | (c & 0x3f));
    }
  }
  return Buffer.from(bytes);
}

class NbtReader {
  private offset = 0;

  constructor(private readonly buf: Buffer) {}

  private ensure(bytes: number): void {
    if (bytes < 0 || this.offset + bytes > this.buf.length) {
      throw new Error("Unexpected end of NBT data");
    }
  }

  readUInt8(): number {
    this.ensure(1);
    const val = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return val;
  }

  readInt8(): number {
    this.ensure(1);
    const val = this.buf.readInt8(this.offset);
    this.offset += 1;
    return val;
  }

  readInt16(): number {
    this.ensure(2);
    const val = this.buf.readInt16BE(this.offset);
    this.offset += 2;
    return val;
  }

  readUInt16(): number {
    this.ensure(2);
    const val = this.buf.readUInt16BE(this.offset);
    this.offset += 2;
    return val;
  }

  readInt32(): number {
    this.ensure(4);
    const val = this.buf.readInt32BE(this.offset);
    this.offset += 4;
    return val;
  }

  readInt64(): bigint {
    this.ensure(8);
    const val = this.buf.readBigInt64BE(this.offset);
    this.offset += 8;
    return val;
  }

  readFloat(): number {
    this.ensure(4);
    const val = this.buf.readFloatBE(this.offset);
    this.offset += 4;
    return val;
  }

  readDouble(): number {
    this.ensure(8);
    const val = this.buf.readDoubleBE(this.offset);
    this.offset += 8;
    return val;
  }

  readString(): string {
    const len = this.readUInt16();
    this.ensure(len);
    const val = decodeModifiedUtf8(this.buf, this.offset, len);
    this.offset += len;
    return val;
  }

  readPayload(tagType: number): NbtValue {
    switch (tagType) {
      case 1:
        return this.readInt8();
      case 2:
        return this.readInt16();
      case 3:
        return this.readInt32();
      case 4:
        return this.readInt64();
      case 5:
        return this.readFloat();
      case 6:
        return this.readDouble();
      case 7: {
        const len = this.readInt32();
        this.ensure(len);
        const slice = this.buf.subarray(this.offset, this.offset + len);
        this.offset += len;
        return slice;
      }
      case 8:
        return this.readString();
      case 9: {
        const elemType = this.readUInt8();
        const len = this.readInt32();
        if (len < 0) throw new Error("Negative NBT list length");
        if (elemType !== 0 && len > this.buf.length - this.offset) {
          throw new Error("NBT list exceeds buffer bounds");
        }
        if (len > 1000000) throw new Error("NBT list too large");
        const out: NbtValue[] = [];
        for (let i = 0; i < len; i += 1) {
          out.push(this.readPayload(elemType));
        }
        return out;
      }
      case 10: {
        const compound: NbtCompound = {};
        let ended = false;
        while (this.offset < this.buf.length) {
          const type = this.readUInt8();
          if (type === 0) {
            ended = true;
            break;
          }
          const name = this.readString();
          compound[name] = this.readPayload(type);
        }
        if (!ended) {
          throw new Error("Unexpected end of NBT compound tag");
        }
        return compound;
      }
      case 11: {
        const len = this.readInt32();
        if (len < 0) throw new Error("Negative NBT int array length");
        this.ensure(len * 4);
        const out: number[] = [];
        for (let i = 0; i < len; i += 1) {
          out.push(this.readInt32());
        }
        return out;
      }
      case 12: {
        const len = this.readInt32();
        if (len < 0) throw new Error("Negative NBT long array length");
        this.ensure(len * 8);
        const out: bigint[] = [];
        for (let i = 0; i < len; i += 1) {
          out.push(this.readInt64());
        }
        return out;
      }
      default:
        throw new Error(`Unsupported NBT tag ${tagType}`);
    }
  }

  readRoot(): NbtCompound {
    const rootType = this.readUInt8();
    if (rootType !== 10) {
      throw new Error("Root NBT tag is not a compound");
    }
    this.readString();
    return this.readPayload(10) as NbtCompound;
  }
}

export function parseNbt(raw: Buffer): NbtCompound {
  const isGzip = raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b;
  const uncompressed = isGzip ? gunzipSync(raw) : raw;
  return new NbtReader(uncompressed).readRoot();
}

function writeStringBuf(str: string): Buffer {
  const bytes = encodeModifiedUtf8(str);
  if (bytes.length > 65535) {
    throw new Error("NBT string exceeds 65535 bytes");
  }
  const len = Buffer.alloc(2);
  len.writeUInt16BE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
}

export interface RawServerNbtEntry {
  name: string;
  ip: string;
  icon?: string;
  acceptTextures?: number;
  hidden?: number;
}

export function writeServersDat(servers: RawServerNbtEntry[]): Buffer {
  const parts: Buffer[] = [];
  parts.push(Buffer.from([10]));
  parts.push(writeStringBuf(""));
  parts.push(Buffer.from([9]));
  parts.push(writeStringBuf("servers"));
  parts.push(Buffer.from([10]));
  const countBuf = Buffer.alloc(4);
  countBuf.writeInt32BE(servers.length, 0);
  parts.push(countBuf);
  for (const srv of servers) {
    parts.push(Buffer.from([8]));
    parts.push(writeStringBuf("name"));
    parts.push(writeStringBuf(srv.name));
    parts.push(Buffer.from([8]));
    parts.push(writeStringBuf("ip"));
    parts.push(writeStringBuf(srv.ip));
    if (srv.icon) {
      parts.push(Buffer.from([8]));
      parts.push(writeStringBuf("icon"));
      parts.push(writeStringBuf(srv.icon));
    }
    if (typeof srv.acceptTextures === "number") {
      parts.push(Buffer.from([1]));
      parts.push(writeStringBuf("acceptTextures"));
      parts.push(Buffer.from([srv.acceptTextures & 0xff]));
    }
    if (typeof srv.hidden === "number") {
      parts.push(Buffer.from([1]));
      parts.push(writeStringBuf("hidden"));
      parts.push(Buffer.from([srv.hidden & 0xff]));
    }
    parts.push(Buffer.from([0]));
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}
