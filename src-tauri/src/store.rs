use crate::crypto::{can_encrypt, decrypt_secret, encrypt_secret, SECRET_PREFIX};
use crate::i18n::{set_main_language, tr};
use crate::paths::{
    get_instances_root, get_launcher_root, get_store_path, reconcile_instance_directories,
};
use crate::types::{
    default_theme_map, AccountState, AccountsState, EffectsSettings, LauncherData,
    LauncherSettings, VersionTypeFilter,
};
use chrono::Utc;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use sysinfo::System;
use tokio::sync::Mutex;

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn get_system_memory_mb() -> u32 {
    let mut sys = System::new();
    sys.refresh_memory();
    let total_mb = (sys.total_memory() / (1024 * 1024)) as u32;
    total_mb.max(1024)
}

pub fn get_max_allocatable_memory_mb() -> u32 {
    ((get_system_memory_mb() / 256) * 256).max(1024)
}

pub fn default_settings(app_version: &str) -> LauncherSettings {
    LauncherSettings {
        java_path: String::new(),
        java_paths: HashMap::new(),
        max_memory_mb: 4096.min(get_max_allocatable_memory_mb()),
        extra_jvm_args: String::new(),
        launcher_data_dir: get_launcher_root().to_string_lossy().to_string(),
        concurrent_downloads: 8,
        after_launch: "keep".to_string(),
        discord_presence: true,
        discord_hide_instance: false,
        beta_updates: app_version.contains('-'),
        update_edition: None,
        auto_install_dependencies: false,
        version_types: VersionTypeFilter::default(),
        home_layout: None,
        nav_layout: None,
        page_layouts: None,
        microsoft_client_id: String::new(),
        language: "en".to_string(),
        theme: default_theme_map(),
        glow_enabled: true,
        glow_size: 100,
        glow_speed: 100,
        animations_enabled: true,
        animation_speed: 100,
        effects: EffectsSettings::default(),
        active_skin_id: None,
        font_family: String::new(),
    }
}

pub fn default_data(app_version: &str) -> LauncherData {
    LauncherData {
        settings: default_settings(app_version),
        instances: Vec::new(),
        active_instance_id: None,
        accounts: Vec::new(),
        active_account_id: None,
        running_processes: HashMap::new(),
        skins: Vec::new(),
        updated_at: Utc::now().to_rfc3339(),
    }
}

pub fn public_accounts(data: &LauncherData) -> AccountsState {
    AccountsState {
        accounts: data.accounts.iter().map(AccountState::sanitized).collect(),
        active_account_id: data.active_account_id.clone(),
    }
}

