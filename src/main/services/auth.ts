import { randomUUID } from "node:crypto";
import { BrowserWindow, type BrowserWindowConstructorOptions } from "electron";
import type { AccountsState, AccountState, LoginStartResult } from "@shared/types";
import { bundledMicrosoftClientId } from "../config";
import { JsonStore } from "../store";

const microsoftAuthorizeUrl = "https://login.live.com/oauth20_authorize.srf";
const microsoftNativeRedirectUri = "https://login.live.com/oauth20_desktop.srf";
const minecraftScope = "service::user.auth.xboxlive.com::MBI_SSL";

interface OAuthErrorResponse {
  error?: string;
  error_description?: string;
}

interface XboxAuthResponse {
  Token: string;
  DisplayClaims?: {
    xui?: Array<{
      uhs?: string;
    }>;
  };
}

interface XstsErrorResponse {
  XErr?: number;
  Message?: string;
}

interface MinecraftLoginResponse {
  access_token: string;
  expires_in: number;
}

interface MinecraftProfileResponse {
  id: string;
  name: string;
}

interface MicrosoftLoginResult {
  accessToken: string;
  expiresIn: number;
}

function toFormBody(values: Record<string, string>): URLSearchParams {
  const body = new URLSearchParams();

  for (const [key, value] of Object.entries(values)) {
    body.set(key, value);
  }

  return body;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readJson<T>(response: Response): Promise<T> {
  const raw = await response.text();
  return (raw ? JSON.parse(raw) : {}) as T;
}

async function postJson<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify(payload)
  });
  const data = await readJson<T & OAuthErrorResponse & XstsErrorResponse>(response);

  if (!response.ok) {
    throw new Error(data.Message || data.error_description || data.error || `Request failed with HTTP ${response.status}`);
  }

  return data;
}

function buildMicrosoftLoginUrl(clientId: string, state: string): string {
  const url = new URL(microsoftAuthorizeUrl);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "token");
  url.searchParams.set("redirect_uri", microsoftNativeRedirectUri);
  url.searchParams.set("scope", minecraftScope);
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");

  return url.toString();
}

function readOAuthParams(url: URL): URLSearchParams {
  const params = new URLSearchParams(url.search);

  if (url.hash.startsWith("#")) {
    const hashParams = new URLSearchParams(url.hash.slice(1));

    for (const [key, value] of hashParams.entries()) {
      params.set(key, value);
    }
  }

  return params;
}

function openMicrosoftLoginWindow(parentWindow: BrowserWindow | null, clientId: string): Promise<MicrosoftLoginResult> {
  const state = randomUUID();
  const options: BrowserWindowConstructorOptions = {
    width: 520,
    height: 720,
    minWidth: 420,
    minHeight: 560,
    title: "Microsoft Login",
    autoHideMenuBar: true,
    parent: parentWindow ?? undefined,
    modal: Boolean(parentWindow),
    backgroundColor: "#101417",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  };
  const authWindow = new BrowserWindow(options);
  const authUrl = buildMicrosoftLoginUrl(clientId, state);

  return new Promise<MicrosoftLoginResult>((resolve, reject) => {
    let finished = false;

    const finish = (error: Error | null, accessToken?: string, expiresIn?: number) => {
      if (finished) {
        return;
      }

      finished = true;
      authWindow.webContents.removeAllListeners("will-redirect");
      authWindow.webContents.removeAllListeners("will-navigate");

      if (!authWindow.isDestroyed()) {
        authWindow.close();
      }

      if (error) {
        reject(error);
        return;
      }

      if (!accessToken) {
        reject(new Error("Microsoft login finished without an access token."));
        return;
      }

      resolve({ accessToken, expiresIn: expiresIn ?? 3600 });
    };

    const handleUrl = (event: Electron.Event, nextUrl: string) => {
      if (!nextUrl.startsWith(microsoftNativeRedirectUri)) {
        return;
      }

      event.preventDefault();
      const url = new URL(nextUrl);
      const params = readOAuthParams(url);
      const returnedState = params.get("state");
      const error = params.get("error");
      const description = params.get("error_description");
      const accessToken = params.get("access_token");
      const expiresIn = Number(params.get("expires_in") ?? "3600");

      if (returnedState !== state) {
        finish(new Error("Microsoft login state check failed."));
        return;
      }

      if (error) {
        finish(new Error(description || error));
        return;
      }

      finish(null, accessToken ?? undefined, Number.isFinite(expiresIn) ? expiresIn : 3600);
    };

    authWindow.webContents.on("will-redirect", handleUrl);
    authWindow.webContents.on("will-navigate", handleUrl);
    authWindow.on("closed", () => {
      if (!finished) {
        finished = true;
        reject(new Error("Microsoft login window was closed."));
      }
    });

    authWindow.loadURL(authUrl).catch((error: unknown) => {
      finish(new Error(errorMessage(error)));
    });
  });
}

