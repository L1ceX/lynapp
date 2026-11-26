use crate::i18n::{tr, tr_string};
use crate::paths::{
    get_instances_root, get_minecraft_root, is_inside_instances_root, pick_instance_directory,
    remove_instance_link,
};
use crate::services::auth::AuthService;
use crate::services::discord::DiscordPresence;
use crate::services::java::JavaService;
use crate::services::minecraft::{LaunchProgress, MinecraftService};
use crate::store::{get_max_allocatable_memory_mb, JsonStore};
use crate::tray;
use crate::types::{
    CrashReportInfo, CreateInstancePayload, InstanceLogsResult, LaunchResult, LauncherInstance,
    QuickPlayTarget, UpdateInstancePayload,
};
use chrono::{DateTime, Utc};
use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

static COPY_SUFFIX_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)(?:\s*\((?:copy|копия)(?:\s+\d+)?\))+$").unwrap());
static CRASH_DESC_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?im)^Description:\s*(.+)$").unwrap());
static CRASH_EXC_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?im)^([a-zA-Z0-9_.$]+(?:Exception|Error)(?::\s*(.+))?)$").unwrap()
});
static CRASH_MIXIN_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)Callback method \S+ in \S+?:(\S+) from mod (\S+) failed injection").unwrap()
});

pub fn sanitize_name(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || (c as u32) < 0x20
            {
                '-'
            } else {
                c
            }
        })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed: String = collapsed.chars().take(64).collect();
    if trimmed.is_empty() {
        "Instance".to_string()
    } else {
        trimmed
    }
}

pub fn parse_jvm_flags(input: Option<&str>) -> Vec<String> {
    let Some(raw) = input.map(str::trim).filter(|s| !s.is_empty()) else {
        return Vec::new();
    };
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut has_token = false;
    for ch in raw.chars() {
        if ch == '"' {
            in_quotes = !in_quotes;
            has_token = true;
            continue;
        }
        if !in_quotes && ch.is_whitespace() {
            if has_token && !current.is_empty() {
                args.push(std::mem::take(&mut current));
            }
            has_token = false;
            continue;
        }
        current.push(ch);
        has_token = true;
    }
    if has_token && !current.is_empty() {
        args.push(current);
    }
    args
}

fn redact_launch_args(args: &[String]) -> Vec<String> {
    let secrets = ["--accessToken", "--clientId", "--xuid", "--uuid", "--session"];
    args.iter()
        .enumerate()
        .map(|(i, arg)| {
            if i > 0 && secrets.contains(&args[i - 1].as_str()) {
                "<redacted>".to_string()
            } else {
                arg.clone()
            }
        })
        .collect()
}

fn write_instance_manifest(instance: &LauncherInstance) {
    let launcher_dir = Path::new(&instance.directory).join(".launcher");
    let _ = fs::create_dir_all(&launcher_dir);
    if let Ok(json) = serde_json::to_string_pretty(instance) {
        let _ = fs::write(launcher_dir.join("instance.json"), json);
    }
}

pub fn is_java_process_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let out = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .creation_flags(0x08000000)
            .output();
        let Ok(out) = out else {
            return false;
        };
        let stdout = String::from_utf8_lossy(&out.stdout);
        let first = stdout
            .split(',')
            .next()
            .unwrap_or("")
            .replace('"', "")
            .trim()
            .to_lowercase();
        first == "java.exe" || first == "javaw.exe"
    }
    #[cfg(not(windows))]
    {
        let comm_path = format!("/proc/{pid}/comm");
        if let Ok(comm) = fs::read_to_string(&comm_path) {
            return comm.trim().to_lowercase().contains("java");
        }
        false
    }
}

fn kill_process_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &format!("-{pid}")])
            .status();
        std::thread::sleep(std::time::Duration::from_millis(150));
        let _ = Command::new("kill")
            .args(["-KILL", &format!("-{pid}")])
            .status();
    }
}

