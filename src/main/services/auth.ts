import { createHash, randomBytes, randomUUID } from "node:crypto";
import { BrowserWindow, session, type BrowserWindowConstructorOptions } from "electron";
import type { AccountsState, AccountState, LoginStartResult } from "@shared/types";
import { bundledMicrosoftClientId } from "../config";
import { JsonStore, getActiveAccount } from "../store";
import { tr } from "../i18n";
import { getAppIconPath } from "../paths";

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

function offlineUuid(name: string): string {
  const hash = createHash("md5").update(`OfflinePlayer:${name}`).digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
    throw new Error(data.Message || data.error_description || data.error || tr(`Request failed with HTTP ${response.status}`, `Ошибка запроса, HTTP ${response.status}`));
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
    icon: getAppIconPath(),
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
      authWindow.webContents.removeAllListeners("render-process-gone");

      if (!authWindow.isDestroyed()) {
        authWindow.close();
      }

      if (error) {
        reject(error);
        return;
      }

      if (!code) {
        reject(new Error(tr("Microsoft login finished without an authorization code.", "Вход через Microsoft завершился без кода авторизации.")));
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
        finish(new Error(tr("Microsoft login state check failed.", "Проверка состояния входа через Microsoft не пройдена.")));
        return;
      }

      if (error) {
        finish(new Error(description || error));
        return;
      }

      finish(null, code ?? undefined);
    };

    authWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    authWindow.webContents.on("will-redirect", handleUrl);
    authWindow.webContents.on("will-navigate", handleUrl);
    authWindow.webContents.on("render-process-gone", () => {
      finish(new Error(tr("Microsoft login window crashed.", "Окно входа Microsoft завершилось с ошибкой.")));
    });
    authWindow.on("closed", () => {
      if (!finished) {
        finished = true;
        reject(new Error(tr("Microsoft login window was closed.", "Окно входа Microsoft было закрыто.")));
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

class PermanentAuthError extends Error {}

async function readMicrosoftTokenResponse(response: Response, step: string, fallbackRefreshToken?: string): Promise<MicrosoftTokenResult> {
  const body = (await readJson<MicrosoftOAuthTokenResponse>(response));
  const refreshToken = body.refresh_token || fallbackRefreshToken;

  if (!response.ok || !body.access_token || !refreshToken) {
    const message = body.error_description || body.error || tr(`Microsoft token request failed during ${step} (HTTP ${response.status})`, `Не удалось получить токен Microsoft на шаге «${step}» (HTTP ${response.status})`);
    if (body.error === "invalid_grant" || body.error === "unauthorized_client" || response.status === 400 || response.status === 401) {
      throw new PermanentAuthError(message);
    }
    throw new Error(message);
  }

  const expiresIn = Number(body.expires_in ?? 3600);
  return {
    accessToken: body.access_token,
    refreshToken,
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
  return readMicrosoftTokenResponse(response, "token refresh", refreshToken);
}

async function authenticateXbox(microsoftAccessToken: string): Promise<XboxAuthResponse> {
  let firstError: unknown = null;

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
        throw new Error(tr("Xbox Live did not return a user token.", "Xbox Live не вернул токен пользователя."));
      }

      return result;
    } catch (error) {
      if (!firstError) {
        firstError = error;
      }
    }
  }

  throw new Error(tr(`Xbox Live authentication failed: ${errorMessage(firstError)}`, `Ошибка входа в Xbox Live: ${errorMessage(firstError)}`));
}

function describeXstsError(payload: XstsErrorResponse, status: number): string {
  switch (payload.XErr) {
    case 2148916229:
      return tr("This Microsoft account is banned from Xbox Live.", "Этот аккаунт Microsoft заблокирован в Xbox Live.");
    case 2148916233:
      return tr("This Microsoft account has no Xbox profile. Open xbox.com once and create a profile.", "У этого аккаунта Microsoft нет профиля Xbox. Откройте xbox.com и создайте профиль.");
    case 2148916234:
      return tr("This Microsoft account is blocked from Xbox Live.", "Доступ этого аккаунта Microsoft к Xbox Live закрыт.");
    case 2148916235:
      return tr("Xbox Live is not available in this account region.", "Xbox Live недоступен в регионе этого аккаунта.");
    case 2148916236:
    case 2148916237:
      return tr("This Xbox account is restricted from online services.", "Этому аккаунту Xbox ограничен доступ к онлайн-сервисам.");
    case 2148916238:
      return tr("This is a child account. It needs adult approval before Minecraft login can work.", "Это детский аккаунт. Для входа в Minecraft нужно разрешение взрослого.");
    default:
      return payload.Message || tr(`Xbox XSTS authorization failed with HTTP ${status}`, `Ошибка авторизации Xbox XSTS, HTTP ${status}`);
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
    throw new Error(tr("Xbox XSTS did not return an authorization token.", "Xbox XSTS не вернул токен авторизации."));
  }

  return payload;
}

async function authenticateMinecraft(uhs: string, xstsToken: string): Promise<MinecraftLoginResponse> {
  const result = await postJson<MinecraftLoginResponse>("https://api.minecraftservices.com/authentication/login_with_xbox", {
    identityToken: `XBL3.0 x=${uhs};${xstsToken}`
  });

  if (!result.access_token) {
    throw new Error(tr("Minecraft Services did not return an access token.", "Minecraft Services не вернул токен доступа."));
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
    throw new Error(tr("Minecraft Java profile was not found on this Microsoft account.", "На этом аккаунте Microsoft нет профиля Minecraft Java."));
  }

  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || tr(`Minecraft profile request failed with HTTP ${response.status}`, `Не удалось получить профиль Minecraft, HTTP ${response.status}`));
  }

  if (!payload.id || !payload.name) {
    throw new Error(tr("Minecraft profile response did not include name and uuid.", "В ответе с профилем Minecraft нет имени и UUID."));
  }

  return payload;
}