fn secret_fields_mut(acc: &mut AccountState) -> [(&'static str, &mut Option<String>); 6] {
    [
        ("minecraftAccessToken", &mut acc.minecraft_access_token),
        ("microsoftRefreshToken", &mut acc.microsoft_refresh_token),
        ("elyAccessToken", &mut acc.ely_access_token),
        ("elyClientToken", &mut acc.ely_client_token),
        ("elyRefreshToken", &mut acc.ely_refresh_token),
        ("xboxUhs", &mut acc.xbox_uhs),
    ]
}

fn encrypt_account(
    acc: &AccountState,
    locked: Option<&mut HashMap<String, String>>,
) -> AccountState {
    let encrypt_ok = can_encrypt();
    let mut copy = acc.clone();
    let mut locked_ref = locked;
    for (name, slot) in secret_fields_mut(&mut copy) {
        if let Some(val) = slot.as_ref() {
            if !val.is_empty() {
                if let Some(map) = locked_ref.as_deref_mut() {
                    map.remove(name);
                }
                if encrypt_ok && !val.starts_with(SECRET_PREFIX) {
                    if let Ok(enc) = encrypt_secret(val) {
                        *slot = Some(enc);
                    }
                }
                continue;
            }
        }
        if let Some(map) = locked_ref.as_deref() {
            if let Some(saved) = map.get(name) {
                *slot = Some(saved.clone());
            }
        }
    }
    copy
}

fn decrypt_accounts(
    accounts: &mut [AccountState],
    locked_secrets: &mut HashMap<String, HashMap<String, String>>,
) -> bool {
    let encrypt_ok = can_encrypt();
    let mut needs_rewrite = false;
    for acc in accounts.iter_mut() {
        let mut unreadable = false;
        let mut locked_count = 0usize;
        let acc_id = acc.id.clone();
        for (name, slot) in secret_fields_mut(acc) {
            let val = match slot.as_ref() {
                Some(v) if !v.is_empty() => v.clone(),
                _ => continue,
            };
            if val.starts_with(SECRET_PREFIX) {
                if !encrypt_ok {
                    locked_secrets
                        .entry(acc_id.clone())
                        .or_default()
                        .insert(name.to_string(), val);
                    *slot = None;
                    locked_count += 1;
                    continue;
                }
                match decrypt_secret(&val) {
                    Ok((plain, was_electron)) => {
                        *slot = Some(plain);
                        if was_electron {
                            needs_rewrite = true;
                        }
                    }
                    Err(_) => {
                        *slot = None;
                        unreadable = true;
                        needs_rewrite = true;
                    }
                }
            } else if encrypt_ok {
                needs_rewrite = true;
            }
        }
        if locked_count > 0 && acc.status == "signed-in" {
            acc.message = Some(
                tr(
                    "Keyring unavailable — unlock system keyring or sign in again",
                    "Хранилище ключей недоступно — разблокируйте системную связку ключей или войдите снова",
                )
                .to_string(),
            );
        }
        if unreadable && acc.status == "signed-in" {
            acc.status = "signed-out".to_string();
            acc.message = Some(
                tr(
                    "Sign in again (device changed)",
                    "Войдите снова (сменилось устройство или система)",
                )
                .to_string(),
            );
        }
    }
    needs_rewrite
}

fn sanitize_legacy_json(mut value: serde_json::Value) -> serde_json::Value {
    if let Some(root) = value.as_object_mut() {
        if let Some(settings) = root.get_mut("settings").and_then(|v| v.as_object_mut()) {
            if !settings.contains_key("effects") {
                if let Some(juice) = settings.remove("juice") {
                    settings.insert("effects".to_string(), juice);
                }
            } else {
                settings.remove("juice");
            }
            if !settings.contains_key("afterLaunch") {
                if settings
                    .get("closeOnLaunch")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                {
                    settings.insert(
                        "afterLaunch".to_string(),
                        serde_json::Value::String("close".to_string()),
                    );
                }
            }
            settings.remove("closeOnLaunch");
            settings.remove("minMemoryMb");
            let nullable_keys = ["homeLayout", "navLayout", "pageLayouts", "activeSkinId"];
            let null_drop: Vec<String> = settings
                .iter()
                .filter(|(k, v)| v.is_null() && !nullable_keys.contains(&k.as_str()))
                .map(|(k, _)| k.clone())
                .collect();
            for k in null_drop {
                settings.remove(&k);
            }
        }
        let has_accounts = root
            .get("accounts")
            .and_then(|v| v.as_array())
            .map(|a| !a.is_empty())
            .unwrap_or(false);
        if !has_accounts {
            if let Some(mut legacy) = root.remove("account") {
                if let Some(obj) = legacy.as_object_mut() {
                    let has_identity = obj.get("profileName").and_then(|v| v.as_str()).is_some()
                        || obj.get("minecraftAccessToken").and_then(|v| v.as_str()).is_some()
                        || obj.get("minecraftUuid").and_then(|v| v.as_str()).is_some();
                    if has_identity {
                        let id = obj
                            .get("minecraftUuid")
                            .and_then(|v| v.as_str())
                            .or_else(|| obj.get("profileName").and_then(|v| v.as_str()))
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| format!("legacy-{}", Utc::now().timestamp_millis()));
                        let status = obj
                            .get("status")
                            .and_then(|v| v.as_str())
                            .unwrap_or("signed-out")
                            .to_string();
                        let kind = if status == "offline" { "offline" } else { "microsoft" };
                        let norm_status = if status == "pending" { "signed-out" } else { &status };
                        obj.insert("id".to_string(), serde_json::Value::String(id.clone()));
                        obj.insert("kind".to_string(), serde_json::Value::String(kind.to_string()));
                        obj.insert(
                            "status".to_string(),
                            serde_json::Value::String(norm_status.to_string()),
                        );
                        root.insert("accounts".to_string(), serde_json::Value::Array(vec![legacy]));
                        root.insert(
                            "activeAccountId".to_string(),
                            serde_json::Value::String(id),
                        );
                    }
                }
            }
        }
        if let Some(rp) = root.get("runningProcesses") {
            if rp.is_null() {
                root.remove("runningProcesses");
            }
        }
    }
    value
}

fn normalize_data(mut data: LauncherData, app_version: &str) -> LauncherData {
    let defaults = default_settings(app_version);
    for (k, v) in defaults.theme {
        data.settings.theme.entry(k).or_insert(v);
    }
    if data.settings.launcher_data_dir.is_empty()
        || data.settings.launcher_data_dir.ends_with("lynapp-remaster")
    {
        data.settings.launcher_data_dir = defaults.launcher_data_dir;
    }
    if !matches!(data.settings.after_launch.as_str(), "keep" | "hide" | "close") {
        data.settings.after_launch = "keep".to_string();
    }
    if data.settings.language != "ru" && data.settings.language != "en" {
        data.settings.language = "en".to_string();
    }
    for inst in &mut data.instances {
        inst.java_path = None;
    }
    if let Some(ref active_id) = data.active_account_id {
        if !data.accounts.iter().any(|a| &a.id == active_id) {
            data.active_account_id = data.accounts.first().map(|a| a.id.clone());
        }
    } else if !data.accounts.is_empty() {
        data.active_account_id = data.accounts.first().map(|a| a.id.clone());
    }
    data.running_processes.clear();
    data
}