fn copy_dir_filtered(src: &Path, dst: &Path, root: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        if name.eq_ignore_ascii_case("session.lock") {
            continue;
        }
        let rel = path.strip_prefix(root).unwrap_or(&path);
        let rel_norm = rel.to_string_lossy().replace('\\', "/").to_lowercase();
        if matches!(
            rel_norm.as_str(),
            "logs" | "crash-reports" | ".launcher/logs" | ".launcher/natives" | ".launcher/instance.json"
        ) {
            continue;
        }
        let target = dst.join(&file_name);
        let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            copy_dir_filtered(&path, &target, root)?;
        } else {
            fs::copy(&path, &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn read_tail(path: &Path, max_bytes: u64) -> (String, bool, u128) {
    let Ok(mut file) = File::open(path) else {
        return (String::new(), false, 0);
    };
    let Ok(meta) = file.metadata() else {
        return (String::new(), false, 0);
    };
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let size = meta.len();
    if size == 0 {
        return (String::new(), true, mtime);
    }
    let start = size.saturating_sub(max_bytes);
    let _ = file.seek(SeekFrom::Start(start));
    let mut buf = Vec::new();
    if file.read_to_end(&mut buf).is_err() {
        return (String::new(), false, 0);
    }
    let mut text = String::from_utf8_lossy(&buf).into_owned();
    if start > 0 {
        if let Some(pos) = text.find('\n') {
            text = text[pos + 1..].to_string();
        }
    }
    (text, true, mtime)
}

fn read_newest_crash(instance_dir: &Path, log_mtime_ms: u128) -> Option<CrashReportInfo> {
    let dir = instance_dir.join("crash-reports");
    let entries = fs::read_dir(&dir).ok()?;
    let mut files: Vec<(String, u128)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let lower = name.to_lowercase();
        if !lower.starts_with("crash-") || (!lower.ends_with(".txt") && !lower.ends_with(".log")) {
            continue;
        }
        let mtime = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0);
        files.push((name, mtime));
    }
    files.sort_by(|a, b| b.1.cmp(&a.1));
    let (newest_name, newest_mtime) = files.into_iter().next()?;
    if log_mtime_ms > 0 && newest_mtime + 60_000 < log_mtime_ms {
        return None;
    }
    let full = fs::read_to_string(dir.join(&newest_name)).ok()?;
    let head: String = full.chars().take(20_000).collect();
    let desc = CRASH_DESC_RE
        .captures(&head)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().to_string())
        .unwrap_or_default();
    let exc = CRASH_EXC_RE
        .captures(&head)
        .and_then(|c| c.get(0))
        .map(|m| m.as_str().trim().to_string());
    let mixin = CRASH_MIXIN_RE.captures(&head).map(|c| {
        (
            c.get(1).map(|m| m.as_str()).unwrap_or("").to_string(),
            c.get(2).map(|m| m.as_str()).unwrap_or("").to_string(),
        )
    });
    let sinytra = head.to_lowercase().contains("sinytra connector is present");
    let mut parts = Vec::new();
    if let Some((method, mod_id)) = &mixin {
        parts.push(format!("Mod '{mod_id}' mixin crash ({method})"));
        parts.push("Remove or update the mod, or drop Sinytra Connector test".to_string());
    } else {
        if !desc.is_empty() {
            parts.push(desc);
        }
        if let Some(e) = exc {
            parts.push(e);
        }
        if sinytra {
            parts.push("Sinytra Connector is present, verify it is not the cause".to_string());
        }
    }
    let description: String = parts
        .into_iter()
        .take(2)
        .collect::<Vec<_>>()
        .join(" / ")
        .chars()
        .take(220)
        .collect();
    Some(CrashReportInfo {
        file: newest_name,
        description: if description.is_empty() {
            "Crash report saved".to_string()
        } else {
            description
        },
        text: full.chars().take(120_000).collect(),
    })
}

pub struct InstanceService {
    store: Arc<JsonStore>,
    java: Arc<JavaService>,
    minecraft: Arc<MinecraftService>,
    auth: Arc<AuthService>,
    discord: Arc<DiscordPresence>,
    launch_cancels: Mutex<HashMap<String, CancellationToken>>,
    managed_pids: Arc<Mutex<HashSet<u32>>>,
}