export class AuthService {
  constructor(private readonly store: JsonStore) {}

  private readonly refreshFlights = new Map<string, { promise: Promise<AccountState | null>; forced: boolean }>();

  private getClientId(data: { settings: { microsoftClientId?: string } }): string {
    return ((data.settings.microsoftClientId || "").trim() || bundledMicrosoftClientId || process.env.LIAN_MICROSOFT_CLIENT_ID || "").trim();
  }

  private async markAccountSignedOut(accountId: string, message: string): Promise<void> {
    await this.store.update((current) => {
      const target = current.accounts.find((item) => item.id === accountId);
      if (target && target.status !== "offline") {
        target.status = "signed-out";
        target.message = message;
      }
    }).catch(() => undefined);
  }

  private async performMicrosoftLogin(microsoftAccessToken: string): Promise<{ profile: MinecraftProfileResponse; minecraft: MinecraftLoginResponse; expiresAt: string; uhs: string }> {
    const xbox = await authenticateXbox(microsoftAccessToken);
    const xsts = await authorizeXsts(xbox.Token);
    const uhs = xsts.DisplayClaims?.xui?.[0]?.uhs;

    if (!uhs) {
      throw new Error(tr("Xbox XSTS response did not include a user hash.", "В ответе Xbox XSTS нет хеша пользователя."));
    }

    const minecraft = await authenticateMinecraft(uhs, xsts.Token);
    const profile = await fetchMinecraftProfile(minecraft.access_token);
    const expiresAt = new Date(Date.now() + minecraft.expires_in * 1000).toISOString();
    return { profile, minecraft, expiresAt, uhs };
  }