async function authenticateXbox(microsoftAccessToken: string): Promise<XboxAuthResponse> {
  let lastError: unknown = null;

  for (const rpsTicket of [`d=${microsoftAccessToken}`, microsoftAccessToken]) {
    try {
      const result = await postJson<XboxAuthResponse>("https://user.auth.xboxlive.com/user/authenticate", {
        Properties: {
          AuthMethod: "RPS",
          SiteName: "user.auth.xboxlive.com",
          RpsTicket: rpsTicket
        },
        RelyingParty: "http://auth.xboxlive.com",
        TokenType: "JWT"
      });

      if (!result.Token) {
        throw new Error("Xbox Live did not return a user token.");
      }

      return result;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Xbox Live authentication failed: ${errorMessage(lastError)}`);
}

function describeXstsError(payload: XstsErrorResponse, status: number): string {
  switch (payload.XErr) {
    case 2148916233:
      return "This Microsoft account has no Xbox profile. Open xbox.com once and create a profile.";
    case 2148916235:
      return "Xbox Live is not available in this account region.";
    case 2148916236:
    case 2148916237:
      return "This Xbox account is restricted from online services.";
    case 2148916238:
      return "This is a child account. It needs adult approval before Minecraft login can work.";
    default:
      return payload.Message || `Xbox XSTS authorization failed with HTTP ${status}`;
  }
}

async function authorizeXsts(xboxToken: string): Promise<XboxAuthResponse> {
  const response = await fetch("https://xsts.auth.xboxlive.com/xsts/authorize", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({
      Properties: {
        SandboxId: "RETAIL",
        UserTokens: [xboxToken]
      },
      RelyingParty: "rp://api.minecraftservices.com/",
      TokenType: "JWT"
    })
  });
  const payload = await readJson<XboxAuthResponse & XstsErrorResponse>(response);

  if (!response.ok) {
    throw new Error(describeXstsError(payload, response.status));
  }

  if (!payload.Token) {
    throw new Error("Xbox XSTS did not return an authorization token.");
  }

  return payload;
}

async function authenticateMinecraft(uhs: string, xstsToken: string): Promise<MinecraftLoginResponse> {
  const result = await postJson<MinecraftLoginResponse>("https://api.minecraftservices.com/authentication/login_with_xbox", {
    identityToken: `XBL3.0 x=${uhs};${xstsToken}`
  });

  if (!result.access_token) {
    throw new Error("Minecraft Services did not return an access token.");
  }

  return result;
}

async function fetchMinecraftProfile(accessToken: string): Promise<MinecraftProfileResponse> {
  const response = await fetch("https://api.minecraftservices.com/minecraft/profile", {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json"
    }
  });
  const payload = await readJson<MinecraftProfileResponse & OAuthErrorResponse>(response);

  if (response.status === 404) {
    throw new Error("Minecraft Java profile was not found on this Microsoft account.");
  }

  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || `Minecraft profile request failed with HTTP ${response.status}`);
  }

  if (!payload.id || !payload.name) {
    throw new Error("Minecraft profile response did not include name and uuid.");
  }

  return payload;
}

export class AuthService {
  constructor(private readonly store: JsonStore) {}

  async beginMicrosoftLogin(parentWindow: BrowserWindow | null): Promise<LoginStartResult> {
    const data = await this.store.getData();
    const clientId = (bundledMicrosoftClientId || process.env.LIAN_MICROSOFT_CLIENT_ID || data.settings.microsoftClientId || "").trim();

    if (!clientId) {
      return {
        status: "missing-client-id",
        message: "Microsoft login is not configured in this build."
      };
    }

    try {
      const microsoftToken = await openMicrosoftLoginWindow(parentWindow, clientId);
      const xbox = await authenticateXbox(microsoftToken.accessToken);
      const xsts = await authorizeXsts(xbox.Token);
      const uhs = xsts.DisplayClaims?.xui?.[0]?.uhs;

      if (!uhs) {
        throw new Error("Xbox XSTS response did not include a user hash.");
      }

      const minecraft = await authenticateMinecraft(uhs, xsts.Token);
      const profile = await fetchMinecraftProfile(minecraft.access_token);
      const expiresAt = new Date(Date.now() + minecraft.expires_in * 1000).toISOString();

      await this.store.update((current) => {
        const existing = current.accounts.find((item) => item.kind === "microsoft" && item.minecraftUuid === profile.id);
        if (existing) {
          existing.status = "signed-in";
          existing.profileName = profile.name;
          existing.expiresAt = expiresAt;
          existing.minecraftAccessToken = minecraft.access_token;
          existing.message = `Signed in as ${profile.name}`;
          current.activeAccountId = existing.id;
          current.settings.activeSkinId = existing.activeSkinId ?? current.settings.activeSkinId ?? null;
        } else {
          const entry: AccountState = {
            id: profile.id,
            kind: "microsoft",
            status: "signed-in",
            profileName: profile.name,
            minecraftUuid: profile.id,
            expiresAt,
            minecraftAccessToken: minecraft.access_token,
            message: `Signed in as ${profile.name}`,
            activeSkinId: null,
            addedAt: new Date().toISOString()
          };
          current.accounts.push(entry);
          current.activeAccountId = entry.id;
          current.settings.activeSkinId = null;
        }
      });

      return {
        status: "signed-in",
        message: `Signed in as ${profile.name}`
      };
    } catch (error) {
      const message = errorMessage(error);

      return {
        status: "failed",
        message
      };
    }
  }

  async useOfflineProfile(username: string): Promise<AccountsState> {
    const name = String(username ?? "").trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
      throw new Error("Offline username must be 3-16 characters: letters, numbers, underscore.");
    }

    return this.store.update((data) => {
      const existing = data.accounts.find((item) => item.kind === "offline" && item.profileName?.toLowerCase() === name.toLowerCase());
      if (existing) {
        existing.status = "offline";
        existing.message = `Offline profile: ${existing.profileName}`;
        data.activeAccountId = existing.id;
      } else {
        const entry: AccountState = {
          id: randomUUID(),
          kind: "offline",
          status: "offline",
          profileName: name,
          message: `Offline profile: ${name}`,
          activeSkinId: null,
          addedAt: new Date().toISOString()
        };
        data.accounts.push(entry);
        data.activeAccountId = entry.id;
      }
      data.settings.activeSkinId = null;
      return { accounts: data.accounts, activeAccountId: data.activeAccountId };
    });
  }

  async setActiveAccount(id: string): Promise<AccountsState> {
    return this.store.update((data) => {
      const target = data.accounts.find((item) => item.id === id);
      if (!target) {
        throw new Error("Account not found");
      }
      data.activeAccountId = target.id;
      data.settings.activeSkinId = target.kind === "microsoft" ? (target.activeSkinId ?? null) : null;
      return { accounts: data.accounts, activeAccountId: data.activeAccountId };
    });
  }

  async removeAccount(id: string): Promise<AccountsState> {
    return this.store.update((data) => {
      data.accounts = data.accounts.filter((item) => item.id !== id);
      if (data.activeAccountId === id) {
        data.activeAccountId = data.accounts[0]?.id ?? null;
      }
      const active = data.accounts.find((item) => item.id === data.activeAccountId) ?? null;
      data.settings.activeSkinId = active?.kind === "microsoft" ? (active.activeSkinId ?? null) : null;
      return { accounts: data.accounts, activeAccountId: data.activeAccountId };
    });
  }
}
