use crate::i18n::{tr, tr_string};
use crate::store::{public_accounts, JsonStore};
use crate::types::{AccountState, AccountsState, LoginStartResult};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use md5::{Digest as Md5Digest, Md5};
use rand::RngCore;
use reqwest::Client;
use serde::Deserialize;
use serde_json::json;
use sha2::Sha256;
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::oneshot;
use url::Url;
use uuid::Uuid;

pub const BUNDLED_MS_CLIENT_ID: &str = "00000000402b5328";
const MS_AUTHORIZE_URL: &str = "https://login.live.com/oauth20_authorize.srf";
const MS_REDIRECT_URI: &str = "https://login.live.com/oauth20_desktop.srf";
const MS_TOKEN_URL: &str = "https://login.live.com/oauth20_token.srf";
const MS_SCOPE: &str = "service::user.auth.xboxlive.com::MBI_SSL";

#[derive(Deserialize)]
struct MsTokenBody {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Deserialize)]
struct XboxAuthBody {
    #[serde(rename = "Token")]
    token: Option<String>,
    #[serde(rename = "DisplayClaims")]
    display_claims: Option<XboxClaims>,
    #[serde(rename = "XErr")]
    xerr: Option<u64>,
    #[serde(rename = "Message")]
    message: Option<String>,
}

#[derive(Deserialize)]
struct XboxClaims {
    xui: Option<Vec<XboxXui>>,
}

#[derive(Deserialize)]
struct XboxXui {
    uhs: Option<String>,
}

#[derive(Deserialize)]
struct McLoginBody {
    access_token: Option<String>,
    expires_in: Option<i64>,
}

#[derive(Deserialize)]
struct McProfileBody {
    id: Option<String>,
    name: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Deserialize)]
struct ElyAuthBody {
    #[serde(rename = "accessToken")]
    access_token: Option<String>,
    #[serde(rename = "selectedProfile")]
    selected_profile: Option<ElyProfile>,
    error: Option<String>,
    #[serde(rename = "errorMessage")]
    error_message: Option<String>,
}

#[derive(Deserialize)]
struct ElyProfile {
    id: Option<String>,
    name: Option<String>,
}

#[derive(Deserialize)]
struct ElyOAuthTokenBody {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Deserialize)]
struct ElyAccountInfoBody {
    uuid: Option<String>,
    username: Option<String>,
    error: Option<String>,
}

pub fn offline_uuid_dashed(name: &str) -> String {
    let mut hasher = Md5::new();
    hasher.update(format!("OfflinePlayer:{name}").as_bytes());
    let mut hash = hasher.finalize();
    hash[6] = (hash[6] & 0x0f) | 0x30;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    let h = hex::encode(hash);
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

pub fn offline_uuid_undashed(name: &str) -> String {
    offline_uuid_dashed(name).replace('-', "")
}

fn generate_pkce() -> (String, String) {
    let mut bytes = [0u8; 64];
    rand::thread_rng().fill_bytes(&mut bytes);
    let verifier = URL_SAFE_NO_PAD.encode(bytes);
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let challenge = URL_SAFE_NO_PAD.encode(hasher.finalize());
    (verifier, challenge)
}

fn describe_xsts_error(xerr: Option<u64>, msg: Option<&str>, status: u16) -> String {
    match xerr {
        Some(2148916229) => tr(
            "This Microsoft account is banned from Xbox Live.",
            "Этот аккаунт Microsoft заблокирован в Xbox Live.",
        )
        .to_string(),
        Some(2148916233) => tr(
            "This Microsoft account has no Xbox profile. Open xbox.com once and create a profile.",
            "У этого аккаунта Microsoft нет профиля Xbox. Откройте xbox.com и создайте профиль.",
        )
        .to_string(),
        Some(2148916234) => tr(
            "This Microsoft account is blocked from Xbox Live.",
            "Доступ этого аккаунта Microsoft к Xbox Live закрыт.",
        )
        .to_string(),
        Some(2148916235) => tr(
            "Xbox Live is not available in this account region.",
            "Xbox Live недоступен в регионе этого аккаунта.",
        )
        .to_string(),
        Some(2148916236) | Some(2148916237) => tr(
            "This Xbox account is restricted from online services.",
            "Этому аккаунту Xbox ограничен доступ к онлайн-сервисам.",
        )
        .to_string(),
        Some(2148916238) => tr(
            "This is a child account. It needs adult approval before Minecraft login can work.",
            "Это детский аккаунт. Для входа в Minecraft нужно разрешение взрослого.",
        )
        .to_string(),
        _ => msg
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                tr_string(
                    format!("Xbox XSTS authorization failed with HTTP {status}"),
                    format!("Ошибка авторизации Xbox XSTS, HTTP {status}"),
                )
            }),
    }
}

pub struct AuthService {
    client: Client,
    store: Arc<JsonStore>,
}