impl InstanceService {
    pub fn new(
        store: Arc<JsonStore>,
        java: Arc<JavaService>,
        minecraft: Arc<MinecraftService>,
        auth: Arc<AuthService>,
        discord: Arc<DiscordPresence>,
    ) -> Self {
        Self {
            store,
            java,
            minecraft,
            auth,
            discord,
            launch_cancels: Mutex::new(HashMap::new()),
            managed_pids: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    pub async fn create(&self, payload: CreateInstancePayload) -> Result<LauncherInstance, String> {
        let game_version = if payload.game_version.trim().is_empty() {
            "1.21.1".to_string()
        } else {
            payload.game_version.trim().to_string()
        };
        let loader = if payload.loader.trim().is_empty() {
            "vanilla".to_string()
        } else {
            payload.loader.trim().to_lowercase()
        };
        self.minecraft.assert_version_exists(&game_version).await?;
        self.minecraft
            .assert_loader_compatible(&loader, &game_version)
            .await?;

        let now = Utc::now().to_rfc3339();
        let id = Uuid::new_v4().to_string();
        let raw_name = if payload.name.trim().is_empty() {
            format!("{loader} {game_version}")
        } else {
            payload.name.clone()
        };
        let existing = self.store.get_data().await;
        let name = sanitize_name(&raw_name);
        let reserved_dirs: Vec<String> = existing
            .instances
            .iter()
            .map(|i| i.directory.clone())
            .collect();
        let dir = pick_instance_directory(&name, None, &reserved_dirs);

        for sub in [
            "mods",
            "resourcepacks",
            "shaderpacks",
            "datapacks",
            "modpacks",
            "config",
            "saves",
            ".launcher/logs",
        ] {
            fs::create_dir_all(dir.join(sub)).map_err(|e| e.to_string())?;
        }

        let instance = LauncherInstance {
            id: id.clone(),
            name,
            game_version,
            loader: loader.clone(),
            loader_version: if loader == "vanilla" {
                None
            } else {
                payload
                    .loader_version
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty())
            },
            directory: dir.to_string_lossy().to_string(),
            icon: if loader == "vanilla" {
                "grass".to_string()
            } else {
                "anvil".to_string()
            },
            java_path: None,
            max_memory_mb: None,
            extra_jvm_args: None,
            created_at: now.clone(),
            updated_at: now,
            last_played_at: None,
            mods: Vec::new(),
        };
        write_instance_manifest(&instance);

        self.store
            .update(|data| {
                data.instances.insert(0, instance.clone());
                data.active_instance_id = Some(id.clone());
                Ok(instance)
            })
            .await
    }

    pub async fn update_instance(
        &self,
        payload: UpdateInstancePayload,
    ) -> Result<LauncherInstance, String> {
        if self.launch_cancels.lock().await.contains_key(&payload.id) {
            return Err(tr(
                "Instance is launching. Wait or cancel launch first.",
                "Инстанция сейчас запускается. Дождитесь или отмените запуск.",
            )
            .to_string());
        }
        self.store.reconcile_instances().await;
        let data = self.store.get_data().await;
        let current = data
            .instances
            .iter()
            .find(|i| i.id == payload.id)
            .cloned()
            .ok_or_else(|| tr("Instance not found", "Инстанция не найдена").to_string())?;
        let is_running = data
            .running_processes
            .get(&payload.id)
            .copied()
            .map(is_java_process_alive)
            .unwrap_or(false);

        let next_gv = payload
            .patch
            .game_version
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| current.game_version.clone());
        let next_loader = payload
            .patch
            .loader
            .clone()
            .unwrap_or_else(|| current.loader.clone());
        let gv_changed = next_gv != current.game_version;
        let loader_kind_changed = next_loader != current.loader;
        if gv_changed || loader_kind_changed {
            self.minecraft.assert_version_exists(&next_gv).await?;
            self.minecraft
                .assert_loader_compatible(&next_loader, &next_gv)
                .await?;
        }

        let next_name = payload.patch.name.as_deref().map(sanitize_name);
        let mut next_directory: Option<String> = None;
        if let Some(ref clean_name) = next_name {
            if clean_name != &current.name && !is_running {
                let old_path = PathBuf::from(&current.directory);
                if old_path.exists() && is_inside_instances_root(&old_path) {
                    let reserved_dirs: Vec<String> = data
                        .instances
                        .iter()
                        .filter(|i| i.id != payload.id)
                        .map(|i| i.directory.clone())
                        .collect();
                    let target = pick_instance_directory(clean_name, Some(&old_path), &reserved_dirs);
                    if target != old_path {
                        let case_only = target
                            .to_string_lossy()
                            .eq_ignore_ascii_case(&old_path.to_string_lossy());
                        let renamed = if case_only {
                            let tmp = old_path.with_file_name(format!(
                                ".renaming-{}",
                                Uuid::new_v4().simple()
                            ));
                            fs::rename(&old_path, &tmp).and_then(|_| {
                                fs::rename(&tmp, &target).or_else(|e| {
                                    let _ = fs::rename(&tmp, &old_path);
                                    Err(e)
                                })
                            })
                        } else {
                            fs::rename(&old_path, &target)
                        };
                        if renamed.is_ok() {
                            remove_instance_link(&current.id);
                            next_directory = Some(target.to_string_lossy().to_string());
                        }
                    }
                }
            }
        }

        let updated = self
            .store
            .update(|d| {
                let inst = d
                    .instances
                    .iter_mut()
                    .find(|i| i.id == payload.id)
                    .ok_or_else(|| tr("Instance not found", "Инстанция не найдена").to_string())?;
                if let Some(name) = next_name {
                    inst.name = name;
                }
                if let Some(dir) = next_directory {
                    inst.directory = dir;
                }
                inst.game_version = next_gv;
                inst.loader = next_loader;
                if inst.loader == "vanilla" {
                    inst.loader_version = None;
                } else if let Some(lv) = payload.patch.loader_version {
                    inst.loader_version = if lv.trim().is_empty() {
                        None
                    } else {
                        Some(lv.trim().to_string())
                    };
                } else if gv_changed || loader_kind_changed {
                    inst.loader_version = None;
                }
                if let Some(mem) = payload.patch.max_memory_mb {
                    inst.max_memory_mb = Some(mem);
                }
                if let Some(args) = payload.patch.extra_jvm_args {
                    inst.extra_jvm_args = Some(args);
                }
                inst.updated_at = Utc::now().to_rfc3339();
                Ok(inst.clone())
            })
            .await?;
        write_instance_manifest(&updated);
        Ok(updated)
    }

