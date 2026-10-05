import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SkinAddPayload, SkinUpdatePayload } from "@shared/ipc";
import type { CapeInfo, SkinInfo } from "@shared/types";
import { getLauncherRoot } from "../paths";
import { JsonStore, getActiveAccount } from "../store";

function skinsDir(): string {
  return path.join(getLauncherRoot(), "skins");
}

function parsePng(buffer: Buffer): { width: number; height: number; data: Buffer } | null {
  if (buffer.length < 33) return null;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (buffer[i] !== signature[i]) return null;
  }
  if (buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    data: buffer
  };
}

function toPngBuffer(dataUrl: string): Buffer {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec((dataUrl ?? "").trim());
  if (!match) {
    throw new Error("Skin must be a PNG file");
  }
  return Buffer.from(match[1], "base64");
}

async function uploadMojangSkin(png: Buffer, slim: boolean, token: string): Promise<void> {
  const boundary = `----lynapp${randomUUID().replace(/-/g, "")}`;
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="variant"\r\n\r\n${slim ? "slim" : "classic"}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="skin.png"\r\nContent-Type: image/png\r\n\r\n`;
  const body = Buffer.concat([Buffer.from(head, "utf8"), png, Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")]);
  const response = await fetch("https://api.minecraftservices.com/minecraft/profile/skins", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body
  });
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.json() as { errorMessage?: string })?.errorMessage ?? "";
    } catch {
      detail = "";
    }
    throw new Error(`Mojang rejected the skin (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
  }
}

export class SkinService {
  constructor(private readonly store: JsonStore) {}

  async list(): Promise<SkinInfo[]> {
    const data = await this.store.getData();
    const active = getActiveAccount(data);
    if (!active || active.kind !== "microsoft" || active.status !== "signed-in") {
      return [];
    }
    const dir = skinsDir();
    await mkdir(dir, { recursive: true });
    const out: SkinInfo[] = [];
    for (const meta of data.skins) {
      try {
        const file = await readFile(path.join(dir, `${meta.id}.png`));
        out.push({ ...meta, dataUrl: `data:image/png;base64,${file.toString("base64")}` });
      } catch {
      }
    }
    return out;
  }

  private async requirePremium(): Promise<void> {
    const data = await this.store.getData();
    const active = getActiveAccount(data);
    if (!active || active.kind !== "microsoft" || active.status !== "signed-in") {
      throw new Error("Sign in with Microsoft to change skins");
    }
  }

  async add(payload: SkinAddPayload): Promise<SkinInfo[]> {
    await this.requirePremium();
    const png = toPngBuffer(payload.dataUrl);
    const parsed = parsePng(png);
    if (!parsed || parsed.width !== 64 || parsed.height !== 64) {
      throw new Error("Skin must be a 64x64 PNG texture");
    }
    const name = (payload.name ?? "").trim().slice(0, 32) || "Custom skin";
    const id = randomUUID();
    const dir = skinsDir();
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${id}.png`), parsed.data);
    await this.store.update((data) => {
      data.skins.unshift({ id, name, slim: payload.slim === true, addedAt: new Date().toISOString() });
    });
    return this.list();
  }

  async update(payload: SkinUpdatePayload): Promise<SkinInfo[]> {
    await this.requirePremium();
    await this.store.update((data) => {
      const skin = data.skins.find((item) => item.id === payload.id);
      if (!skin) {
        throw new Error("Skin not found");
      }
      if (payload.patch.name !== undefined) {
        skin.name = payload.patch.name.trim().slice(0, 32) || skin.name;
      }
      if (payload.patch.slim !== undefined) {
        skin.slim = payload.patch.slim;
      }
    });
    return this.list();
  }

  async remove(id: string): Promise<{ skins: SkinInfo[]; activeSkinId: string | null }> {
    await this.requirePremium();
    await rm(path.join(skinsDir(), `${id}.png`), { force: true });
    const activeSkinId = await this.store.update((data) => {
      data.skins = data.skins.filter((item) => item.id !== id);
      if (data.settings.activeSkinId === id) {
        data.settings.activeSkinId = data.skins[0]?.id ?? null;
      }
      return data.settings.activeSkinId;
    });
    return { skins: await this.list(), activeSkinId };
  }

  async activate(id: string): Promise<{ activeSkinId: string; uploaded: boolean }> {
    await this.requirePremium();
    const data = await this.store.getData();
    const meta = data.skins.find((item) => item.id === id);
    if (!meta) {
      throw new Error("Skin not found");
    }
    let uploaded = false;
    const active = getActiveAccount(data);
    if (active?.status === "signed-in" && active.minecraftAccessToken) {
      const png = await readFile(path.join(skinsDir(), `${id}.png`));
      await uploadMojangSkin(png, meta.slim, active.minecraftAccessToken);
      uploaded = true;
    }
    await this.store.update((current) => {
      current.settings.activeSkinId = id;
      const currentActive = getActiveAccount(current);
      if (currentActive && currentActive.kind === "microsoft") {
        currentActive.activeSkinId = id;
      }
    });
    return { activeSkinId: id, uploaded };
  }

  private async accountToken(): Promise<string> {
    const data = await this.store.getData();
    const active = getActiveAccount(data);
    if (!active || active.kind !== "microsoft" || active.status !== "signed-in" || !active.minecraftAccessToken) {
      throw new Error("Sign in with Microsoft to manage capes");
    }
    return active.minecraftAccessToken;
  }

  async elySkin(): Promise<{ dataUrl: string; slim: boolean } | null> {
    const data = await this.store.getData();
    const active = getActiveAccount(data);
    if (!active || active.kind !== "ely" || active.status !== "signed-in" || !active.profileName) {
      return null;
    }

    try {
      const response = await fetch(`http://skinsystem.ely.by/textures/${encodeURIComponent(active.profileName)}?version=2`, {
        headers: { "user-agent": "lynapp/1.0.1" }
      });
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as { SKIN?: { url?: string; metadata?: { model?: string } } };
      const url = body.SKIN?.url;
      if (!url) {
        return null;
      }
      const texture = await fetch(url, { headers: { "user-agent": "lynapp/1.0.1" } });
      if (!texture.ok) {
        return null;
      }
      const png = Buffer.from(await texture.arrayBuffer());
      const parsed = parsePng(png);
      if (!parsed || parsed.width !== 64 || parsed.height !== 64) {
        return null;
      }
      return {
        dataUrl: `data:image/png;base64,${png.toString("base64")}`,
        slim: body.SKIN?.metadata?.model === "slim"
      };
    } catch {
      return null;
    }
  }

  async listCapes(): Promise<CapeInfo[]> {    const token = await this.accountToken();
    const response = await fetch("https://api.minecraftservices.com/minecraft/profile", {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      throw new Error(`Mojang profile failed (HTTP ${response.status})`);
    }
    const body = (await response.json()) as {
      capes?: Array<{ id: string; state: string; url: string; alias: string }>;
    };
    return (body.capes ?? []).map((cape) => ({
      id: cape.id,
      alias: cape.alias,
      url: cape.url,
      active: cape.state === "ACTIVE"
    }));
  }

  async equipCape(capeId: string | null): Promise<CapeInfo[]> {
    const token = await this.accountToken();
    const response = await fetch("https://api.minecraftservices.com/minecraft/profile/capes/active", capeId
      ? {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ capeId })
        }
      : {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` }
        });
    if (!response.ok) {
      throw new Error(`Mojang rejected the cape (HTTP ${response.status})`);
    }
    return this.listCapes();
  }
}