impl AuthService {
    pub fn new(store: Arc<JsonStore>) -> Self {
        let client = Client::builder()
            .user_agent("lynapp/2.0.0-beta.1")
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| Client::new());
        Self { client, store }
    }

    fn client_id_for(&self, configured: &str) -> String {
        let trimmed = configured.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
        if let Ok(env_id) = std::env::var("LIAN_MICROSOFT_CLIENT_ID") {
            if !env_id.trim().is_empty() {
                return env_id.trim().to_string();
            }
        }
        BUNDLED_MS_CLIENT_ID.to_string()
    }

    async fn exchange_ms_code(
        &self,
        client_id: &str,
        code: &str,
        verifier: &str,
    ) -> Result<(String, String, i64), (bool, String)> {
        let params = [
            ("client_id", client_id),
            ("code", code),
            ("code_verifier", verifier),
            ("grant_type", "authorization_code"),
            ("redirect_uri", MS_REDIRECT_URI),
            ("scope", MS_SCOPE),
        ];
        let resp = self
            .client
            .post(MS_TOKEN_URL)
            .form(&params)
            .send()
            .await
            .map_err(|e| (false, e.to_string()))?;
        let status = resp.status().as_u16();
        let body: MsTokenBody = resp.json().await.map_err(|e| (false, e.to_string()))?;
        match (body.access_token, body.refresh_token) {
            (Some(at), Some(rt)) if status < 300 => Ok((at, rt, body.expires_in.unwrap_or(3600))),
            _ => {
                let msg = body
                    .error_description
                    .or(body.error.clone())
                    .unwrap_or_else(|| format!("Microsoft token request failed (HTTP {status})"));
                let perm = matches!(
                    body.error.as_deref(),
                    Some("invalid_grant") | Some("unauthorized_client")
                ) || status == 400
                    || status == 401;
                Err((perm, msg))
            }
        }
    }

    async fn refresh_ms_token(
        &self,
        client_id: &str,
        refresh_token: &str,
    ) -> Result<(String, String, i64), (bool, String)> {
        let params = [
            ("client_id", client_id),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
            ("redirect_uri", MS_REDIRECT_URI),
            ("scope", MS_SCOPE),
        ];
        let resp = self
            .client
            .post(MS_TOKEN_URL)
            .form(&params)
            .send()
            .await
            .map_err(|e| (false, e.to_string()))?;
        let status = resp.status().as_u16();
        let body: MsTokenBody = resp.json().await.map_err(|e| (false, e.to_string()))?;
        let next_rt = body.refresh_token.unwrap_or_else(|| refresh_token.to_string());
        match body.access_token {
            Some(at) if status < 300 => Ok((at, next_rt, body.expires_in.unwrap_or(3600))),
            _ => {
                let msg = body
                    .error_description
                    .or(body.error.clone())
                    .unwrap_or_else(|| format!("Microsoft token refresh failed (HTTP {status})"));
                let perm = matches!(
                    body.error.as_deref(),
                    Some("invalid_grant") | Some("unauthorized_client")
                ) || status == 400
                    || status == 401;
                Err((perm, msg))
            }
        }
    }

    async fn perform_ms_chain(
        &self,
        ms_access_token: &str,
    ) -> Result<(String, String, String, String, String), String> {
        let mut xbox_token = None;
        let mut first_err = None;
        for ticket in [format!("d={ms_access_token}"), ms_access_token.to_string()] {
            let res = self
                .client
                .post("https://user.auth.xboxlive.com/user/authenticate")
                .json(&json!({
                    "Properties": {
                        "AuthMethod": "RPS",
                        "SiteName": "user.auth.xboxlive.com",
                        "RpsTicket": ticket
                    },
                    "RelyingParty": "http://auth.xboxlive.com",
                    "TokenType": "JWT"
                }))
                .send()
                .await;
            match res {
                Ok(resp) if resp.status().is_success() => {
                    if let Ok(body) = resp.json::<XboxAuthBody>().await {
                        if let Some(tok) = body.token {
                            xbox_token = Some(tok);
                            break;
                        }
                    }
                }
                Ok(resp) => {
                    if first_err.is_none() {
                        first_err = Some(format!("HTTP {}", resp.status().as_u16()));
                    }
                }
                Err(e) => {
                    if first_err.is_none() {
                        first_err = Some(e.to_string());
                    }
                }
            }
        }
        let xbox_tok = xbox_token.ok_or_else(|| {
            let detail = first_err.unwrap_or_else(|| "unknown error".to_string());
            tr_string(
                format!("Xbox Live authentication failed: {detail}"),
                format!("Ошибка входа в Xbox Live: {detail}"),
            )
        })?;

        let xsts_resp = self
            .client
            .post("https://xsts.auth.xboxlive.com/xsts/authorize")
            .json(&json!({
                "Properties": {
                    "SandboxId": "RETAIL",
                    "UserTokens": [xbox_tok]
                },
                "RelyingParty": "rp://api.minecraftservices.com/",
                "TokenType": "JWT"
            }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let xsts_status = xsts_resp.status().as_u16();
        let xsts_body: XboxAuthBody = xsts_resp.json().await.map_err(|e| e.to_string())?;
        if xsts_status >= 300 {
            return Err(describe_xsts_error(
                xsts_body.xerr,
                xsts_body.message.as_deref(),
                xsts_status,
            ));
        }
        let xsts_tok = xsts_body.token.ok_or_else(|| {
            tr(
                "Xbox XSTS did not return an authorization token.",
                "Xbox XSTS не вернул токен авторизации.",
            )
            .to_string()
        })?;
        let uhs = xsts_body
            .display_claims
            .and_then(|c| c.xui)
            .and_then(|mut list| list.pop())
            .and_then(|x| x.uhs)
            .ok_or_else(|| {
                tr(
                    "Xbox XSTS response did not include a user hash.",
                    "В ответе Xbox XSTS нет хеша пользователя.",
                )
                .to_string()
            })?;

        let mc_resp = self
            .client
            .post("https://api.minecraftservices.com/authentication/login_with_xbox")
            .json(&json!({ "identityToken": format!("XBL3.0 x={uhs};{xsts_tok}") }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !mc_resp.status().is_success() {
            return Err(tr_string(
                format!("Minecraft Xbox login failed (HTTP {})", mc_resp.status().as_u16()),
                format!("Ошибка входа Minecraft через Xbox (HTTP {})", mc_resp.status().as_u16()),
            ));
        }
        let mc_body: McLoginBody = mc_resp.json().await.map_err(|e| e.to_string())?;
        let mc_token = mc_body.access_token.ok_or_else(|| {
            tr(
                "Minecraft Services did not return an access token.",
                "Minecraft Services не вернул токен доступа.",
            )
            .to_string()
        })?;
        let expires_at =
            (Utc::now() + ChronoDuration::seconds(mc_body.expires_in.unwrap_or(86400))).to_rfc3339();

        let prof_resp = self
            .client
            .get("https://api.minecraftservices.com/minecraft/profile")
            .bearer_auth(&mc_token)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let prof_status = prof_resp.status().as_u16();
        let prof_body: McProfileBody = prof_resp.json().await.map_err(|e| e.to_string())?;
        if prof_status == 404 {
            return Err(tr(
                "Minecraft Java profile was not found on this Microsoft account.",
                "На этом аккаунте Microsoft нет профиля Minecraft Java.",
            )
            .to_string());
        }
        if prof_status >= 300 {
            return Err(prof_body
                .error_description
                .or(prof_body.error)
                .unwrap_or_else(|| format!("Minecraft profile HTTP {prof_status}")));
        }
        let uuid = prof_body.id.ok_or_else(|| "Missing Minecraft UUID".to_string())?;
        let name = prof_body.name.ok_or_else(|| "Missing Minecraft name".to_string())?;
        Ok((uuid, name, mc_token, expires_at, uhs))
    }

    pub async fn begin_microsoft_login(&self, app: &AppHandle) -> LoginStartResult {
        let data = self.store.get_data().await;
        let client_id = self.client_id_for(&data.settings.microsoft_client_id);
        if client_id.is_empty() {
            return LoginStartResult {
                status: "missing-client-id".to_string(),
                message: tr(
                    "Microsoft login is not configured in this build.",
                    "Вход через Microsoft не настроен в этой сборке.",
                )
                .to_string(),
            };
        }

        let state_token = Uuid::new_v4().to_string();
        let (verifier, challenge) = generate_pkce();
        let mut auth_url = Url::parse(MS_AUTHORIZE_URL).unwrap();
        auth_url
            .query_pairs_mut()
            .append_pair("client_id", &client_id)
            .append_pair("response_type", "code")
            .append_pair("redirect_uri", MS_REDIRECT_URI)
            .append_pair("scope", MS_SCOPE)
            .append_pair("state", &state_token)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("prompt", "select_account");

        let (tx, rx) = oneshot::channel::<Result<String, String>>();
        let tx_cell = Arc::new(StdMutex::new(Some(tx)));
        let tx_nav = tx_cell.clone();
        let state_expected = state_token.clone();
        let win_label = format!("ms-login-{}", Uuid::new_v4().simple());

        let win_res = WebviewWindowBuilder::new(app, &win_label, WebviewUrl::External(auth_url))
            .title("Microsoft Login")
            .inner_size(520.0, 720.0)
            .center()
            .resizable(true)
            .on_navigation(move |next_url| {
                if next_url.as_str().starts_with(MS_REDIRECT_URI) {
                    let params: HashMap<String, String> =
                        next_url.query_pairs().into_owned().collect();
                    let result = if params.get("state").map(|s| s.as_str()) != Some(state_expected.as_str()) {
                        Err(tr(
                            "Microsoft login state check failed.",
                            "Проверка состояния входа через Microsoft не пройдена.",
                        )
                        .to_string())
                    } else if let Some(err) = params.get("error") {
                        Err(params
                            .get("error_description")
                            .cloned()
                            .unwrap_or_else(|| err.clone()))
                    } else if let Some(code) = params.get("code") {
                        Ok(code.clone())
                    } else {
                        Err(tr(
                            "Microsoft login finished without an authorization code.",
                            "Вход через Microsoft завершился без кода авторизации.",
                        )
                        .to_string())
                    };
                    if let Some(sender) = tx_nav.lock().unwrap().take() {
                        let _ = sender.send(result);
                    }
                    return false;
                }
                true
            })
            .build();

        let win = match win_res {
            Ok(w) => w,
            Err(e) => {
                return LoginStartResult {
                    status: "failed".to_string(),
                    message: e.to_string(),
                };
            }
        };

        let tx_close = tx_cell.clone();
        win.on_window_event(move |event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(sender) = tx_close.lock().unwrap().take() {
                    let _ = sender.send(Err(tr(
                        "Microsoft login window was closed.",
                        "Окно входа Microsoft было закрыто.",
                    )
                    .to_string()));
                }
            }
        });

        let code = match rx.await {
            Ok(Ok(c)) => {
                let _ = win.close();
                c
            }
            Ok(Err(msg)) => {
                let _ = win.close();
                return LoginStartResult {
                    status: "failed".to_string(),
                    message: msg,
                };
            }
            Err(_) => {
                let _ = win.close();
                return LoginStartResult {
                    status: "failed".to_string(),
                    message: tr(
                        "Microsoft login window was closed.",
                        "Окно входа Microsoft было закрыто.",
                    )
                    .to_string(),
                };
            }
        };

        let (ms_at, ms_rt, _) = match self.exchange_ms_code(&client_id, &code, &verifier).await {
            Ok(t) => t,
            Err((_, msg)) => {
                return LoginStartResult {
                    status: "failed".to_string(),
                    message: msg,
                };
            }
        };

        let (uuid, name, mc_token, expires_at, uhs) = match self.perform_ms_chain(&ms_at).await {
            Ok(v) => v,
            Err(msg) => {
                return LoginStartResult {
                    status: "failed".to_string(),
                    message: msg,
                };
            }
        };

        if let Err(msg) = self
            .store_microsoft_session(&uuid, &name, &mc_token, &expires_at, &ms_rt, &uhs, true)
            .await
        {
            return LoginStartResult {
                status: "failed".to_string(),
                message: msg,
            };
        }

        LoginStartResult {
            status: "signed-in".to_string(),
            message: tr_string(format!("Signed in as {name}"), format!("Выполнен вход: {name}")),
        }
    }

    async fn store_microsoft_session(
        &self,
        uuid: &str,
        name: &str,
        mc_token: &str,
        expires_at: &str,
        refresh_token: &str,
        uhs: &str,
        activate: bool,
    ) -> Result<AccountState, String> {
        let msg = tr_string(format!("Signed in as {name}"), format!("Выполнен вход: {name}"));
        self.store
            .update(|data| {
                if activate {
                    if let Some(prev_id) = data.active_account_id.clone() {
                        if let Some(prev) = data.accounts.iter_mut().find(|a| a.id == prev_id) {
                            if prev.kind == "microsoft" || prev.kind == "ely" {
                                prev.active_skin_id =
                                    data.settings.active_skin_id.clone().or(prev.active_skin_id.clone());
                            }
                        }
                    }
                }
                if let Some(existing) = data
                    .accounts
                    .iter_mut()
                    .find(|a| a.kind == "microsoft" && a.minecraft_uuid.as_deref() == Some(uuid))
                {
                    existing.status = "signed-in".to_string();
                    existing.profile_name = Some(name.to_string());
                    existing.expires_at = Some(expires_at.to_string());
                    existing.minecraft_access_token = Some(mc_token.to_string());
                    if !refresh_token.is_empty() {
                        existing.microsoft_refresh_token = Some(refresh_token.to_string());
                    }
                    existing.xbox_uhs = Some(uhs.to_string());
                    existing.message = Some(msg);
                    let id = existing.id.clone();
                    let skin = existing.active_skin_id.clone();
                    let ret = existing.clone();
                    if activate {
                        data.active_account_id = Some(id);
                        data.settings.active_skin_id = skin;
                    }
                    return Ok(ret);
                }

                let entry = AccountState {
                    id: uuid.to_string(),
                    kind: "microsoft".to_string(),
                    status: "signed-in".to_string(),
                    profile_name: Some(name.to_string()),
                    minecraft_uuid: Some(uuid.to_string()),
                    expires_at: Some(expires_at.to_string()),
                    message: Some(msg),
                    user_code: None,
                    verification_uri: None,
                    login_expires_at: None,
                    minecraft_access_token: Some(mc_token.to_string()),
                    microsoft_refresh_token: Some(refresh_token.to_string()),
                    ely_access_token: None,
                    ely_client_token: None,
                    ely_refresh_token: None,
                    ely_auth_mode: None,
                    xbox_uhs: Some(uhs.to_string()),
                    active_skin_id: None,
                    added_at: Some(Utc::now().to_rfc3339()),
                };
                data.accounts.push(entry.clone());
                if activate {
                    data.active_account_id = Some(uuid.to_string());
                    data.settings.active_skin_id = None;
                }
                Ok(entry)
            })
            .await
    }

    async fn mark_signed_out(&self, account_id: &str, message: String) {
        let _ = self
            .store
            .update(|data| {
                if let Some(acc) = data.accounts.iter_mut().find(|a| a.id == account_id) {
                    if acc.status != "offline" {
                        acc.status = "signed-out".to_string();
                        acc.message = Some(message);
                    }
                }
                Ok(())
            })
            .await;
    }

    pub async fn ensure_fresh_session(&self, force: bool) -> Option<AccountState> {
        let data = self.store.get_data().await;
        let active = data
            .accounts
            .iter()
            .find(|a| Some(&a.id) == data.active_account_id.as_ref())
            .or_else(|| data.accounts.first())
            .cloned()?;
        if active.status != "signed-in" {
            return None;
        }

        if active.kind == "ely" {
            let token = active.ely_access_token.clone()?;
            if active.ely_auth_mode.as_deref() == Some("oauth2")
                || (active.ely_client_token.is_none() && active.ely_refresh_token.is_some())
            {
                let info_ok = self
                    .client
                    .get("https://account.ely.by/api/account/v1/info")
                    .bearer_auth(&token)
                    .send()
                    .await
                    .map(|r| r.status().is_success())
                    .unwrap_or(true);
                if info_ok && !force {
                    return Some(active);
                }
                let client_id = option_env!("MAIN_VITE_ELY_CLIENT_ID").unwrap_or("").trim();
                let client_secret = option_env!("MAIN_VITE_ELY_CLIENT_SECRET").unwrap_or("").trim();
                let Some(rt) = active.ely_refresh_token.clone() else {
                    self.mark_signed_out(
                        &active.id,
                        tr(
                            "Ely.by session expired. Sign in again.",
                            "Сессия Ely.by истекла. Войдите снова.",
                        )
                        .to_string(),
                    )
                    .await;
                    return None;
                };
                if client_id.is_empty() || client_secret.is_empty() {
                    return Some(active);
                }
                let res = self
                    .client
                    .post("https://account.ely.by/api/oauth2/v1/token")
                    .form(&[
                        ("client_id", client_id),
                        ("client_secret", client_secret),
                        ("refresh_token", rt.as_str()),
                        ("grant_type", "refresh_token"),
                    ])
                    .send()
                    .await
                    .ok()?;
                if !res.status().is_success() {
                    self.mark_signed_out(
                        &active.id,
                        tr(
                            "Ely.by session expired. Sign in again.",
                            "Сессия Ely.by истекла. Войдите снова.",
                        )
                        .to_string(),
                    )
                    .await;
                    return None;
                }
                let body: ElyOAuthTokenBody = res.json().await.ok()?;
                let new_at = body.access_token?;
                let new_exp = body
                    .expires_in
                    .map(|s| (Utc::now() + ChronoDuration::seconds(s)).to_rfc3339());
                let acc_id = active.id.clone();
                return self
                    .store
                    .update(|d| {
                        let target = d
                            .accounts
                            .iter_mut()
                            .find(|a| a.id == acc_id)
                            .ok_or_else(|| "not found".to_string())?;
                        target.ely_access_token = Some(new_at);
                        if let Some(nrt) = body.refresh_token {
                            target.ely_refresh_token = Some(nrt);
                        }
                        if let Some(exp) = new_exp {
                            target.expires_at = Some(exp);
                        }
                        Ok(target.clone())
                    })
                    .await
                    .ok();
            }

            let valid_resp = self
                .client
                .post("https://authserver.ely.by/auth/validate")
                .json(&json!({ "accessToken": token }))
                .send()
                .await;
            match valid_resp {
                Ok(r) if r.status().is_success() => return Some(active),
                Err(_) => return Some(active),
                Ok(r) if r.status().as_u16() != 401 && r.status().as_u16() != 403 => {
                    return Some(active)
                }
                _ => {}
            }
            let Some(ct) = active.ely_client_token.clone() else {
                self.mark_signed_out(
                    &active.id,
                    tr(
                        "Ely.by session expired. Sign in again.",
                        "Сессия Ely.by истекла. Войдите снова.",
                    )
                    .to_string(),
                )
                .await;
                return None;
            };
            let ref_resp = self
                .client
                .post("https://authserver.ely.by/auth/refresh")
                .json(&json!({
                    "accessToken": token,
                    "clientToken": ct,
                    "requestUser": false
                }))
                .send()
                .await
                .ok()?;
            if !ref_resp.status().is_success() {
                self.mark_signed_out(
                    &active.id,
                    tr(
                        "Ely.by session expired. Sign in again.",
                        "Сессия Ely.by истекла. Войдите снова.",
                    )
                    .to_string(),
                )
                .await;
                return None;
            }
            let body: ElyAuthBody = ref_resp.json().await.ok()?;
            let next_token = body.access_token?;
            let acc_id = active.id.clone();
            return self
                .store
                .update(|d| {
                    let target = d
                        .accounts
                        .iter_mut()
                        .find(|a| a.id == acc_id)
                        .ok_or_else(|| "not found".to_string())?;
                    target.ely_access_token = Some(next_token);
                    Ok(target.clone())
                })
                .await
                .ok();
        }

        if active.kind != "microsoft" {
            return Some(active);
        }
        let refresh_token = active.microsoft_refresh_token.clone()?;
        let not_expiring = active
            .expires_at
            .as_deref()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.with_timezone(&Utc) - Utc::now() > ChronoDuration::minutes(5))
            .unwrap_or(false);
        if !force && active.minecraft_access_token.is_some() && not_expiring {
            return Some(active);
        }
        let client_id = self.client_id_for(&data.settings.microsoft_client_id);
        let (ms_at, next_rt, _) = match self.refresh_ms_token(&client_id, &refresh_token).await {
            Ok(v) => v,
            Err((true, _)) => {
                self.mark_signed_out(
                    &active.id,
                    tr(
                        "Microsoft session expired. Sign in again.",
                        "Сессия Microsoft истекла. Войдите снова.",
                    )
                    .to_string(),
                )
                .await;
                return None;
            }
            Err((false, _)) => return None,
        };
        let (uuid, name, mc_token, expires_at, uhs) = self.perform_ms_chain(&ms_at).await.ok()?;
        self.store_microsoft_session(&uuid, &name, &mc_token, &expires_at, &next_rt, &uhs, false)
            .await
            .ok()
    }

    pub async fn try_silent_refresh(&self) -> AccountsState {
        let _ = self.ensure_fresh_session(false).await;
        let data = self.store.get_data().await;
        public_accounts(&data)
    }

    pub async fn ely_login(&self, app: &AppHandle) -> Result<AccountsState, String> {
        let client_id = option_env!("MAIN_VITE_ELY_CLIENT_ID")
            .unwrap_or("")
            .trim()
            .to_string();
        let client_secret = option_env!("MAIN_VITE_ELY_CLIENT_SECRET")
            .unwrap_or("")
            .trim()
            .to_string();

        if !client_id.is_empty() && !client_secret.is_empty() {
            return self
                .ely_oauth_login(app, &client_id, &client_secret)
                .await;
        }

        let (username, password, totp) = self.open_ely_credentials_popup(app).await?;
        let full_pass = if totp.is_empty() {
            password
        } else {
            format!("{password}:{totp}")
        };
        let client_token = Uuid::new_v4().simple().to_string();
        let resp = self
            .client
            .post("https://authserver.ely.by/auth/authenticate")
            .json(&json!({
                "username": username,
                "password": full_pass,
                "clientToken": client_token,
                "requestUser": true
            }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        let body: ElyAuthBody = resp.json().await.map_err(|e| e.to_string())?;
        let (Some(access_token), Some(prof)) = (body.access_token, body.selected_profile) else {
            let detail = body
                .error_message
                .or(body.error)
                .unwrap_or_else(|| format!("Ely.by login failed (HTTP {status})"));
            return Err(detail);
        };
        let account_id = prof.id.unwrap_or_default().replace('-', "");
        let profile_name = prof.name.unwrap_or(username);
        self.save_ely_account(
            account_id,
            profile_name,
            access_token,
            "yggdrasil".to_string(),
            Some(client_token),
            None,
            None,
        )
        .await
    }

    async fn ely_oauth_login(
        &self,
        app: &AppHandle,
        client_id: &str,
        client_secret: &str,
    ) -> Result<AccountsState, String> {
        let state_token = Uuid::new_v4().simple().to_string();
        let redirect_uri = "http://127.0.0.1/ely-callback";
        let mut url = Url::parse("https://account.ely.by/oauth2/v1").unwrap();
        url.query_pairs_mut()
            .append_pair("client_id", client_id)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("response_type", "code")
            .append_pair("scope", "account_info minecraft_server_session offline_access")
            .append_pair("state", &state_token);

        let (tx, rx) = oneshot::channel::<Result<String, String>>();
        let tx_cell = Arc::new(StdMutex::new(Some(tx)));
        let tx_nav = tx_cell.clone();
        let expected = state_token.clone();
        let label = format!("ely-oauth-{}", Uuid::new_v4().simple());

        let win = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
            .title(tr("Sign in with Ely.by", "Вход через Ely.by"))
            .inner_size(820.0, 660.0)
            .center()
            .on_navigation(move |next_url| {
                if next_url.as_str().starts_with(redirect_uri) {
                    let params: HashMap<String, String> =
                        next_url.query_pairs().into_owned().collect();
                    let res = if params.get("state").map(|s| s.as_str()) != Some(expected.as_str()) {
                        Err("Ely.by state mismatch".to_string())
                    } else if let Some(code) = params.get("code") {
                        Ok(code.clone())
                    } else {
                        Err(params
                            .get("error_description")
                            .or_else(|| params.get("error"))
                            .cloned()
                            .unwrap_or_else(|| "Ely.by OAuth failed".to_string()))
                    };
                    if let Some(s) = tx_nav.lock().unwrap().take() {
                        let _ = s.send(res);
                    }
                    return false;
                }
                true
            })
            .build()
            .map_err(|e| e.to_string())?;

        let tx_close = tx_cell.clone();
        win.on_window_event(move |ev| {
            if let tauri::WindowEvent::Destroyed = ev {
                if let Some(s) = tx_close.lock().unwrap().take() {
                    let _ = s.send(Err(tr(
                        "Ely.by login window was closed.",
                        "Окно входа Ely.by было закрыто.",
                    )
                    .to_string()));
                }
            }
        });

        let code = match rx.await {
            Ok(Ok(c)) => {
                let _ = win.close();
                c
            }
            Ok(Err(e)) => {
                let _ = win.close();
                return Err(e);
            }
            Err(_) => {
                let _ = win.close();
                return Err(tr(
                    "Ely.by login window was closed.",
                    "Окно входа Ely.by было закрыто.",
                )
                .to_string());
            }
        };

        let token_resp = self
            .client
            .post("https://account.ely.by/api/oauth2/v1/token")
            .form(&[
                ("client_id", client_id),
                ("client_secret", client_secret),
                ("code", code.as_str()),
                ("redirect_uri", redirect_uri),
                ("grant_type", "authorization_code"),
            ])
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let token_body: ElyOAuthTokenBody = token_resp.json().await.map_err(|e| e.to_string())?;
        let access_token = token_body
            .access_token
            .ok_or_else(|| token_body.error_description.or(token_body.error).unwrap_or_else(|| "Ely.by token error".to_string()))?;
        let info_resp = self
            .client
            .get("https://account.ely.by/api/account/v1/info")
            .bearer_auth(&access_token)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let info: ElyAccountInfoBody = info_resp.json().await.map_err(|e| e.to_string())?;
        let uuid = info
            .uuid
            .ok_or_else(|| info.error.unwrap_or_else(|| "Missing Ely.by UUID".to_string()))?
            .replace('-', "");
        let name = info.username.ok_or_else(|| "Missing Ely.by username".to_string())?;
        let expires_at = token_body
            .expires_in
            .map(|s| (Utc::now() + ChronoDuration::seconds(s)).to_rfc3339());
        self.save_ely_account(
            uuid,
            name,
            access_token,
            "oauth2".to_string(),
            None,
            token_body.refresh_token,
            expires_at,
        )
        .await
    }

    async fn open_ely_credentials_popup(
        &self,
        app: &AppHandle,
    ) -> Result<(String, String, String), String> {
        let title_txt = tr("Sign in with Ely.by", "Вход через Ely.by");
        let login_ph = tr("Username or e-mail", "Ник или e-mail");
        let pass_ph = tr("Password", "Пароль");
        let totp_ph = tr("2FA code (if enabled)", "Код 2FA (если включён)");
        let btn_txt = tr("Sign in", "Войти");
        let html = format!(
            "<!doctype html><html><head><meta charset=utf-8><style>body{{margin:0;background:#0b111d;color:#e8f0fb;font:14px system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh}}form{{width:320px;background:#101d2e;border:1px solid #21364e;border-radius:14px;padding:24px;display:flex;flex-direction:column;gap:12px}}h2{{margin:0 0 6px;font-size:18px}}input{{background:#0b1524;color:#e8f0fb;border:1px solid #21364e;border-radius:8px;padding:10px 12px;font-size:14px}}button{{background:#224e78;color:#fff;border:0;border-radius:8px;padding:11px;font-size:14px;font-weight:600;cursor:pointer}}button:hover{{background:#2c6396}}</style></head><body><form id=f><h2>{title_txt}</h2><input id=u placeholder='{login_ph}' required autofocus><input id=p type=password placeholder='{pass_ph}' required><input id=t placeholder='{totp_ph}'><button type=submit>{btn_txt}</button></form><script>document.getElementById('f').onsubmit=e=>{{e.preventDefault();const q=new URLSearchParams({{u:u.value.trim(),p:p.value,t:t.value.trim()}});location.href='http://127.0.0.1/ely-submit?'+q.toString();}};</script></body></html>"
        );
        let data_url = Url::parse(&format!(
            "data:text/html;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(html.as_bytes())
        ))
        .map_err(|e| e.to_string())?;

        let (tx, rx) = oneshot::channel::<Result<(String, String, String), String>>();
        let tx_cell = Arc::new(StdMutex::new(Some(tx)));
        let tx_nav = tx_cell.clone();
        let label = format!("ely-login-{}", Uuid::new_v4().simple());

        let win = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(data_url))
            .title(title_txt)
            .inner_size(420.0, 380.0)
            .center()
            .resizable(false)
            .on_navigation(move |next_url| {
                if next_url.as_str().starts_with("http://127.0.0.1/ely-submit") {
                    let params: HashMap<String, String> =
                        next_url.query_pairs().into_owned().collect();
                    let u = params.get("u").cloned().unwrap_or_default();
                    let p = params.get("p").cloned().unwrap_or_default();
                    let t = params.get("t").cloned().unwrap_or_default();
                    if let Some(s) = tx_nav.lock().unwrap().take() {
                        let _ = s.send(Ok((u, p, t)));
                    }
                    return false;
                }
                true
            })
            .build()
            .map_err(|e| e.to_string())?;

        let tx_close = tx_cell.clone();
        win.on_window_event(move |ev| {
            if let tauri::WindowEvent::Destroyed = ev {
                if let Some(s) = tx_close.lock().unwrap().take() {
                    let _ = s.send(Err(tr(
                        "Ely.by login window was closed.",
                        "Окно входа Ely.by было закрыто.",
                    )
                    .to_string()));
                }
            }
        });

        let res = rx.await;
        let _ = win.close();
        match res {
            Ok(Ok(creds)) => Ok(creds),
            Ok(Err(e)) => Err(e),
            Err(_) => Err(tr(
                "Ely.by login window was closed.",
                "Окно входа Ely.by было закрыто.",
            )
            .to_string()),
        }
    }

    async fn save_ely_account(
        &self,
        account_id: String,
        profile_name: String,
        access_token: String,
        mode: String,
        client_token: Option<String>,
        refresh_token: Option<String>,
        expires_at: Option<String>,
    ) -> Result<AccountsState, String> {
        let msg = tr_string(
            format!("Ely.by as {profile_name}"),
            format!("Ely.by: {profile_name}"),
        );
        self.store
            .update(|data| {
                if let Some(prev_id) = data.active_account_id.clone() {
                    if let Some(prev) = data.accounts.iter_mut().find(|a| a.id == prev_id) {
                        if prev.kind == "microsoft" || prev.kind == "ely" {
                            prev.active_skin_id =
                                data.settings.active_skin_id.clone().or(prev.active_skin_id.clone());
                        }
                    }
                }
                if let Some(existing) = data
                    .accounts
                    .iter_mut()
                    .find(|a| a.kind == "ely" && a.minecraft_uuid.as_deref() == Some(account_id.as_str()))
                {
                    existing.status = "signed-in".to_string();
                    existing.profile_name = Some(profile_name);
                    existing.ely_access_token = Some(access_token);
                    existing.ely_auth_mode = Some(mode);
                    existing.ely_client_token = client_token;
                    existing.ely_refresh_token = refresh_token;
                    existing.expires_at = expires_at;
                    existing.message = Some(msg);
                    let id = existing.id.clone();
                    let skin = existing.active_skin_id.clone();
                    data.active_account_id = Some(id);
                    data.settings.active_skin_id = skin;
                } else {
                    let entry = AccountState {
                        id: account_id.clone(),
                        kind: "ely".to_string(),
                        status: "signed-in".to_string(),
                        profile_name: Some(profile_name),
                        minecraft_uuid: Some(account_id.clone()),
                        expires_at,
                        message: Some(msg),
                        user_code: None,
                        verification_uri: None,
                        login_expires_at: None,
                        minecraft_access_token: None,
                        microsoft_refresh_token: None,
                        ely_access_token: Some(access_token),
                        ely_client_token: client_token,
                        ely_refresh_token: refresh_token,
                        ely_auth_mode: Some(mode),
                        xbox_uhs: None,
                        active_skin_id: None,
                        added_at: Some(Utc::now().to_rfc3339()),
                    };
                    data.accounts.push(entry);
                    data.active_account_id = Some(account_id);
                    data.settings.active_skin_id = None;
                }
                Ok(public_accounts(data))
            })
            .await
    }

    pub async fn use_offline_profile(&self, username: &str) -> Result<AccountsState, String> {
        let name = username.trim().to_string();
        if name.len() < 3
            || name.len() > 16
            || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            return Err(tr(
                "Offline username must be 3-16 characters: letters, numbers, underscore.",
                "Офлайн-имя должно содержать от 3 до 16 символов: латинские буквы, цифры и подчёркивание.",
            )
            .to_string());
        }
        self.store
            .update(|data| {
                if let Some(prev_id) = data.active_account_id.clone() {
                    if let Some(prev) = data.accounts.iter_mut().find(|a| a.id == prev_id) {
                        if prev.kind == "microsoft" || prev.kind == "ely" {
                            prev.active_skin_id =
                                data.settings.active_skin_id.clone().or(prev.active_skin_id.clone());
                        }
                    }
                }
                if let Some(existing) = data.accounts.iter_mut().find(|a| {
                    a.kind == "offline"
                        && a.profile_name
                            .as_deref()
                            .map(|n| n.eq_ignore_ascii_case(&name))
                            .unwrap_or(false)
                }) {
                    let pname = existing.profile_name.clone().unwrap_or_else(|| name.clone());
                    existing.status = "offline".to_string();
                    existing.message = Some(tr_string(
                        format!("Offline profile: {pname}"),
                        format!("Офлайн-профиль: {pname}"),
                    ));
                    data.active_account_id = Some(existing.id.clone());
                } else {
                    let mut id = offline_uuid_dashed(&name);
                    if data.accounts.iter().any(|a| a.id == id) {
                        id = Uuid::new_v4().to_string();
                    }
                    data.accounts.push(AccountState {
                        id: id.clone(),
                        kind: "offline".to_string(),
                        status: "offline".to_string(),
                        profile_name: Some(name.clone()),
                        minecraft_uuid: Some(offline_uuid_undashed(&name)),
                        expires_at: None,
                        message: Some(tr_string(
                            format!("Offline profile: {name}"),
                            format!("Офлайн-профиль: {name}"),
                        )),
                        user_code: None,
                        verification_uri: None,
                        login_expires_at: None,
                        minecraft_access_token: None,
                        microsoft_refresh_token: None,
                        ely_access_token: None,
                        ely_client_token: None,
                        ely_refresh_token: None,
                        ely_auth_mode: None,
                        xbox_uhs: None,
                        active_skin_id: None,
                        added_at: Some(Utc::now().to_rfc3339()),
                    });
                    data.active_account_id = Some(id);
                }
                data.settings.active_skin_id = None;
                Ok(public_accounts(data))
            })
            .await
    }

    pub async fn set_active_account(&self, id: &str) -> Result<AccountsState, String> {
        self.store
            .update(|data| {
                if let Some(prev_id) = data.active_account_id.clone() {
                    if let Some(prev) = data.accounts.iter_mut().find(|a| a.id == prev_id) {
                        if prev.kind == "microsoft" || prev.kind == "ely" {
                            prev.active_skin_id =
                                data.settings.active_skin_id.clone().or(prev.active_skin_id.clone());
                        }
                    }
                }
                let target = data
                    .accounts
                    .iter()
                    .find(|a| a.id == id)
                    .ok_or_else(|| tr("Account not found", "Аккаунт не найден").to_string())?;
                let skin = if target.kind == "microsoft" || target.kind == "ely" {
                    target.active_skin_id.clone()
                } else {
                    None
                };
                data.active_account_id = Some(target.id.clone());
                data.settings.active_skin_id = skin;
                Ok(public_accounts(data))
            })
            .await
    }

    pub async fn remove_account(&self, id: &str) -> Result<AccountsState, String> {
        self.store
            .update(|data| {
                if let Some(prev_id) = data.active_account_id.clone() {
                    if prev_id != id {
                        if let Some(prev) = data.accounts.iter_mut().find(|a| a.id == prev_id) {
                            if prev.kind == "microsoft" || prev.kind == "ely" {
                                prev.active_skin_id = data
                                    .settings
                                    .active_skin_id
                                    .clone()
                                    .or(prev.active_skin_id.clone());
                            }
                        }
                    }
                }
                data.accounts.retain(|a| a.id != id);
                if data.active_account_id.as_deref() == Some(id) {
                    data.active_account_id = data.accounts.first().map(|a| a.id.clone());
                }
                let active_skin = data
                    .accounts
                    .iter()
                    .find(|a| Some(&a.id) == data.active_account_id.as_ref())
                    .and_then(|a| {
                        if a.kind == "microsoft" || a.kind == "ely" {
                            a.active_skin_id.clone()
                        } else {
                            None
                        }
                    });
                data.settings.active_skin_id = active_skin;
                Ok(public_accounts(data))
            })
            .await
    }
}