    pub async fn duplicate(&self, id: &str) -> Result<LauncherInstance, String> {
        self.store.reconcile_instances().await;
        let data = self.store.get_data().await;
        let source = data
            .instances
            .iter()
            .find(|i| i.id == id)
            .cloned()
            .ok_or_else(|| tr("Instance not found", "Инстанция не найдена").to_string())?;
        if self.launch_cancels.lock().await.contains_key(id) {
            return Err(tr(
                "Instance is launching. Cancel launch before copying.",
                "Инстанция запускается. Отмените запуск перед копированием.",
            )
            .to_string());
        }
        if let Some(&pid) = data.running_processes.get(id) {
            if is_java_process_alive(pid) {
                return Err(tr(
                    "Instance is running. Stop it before copying.",
                    "Инстанция запущена. Остановите её перед копированием.",
                )
                .to_string());
            }
        }
        let src_dir = PathBuf::from(&source.directory);
        if !src_dir.exists() {
            return Err(
                tr("The instance folder is missing", "Папка инстанции не найдена").to_string(),
            );
        }

        let base = COPY_SUFFIX_RE.replace(&source.name, "").trim().to_string();
        let base_name = if base.is_empty() {
            source.name.clone()
        } else {
            base
        };
        let suffix = tr("copy", "копия");
        let mut name = sanitize_name(&format!("{base_name} ({suffix})"));
        for n in 2..100 {
            if !data
                .instances
                .iter()
                .any(|i| i.name.eq_ignore_ascii_case(&name))
            {
                break;
            }
            name = sanitize_name(&format!("{base_name} ({suffix} {n})"));
        }

        let new_id = Uuid::new_v4().to_string();
        let reserved_dirs: Vec<String> = data
            .instances
            .iter()
            .map(|i| i.directory.clone())
            .collect();
        let target_dir = pick_instance_directory(&name, None, &reserved_dirs);
        let dst_clone = target_dir.clone();
        let copy_res =
            tokio::task::spawn_blocking(move || copy_dir_filtered(&src_dir, &dst_clone, &src_dir))
                .await
                .map_err(|e| e.to_string())?;
        if let Err(err) = copy_res {
            let _ = fs::remove_dir_all(&target_dir);
            return Err(err);
        }

        let now = Utc::now().to_rfc3339();
        let copy = LauncherInstance {
            id: new_id.clone(),
            name,
            game_version: source.game_version,
            loader: source.loader,
            loader_version: source.loader_version,
            directory: target_dir.to_string_lossy().to_string(),
            icon: source.icon,
            java_path: None,
            max_memory_mb: source.max_memory_mb,
            extra_jvm_args: source.extra_jvm_args,
            created_at: now.clone(),
            updated_at: now,
            last_played_at: None,
            mods: source.mods,
        };
        write_instance_manifest(&copy);

        let id_owned = id.to_string();
        self.store
            .update(|d| {
                let idx = d
                    .instances
                    .iter()
                    .position(|i| i.id == id_owned)
                    .map(|p| p + 1)
                    .unwrap_or(0);
                d.instances.insert(idx, copy.clone());
                d.active_instance_id = Some(new_id.clone());
                Ok(copy)
            })
            .await
    }