  private async storeMicrosoftSession(
    profile: MinecraftProfileResponse,
    minecraft: MinecraftLoginResponse,
    expiresAt: string,
    refreshToken: string,
    uhs: string,
    activate = true
  ): Promise<AccountState> {
    return this.store.update((current) => {
      const prevActive = current.accounts.find((item) => item.id === current.activeAccountId) ?? null;
      if (activate && prevActive && prevActive.kind === "microsoft") {
        prevActive.activeSkinId = current.settings.activeSkinId ?? prevActive.activeSkinId ?? null;
      }
      const existing = current.accounts.find((item) => item.kind === "microsoft" && item.minecraftUuid === profile.id);
      if (existing) {
        existing.status = "signed-in";
        existing.profileName = profile.name;
        existing.expiresAt = expiresAt;
        existing.minecraftAccessToken = minecraft.access_token;
        if (refreshToken) existing.microsoftRefreshToken = refreshToken;
        existing.xboxUhs = uhs;
        existing.message = tr(`Signed in as ${profile.name}`, `Выполнен вход: ${profile.name}`);
        if (activate) {
          current.activeAccountId = existing.id;
          current.settings.activeSkinId = existing.activeSkinId ?? null;
        }
        return existing;
      }
      const entry: AccountState = {
        id: profile.id,
        kind: "microsoft",
        status: "signed-in",
        profileName: profile.name,
        minecraftUuid: profile.id,
        expiresAt,
        minecraftAccessToken: minecraft.access_token,
        microsoftRefreshToken: refreshToken,
        xboxUhs: uhs,
        message: tr(`Signed in as ${profile.name}`, `Выполнен вход: ${profile.name}`),
        activeSkinId: null,
        addedAt: new Date().toISOString()
      };
      current.accounts.push(entry);
      if (activate) {
        current.activeAccountId = entry.id;
        current.settings.activeSkinId = null;
      }
      return entry;
    });
  }

  async beginMicrosoftLogin(parentWindow: BrowserWindow | null): Promise<LoginStartResult> {
    const data = await this.store.getData();
    const clientId = this.getClientId(data);

    if (!clientId) {
      return {
        status: "missing-client-id",
        message: tr("Microsoft login is not configured in this build.", "Вход через Microsoft не настроен в этой сборке.")
      };
    }

    try {
      const { code, verifier } = await openMicrosoftLoginWindow(parentWindow, clientId);
      const tokens = await exchangeCodeForTokens(clientId, code, verifier);
      const { profile, minecraft, expiresAt, uhs } = await this.performMicrosoftLogin(tokens.accessToken);
      await this.storeMicrosoftSession(profile, minecraft, expiresAt, tokens.refreshToken, uhs);

      return {
        status: "signed-in",
        message: tr(`Signed in as ${profile.name}`, `Выполнен вход: ${profile.name}`)
      };
    } catch (error) {
      const message = errorMessage(error);

      return {
        status: "failed",
        message
      };
    }
  }

  async ensureFreshSession(force = false): Promise<AccountState | null> {
    const data = await this.store.getData();
    const active = getActiveAccount(data);
    if (!active) {
      return null;
    }
    const key = active.id;
    const existing = this.refreshFlights.get(key);
    if (existing) {
      if (!force || existing.forced) {
        return existing.promise;
      }
      await existing.promise.catch(() => null);
      return this.ensureFreshSession(true);
    }
    let entry: { promise: Promise<AccountState | null>; forced: boolean };
    const promise = this.doEnsureFreshSession(active.id, force).finally(() => {
      if (this.refreshFlights.get(key) === entry) {
        this.refreshFlights.delete(key);
      }
    });
    entry = { promise, forced: force };
    this.refreshFlights.set(key, entry);
    return promise;
  }