struct StoreInner {
    data: LauncherData,
    locked_secrets: HashMap<String, HashMap<String, String>>,
}

pub struct JsonStore {
    file_path: PathBuf,
    inner: Mutex<StoreInner>,
}

impl JsonStore {
    pub fn load_sync(app_version: &str) -> Result<Self, String> {
        let file_path = get_store_path();
        if let Some(parent) = file_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::create_dir_all(get_instances_root()).map_err(|e| e.to_string())?;

        let mut locked_secrets = HashMap::new();
        let (mut data, mut should_save) = if !file_path.exists() {
            (default_data(app_version), true)
        } else {
            let raw = fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
            let parsed_res = serde_json::from_str::<serde_json::Value>(&raw)
                .map(sanitize_legacy_json)
                .and_then(serde_json::from_value::<LauncherData>);
            match parsed_res {
                Ok(parsed) => (normalize_data(parsed, app_version), false),
                Err(_) => {
                    let backup = format!(
                        "{}.corrupt-{}",
                        file_path.to_string_lossy(),
                        Utc::now().timestamp_millis()
                    );
                    let _ = fs::rename(&file_path, backup);
                    (default_data(app_version), true)
                }
            }
        };

        set_main_language(&data.settings.language);
        if decrypt_accounts(&mut data.accounts, &mut locked_secrets) {
            should_save = true;
        }
        if reconcile_instance_directories(&mut data.instances) {
            should_save = true;
        }

        if should_save {
            let snapshot = serialize_snapshot(&data, &mut locked_secrets)?;
            save_snapshot_sync(&file_path, &snapshot)?;
        }

        Ok(Self {
            file_path,
            inner: Mutex::new(StoreInner {
                data,
                locked_secrets,
            }),
        })
    }

    pub async fn get_data(&self) -> LauncherData {
        self.inner.lock().await.data.clone()
    }

    pub async fn reconcile_instances(&self) -> bool {
        let mut guard = self.inner.lock().await;
        if !reconcile_instance_directories(&mut guard.data.instances) {
            return false;
        }
        guard.data.updated_at = Utc::now().to_rfc3339();
        let inner = &mut *guard;
        let snapshot = match serialize_snapshot(&inner.data, &mut inner.locked_secrets) {
            Ok(s) => s,
            Err(_) => return true,
        };
        let path = self.file_path.clone();
        let _ = tokio::task::spawn_blocking(move || save_snapshot_sync(&path, &snapshot)).await;
        true
    }

    pub async fn update<F, R>(&self, mutator: F) -> Result<R, String>
    where
        F: FnOnce(&mut LauncherData) -> Result<R, String>,
    {
        let mut guard = self.inner.lock().await;
        let backup = guard.data.clone();
        let result = match mutator(&mut guard.data) {
            Ok(v) => v,
            Err(err) => {
                guard.data = backup;
                return Err(err);
            }
        };
        guard.data.updated_at = Utc::now().to_rfc3339();
        let StoreInner {
            ref data,
            ref mut locked_secrets,
        } = *guard;
        let snapshot = match serialize_snapshot(data, locked_secrets) {
            Ok(s) => s,
            Err(err) => {
                guard.data = backup;
                return Err(err);
            }
        };
        let path = self.file_path.clone();
        if let Err(err) = save_snapshot_async(path, snapshot).await {
            guard.data = backup;
            return Err(err);
        }
        Ok(result)
    }
}

fn serialize_snapshot(
    data: &LauncherData,
    locked_secrets: &mut HashMap<String, HashMap<String, String>>,
) -> Result<String, String> {
    let active_ids: Vec<&str> = data.accounts.iter().map(|a| a.id.as_str()).collect();
    locked_secrets.retain(|k, _| active_ids.contains(&k.as_str()));

    let mut to_save = data.clone();
    to_save.accounts = data
        .accounts
        .iter()
        .map(|acc| encrypt_account(acc, locked_secrets.get_mut(&acc.id)))
        .collect();
    serde_json::to_string_pretty(&to_save).map_err(|e| e.to_string())
}

fn save_snapshot_sync(file_path: &PathBuf, snapshot: &str) -> Result<(), String> {
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let counter = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = PathBuf::from(format!(
        "{}.{}.{}.tmp",
        file_path.to_string_lossy(),
        std::process::id(),
        counter
    ));
    let res = (|| -> Result<(), String> {
        fs::write(&tmp, snapshot.as_bytes()).map_err(|e| e.to_string())?;
        for attempt in 0..8 {
            match fs::rename(&tmp, file_path) {
                Ok(_) => return Ok(()),
                Err(e) if attempt < 7 => {
                    let _ = e;
                    std::thread::sleep(Duration::from_millis(60 * (attempt + 1)));
                }
                Err(e) => return Err(e.to_string()),
            }
        }
        Ok(())
    })();
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    res
}

async fn save_snapshot_async(file_path: PathBuf, snapshot: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || save_snapshot_sync(&file_path, &snapshot))
        .await
        .map_err(|e| e.to_string())?
}