    pub async fn remove(&self, id: &str) -> Result<bool, String> {
        let data = self.store.get_data().await;
        let Some(target) = data.instances.iter().find(|i| i.id == id).cloned() else {
            return Ok(false);
        };
        if self.launch_cancels.lock().await.contains_key(id) {
            return Err(tr(
                "Instance is launching. Cancel launch before deleting.",
                "Инстанция сейчас запускается. Сначала отмените запуск.",
            )
            .to_string());
        }
        if let Some(&pid) = data.running_processes.get(id) {
            if is_java_process_alive(pid) {
                return Err(tr(
                    "Instance is running. Stop it before deleting.",
                    "Инстанция запущена. Остановите её перед удалением.",
                )
                .to_string());
            }
        }

        let root = fs::canonicalize(get_instances_root()).unwrap_or_else(|_| get_instances_root());
        let target_dir = PathBuf::from(&target.directory);
        let resolved = fs::canonicalize(&target_dir).unwrap_or_else(|_| target_dir.clone());
        let root_cmp = root.to_string_lossy().to_lowercase();
        let dir_cmp = resolved.to_string_lossy().to_lowercase();
        if dir_cmp == root_cmp || !dir_cmp.starts_with(&root_cmp) {
            return Err(tr(
                "Refusing to delete a folder outside the instances directory",
                "Удаление отменено: папка находится вне каталога инстанций",
            )
            .to_string());
        }

        let id_str = id.to_string();
        tokio::task::spawn_blocking(move || {
            if target_dir.exists() {
                let _ = fs::remove_dir_all(&target_dir);
            }
            let safe_id: String = id_str
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                        c
                    } else {
                        '_'
                    }
                })
                .collect();
            let link = get_minecraft_root().join("instance-links").join(&safe_id);
            if fs::symlink_metadata(&link).is_ok() {
                let _ = fs::remove_dir(&link);
            }
            let _ = fs::remove_dir_all(get_minecraft_root().join("natives").join(&safe_id));
            #[cfg(windows)]
            {
                let _ = fs::remove_dir_all(
                    std::env::temp_dir().join("lynapp").join("natives").join(&safe_id),
                );
            }
        })
        .await
        .map_err(|e| e.to_string())?;

        let id_owned = id.to_string();
        self.store
            .update(|d| {
                let before = d.instances.len();
                d.instances.retain(|i| i.id != id_owned);
                d.running_processes.remove(&id_owned);
                if d.active_instance_id.as_deref() == Some(id_owned.as_str()) {
                    d.active_instance_id = d.instances.first().map(|i| i.id.clone());
                }
                Ok(d.instances.len() != before)
            })
            .await
    }

    pub async fn get_running(&self) -> Vec<String> {
        let snapshot = self.store.get_data().await.running_processes;
        let (alive, dead) = tokio::task::spawn_blocking(move || {
            let mut alive = Vec::new();
            let mut dead = Vec::new();
            for (id, pid) in snapshot {
                if is_java_process_alive(pid) {
                    alive.push(id);
                } else {
                    dead.push((id, pid));
                }
            }
            (alive, dead)
        })
        .await
        .unwrap_or_default();

        if !dead.is_empty() {
            let _ = self
                .store
                .update(|d| {
                    for (id, pid) in dead {
                        if d.running_processes.get(&id) == Some(&pid) {
                            d.running_processes.remove(&id);
                        }
                    }
                    Ok(())
                })
                .await;
        }
        alive
    }

    pub async fn launch(
        &self,
        app: &AppHandle,
        id: &str,
        quick_play: Option<QuickPlayTarget>,
    ) -> Result<LaunchResult, String> {
        {
            let mut cancels = self.launch_cancels.lock().await;
            if cancels.contains_key(id) {
                return Ok(LaunchResult {
                    ok: false,
                    message: tr("already launching", "уже запускается").to_string(),
                    log_path: None,
                    pid: None,
                });
            }
            cancels.insert(id.to_string(), CancellationToken::new());
        }

        let token = self
            .launch_cancels
            .lock()
            .await
            .get(id)
            .cloned()
            .unwrap_or_default();

        let result = self.run_launch(app, id, quick_play, token.clone()).await;

        self.launch_cancels.lock().await.remove(id);
        match result {
            Ok(v) => Ok(v),
            Err(_) if token.is_cancelled() => Ok(LaunchResult {
                ok: false,
                message: tr("launch cancelled", "запуск отменён").to_string(),
                log_path: None,
                pid: None,
            }),
            Err(e) => Err(e),
        }
    }

    async fn run_launch(
        &self,
        app: &AppHandle,
        id: &str,
        quick_play: Option<QuickPlayTarget>,
        cancel: CancellationToken,
    ) -> Result<LaunchResult, String> {
        self.store.reconcile_instances().await;
        let data = self.store.get_data().await;
        let Some(instance) = data.instances.iter().find(|i| i.id == id).cloned() else {
            return Ok(LaunchResult {
                ok: false,
                message: tr("Instance not found", "Инстанция не найдена").to_string(),
                log_path: None,
                pid: None,
            });
        };

        if let Some(&pid) = data.running_processes.get(id) {
            if is_java_process_alive(pid) {
                return Ok(LaunchResult {
                    ok: false,
                    message: tr("already running", "уже запущена").to_string(),
                    log_path: None,
                    pid: None,
                });
            }
        }

        let mut active_account = match data
            .accounts
            .iter()
            .find(|a| Some(&a.id) == data.active_account_id.as_ref())
            .or_else(|| data.accounts.first())
            .cloned()
        {
            Some(a) => a,
            None => {
                return Ok(LaunchResult {
                    ok: false,
                    message: tr(
                        "Add an account first (Microsoft login or offline profile)",
                        "Сначала добавьте аккаунт (вход через Microsoft или офлайн-профиль)",
                    )
                    .to_string(),
                    log_path: None,
                    pid: None,
                });
            }
        };

        if active_account.kind != "offline" {
            if let Some(fresh) = self.auth.ensure_fresh_session(false).await {
                active_account = fresh;
            }
        }
        if active_account.kind == "microsoft" {
            if let Some(exp_str) = &active_account.expires_at {
                if let Ok(exp) = DateTime::parse_from_rfc3339(exp_str) {
                    if exp.with_timezone(&Utc) < Utc::now() {
                        let pname = active_account.profile_name.as_deref().unwrap_or("account");
                        return Ok(LaunchResult {
                            ok: false,
                            message: tr_string(
                                format!("Microsoft session for {pname} expired. Log in again via Add account."),
                                format!("Сессия Microsoft для {pname} истекла. Войдите снова через «Добавить аккаунт»."),
                            ),
                            log_path: None,
                            pid: None,
                        });
                    }
                }
            }
        }

        let required_major = self
            .minecraft
            .get_required_java_major(&instance.game_version)
            .await;
        let mut preferred = Vec::new();
        if let Some(p) = data.settings.java_paths.get(&required_major.to_string()) {
            preferred.push(p.clone());
        }
        if !data.settings.java_path.is_empty() {
            preferred.push(data.settings.java_path.clone());
        }

        let app_for_java = app.clone();
        let id_for_java = id.to_string();
        let mut last_emit = std::time::Instant::now() - std::time::Duration::from_secs(1);
        let java_rt = self
            .java
            .ensure_runtime(required_major, &preferred, Some(cancel.clone()), |received, total| {
                if last_emit.elapsed().as_millis() >= 100 || Some(received) == total {
                    last_emit = std::time::Instant::now();
                    let _ = app_for_java.emit(
                        "transfer:progress",
                        serde_json::json!({
                            "key": format!("launch:{id_for_java}"),
                            "fileName": "Java",
                            "received": received,
                            "total": total,
                            "phase": "java",
                            "doneFiles": 0,
                            "totalFiles": 0
                        }),
                    );
                }
            })
            .await?;

        let raw_mem = instance.max_memory_mb.unwrap_or(data.settings.max_memory_mb);
        let max_mem = raw_mem.clamp(512, get_max_allocatable_memory_mb());
        let extra_src = instance
            .extra_jvm_args
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&data.settings.extra_jvm_args);
        let extra_jvm = parse_jvm_flags(Some(extra_src));

        let id_owned = id.to_string();
        let updated_inst = self
            .store
            .update(|d| {
                let target = d
                    .instances
                    .iter_mut()
                    .find(|i| i.id == id_owned)
                    .ok_or_else(|| tr("Instance not found", "Инстанция не найдена").to_string())?;
                let now = Utc::now().to_rfc3339();
                target.updated_at = now.clone();
                target.last_played_at = Some(now);
                d.active_instance_id = Some(target.id.clone());
                Ok(target.clone())
            })
            .await?;
        write_instance_manifest(&updated_inst);

        let app_prog = app.clone();
        let id_prog = id.to_string();
        let mut last_mc_emit = std::time::Instant::now() - std::time::Duration::from_secs(1);
        let launch = self
            .minecraft
            .prepare_launch(
                &updated_inst,
                &active_account,
                max_mem,
                &extra_jvm,
                Path::new(&java_rt.path),
                Some(&cancel),
                data.settings.concurrent_downloads as usize,
                quick_play.as_ref(),
                |prog: LaunchProgress| {
                    if last_mc_emit.elapsed().as_millis() >= 100 || prog.done == prog.total {
                        last_mc_emit = std::time::Instant::now();
                        let fname = match prog.phase.as_str() {
                            "assets" => "assets",
                            "loader" => "loader",
                            _ => "libraries",
                        };
                        let _ = app_prog.emit(
                            "transfer:progress",
                            serde_json::json!({
                                "key": format!("launch:{id_prog}"),
                                "fileName": fname,
                                "received": prog.received.unwrap_or(prog.done as u64),
                                "total": prog.total_bytes.unwrap_or(prog.total as u64),
                                "phase": prog.phase,
                                "doneFiles": prog.done,
                                "totalFiles": prog.total
                            }),
                        );
                    }
                },
            )
            .await?;

        let plan_path = Path::new(&instance.directory)
            .join(".launcher")
            .join("logs")
            .join("latest-launch-plan.log");
        let redacted = redact_launch_args(&launch.args)
            .into_iter()
            .map(|a| if a.contains(' ') { format!("\"{a}\"") } else { a })
            .collect::<Vec<_>>()
            .join(" ");
        let plan_text = format!(
            "Instance: {}\nGame version: {}\nLoader: {}\nJava: {}\nJava path: {}\nMain class: {}\nNatives: {}\nWorking directory: {}\nCommand: \"{}\" {}\n",
            instance.name,
            instance.game_version,
            instance.loader,
            java_rt.message,
            java_rt.path,
            launch.main_class,
            launch.natives_dir.display(),
            launch.launch_directory.display(),
            java_rt.path,
            redacted
        );
        let _ = fs::write(&plan_path, plan_text);

        let log_header = format!(
            "lynapp Minecraft log\nStarted: {}\nInstance: {}\nGame version: {}\nJava: {}\n\n",
            Utc::now().to_rfc3339(),
            instance.name,
            instance.game_version,
            java_rt.path
        );
        let _ = fs::write(&launch.log_path, log_header);

        if cancel.is_cancelled() {
            return Err(tr("launch cancelled", "запуск отменён").to_string());
        }

        let log_out = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&launch.log_path)
            .map_err(|e| e.to_string())?;
        let log_err = log_out.try_clone().map_err(|e| e.to_string())?;

        let mut cmd = Command::new(&java_rt.path);
        cmd.args(&launch.args)
            .current_dir(&launch.launch_directory)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log_out))
            .stderr(Stdio::from(log_err));
        #[cfg(windows)]
        {
            if java_rt.path.to_ascii_lowercase().ends_with("java.exe") {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000);
            }
        }

        let mut child = cmd.spawn().map_err(|e| {
            tr_string(
                format!("Could not start Java: {e}"),
                format!("Не удалось запустить Java: {e}"),
            )
        })?;
        let pid = child.id();

        self.managed_pids.lock().await.insert(pid);
        let id_save = id.to_string();
        self.store
            .update(|d| {
                d.running_processes.insert(id_save, pid);
                Ok(())
            })
            .await?;

        self.discord.game_started(&updated_inst).await;

        let after_action = data.settings.after_launch.clone();
        if after_action == "hide" || after_action == "close" {
            let app_after = app.clone();
            let store_after = self.store.clone();
            let id_after = id.to_string();
            let delay_ms = if after_action == "hide" { 1200 } else { 2000 };
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                let still_running = store_after
                    .get_data()
                    .await
                    .running_processes
                    .get(&id_after)
                    .copied()
                    .map(is_java_process_alive)
                    .unwrap_or(false);
                if still_running {
                    if after_action == "hide" {
                        let _ = tray::hide_to_tray(&app_after);
                    } else {
                        app_after.exit(0);
                    }
                }
            });
        }

        let store_wait = self.store.clone();
        let discord_wait = self.discord.clone();
        let managed_wait = self.managed_pids.clone();
        let app_wait = app.clone();
        let id_wait = id.to_string();
        tokio::task::spawn_blocking(move || {
            let _ = child.wait();
            let rt = tokio::runtime::Handle::current();
            rt.block_on(async move {
                managed_wait.lock().await.remove(&pid);
                let _ = store_wait
                    .update(|d| {
                        if d.running_processes.get(&id_wait) == Some(&pid) {
                            d.running_processes.remove(&id_wait);
                        }
                        Ok(())
                    })
                    .await;
                discord_wait.game_stopped(&id_wait).await;
                if tray::is_hidden_for_game() {
                    let any_left = !store_wait.get_data().await.running_processes.is_empty();
                    if !any_left {
                        let _ = tray::restore_from_tray(&app_wait);
                    }
                }
            });
        });

        let warn_suffix = launch
            .warning
            .as_deref()
            .map(|w| format!(" ({w})"))
            .unwrap_or_default();
        Ok(LaunchResult {
            ok: true,
            message: tr_string(
                format!("{}. Minecraft process started{warn_suffix}.", java_rt.message),
                format!("{}. Процесс Minecraft запущен{warn_suffix}.", java_rt.message),
            ),
            log_path: Some(launch.log_path.to_string_lossy().to_string()),
            pid: Some(pid),
        })
    }

    pub async fn cancel_launch(&self, id: &str) -> Result<LaunchResult, String> {
        if let Some(tok) = self.launch_cancels.lock().await.get(id) {
            tok.cancel();
        }
        let data = self.store.get_data().await;
        if let Some(&pid) = data.running_processes.get(id) {
            if is_java_process_alive(pid) {
                tokio::task::spawn_blocking(move || kill_process_tree(pid))
                    .await
                    .map_err(|e| e.to_string())?;
                let id_owned = id.to_string();
                let _ = self
                    .store
                    .update(|d| {
                        if d.running_processes.get(&id_owned) == Some(&pid) {
                            d.running_processes.remove(&id_owned);
                        }
                        Ok(())
                    })
                    .await;
                self.discord.game_stopped(id).await;
                return Ok(LaunchResult {
                    ok: true,
                    message: tr("stopped", "остановлена").to_string(),
                    log_path: None,
                    pid: None,
                });
            }
        }
        Ok(LaunchResult {
            ok: true,
            message: tr("launch cancelled", "запуск отменён").to_string(),
            log_path: None,
            pid: None,
        })
    }

    pub async fn stop(&self, id: &str) -> Result<LaunchResult, String> {
        let data = self.store.get_data().await;
        let Some(&pid) = data.running_processes.get(id) else {
            return Ok(LaunchResult {
                ok: false,
                message: tr("not running", "не запущена").to_string(),
                log_path: None,
                pid: None,
            });
        };
        if !is_java_process_alive(pid) {
            let id_owned = id.to_string();
            let _ = self
                .store
                .update(|d| {
                    if d.running_processes.get(&id_owned) == Some(&pid) {
                        d.running_processes.remove(&id_owned);
                    }
                    Ok(())
                })
                .await;
            return Ok(LaunchResult {
                ok: false,
                message: tr("not running", "не запущена").to_string(),
                log_path: None,
                pid: None,
            });
        }
        tokio::task::spawn_blocking(move || kill_process_tree(pid))
            .await
            .map_err(|e| e.to_string())?;
        let id_owned = id.to_string();
        let _ = self
            .store
            .update(|d| {
                if d.running_processes.get(&id_owned) == Some(&pid) {
                    d.running_processes.remove(&id_owned);
                }
                Ok(())
            })
            .await;
        self.discord.game_stopped(id).await;
        Ok(LaunchResult {
            ok: true,
            message: tr("stopped", "остановлена").to_string(),
            log_path: None,
            pid: None,
        })
    }

    pub async fn get_logs(&self, id: &str) -> Result<InstanceLogsResult, String> {
        let data = self.store.get_data().await;
        let inst = data
            .instances
            .iter()
            .find(|i| i.id == id)
            .cloned()
            .ok_or_else(|| tr("Instance not found", "Инстанция не найдена").to_string())?;
        let dir = PathBuf::from(&inst.directory);
        tokio::task::spawn_blocking(move || {
            let (log, has_log, mtime) =
                read_tail(&dir.join(".launcher").join("logs").join("latest.log"), 200 * 1024);
            let (plan, _, _) = read_tail(
                &dir.join(".launcher").join("logs").join("latest-launch-plan.log"),
                200 * 1024,
            );
            let crash = read_newest_crash(&dir, mtime);
            InstanceLogsResult {
                log,
                plan,
                has_log,
                crash,
            }
        })
        .await
        .map_err(|e| e.to_string())
    }
}