  private async ensureElyOAuthSession(active: AccountState): Promise<AccountState | null> {
    if (!active.elyAccessToken) return null;
    const exp = active.expiresAt ? Date.parse(active.expiresAt) : NaN;
    const notExpired = Number.isNaN(exp) || exp - Date.now() > 60 * 1000;
    if (notExpired) {
      try {
        const infoRes = await fetch("https://account.ely.by/api/account/v1/info", {
          headers: { Authorization: `Bearer ${active.elyAccessToken}`, accept: "application/json" }
        });
        if (infoRes.ok) {
          return active;
        }
        if (infoRes.status !== 401 && infoRes.status !== 403) {
          return active;
        }
      } catch {
        return active;
      }
    }
    const clientId = String(import.meta.env.MAIN_VITE_ELY_CLIENT_ID ?? "").trim();
    const clientSecret = String(import.meta.env.MAIN_VITE_ELY_CLIENT_SECRET ?? "").trim();
    if (!clientId || !clientSecret || !active.elyRefreshToken) {
      await this.markAccountSignedOut(active.id, tr("Ely.by session expired. Sign in again.", "Сессия Ely.by истекла. Войдите снова."));
      return null;
    }
    try {
      const tokenRes = await fetch("https://account.ely.by/api/oauth2/v1/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: toFormBody({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: active.elyRefreshToken,
          grant_type: "refresh_token"
        })
      });
      const tokenData = await readJson<{ access_token?: string; refresh_token?: string; expires_in?: number; error?: string }>(tokenRes);
      if (!tokenRes.ok || !tokenData.access_token) {
        if (tokenRes.status === 400 || tokenRes.status === 401 || tokenRes.status === 403) {
          await this.markAccountSignedOut(active.id, tr("Ely.by session expired. Sign in again.", "Сессия Ely.by истекла. Войдите снова."));
        }
        return null;
      }
      const expiresAt = tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString() : undefined;
      return await this.store.update((current) => {
        const target = current.accounts.find((item) => item.id === active.id);
        if (!target) throw new Error(tr("Account not found", "Аккаунт не найден"));
        target.elyAccessToken = tokenData.access_token;
        if (tokenData.refresh_token) target.elyRefreshToken = tokenData.refresh_token;
        if (expiresAt) target.expiresAt = expiresAt;
        return target;
      });
    } catch {
      return null;
    }
  }

  private async doEnsureFreshSession(accountId: string, force = false): Promise<AccountState | null> {
    const data = await this.store.getData();
    const active = data.accounts.find((item) => item.id === accountId);
    if (!active || active.status !== "signed-in") {
      return null;
    }
    if (active.kind === "ely") {
      if (!active.elyAccessToken) {
        return null;
      }
      if (active.elyAuthMode === "oauth2" || (!active.elyClientToken && active.elyRefreshToken)) {
        return this.ensureElyOAuthSession(active);
      }
      const valid = await this.validateElySession(active.elyAccessToken);
      if (valid !== false) {
        return active;
      }
      if (!active.elyClientToken) {
        await this.markAccountSignedOut(active.id, tr("Ely.by session expired. Sign in again.", "Сессия Ely.by истекла. Войдите снова."));
        return null;
      }
      try {
        const accessToken = await this.refreshElySession(active.elyAccessToken, active.elyClientToken);
        return await this.store.update((current) => {
          const target = current.accounts.find((item) => item.id === active.id);
          if (!target) {
            throw new Error(tr("Account not found", "Аккаунт не найден"));
          }
          target.elyAccessToken = accessToken;
          return target;
        });
      } catch (error) {
        if (error instanceof PermanentAuthError) {
          await this.markAccountSignedOut(active.id, tr("Ely.by session expired. Sign in again.", "Сессия Ely.by истекла. Войдите снова."));
        }
        return null;
      }
    }
    if (active.kind !== "microsoft" || !active.microsoftRefreshToken) {
      return null;
    }
    const exp = active.expiresAt ? Date.parse(active.expiresAt) : NaN;
    const hasAccessToken = Boolean(active.minecraftAccessToken);
    if (!force && hasAccessToken && !Number.isNaN(exp) && exp - Date.now() > 5 * 60 * 1000) {
      return active;
    }
    const clientId = this.getClientId(data);
    if (!clientId) {
      return !force && hasAccessToken && !Number.isNaN(exp) && exp > Date.now() ? active : null;
    }

    try {
      const tokens = await refreshMicrosoftToken(clientId, active.microsoftRefreshToken);
      if (tokens.refreshToken && tokens.refreshToken !== active.microsoftRefreshToken) {
        await this.store.update((current) => {
          const target = current.accounts.find((item) => item.id === active.id);
          if (target) {
            target.microsoftRefreshToken = tokens.refreshToken;
          }
        });
      }
      const { profile, minecraft, expiresAt, uhs } = await this.performMicrosoftLogin(tokens.accessToken);
      return await this.storeMicrosoftSession(profile, minecraft, expiresAt, tokens.refreshToken, uhs, false);
    } catch (error) {
      if (error instanceof PermanentAuthError) {
        await this.markAccountSignedOut(active.id, tr("Microsoft session expired. Sign in again.", "Сессия Microsoft истекла. Войдите снова."));
        return null;
      }
      if (!force && hasAccessToken && !Number.isNaN(exp) && exp > Date.now()) {
        return active;
      }
      return null;
    }
  }

  async trySilentRefresh(): Promise<AccountsState> {
    await this.ensureFreshSession();
    const data = await this.store.getData();
    return { accounts: data.accounts, activeAccountId: data.activeAccountId };
  }

  private async copyCookiesToAccount(cookies: Electron.Cookie[], accountId: string): Promise<void> {
    if (!cookies.length) return;
    const targetSession = session.fromPartition(`persist:ely-${accountId}`);
    for (const cookie of cookies) {
      const host = cookie.domain?.replace(/^\./, "") || "ely.by";
      const url = `${cookie.secure ? "https" : "http"}://${host}${cookie.path || "/"}`;
      await targetSession.cookies.set({
        url,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        expirationDate: cookie.expirationDate,
        sameSite: cookie.sameSite
      }).catch(() => undefined);
    }
  }

  private async openElyOAuthWindow(clientId: string): Promise<{ code: string; redirectUri: string; cookies: Electron.Cookie[] }> {
    const partition = `ely-oauth-${randomUUID()}`;
    const authSession = session.fromPartition(partition);
    const state = randomBytes(16).toString("hex");
    const redirectUri = "http://127.0.0.1/ely-callback";
    const authUrl = `https://account.ely.by/oauth2/v1?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "account_info minecraft_server_session offline_access",
      state
    }).toString()}`;

    try {
      const code = await new Promise<string>((resolve, reject) => {
        const win = new BrowserWindow({
          width: 860,
          height: 680,
          center: true,
          title: tr("Sign in with Ely.by", "Вход через Ely.by"),
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

        let finished = false;
        const finish = (err: Error | null, codeValue?: string): void => {
          if (finished) return;
          finished = true;
          setTimeout(() => {
            if (!win.isDestroyed()) win.close();
          }, 120);
          if (err) {
            reject(err);
            return;
          }
          if (!codeValue) {
            reject(new Error(tr("Ely.by sign-in did not return an authorization code.", "Вход через Ely.by не вернул код авторизации.")));
            return;
          }
          resolve(codeValue);
        };

        const checkCallback = (event: Electron.Event, nextUrl: string): void => {
          if (!nextUrl.startsWith(redirectUri)) return;
          event.preventDefault();
          const url = new URL(nextUrl);
          if (url.searchParams.get("state") !== state) {
            finish(new Error(tr("Ely.by state verification failed.", "Ошибка проверки состояния Ely.by.")));
            return;
          }
          const error = url.searchParams.get("error");
          if (error) {
            finish(new Error(url.searchParams.get("error_description") || error));
            return;
          }
          finish(null, url.searchParams.get("code") ?? undefined);
        };

        win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        win.webContents.on("will-redirect", checkCallback);
        win.webContents.on("will-navigate", checkCallback);
        win.webContents.on("render-process-gone", () => {
          finish(new Error(tr("Ely.by login window crashed.", "Окно входа Ely.by завершилось с ошибкой.")));
        });
        win.on("closed", () => {
          if (!finished) {
            finished = true;
            reject(new Error(tr("Ely.by login window was closed.", "Окно входа Ely.by было закрыто.")));
          }
        });
        win.loadURL(authUrl).catch((error) => {
          if (!finished) finish(new Error(errorMessage(error)));
        });
      });
      const cookies = await authSession.cookies.get({}).catch(() => []);
      return { code, redirectUri, cookies };
    } finally {
      await authSession.clearStorageData().catch(() => undefined);
    }
  }

  private async openElyWebSignInWindow(): Promise<{ login: string; password: string; totp: string; cookies: Electron.Cookie[] }> {
    const partition = `ely-signin-${randomUUID()}`;
    const authSession = session.fromPartition(partition);
    const captured = { login: "", password: "", totp: "" };
    const pendingReads: Array<Promise<void>> = [];

    const parsePayload = (raw: string): void => {
      if (!raw.trim()) return;
      try {
        if (raw.trim().startsWith("{")) {
          const obj = JSON.parse(raw) as { login?: string; username?: string; password?: string; totp?: string };
          if (obj.login || obj.username) captured.login = String(obj.login || obj.username).trim();
          if (obj.password) captured.password = String(obj.password);
          if (obj.totp !== undefined && String(obj.totp).trim()) captured.totp = String(obj.totp).trim();
          return;
        }
        const params = new URLSearchParams(raw);
        const login = params.get("login") ?? params.get("username") ?? "";
        const password = params.get("password") ?? "";
        const totp = params.get("totp") ?? "";
        if (login.trim()) captured.login = login.trim();
        if (password) captured.password = password;
        if (totp.trim()) captured.totp = totp.trim();
      } catch {
      }
    };

    authSession.webRequest.onBeforeRequest({ urls: ["https://account.ely.by/api/authentication/*"] }, (details, callback) => {
      for (const item of details.uploadData ?? []) {
        if (item.bytes) {
          parsePayload(item.bytes.toString("utf8"));
        } else if (item.blobUUID) {
          pendingReads.push(
            authSession.getBlobData(item.blobUUID)
              .then((buf) => parsePayload(buf.toString("utf8")))
              .catch(() => undefined)
          );
        }
      }
      callback({});
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const win = new BrowserWindow({
          width: 860,
          height: 680,
          center: true,
          title: tr("Sign in with Ely.by", "Вход через Ely.by"),
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

        let finished = false;
        const finish = (err: Error | null, delayMs = 0): void => {
          if (finished) return;
          finished = true;
          const closeAndResolve = (): void => {
            if (!win.isDestroyed()) win.close();
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          };
          if (delayMs > 0) {
            setTimeout(closeAndResolve, delayMs);
          } else {
            closeAndResolve();
          }
        };

        win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        win.webContents.on("did-navigate", (_event, rawUrl) => {
          void (async () => {
            if (finished) return;
            try {
              const u = new URL(rawUrl);
              if ((u.hostname !== "ely.by" && u.hostname !== "www.ely.by") || u.pathname.startsWith("/authorization")) {
                return;
              }
              await Promise.allSettled(pendingReads);
              if (captured.login && captured.password) {
                finish(null, 250);
                return;
              }
              const res = await authSession.fetch("https://ely.by/authorization/login", { redirect: "manual" }).catch(() => null);
              const cookies = await authSession.cookies.get({ domain: "ely.by" }).catch(() => []);
              if ((res && res.status >= 300 && res.status < 400) || cookies.some((c) => /identity/i.test(c.name))) {
                finish(null, 250);
              }
            } catch {
            }
          })();
        });
        win.webContents.on("render-process-gone", () => {
          finish(new Error(tr("Ely.by login window crashed.", "Окно входа Ely.by завершилось с ошибкой.")));
        });
        win.on("closed", () => {
          if (!finished) {
            finished = true;
            reject(new Error(tr("Ely.by login window was closed.", "Окно входа Ely.by было закрыто.")));
          }
        });
        win.loadURL("https://ely.by/authorization/login").catch((error) => {
          if (!finished) finish(new Error(errorMessage(error)));
        });
      });

      await Promise.allSettled(pendingReads);
      const cookies = await authSession.cookies.get({}).catch(() => []);
      return { ...captured, cookies };
    } finally {
      authSession.webRequest.onBeforeRequest({ urls: ["https://account.ely.by/api/authentication/*"] }, null);
      await authSession.clearStorageData().catch(() => undefined);
    }
  }

  async elyLogin(): Promise<AccountsState> {
    const clientId = String(import.meta.env.MAIN_VITE_ELY_CLIENT_ID ?? "").trim();
    const clientSecret = String(import.meta.env.MAIN_VITE_ELY_CLIENT_SECRET ?? "").trim();
    const clientToken = randomUUID().replace(/-/g, "");
    let profile: { id: string; name: string; accessToken: string; refreshToken?: string; expiresAt?: string; mode: "oauth2" | "yggdrasil"; cookies: Electron.Cookie[] };

    if (clientId && clientSecret) {
      const { code, redirectUri, cookies } = await this.openElyOAuthWindow(clientId);
      const tokenRes = await fetch("https://account.ely.by/api/oauth2/v1/token", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json"
        },
        body: toFormBody({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
          grant_type: "authorization_code"
        })
      });
      const tokenData = await readJson<{ access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }>(tokenRes);
      if (!tokenRes.ok || !tokenData.access_token) {
        throw new Error(tokenData.error_description || tokenData.error || tr(`Ely.by OAuth token failed (HTTP ${tokenRes.status})`, `Не удалось получить токен Ely.by OAuth (HTTP ${tokenRes.status})`));
      }
      const infoRes = await fetch("https://account.ely.by/api/account/v1/info", {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          accept: "application/json"
        }
      });
      const info = await readJson<{ uuid?: string; username?: string; error?: string }>(infoRes);
      if (!infoRes.ok || !info.uuid || !info.username) {
        throw new Error(info.error || tr(`Could not read Ely.by profile (HTTP ${infoRes.status})`, `Не удалось прочитать профиль Ely.by (HTTP ${infoRes.status})`));
      }
      const expiresAt = tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString() : undefined;
      profile = { id: info.uuid, name: info.username, accessToken: tokenData.access_token, refreshToken: tokenData.refresh_token, expiresAt, mode: "oauth2", cookies };
    } else {
      const creds = await this.openElyWebSignInWindow();
      if (!creds.login || !creds.password) {
        throw new Error(tr("Sign in with your Ely.by username or e-mail and password in the popup window.", "Войдите по логину или почте и паролю Ely.by в открывшемся окне."));
      }
      const auth = await this.authenticateEly(creds.login, creds.totp ? `${creds.password}:${creds.totp}` : creds.password, clientToken);
      profile = { ...auth, mode: "yggdrasil", cookies: creds.cookies };
    }

    const accountId = profile.id.replace(/-/g, "");
    await this.copyCookiesToAccount(profile.cookies, accountId);

    return this.store.update((data) => {
      const prevActive = data.accounts.find((item) => item.id === data.activeAccountId) ?? null;
      if (prevActive && (prevActive.kind === "microsoft" || prevActive.kind === "ely")) {
        prevActive.activeSkinId = data.settings.activeSkinId ?? prevActive.activeSkinId ?? null;
      }
      const existing = data.accounts.find((item) => item.kind === "ely" && item.minecraftUuid === accountId);
      if (existing) {
        existing.status = "signed-in";
        existing.profileName = profile.name;
        existing.elyAccessToken = profile.accessToken;
        existing.elyAuthMode = profile.mode;
        if (profile.mode === "yggdrasil") {
          existing.elyClientToken = clientToken;
          delete existing.elyRefreshToken;
          delete existing.expiresAt;
        } else {
          delete existing.elyClientToken;
          if (profile.refreshToken) existing.elyRefreshToken = profile.refreshToken;
          if (profile.expiresAt) existing.expiresAt = profile.expiresAt;
        }
        existing.message = tr(`Ely.by as ${profile.name}`, `Ely.by: ${profile.name}`);
        data.activeAccountId = existing.id;
        data.settings.activeSkinId = existing.activeSkinId ?? null;
      } else {
        const entry: AccountState = {
          id: accountId,
          kind: "ely",
          status: "signed-in",
          profileName: profile.name,
          minecraftUuid: accountId,
          elyAccessToken: profile.accessToken,
          elyAuthMode: profile.mode,
          ...(profile.mode === "yggdrasil" ? { elyClientToken: clientToken } : { elyRefreshToken: profile.refreshToken, expiresAt: profile.expiresAt }),
          message: tr(`Ely.by as ${profile.name}`, `Ely.by: ${profile.name}`),
          activeSkinId: null,
          addedAt: new Date().toISOString()
        };
        data.accounts.push(entry);
        data.activeAccountId = entry.id;
        data.settings.activeSkinId = null;
      }
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
      const detail = body.errorMessage || body.error || tr(`Ely.by login failed (HTTP ${response.status})`, `Не удалось войти через Ely.by (HTTP ${response.status})`);
      const hint = /two factor/i.test(detail) ? tr(" Enter your 2FA token in the token field.", " Введите код двухфакторной аутентификации в поле для кода.") : "";
      throw new Error(`${detail}.${hint}`);
    }

    return {
      id: body.selectedProfile.id,
      name: body.selectedProfile.name,
      accessToken: body.accessToken
    };
  }

  private async validateElySession(accessToken: string): Promise<boolean | null> {
    try {
      const response = await fetch("https://authserver.ely.by/auth/validate", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json"
        },
        body: JSON.stringify({ accessToken })
      });
      if (response.ok) return true;
      if (response.status === 401 || response.status === 403) return false;
      return null;
    } catch {
      return null;
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
      const msg = body.errorMessage || body.error || tr(`Ely.by refresh failed (HTTP ${response.status})`, `Не удалось обновить сессию Ely.by (HTTP ${response.status})`);
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        throw new PermanentAuthError(msg);
      }
      throw new Error(msg);
    }

    return body.accessToken;
  }

  async useOfflineProfile(username: string): Promise<AccountsState> {
    const name = String(username ?? "").trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
      throw new Error(tr("Offline username must be 3-16 characters: letters, numbers, underscore.", "Офлайн-имя должно содержать от 3 до 16 символов: латинские буквы, цифры и подчёркивание."));
    }

    return this.store.update((data) => {
      const prevActive = data.accounts.find((item) => item.id === data.activeAccountId) ?? null;
      if (prevActive && (prevActive.kind === "microsoft" || prevActive.kind === "ely")) {
        prevActive.activeSkinId = data.settings.activeSkinId ?? prevActive.activeSkinId ?? null;
      }
      const existing = data.accounts.find((item) => item.kind === "offline" && item.profileName?.toLowerCase() === name.toLowerCase());
      if (existing) {
        existing.status = "offline";
        existing.message = tr(`Offline profile: ${existing.profileName}`, `Офлайн-профиль: ${existing.profileName}`);
        data.activeAccountId = existing.id;
      } else {
        const entry: AccountState = {
          id: offlineUuid(name),
          kind: "offline",
          status: "offline",
          profileName: name,
          message: tr(`Offline profile: ${name}`, `Офлайн-профиль: ${name}`),
          activeSkinId: null,
          addedAt: new Date().toISOString()
        };
        if (data.accounts.some((item) => item.id === entry.id)) {
          entry.id = randomUUID();
        }
        data.accounts.push(entry);
        data.activeAccountId = entry.id;
      }
      data.settings.activeSkinId = null;
      return { accounts: data.accounts, activeAccountId: data.activeAccountId };
    });
  }

  async setActiveAccount(id: string): Promise<AccountsState> {
    return this.store.update((data) => {
      const prevActive = data.accounts.find((item) => item.id === data.activeAccountId) ?? null;
      if (prevActive && (prevActive.kind === "microsoft" || prevActive.kind === "ely")) {
        prevActive.activeSkinId = data.settings.activeSkinId ?? prevActive.activeSkinId ?? null;
      }
      const target = data.accounts.find((item) => item.id === id);
      if (!target) {
        throw new Error(tr("Account not found", "Аккаунт не найден"));
      }
      data.activeAccountId = target.id;
      data.settings.activeSkinId = target.kind === "microsoft" || target.kind === "ely" ? (target.activeSkinId ?? null) : null;
      return { accounts: data.accounts, activeAccountId: data.activeAccountId };
    });
  }

  async removeAccount(id: string): Promise<AccountsState> {
    return this.store.update((data) => {
      const prevActive = data.accounts.find((item) => item.id === data.activeAccountId) ?? null;
      if (prevActive && prevActive.id !== id && (prevActive.kind === "microsoft" || prevActive.kind === "ely")) {
        prevActive.activeSkinId = data.settings.activeSkinId ?? prevActive.activeSkinId ?? null;
      }
      data.accounts = data.accounts.filter((item) => item.id !== id);
      if (data.activeAccountId === id) {
        data.activeAccountId = data.accounts[0]?.id ?? null;
      }
      const active = data.accounts.find((item) => item.id === data.activeAccountId) ?? null;
      data.settings.activeSkinId = active?.kind === "microsoft" || active?.kind === "ely" ? (active.activeSkinId ?? null) : null;
      return { accounts: data.accounts, activeAccountId: data.activeAccountId };
    });
  }
}
