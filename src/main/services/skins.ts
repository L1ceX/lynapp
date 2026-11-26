import { randomUUID } from "node:crypto";
import { BrowserWindow, session } from "electron";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SkinAddPayload, SkinUpdatePayload } from "@shared/ipc";
import type { AccountState, CapeInfo, SkinInfo } from "@shared/types";
import { getAppIconPath, getLauncherRoot } from "../paths";
import { JsonStore, getActiveAccount } from "../store";
import type { AuthService } from "./auth";
import { tr } from "../i18n";

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
    throw new Error(tr("Skin must be a PNG file", "Скин должен быть файлом PNG"));
  }
  return Buffer.from(match[1], "base64");
}

function canAccountEditSkins(account: AccountState | null): boolean {
  return Boolean(account && (account.kind === "microsoft" || account.kind === "ely") && account.status === "signed-in");
}

class MojangHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
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
    throw new MojangHttpError(response.status, tr(`Mojang rejected the skin (HTTP ${response.status})${detail ? `: ${detail}` : ""}`, `Mojang отклонил скин (HTTP ${response.status})${detail ? `: ${detail}` : ""}`));
  }
}

function elyPartition(accountId: string): string {
  return `persist:ely-${accountId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

async function openElyWebLoginWindow(accountId: string): Promise<boolean> {
  const partition = elyPartition(accountId);
  const elySession = session.fromPartition(partition);
  return new Promise<boolean>((resolve) => {
    const win = new BrowserWindow({
      width: 860,
      height: 680,
      center: true,
      title: tr("Sign in to Ely.by Skins", "Вход в каталог скинов Ely.by"),
      icon: getAppIconPath(),
      backgroundColor: "#0b111d",
      autoHideMenuBar: true,
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false
      }
    });

    let done = false;
    const finish = (ok: boolean, delayMs = 0): void => {
      if (done) return;
      done = true;
      const closeWin = (): void => {
        if (!win.isDestroyed()) win.close();
        resolve(ok);
      };
      if (delayMs > 0) {
        setTimeout(closeWin, delayMs);
      } else {
        closeWin();
      }
    };

    const checkUrl = (rawUrl: string): void => {
      void (async () => {
        if (done) return;
        try {
          const u = new URL(rawUrl);
          if ((u.hostname !== "ely.by" && u.hostname !== "www.ely.by") || u.pathname.startsWith("/authorization")) {
            return;
          }
          const res = await elySession.fetch("https://ely.by/authorization/login", { redirect: "manual" }).catch(() => null);
          const cookies = await elySession.cookies.get({ domain: "ely.by" }).catch(() => []);
          if ((res && res.status >= 300 && res.status < 400) || cookies.some((c) => /identity/i.test(c.name))) {
            finish(true, 200);
          }
        } catch {
        }
      })();
    };

    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("did-navigate", (_e, url) => checkUrl(url));
    win.webContents.on("render-process-gone", () => finish(false));
    win.on("closed", () => finish(false));
    win.loadURL("https://ely.by/authorization/login").catch(() => {
      if (!done) finish(false);
    });
  });
}

async function postElySkinMultipart(accountId: string, png: Buffer): Promise<{ url?: string; error?: string; text?: string }> {
  const elySession = session.fromPartition(elyPartition(accountId));
  const boundary = `----lynapp${randomUUID().replace(/-/g, "")}`;
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="skin.png"\r\nContent-Type: image/png\r\n\r\n`;
  const body = Buffer.concat([Buffer.from(head, "utf8"), png, Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")]);
  const res = await elySession.fetch("https://ely.by/api/legacy/skins", {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "X-Requested-With": "XMLHttpRequest",
      Accept: "application/json"
    },
    body
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      return { error: "error_login", text };
    }
    try {
      const parsed = JSON.parse(text) as { url?: string; error?: string; text?: string };
      return { ...parsed, error: parsed.error || `http_${res.status}`, text: parsed.text || text };
    } catch {
      return { error: `http_${res.status}`, text };
    }
  }
  try {
    return JSON.parse(text) as { url?: string; error?: string; text?: string };
  } catch {
    return { error: "invalid_json", text };
  }
}

async function uploadElySkin(accountId: string, png: Buffer, slim: boolean, name: string): Promise<void> {
  let uploadRes = await postElySkinMultipart(accountId, png);
  if (uploadRes.error === "error_login" || (!uploadRes.url && (!uploadRes.error || uploadRes.error === "invalid_json"))) {
    const loggedIn = await openElyWebLoginWindow(accountId);
    if (!loggedIn) {
      throw new Error(tr("Sign in to Ely.by in the popup window to upload skins", "Войдите в Ely.by во всплывающем окне, чтобы загружать скины"));
    }
    uploadRes = await postElySkinMultipart(accountId, png);
  }

  const idMatch = /\/skins\/s(\d+)/.exec(uploadRes.url ?? "");
  if (!idMatch) {
    const detail = (uploadRes.text ?? "").replace(/<[^>]+>/g, "").trim();
    throw new Error(detail || tr("Ely.by rejected the skin upload", "Ely.by отклонил загрузку скина"));
  }

  const skinId = idMatch[1];
  const elySession = session.fromPartition(elyPartition(accountId));

  if (uploadRes.url?.endsWith("/edit") || slim) {
    try {
      const form = new URLSearchParams();
      form.set("SkinEditForm[name]", name || "Skin");
      form.set("SkinEditForm[kind]", "1");
      form.set("SkinEditForm[is_slim]", slim ? "1" : "0");
      form.set("SkinEditForm[color]", "");
      form.set("SkinEditForm[tags]", "");
      await elySession.fetch(`https://ely.by/skins/s${skinId}/edit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
          Accept: "application/json"
        },
        body: form.toString()
      });
    } catch {
    }
  }

  const wearForm = new URLSearchParams({ skinId });
  const wearRes = await elySession.fetch("https://ely.by/api/legacy/users/skin", {
    method: "PUT",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Accept: "application/json"
    },
    body: wearForm.toString()
  });
  if (!wearRes.ok) {
    throw new Error(tr(`Could not apply skin on Ely.by (HTTP ${wearRes.status})`, `Не удалось применить скин на Ely.by (HTTP ${wearRes.status})`));
  }
}

type RemoteSkinData = { dataUrl: string; slim: boolean };

async function downloadRemoteSkin(url: string, slim: boolean): Promise<RemoteSkinData | null> {
  const texture = await fetch(url, { headers: { "user-agent": "lynapp/1.1.0-beta.6" } });
  if (!texture.ok) {
    return null;
  }
  const png = Buffer.from(await texture.arrayBuffer());
  const parsed = parsePng(png);
  if (!parsed || parsed.width !== 64 || (parsed.height !== 64 && parsed.height !== 32)) {
    return null;
  }
  return {
    dataUrl: `data:image/png;base64,${png.toString("base64")}`,
    slim
  };
}

async function fetchElyRemoteSkin(profileName: string): Promise<RemoteSkinData | null> {
  try {
    const response = await fetch(`https://skinsystem.ely.by/textures/${encodeURIComponent(profileName)}?version=2&_=${Date.now()}`, {
      headers: { "user-agent": "lynapp/1.1.0-beta.6" }
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { SKIN?: { url?: string; metadata?: { model?: string } } };
    const url = body.SKIN?.url;
    if (!url) {
      return null;
    }
    return await downloadRemoteSkin(url, body.SKIN?.metadata?.model === "slim");
  } catch {
    return null;
  }
}

async function fetchMojangRemoteSkin(account: AccountState): Promise<RemoteSkinData | null> {
  try {
    if (account.minecraftUuid) {
      const response = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${encodeURIComponent(account.minecraftUuid)}`, {
        headers: { "user-agent": "lynapp/1.1.0-beta.6" }
      });
      if (response.ok) {
        const body = (await response.json()) as {
          properties?: Array<{ name?: string; value?: string }>;
        };
        const texturesProp = body.properties?.find((item) => item.name === "textures" && item.value)?.value;
        if (texturesProp) {
          const decoded = JSON.parse(Buffer.from(texturesProp, "base64").toString("utf8")) as {
            textures?: { SKIN?: { url?: string; metadata?: { model?: string } } };
          };
          const url = decoded.textures?.SKIN?.url;
          if (url) {
            return await downloadRemoteSkin(url, decoded.textures?.SKIN?.metadata?.model === "slim");
          }
        }
      }
    }
    if (account.minecraftAccessToken) {
      const response = await fetch("https://api.minecraftservices.com/minecraft/profile", {
        headers: {
          Authorization: `Bearer ${account.minecraftAccessToken}`,
          "user-agent": "lynapp/1.1.0-beta.6"
        }
      });
      if (response.ok) {
        const body = (await response.json()) as {
          skins?: Array<{ state?: string; url?: string; variant?: string }>;
        };
        const activeSkin = body.skins?.find((item) => item.state === "ACTIVE" && item.url) ?? body.skins?.find((item) => Boolean(item.url));
        if (activeSkin?.url) {
          return await downloadRemoteSkin(activeSkin.url, activeSkin.variant === "SLIM");
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

export class SkinService {
  private readonly remoteSkinCache = new Map<string, { value: RemoteSkinData | null; fetchedAt: number }>();
  private readonly remoteSkinInFlight = new Map<string, Promise<RemoteSkinData | null>>();
  private readonly remoteSkinEpoch = new Map<string, number>();

  constructor(private readonly store: JsonStore, private readonly auth?: AuthService) {}

  private async refreshMicrosoftSession(): Promise<void> {
    if (this.auth) {
      await this.auth.ensureFreshSession().catch(() => null);
    }
  }

  async list(): Promise<SkinInfo[]> {
    const data = await this.store.getData();
    const active = getActiveAccount(data);
    if (!active || !canAccountEditSkins(active)) {
      return [];
    }
    const dir = skinsDir();
    await mkdir(dir, { recursive: true });
    const out: SkinInfo[] = [];
    for (const meta of data.skins) {
      if (meta.accountId && meta.accountId !== active.id) continue;
      try {
        const file = await readFile(path.join(dir, `${meta.id}.png`));
        out.push({ ...meta, accountId: meta.accountId ?? null, dataUrl: `data:image/png;base64,${file.toString("base64")}` });
      } catch {
      }
    }
    return out;
  }

  private async requireSkinAccount(): Promise<AccountState> {
    const data = await this.store.getData();
    const active = getActiveAccount(data);
    if (!active || !canAccountEditSkins(active)) {
      throw new Error(tr("Sign in with Microsoft or Ely.by to change skins", "Войдите через Microsoft или Ely.by, чтобы изменять скины"));
    }
    return active;
  }

  async add(payload: SkinAddPayload): Promise<SkinInfo[]> {
    const active = await this.requireSkinAccount();
    const png = toPngBuffer(payload.dataUrl);
    const parsed = parsePng(png);
    if (!parsed || parsed.width !== 64 || (parsed.height !== 64 && parsed.height !== 32)) {
      throw new Error(tr("Skin must be a 64x64 (or 64x32) PNG texture", "Скин должен быть текстурой PNG 64×64 (или 64×32)"));
    }
    const name = (payload.name ?? "").trim().slice(0, 32) || "Custom skin";
    const id = randomUUID();
    const dir = skinsDir();
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${id}.png`), parsed.data);
    const ownerId = payload.accountId ? active.id : null;
    await this.store.update((data) => {
      data.skins.unshift({ id, name, slim: payload.slim === true, addedAt: new Date().toISOString(), accountId: ownerId });
    });
    return this.list();
  }

  async update(payload: SkinUpdatePayload): Promise<SkinInfo[]> {
    const active = await this.requireSkinAccount();
    await this.store.update((data) => {
      const skin = data.skins.find((item) => item.id === payload.id);
      if (!skin || (skin.accountId && skin.accountId !== active.id)) {
        throw new Error(tr("Skin not found", "Скин не найден"));
      }
      if (payload.patch.name !== undefined) {
        skin.name = payload.patch.name.trim().slice(0, 32) || skin.name;
      }
      if (payload.patch.slim !== undefined) {
        skin.slim = payload.patch.slim;
      }
      if (payload.patch.accountId !== undefined) {
        skin.accountId = payload.patch.accountId ? active.id : null;
        if (skin.accountId) {
          for (const account of data.accounts) {
            if (account.id !== active.id && account.activeSkinId === skin.id) {
              account.activeSkinId = null;
            }
          }
        }
      }
    });
    return this.list();
  }

  async remove(id: string): Promise<{ skins: SkinInfo[]; activeSkinId: string | null }> {
    const active = await this.requireSkinAccount();
    const current = await this.store.getData();
    const target = current.skins.find((item) => item.id === id);
    if (!target || path.basename(target.id) !== target.id || (target.accountId && target.accountId !== active.id)) {
      throw new Error(tr("Skin not found", "Скин не найден"));
    }
    await rm(path.join(skinsDir(), `${target.id}.png`), { force: true });
    const activeSkinId = await this.store.update((data) => {
      data.skins = data.skins.filter((item) => item.id !== id);
      if (data.settings.activeSkinId === id) {
        data.settings.activeSkinId = null;
      }
      for (const account of data.accounts) {
        if (account.activeSkinId === id) {
          account.activeSkinId = null;
        }
      }
      return data.accounts.find((item) => item.id === active.id)?.activeSkinId ?? null;
    });
    return { skins: await this.list(), activeSkinId };
  }

  async activate(id: string): Promise<{ activeSkinId: string; uploaded: boolean }> {
    const active = await this.requireSkinAccount();
    let refreshedAccount: AccountState | null = active;
    if (active.kind === "microsoft" && this.auth) {
      refreshedAccount = await this.auth.ensureFreshSession().catch(() => null);
    }
    const data = await this.store.getData();
    const meta = data.skins.find((item) => item.id === id);
    if (!meta || (meta.accountId && meta.accountId !== active.id)) {
      throw new Error(tr("Skin not found", "Скин не найден"));
    }
    const freshActive = getActiveAccount(data);
    if (!freshActive || freshActive.id !== active.id) {
      throw new Error(tr("Active account changed while applying skin", "Активный аккаунт изменился во время применения скина"));
    }
    if (freshActive.kind === "microsoft") {
      if (!refreshedAccount || refreshedAccount.id !== active.id || freshActive.status !== "signed-in" || !freshActive.minecraftAccessToken) {
        throw new Error(tr("Microsoft session expired. Sign in again to change skins.", "Сессия Microsoft истекла. Войдите снова, чтобы менять скины."));
      }
    } else if (freshActive.status !== "signed-in") {
      throw new Error(tr("Sign in with Microsoft or Ely.by to change skins", "Войдите через Microsoft или Ely.by, чтобы изменять скины"));
    }

    const png = await readFile(path.join(skinsDir(), `${id}.png`));
    let uploaded = false;
    if (freshActive.kind === "microsoft" && freshActive.minecraftAccessToken) {
      try {
        await uploadMojangSkin(png, meta.slim, freshActive.minecraftAccessToken);
      } catch (error) {
        if (error instanceof MojangHttpError && error.status === 401 && this.auth) {
          const retried = await this.auth.ensureFreshSession(true).catch(() => null);
          if (!retried || retried.id !== active.id || retried.status !== "signed-in" || !retried.minecraftAccessToken) {
            throw new Error(tr("Microsoft session expired. Sign in again to change skins.", "Сессия Microsoft истекла. Войдите снова, чтобы менять скины."));
          }
          await uploadMojangSkin(png, meta.slim, retried.minecraftAccessToken);
        } else {
          throw error;
        }
      }
      uploaded = true;
    } else if (freshActive.kind === "ely") {
      await uploadElySkin(freshActive.id, png, meta.slim, meta.name);
      uploaded = true;
    }
    if (!uploaded) {
      throw new Error(tr("Could not upload skin for the active account", "Не удалось загрузить скин для активного аккаунта"));
    }
    await this.store.update((current) => {
      const stillExists = current.skins.some((item) => item.id === id && (!item.accountId || item.accountId === active.id));
      if (!stillExists) {
        throw new Error(tr("Skin was deleted while uploading", "Скин был удалён во время загрузки"));
      }
      const targetAccount = current.accounts.find((item) => item.id === active.id);
      if (targetAccount && (targetAccount.kind === "microsoft" || targetAccount.kind === "ely")) {
        targetAccount.activeSkinId = id;
      }
      const currentActive = getActiveAccount(current);
      if (!currentActive || currentActive.id !== active.id) {
        throw new Error(tr("Active account changed while applying skin", "Активный аккаунт изменился во время применения скина"));
      }
      current.settings.activeSkinId = id;
    });
    this.invalidateAccountSkinCache(active.id);
    return { activeSkinId: id, uploaded };
  }

  private invalidateAccountSkinCache(accountId: string): void {
    this.remoteSkinEpoch.set(accountId, (this.remoteSkinEpoch.get(accountId) ?? 0) + 1);
    const prefix = `${accountId}:`;
    for (const key of this.remoteSkinCache.keys()) {
      if (key.startsWith(prefix)) {
        this.remoteSkinCache.delete(key);
      }
    }
    for (const key of this.remoteSkinInFlight.keys()) {
      if (key.startsWith(prefix)) {
        this.remoteSkinInFlight.delete(key);
      }
    }
  }

  private async accountToken(): Promise<string> {
    await this.refreshMicrosoftSession();
    const data = await this.store.getData();
    const active = getActiveAccount(data);
    if (!active || active.kind !== "microsoft" || active.status !== "signed-in" || !active.minecraftAccessToken) {
      throw new Error(tr("Sign in with Microsoft to manage capes", "Войдите через Microsoft, чтобы управлять плащами"));
    }
    return active.minecraftAccessToken;
  }

  async elySkin(): Promise<RemoteSkinData | null> {
    const data = await this.store.getData();
    const active = getActiveAccount(data);
    if (!active || active.kind !== "ely" || active.status !== "signed-in" || !active.profileName) {
      return null;
    }
    return fetchElyRemoteSkin(active.profileName);
  }

  async accountSkin(): Promise<RemoteSkinData | null> {
    const data = await this.store.getData();
    const active = getActiveAccount(data);
    if (!active || !canAccountEditSkins(active)) {
      return null;
    }
    if (active.activeSkinId) {
      const meta = data.skins.find((item) => item.id === active.activeSkinId && (!item.accountId || item.accountId === active.id));
      if (meta) {
        try {
          const file = await readFile(path.join(skinsDir(), `${meta.id}.png`));
          const parsed = parsePng(file);
          if (parsed && parsed.width === 64 && (parsed.height === 64 || parsed.height === 32)) {
            return {
              dataUrl: `data:image/png;base64,${file.toString("base64")}`,
              slim: meta.slim
            };
          }
        } catch {
        }
      }
    }
    const cacheKey = `${active.id}:${active.kind}:${active.minecraftUuid ?? ""}:${active.profileName ?? ""}`;
    const cached = this.remoteSkinCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < 300_000) {
      return cached.value;
    }
    const pending = this.remoteSkinInFlight.get(cacheKey);
    if (pending) {
      return pending;
    }
    const epoch = this.remoteSkinEpoch.get(active.id) ?? 0;
    const loader = (async () => {
      const remote = active.kind === "ely"
        ? (active.profileName ? await fetchElyRemoteSkin(active.profileName) : null)
        : await fetchMojangRemoteSkin(active);
      if (remote && (this.remoteSkinEpoch.get(active.id) ?? 0) === epoch) {
        this.remoteSkinCache.set(cacheKey, { value: remote, fetchedAt: Date.now() });
      }
      return remote;
    })().finally(() => {
      if (this.remoteSkinInFlight.get(cacheKey) === loader) {
        this.remoteSkinInFlight.delete(cacheKey);
      }
    });
    this.remoteSkinInFlight.set(cacheKey, loader);
    return loader;
  }

  async listCapes(): Promise<CapeInfo[]> {
    const token = await this.accountToken();
    const response = await fetch("https://api.minecraftservices.com/minecraft/profile", {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      throw new Error(tr(`Mojang profile failed (HTTP ${response.status})`, `Не удалось получить профиль Mojang (HTTP ${response.status})`));
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
      if (response.status === 429) {
        throw new Error(tr(
          "Too many requests to Mojang. Wait a few seconds and try again (HTTP 429).",
          "Слишком много запросов к Mojang. Подождите несколько секунд и попробуйте снова (HTTP 429)."
        ));
      }
      throw new Error(tr(`Mojang rejected the cape (HTTP ${response.status})`, `Mojang отклонил плащ (HTTP ${response.status})`));
    }
    const raw = await response.text().catch(() => "");
    if (raw) {
      try {
        const body = JSON.parse(raw) as {
          capes?: Array<{ id: string; state: string; url: string; alias: string }>;
        };
        if (Array.isArray(body?.capes)) {
          return body.capes.map((cape) => ({
            id: cape.id,
            alias: cape.alias,
            url: cape.url,
            active: cape.state === "ACTIVE"
          }));
        }
      } catch {
      }
    }
    return this.listCapes();
  }
}
