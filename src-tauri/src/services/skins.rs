use crate::i18n::{tr, tr_string};
use crate::paths::get_skins_dir;
use crate::services::auth::AuthService;
use crate::store::JsonStore;
use crate::types::{
    AccountState, CapeInfo, ElySkinResult, SkinActivateResult, SkinAddPayload, SkinInfo, SkinMeta,
    SkinRemoveResult, SkinUpdatePayload,
};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use chrono::Utc;
use reqwest::multipart::{Form, Part};
use reqwest::Client;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use uuid::Uuid;

fn parse_png_dims(buf: &[u8]) -> Option<(u32, u32)> {
    if buf.len() < 33 {
        return None;
    }
    let sig = [137u8, 80, 78, 71, 13, 10, 26, 10];
    if buf[..8] != sig || &buf[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes([buf[16], buf[17], buf[18], buf[19]]);
    let h = u32::from_be_bytes([buf[20], buf[21], buf[22], buf[23]]);
    Some((w, h))
}

fn to_png_bytes(data_url: &str) -> Result<Vec<u8>, String> {
    let trimmed = data_url.trim();
    let b64 = trimmed
        .strip_prefix("data:image/png;base64,")
        .ok_or_else(|| tr("Skin must be a PNG file", "Скин должен быть файлом PNG").to_string())?;
    STANDARD.decode(b64).map_err(|e| e.to_string())
}

fn can_edit_skins(acc: Option<&AccountState>) -> bool {
    acc.map(|a| (a.kind == "microsoft" || a.kind == "ely") && a.status == "signed-in")
        .unwrap_or(false)
}

pub struct SkinService {
    client: Client,
    store: Arc<JsonStore>,
    auth: Arc<AuthService>,
    remote_cache: Mutex<HashMap<String, (Option<ElySkinResult>, Instant)>>,
}

impl SkinService {
    pub fn new(store: Arc<JsonStore>, auth: Arc<AuthService>) -> Self {
        let client = Client::builder()
            .user_agent("lynapp/2.0.0-beta.3")
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| Client::new());
        Self {
            client,
            store,
            auth,
            remote_cache: Mutex::new(HashMap::new()),
        }
    }

    async fn active_account(&self) -> Option<AccountState> {
        let data = self.store.get_data().await;
        data.accounts
            .iter()
            .find(|a| Some(&a.id) == data.active_account_id.as_ref())
            .or_else(|| data.accounts.first())
            .cloned()
    }

    async fn require_skin_account(&self) -> Result<AccountState, String> {
        let acc = self.active_account().await;
        if !can_edit_skins(acc.as_ref()) {
            return Err(tr(
                "Sign in with Microsoft or Ely.by to change skins",
                "Войдите через Microsoft или Ely.by, чтобы изменять скины",
            )
            .to_string());
        }
        Ok(acc.unwrap())
    }

    pub async fn list(&self) -> Result<Vec<SkinInfo>, String> {
        let data = self.store.get_data().await;
        let active = data
            .accounts
            .iter()
            .find(|a| Some(&a.id) == data.active_account_id.as_ref())
            .or_else(|| data.accounts.first());
        let Some(active) = active.filter(|a| can_edit_skins(Some(a))) else {
            return Ok(Vec::new());
        };
        let dir = get_skins_dir();
        let _ = fs::create_dir_all(&dir);
        let mut out = Vec::new();
        for meta in &data.skins {
            if let Some(owner) = &meta.account_id {
                if owner != &active.id {
                    continue;
                }
            }
            if let Ok(bytes) = fs::read(dir.join(format!("{}.png", meta.id))) {
                out.push(SkinInfo {
                    id: meta.id.clone(),
                    name: meta.name.clone(),
                    slim: meta.slim,
                    added_at: meta.added_at.clone(),
                    account_id: meta.account_id.clone(),
                    data_url: format!("data:image/png;base64,{}", STANDARD.encode(bytes)),
                });
            }
        }
        Ok(out)
    }

    pub async fn add(&self, payload: SkinAddPayload) -> Result<Vec<SkinInfo>, String> {
        let active = self.require_skin_account().await?;
        let png = to_png_bytes(&payload.data_url)?;
        let Some((w, h)) = parse_png_dims(&png) else {
            return Err(tr(
                "Skin must be a 64x64 (or 64x32) PNG texture",
                "Скин должен быть текстурой PNG 64×64 (или 64×32)",
            )
            .to_string());
        };
        if w != 64 || (h != 64 && h != 32) {
            return Err(tr(
                "Skin must be a 64x64 (or 64x32) PNG texture",
                "Скин должен быть текстурой PNG 64×64 (или 64×32)",
            )
            .to_string());
        }
        let name: String = payload.name.trim().chars().take(32).collect();
        let final_name = if name.is_empty() {
            "Custom skin".to_string()
        } else {
            name
        };
        let id = Uuid::new_v4().to_string();
        let dir = get_skins_dir();
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        fs::write(dir.join(format!("{id}.png")), &png).map_err(|e| e.to_string())?;
        let owner_id = payload
            .account_id
            .filter(|s| !s.is_empty())
            .map(|_| active.id.clone());

        self.store
            .update(|d| {
                d.skins.insert(
                    0,
                    SkinMeta {
                        id,
                        name: final_name,
                        slim: payload.slim,
                        added_at: Utc::now().to_rfc3339(),
                        account_id: owner_id,
                    },
                );
                Ok(())
            })
            .await?;
        self.list().await
    }

    pub async fn update(&self, payload: SkinUpdatePayload) -> Result<Vec<SkinInfo>, String> {
        let active = self.require_skin_account().await?;
        self.store
            .update(|d| {
                let skin = d
                    .skins
                    .iter_mut()
                    .find(|s| s.id == payload.id)
                    .ok_or_else(|| tr("Skin not found", "Скин не найден").to_string())?;
                if let Some(owner) = &skin.account_id {
                    if owner != &active.id {
                        return Err(tr("Skin not found", "Скин не найден").to_string());
                    }
                }
                if let Some(name) = payload.patch.name {
                    let trimmed: String = name.trim().chars().take(32).collect();
                    if !trimmed.is_empty() {
                        skin.name = trimmed;
                    }
                }
                if let Some(slim) = payload.patch.slim {
                    skin.slim = slim;
                }
                if let Some(owner_opt) = payload.patch.account_id {
                    let new_owner = owner_opt.filter(|s| !s.is_empty()).map(|_| active.id.clone());
                    skin.account_id = new_owner.clone();
                    if new_owner.is_some() {
                        for acc in &mut d.accounts {
                            if acc.id != active.id && acc.active_skin_id.as_deref() == Some(&payload.id) {
                                acc.active_skin_id = None;
                            }
                        }
                    }
                }
                Ok(())
            })
            .await?;
        self.list().await
    }

    pub async fn remove(&self, id: &str) -> Result<SkinRemoveResult, String> {
        let active = self.require_skin_account().await?;
        if id.contains('/') || id.contains('\\') || id.contains("..") {
            return Err(tr("Skin not found", "Скин не найден").to_string());
        }
        let _ = fs::remove_file(get_skins_dir().join(format!("{id}.png")));
        let id_owned = id.to_string();
        let active_skin_id = self
            .store
            .update(|d| {
                d.skins.retain(|s| s.id != id_owned);
                if d.settings.active_skin_id.as_deref() == Some(id_owned.as_str()) {
                    d.settings.active_skin_id = None;
                }
                for acc in &mut d.accounts {
                    if acc.active_skin_id.as_deref() == Some(id_owned.as_str()) {
                        acc.active_skin_id = None;
                    }
                }
                Ok(d.accounts
                    .iter()
                    .find(|a| a.id == active.id)
                    .and_then(|a| a.active_skin_id.clone()))
            })
            .await?;
        Ok(SkinRemoveResult {
            skins: self.list().await?,
            active_skin_id,
        })
    }

    async fn upload_mojang_skin(&self, png: Vec<u8>, slim: bool, token: &str) -> Result<u16, String> {
        let part = Part::bytes(png)
            .file_name("skin.png")
            .mime_str("image/png")
            .map_err(|e| e.to_string())?;
        let form = Form::new()
            .text("variant", if slim { "slim" } else { "classic" })
            .part("file", part);
        let resp = self
            .client
            .post("https://api.minecraftservices.com/minecraft/profile/skins")
            .bearer_auth(token)
            .multipart(form)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        if status < 300 {
            return Ok(status);
        }
        let detail = resp
            .json::<Value>()
            .await
            .ok()
            .and_then(|v| v.get("errorMessage").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_default();
        Err(tr_string(
            format!("Mojang rejected the skin (HTTP {status}){}", if detail.is_empty() { String::new() } else { format!(": {detail}") }),
            format!("Mojang отклонил скин (HTTP {status}){}", if detail.is_empty() { String::new() } else { format!(": {detail}") }),
        ))
    }

    pub async fn activate(&self, id: &str) -> Result<SkinActivateResult, String> {
        let active = self.require_skin_account().await?;
        if active.kind == "microsoft" {
            let _ = self.auth.ensure_fresh_session(false).await;
        }
        let data = self.store.get_data().await;
        let meta = data
            .skins
            .iter()
            .find(|s| s.id == id && s.account_id.as_deref().map(|o| o == active.id).unwrap_or(true))
            .cloned()
            .ok_or_else(|| tr("Skin not found", "Скин не найден").to_string())?;
        let fresh = self
            .active_account()
            .await
            .filter(|a| a.id == active.id)
            .ok_or_else(|| {
                tr(
                    "Active account changed while applying skin",
                    "Активный аккаунт изменился во время применения скина",
                )
                .to_string()
            })?;

        let png = fs::read(get_skins_dir().join(format!("{id}.png"))).map_err(|e| e.to_string())?;
        let uploaded = if fresh.kind == "microsoft" {
            let token = fresh.minecraft_access_token.clone().ok_or_else(|| {
                tr(
                    "Microsoft session expired. Sign in again to change skins.",
                    "Сессия Microsoft истекла. Войдите снова, чтобы менять скины.",
                )
                .to_string()
            })?;
            match self.upload_mojang_skin(png.clone(), meta.slim, &token).await {
                Ok(_) => true,
                Err(err) if err.contains("HTTP 401") => {
                    let retried = self
                        .auth
                        .ensure_fresh_session(true)
                        .await
                        .and_then(|a| a.minecraft_access_token)
                        .ok_or(err)?;
                    self.upload_mojang_skin(png, meta.slim, &retried).await?;
                    true
                }
                Err(err) => return Err(err),
            }
        } else {
            return Err(tr(
                "Direct PNG upload to Ely.by requires Ely.by website sign-in (open skins.ely.by)",
                "Загрузка скина в Ely.by выполняется через сайт Ely.by (откройте ely.by/skins)",
            )
            .to_string());
        };

        let id_owned = id.to_string();
        let active_id = active.id.clone();
        self.store
            .update(|d| {
                if let Some(acc) = d.accounts.iter_mut().find(|a| a.id == active_id) {
                    acc.active_skin_id = Some(id_owned.clone());
                }
                d.settings.active_skin_id = Some(id_owned.clone());
                Ok(())
            })
            .await?;
        self.remote_cache
            .lock()
            .await
            .retain(|k, _| !k.starts_with(&format!("{}:", active.id)));

        Ok(SkinActivateResult {
            active_skin_id: id.to_string(),
            uploaded,
        })
    }

    async fn download_remote_skin(&self, url: &str, slim: bool) -> Option<ElySkinResult> {
        let resp = self.client.get(url).send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let bytes = resp.bytes().await.ok()?;
        let (w, h) = parse_png_dims(&bytes)?;
        if w != 64 || (h != 64 && h != 32) {
            return None;
        }
        Some(ElySkinResult {
            data_url: format!("data:image/png;base64,{}", STANDARD.encode(&bytes)),
            slim,
        })
    }

    async fn fetch_ely_remote(&self, profile_name: &str) -> Option<ElySkinResult> {
        let url = format!(
            "https://skinsystem.ely.by/textures/{}?version=2&_={}",
            urlencoding_simple(profile_name),
            Utc::now().timestamp_millis()
        );
        let resp = self.client.get(url).send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let body: Value = resp.json().await.ok()?;
        let tex_url = body.pointer("/SKIN/url").and_then(Value::as_str)?;
        let slim = body
            .pointer("/SKIN/metadata/model")
            .and_then(Value::as_str)
            == Some("slim");
        self.download_remote_skin(tex_url, slim).await
    }

    async fn fetch_mojang_remote(&self, acc: &AccountState) -> Option<ElySkinResult> {
        if let Some(uuid) = &acc.minecraft_uuid {
            let url = format!(
                "https://sessionserver.mojang.com/session/minecraft/profile/{}",
                urlencoding_simple(uuid)
            );
            if let Ok(resp) = self.client.get(url).send().await {
                if resp.status().is_success() {
                    if let Ok(body) = resp.json::<Value>().await {
                        if let Some(val_b64) = body
                            .get("properties")
                            .and_then(Value::as_array)
                            .and_then(|arr| {
                                arr.iter().find_map(|p| {
                                    if p.get("name").and_then(Value::as_str) == Some("textures") {
                                        p.get("value").and_then(Value::as_str)
                                    } else {
                                        None
                                    }
                                })
                            })
                        {
                            if let Ok(decoded) = STANDARD.decode(val_b64) {
                                if let Ok(tex_json) = serde_json::from_slice::<Value>(&decoded) {
                                    if let Some(tex_url) =
                                        tex_json.pointer("/textures/SKIN/url").and_then(Value::as_str)
                                    {
                                        let slim = tex_json
                                            .pointer("/textures/SKIN/metadata/model")
                                            .and_then(Value::as_str)
                                            == Some("slim");
                                        return self.download_remote_skin(tex_url, slim).await;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        None
    }

    pub async fn ely_skin(&self) -> Option<ElySkinResult> {
        let active = self.active_account().await?;
        if active.kind != "ely" || active.status != "signed-in" {
            return None;
        }
        let name = active.profile_name?;
        self.fetch_ely_remote(&name).await
    }

    pub async fn account_skin(&self) -> Option<ElySkinResult> {
        let data = self.store.get_data().await;
        let active = data
            .accounts
            .iter()
            .find(|a| Some(&a.id) == data.active_account_id.as_ref())
            .or_else(|| data.accounts.first())
            .cloned()?;
        if !can_edit_skins(Some(&active)) {
            return None;
        }
        if let Some(skin_id) = &active.active_skin_id {
            if let Some(meta) = data.skins.iter().find(|s| {
                &s.id == skin_id && s.account_id.as_deref().map(|o| o == active.id).unwrap_or(true)
            }) {
                if let Ok(bytes) = fs::read(get_skins_dir().join(format!("{}.png", meta.id))) {
                    if let Some((64, 64 | 32)) = parse_png_dims(&bytes) {
                        return Some(ElySkinResult {
                            data_url: format!("data:image/png;base64,{}", STANDARD.encode(bytes)),
                            slim: meta.slim,
                        });
                    }
                }
            }
        }
        let cache_key = format!(
            "{}:{}:{}:{}",
            active.id,
            active.kind,
            active.minecraft_uuid.as_deref().unwrap_or(""),
            active.profile_name.as_deref().unwrap_or("")
        );
        if let Some((val, at)) = self.remote_cache.lock().await.get(&cache_key) {
            if at.elapsed() < Duration::from_secs(300) {
                return val.clone();
            }
        }
        let remote = if active.kind == "ely" {
            match active.profile_name.as_deref() {
                Some(n) => self.fetch_ely_remote(n).await,
                None => None,
            }
        } else {
            self.fetch_mojang_remote(&active).await
        };
        if remote.is_some() {
            self.remote_cache
                .lock()
                .await
                .insert(cache_key, (remote.clone(), Instant::now()));
        }
        remote
    }

    async fn mojang_token(&self) -> Result<String, String> {
        let _ = self.auth.ensure_fresh_session(false).await;
        let active = self.active_account().await;
        let Some(acc) = active.filter(|a| a.kind == "microsoft" && a.status == "signed-in") else {
            return Err(tr(
                "Sign in with Microsoft to manage capes",
                "Войдите через Microsoft, чтобы управлять плащами",
            )
            .to_string());
        };
        acc.minecraft_access_token.ok_or_else(|| {
            tr(
                "Sign in with Microsoft to manage capes",
                "Войдите через Microsoft, чтобы управлять плащами",
            )
            .to_string()
        })
    }

    pub async fn list_capes(&self) -> Result<Vec<CapeInfo>, String> {
        let token = self.mojang_token().await?;
        let resp = self
            .client
            .get("https://api.minecraftservices.com/minecraft/profile")
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("Mojang profile HTTP {}", resp.status().as_u16()));
        }
        let body: Value = resp.json().await.map_err(|e| e.to_string())?;
        Ok(parse_capes(&body))
    }

    pub async fn equip_cape(&self, cape_id: Option<String>) -> Result<Vec<CapeInfo>, String> {
        let token = self.mojang_token().await?;
        let req = match cape_id {
            Some(cid) => self
                .client
                .put("https://api.minecraftservices.com/minecraft/profile/capes/active")
                .bearer_auth(&token)
                .json(&json!({ "capeId": cid })),
            None => self
                .client
                .delete("https://api.minecraftservices.com/minecraft/profile/capes/active")
                .bearer_auth(&token),
        };
        let resp = req.send().await.map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        if status == 429 {
            return Err(tr(
                "Too many requests to Mojang. Wait a few seconds and try again (HTTP 429).",
                "Слишком много запросов к Mojang. Подождите несколько секунд и попробуйте снова (HTTP 429).",
            )
            .to_string());
        }
        if status >= 300 {
            return Err(format!("Mojang cape HTTP {status}"));
        }
        if let Ok(body) = resp.json::<Value>().await {
            if body.get("capes").is_some() {
                return Ok(parse_capes(&body));
            }
        }
        self.list_capes().await
    }
}

fn parse_capes(body: &Value) -> Vec<CapeInfo> {
    body.get("capes")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|c| {
                    Some(CapeInfo {
                        id: c.get("id")?.as_str()?.to_string(),
                        alias: c.get("alias").and_then(Value::as_str).unwrap_or("").to_string(),
                        url: c.get("url")?.as_str()?.to_string(),
                        active: c.get("state").and_then(Value::as_str) == Some("ACTIVE"),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn urlencoding_simple(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}
