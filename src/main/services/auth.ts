import { createHash, randomBytes, randomUUID } from "node:crypto";
import { BrowserWindow, type BrowserWindowConstructorOptions } from "electron";
import type { AccountsState, AccountState, LoginStartResult } from "@shared/types";
import { bundledMicrosoftClientId } from "../config";
import { JsonStore, getActiveAccount } from "../store";

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
  code: string;
  verifier: string;
}

interface MicrosoftTokenResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

function generatePkceVerifier(): string {
  return randomBytes(64).toString("base64url");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
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

function buildMicrosoftLoginUrl(clientId: string, state: string, challenge: string): string {
  const url = new URL(microsoftAuthorizeUrl);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", microsoftNativeRedirectUri);
  url.searchParams.set("scope", minecraftScope);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
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
  const verifier = generatePkceVerifier();
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
  const authUrl = buildMicrosoftLoginUrl(clientId, state, pkceChallenge(verifier));

  return new Promise<MicrosoftLoginResult>((resolve, reject) => {
    let finished = false;

    const finish = (error: Error | null, code?: string) => {
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

      if (!code) {
        reject(new Error("Microsoft login finished without an authorization code."));
        return;
      }

      resolve({ code, verifier });
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
      const code = params.get("code");

      if (returnedState !== state) {
        finish(new Error("Microsoft login state check failed."));
        return;
      }

      if (error) {
        finish(new Error(description || error));
        return;
      }

      finish(null, code ?? undefined);
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

interface MicrosoftOAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function readMicrosoftTokenResponse(response: Response, step: string): Promise<MicrosoftTokenResult> {
  const body = (await readJson<MicrosoftOAuthTokenResponse>(response));

  if (!response.ok || !body.access_token || !body.refresh_token) {
    throw new Error(body.error_description || body.error || `Microsoft token request failed during ${step} (HTTP ${response.status})`);
  }

  const expiresIn = Number(body.expires_in ?? 3600);
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresIn: Number.isFinite(expiresIn) ? expiresIn : 3600
  };
}

async function exchangeCodeForTokens(clientId: string, code: string, verifier: string): Promise<MicrosoftTokenResult> {
  const response = await fetch("https://login.live.com/oauth20_token.srf", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json"
    },
    body: toFormBody({
      client_id: clientId,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: microsoftNativeRedirectUri,
      scope: minecraftScope
    })
  });
  return readMicrosoftTokenResponse(response, "code exchange");
}

async function refreshMicrosoftToken(clientId: string, refreshToken: string): Promise<MicrosoftTokenResult> {
  const response = await fetch("https://login.live.com/oauth20_token.srf", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json"
    },
    body: toFormBody({
      client_id: clientId,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      redirect_uri: microsoftNativeRedirectUri,
      scope: minecraftScope
    })
  });
  return readMicrosoftTokenResponse(response, "token refresh");
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

  private getClientId(data: { settings: { microsoftClientId?: string } }): string {
    return (bundledMicrosoftClientId || process.env.LIAN_MICROSOFT_CLIENT_ID || data.settings.microsoftClientId || "").trim();
  }

  private async performMicrosoftLogin(microsoftAccessToken: string): Promise<{ profile: MinecraftProfileResponse; minecraft: MinecraftLoginResponse; expiresAt: string }> {
    const xbox = await authenticateXbox(microsoftAccessToken);
    const xsts = await authorizeXsts(xbox.Token);
    const uhs = xsts.DisplayClaims?.xui?.[0]?.uhs;

    if (!uhs) {
      throw new Error("Xbox XSTS response did not include a user hash.");
    }

    const minecraft = await authenticateMinecraft(uhs, xsts.Token);
    const profile = await fetchMinecraftProfile(minecraft.access_token);
    const expiresAt = new Date(Date.now() + minecraft.expires_in * 1000).toISOString();
    return { profile, minecraft, expiresAt };
  }

  private async storeMicrosoftSession(profile: MinecraftProfileResponse, minecraft: MinecraftLoginResponse, expiresAt: string, refreshToken: string): Promise<void> {
    await this.store.update((current) => {
      const existing = current.accounts.find((item) => item.kind === "microsoft" && item.minecraftUuid === profile.id);
      if (existing) {
        existing.status = "signed-in";
        existing.profileName = profile.name;
        existing.expiresAt = expiresAt;
        existing.minecraftAccessToken = minecraft.access_token;
        existing.microsoftRefreshToken = refreshToken;
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
          microsoftRefreshToken: refreshToken,
          message: `Signed in as ${profile.name}`,
          activeSkinId: null,
          addedAt: new Date().toISOString()
        };
        current.accounts.push(entry);
        current.activeAccountId = entry.id;
        current.settings.activeSkinId = null;
      }
    });
  }

  async beginMicrosoftLogin(parentWindow: BrowserWindow | null): Promise<LoginStartResult> {
    const data = await this.store.getData();
    const clientId = this.getClientId(data);

    if (!clientId) {
      return {
        status: "missing-client-id",
        message: "Microsoft login is not configured in this build."
      };
    }

    try {
      const { code, verifier } = await openMicrosoftLoginWindow(parentWindow, clientId);
      const tokens = await exchangeCodeForTokens(clientId, code, verifier);
      const { profile, minecraft, expiresAt } = await this.performMicrosoftLogin(tokens.accessToken);
      await this.storeMicrosoftSession(profile, minecraft, expiresAt, tokens.refreshToken);

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

  async ensureFreshSession(): Promise<AccountState | null> {
    const data = await this.store.getData();
    const active = getActiveAccount(data);
    if (!active || active.status !== "signed-in") {
      return null;
    }
    if (active.kind === "ely") {
      if (!active.elyAccessToken) {
        return null;
      }
      if (await this.validateElySession(active.elyAccessToken)) {
        return active;
      }
      if (!active.elyClientToken) {
        return null;
      }
      try {
        const accessToken = await this.refreshElySession(active.elyAccessToken, active.elyClientToken);
        const refreshed = await this.store.update((current) => {
          const target = current.accounts.find((item) => item.id === active.id);
          if (!target) {
            throw new Error("Account not found");
          }
          target.elyAccessToken = accessToken;
          return target;
        });
        return refreshed;
      } catch {
        return null;
      }
    }
    if (active.kind !== "microsoft" || !active.microsoftRefreshToken) {
      return null;
    }
    const clientId = this.getClientId(data);
    if (!clientId) {
      return null;
    }

    try {
      const tokens = await refreshMicrosoftToken(clientId, active.microsoftRefreshToken);
      const { profile, minecraft, expiresAt } = await this.performMicrosoftLogin(tokens.accessToken);
      await this.storeMicrosoftSession(profile, minecraft, expiresAt, tokens.refreshToken);
      const fresh = await this.store.getData();
      return getActiveAccount(fresh);
    } catch {
      return null;
    }
  }

  async trySilentRefresh(): Promise<AccountsState> {
    await this.ensureFreshSession();
    const data = await this.store.getData();
    return { accounts: data.accounts, activeAccountId: data.activeAccountId };
  }

  async elyLogin(username: string, password: string, totp?: string): Promise<AccountsState> {
    const name = String(username ?? "").trim();
    if (!name) {
      throw new Error("Enter your Ely.by username or e-mail.");
    }
    if (!password) {
      throw new Error("Enter your Ely.by password.");
    }
    const code = String(totp ?? "").trim();
    const clientToken = randomUUID();
    const profile = await this.authenticateEly(name, code ? `${password}:${code}` : password, clientToken);

    return this.store.update((data) => {
      const id = profile.id.replace(/-/g, "");
      const existing = data.accounts.find((item) => item.kind === "ely" && item.minecraftUuid === id);
      if (existing) {
        existing.status = "signed-in";
        existing.profileName = profile.name;
        existing.elyAccessToken = profile.accessToken;
        existing.elyClientToken = clientToken;
        existing.message = `Ely.by as ${profile.name}`;
        data.activeAccountId = existing.id;
      } else {
        const entry: AccountState = {
          id,
          kind: "ely",
          status: "signed-in",
          profileName: profile.name,
          minecraftUuid: id,
          elyAccessToken: profile.accessToken,
          elyClientToken: clientToken,
          message: `Ely.by as ${profile.name}`,
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

  private async authenticateEly(username: string, password: string, clientToken: string): Promise<{ id: string; name: string; accessToken: string }> {
    const response = await fetch("https://authserver.ely.by/auth/authenticate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({
        username,
        password,
        clientToken,
        requestUser: true
      })
    });
    const body = (await readJson<{ accessToken?: string; selectedProfile?: { id?: string; name?: string }; error?: string; errorMessage?: string }>(response));

    if (!response.ok || !body.accessToken || !body.selectedProfile?.id || !body.selectedProfile?.name) {
      const detail = body.errorMessage || body.error || `Ely.by login failed (HTTP ${response.status})`;
      const hint = /two factor/i.test(detail) ? " Enter your 2FA token in the token field." : "";
      throw new Error(`${detail}.${hint}`);
    }

    return {
      id: body.selectedProfile.id,
      name: body.selectedProfile.name,
      accessToken: body.accessToken
    };
  }

  private async validateElySession(accessToken: string): Promise<boolean> {
    try {
      const response = await fetch("https://authserver.ely.by/auth/validate", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json"
        },
        body: JSON.stringify({ accessToken })
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async refreshElySession(accessToken: string, clientToken: string): Promise<string> {
    const response = await fetch("https://authserver.ely.by/auth/refresh", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({ accessToken, clientToken, requestUser: false })
    });
    const body = (await readJson<{ accessToken?: string; error?: string; errorMessage?: string }>(response));

    if (!response.ok || !body.accessToken) {
      throw new Error(body.errorMessage || body.error || `Ely.by refresh failed (HTTP ${response.status})`);
    }

    return body.accessToken;
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
