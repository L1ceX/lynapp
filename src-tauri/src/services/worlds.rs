use crate::i18n::tr;
use crate::paths::get_launcher_root;
use crate::services::instances::is_java_process_alive;
use crate::services::nbt::parse_nbt;
use crate::services::ziputil::{create_zip_from_dir, extract_zip};
use crate::store::JsonStore;
use crate::types::{WorldBackupInfo, WorldInfo};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use chrono::{DateTime, Utc};
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use uuid::Uuid;

fn safe_segment(name: &str) -> Result<String, String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
    {
        return Err(tr("Invalid world folder name", "Некорректное имя папки мира").to_string());
    }
    Ok(name.to_string())
}

fn folder_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if let Ok(meta) = fs::symlink_metadata(&p) {
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                total = total.saturating_add(folder_size(&p));
            } else if meta.is_file() {
                total = total.saturating_add(meta.len());
            }
        }
    }
    total
}

fn backups_dir(instance_dir: &Path, folder_name: &str) -> PathBuf {
    instance_dir
        .join(".launcher")
        .join("backups")
        .join(folder_name)
}

fn list_backups_for_world(instance_dir: &Path, folder_name: &str) -> Vec<WorldBackupInfo> {
    let dir = backups_dir(instance_dir, folder_name);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.to_lowercase().ends_with(".zip") {
            continue;
        }
        if let Ok(meta) = path.metadata() {
            let created_at = meta
                .modified()
                .ok()
                .map(|t| DateTime::<Utc>::from(t).to_rfc3339())
                .unwrap_or_else(|| Utc::now().to_rfc3339());
            out.push(WorldBackupInfo {
                id: name.clone(),
                file_name: name,
                size: meta.len(),
                created_at,
            });
        }
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    out
}

fn list_worlds_sync(instance_dir: &Path) -> Vec<WorldInfo> {
    let saves_dir = instance_dir.join("saves");
    let Ok(entries) = fs::read_dir(&saves_dir) else {
        return Vec::new();
    };
    let mut worlds = Vec::new();
    for entry in entries.flatten() {
        let world_dir = entry.path();
        if !world_dir.is_dir() {
            continue;
        }
        let level_dat = world_dir.join("level.dat");
        if !level_dat.exists() {
            continue;
        }
        let folder_name = entry.file_name().to_string_lossy().to_string();
        let mut name = folder_name.clone();
        let mut last_played: Option<String> = None;
        let mut game_mode = "survival".to_string();
        let mut hardcore = false;
        let mut cheats = false;
        let mut version_name: Option<String> = None;

        if let Ok(raw) = fs::read(&level_dat) {
            if let Ok(root) = parse_nbt(&raw) {
                let data = root
                    .get("Data")
                    .and_then(|v| v.as_compound())
                    .unwrap_or(&root);
                if let Some(ln) = data.get("LevelName").and_then(|v| v.as_str()) {
                    if !ln.trim().is_empty() {
                        name = ln.trim().to_string();
                    }
                }
                if let Some(ms) = data.get("LastPlayed").and_then(|v| v.as_i64()) {
                    if ms > 0 {
                        if let Some(dt) = DateTime::from_timestamp_millis(ms) {
                            last_played = Some(dt.to_rfc3339());
                        }
                    }
                }
                game_mode = match data.get("GameType").and_then(|v| v.as_i64()).unwrap_or(0) {
                    1 => "creative",
                    2 => "adventure",
                    3 => "spectator",
                    _ => "survival",
                }
                .to_string();
                hardcore = data.get("hardcore").and_then(|v| v.as_i64()).unwrap_or(0) == 1;
                cheats = data
                    .get("allowCommands")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0)
                    == 1;
                version_name = data
                    .get("Version")
                    .and_then(|v| v.as_compound())
                    .and_then(|v| v.get("Name"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
            }
        }

        if last_played.is_none() {
            last_played = level_dat
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .map(|t| DateTime::<Utc>::from(t).to_rfc3339());
        }

        let icon_data_url = fs::read(world_dir.join("icon.png"))
            .ok()
            .map(|b| format!("data:image/png;base64,{}", STANDARD.encode(b)));

        let size = folder_size(&world_dir);
        let backups = list_backups_for_world(instance_dir, &folder_name);

        worlds.push(WorldInfo {
            folder_name,
            name,
            last_played,
            game_mode,
            hardcore,
            cheats,
            version_name,
            size,
            icon_data_url,
            backups,
        });
    }
    worlds.sort_by(|a, b| b.last_played.cmp(&a.last_played));
    worlds
}

pub struct WorldService {
    store: Arc<JsonStore>,
}

impl WorldService {
    pub fn new(store: Arc<JsonStore>) -> Self {
        Self { store }
    }

    async fn get_instance_dir(&self, instance_id: &str) -> Result<PathBuf, String> {
        let data = self.store.get_data().await;
        let inst = data
            .instances
            .iter()
            .find(|i| i.id == instance_id)
            .ok_or_else(|| tr("Instance not found", "Инстанция не найдена").to_string())?;
        Ok(PathBuf::from(&inst.directory))
    }

    async fn assert_writable(&self, instance_id: &str, world_dir: &Path) -> Result<(), String> {
        let data = self.store.get_data().await;
        if let Some(&pid) = data.running_processes.get(instance_id) {
            if is_java_process_alive(pid) {
                return Err(tr(
                    "Stop the running Minecraft instance before modifying worlds.",
                    "Остановите запущенную инстанцию Minecraft перед изменением миров.",
                )
                .to_string());
            }
        }
        let lock = world_dir.join("session.lock");
        if lock.exists() {
            if let Err(e) = OpenOptions::new().read(true).write(true).open(&lock) {
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::WouldBlock
                ) {
                    return Err(tr(
                        "This world is currently open in Minecraft.",
                        "Этот мир сейчас открыт в Minecraft.",
                    )
                    .to_string());
                }
            }
        }
        Ok(())
    }

    pub async fn list(&self, instance_id: &str) -> Result<Vec<WorldInfo>, String> {
        let dir = self.get_instance_dir(instance_id).await?;
        tokio::task::spawn_blocking(move || list_worlds_sync(&dir))
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn backup(&self, instance_id: &str, folder_name: &str) -> Result<Vec<WorldInfo>, String> {
        let safe = safe_segment(folder_name)?;
        let dir = self.get_instance_dir(instance_id).await?;
        let world_dir = dir.join("saves").join(&safe);
        if !world_dir.exists() {
            return Err(tr("World folder not found", "Папка мира не найдена").to_string());
        }
        let dir_clone = dir.clone();
        tokio::task::spawn_blocking(move || {
            let bdir = backups_dir(&dir_clone, &safe);
            fs::create_dir_all(&bdir).map_err(|e| e.to_string())?;
            let stamp = Utc::now().format("%Y-%m-%dT%H-%M-%S").to_string();
            let mut zip_path = bdir.join(format!("{safe}-{stamp}.zip"));
            if zip_path.exists() {
                zip_path = bdir.join(format!(
                    "{safe}-{stamp}-{}.zip",
                    Utc::now().timestamp_subsec_millis()
                ));
            }
            let tmp = bdir.join(format!(
                "{}.{}.{}.tmp",
                zip_path.file_name().unwrap().to_string_lossy(),
                std::process::id(),
                Uuid::new_v4()
            ));
            let res = create_zip_from_dir(&world_dir, &tmp, true, |p, _| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| !n.eq_ignore_ascii_case("session.lock"))
                    .unwrap_or(true)
            });
            if let Err(e) = res {
                let _ = fs::remove_file(&tmp);
                return Err(e);
            }
            if let Err(e) = fs::rename(&tmp, &zip_path) {
                let _ = fs::remove_file(&tmp);
                return Err(e.to_string());
            }
            Ok::<Vec<WorldInfo>, String>(list_worlds_sync(&dir_clone))
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub async fn restore(
        &self,
        instance_id: &str,
        folder_name: &str,
        backup_id: &str,
    ) -> Result<Vec<WorldInfo>, String> {
        let safe_folder = safe_segment(folder_name)?;
        let safe_backup = safe_segment(backup_id)?;
        let dir = self.get_instance_dir(instance_id).await?;
        let zip_path = backups_dir(&dir, &safe_folder).join(&safe_backup);
        if !zip_path.exists() {
            return Err(tr("Backup file not found", "Файл резервной копии не найден").to_string());
        }
        let world_dir = dir.join("saves").join(&safe_folder);
        self.assert_writable(instance_id, &world_dir).await?;

        let dir_clone = dir.clone();
        tokio::task::spawn_blocking(move || {
            let tmp = get_launcher_root()
                .join("cache")
                .join(format!("world-restore-{}", Uuid::new_v4()));
            let res = (|| -> Result<(), String> {
                extract_zip(&zip_path, &tmp)?;
                let lvl = tmp.join("level.dat");
                if !lvl.exists() {
                    return Err(tr(
                        "Backup archive does not contain level.dat",
                        "В архиве резервной копии отсутствует level.dat",
                    )
                    .to_string());
                }
                let raw = fs::read(&lvl).map_err(|e| e.to_string())?;
                parse_nbt(&raw).map_err(|_| {
                    tr(
                        "Backup archive contains a corrupt level.dat",
                        "В архиве резервной копии повреждён файл level.dat",
                    )
                    .to_string()
                })?;

                let old = dir_clone
                    .join(".launcher")
                    .join("tmp")
                    .join(format!("world-old-{}", Uuid::new_v4()));
                let mut moved = false;
                if world_dir.exists() {
                    if let Some(p) = old.parent() {
                        let _ = fs::create_dir_all(p);
                    }
                    fs::rename(&world_dir, &old).map_err(|e| e.to_string())?;
                    moved = true;
                }
                if let Err(e) = copy_dir_all(&tmp, &world_dir) {
                    let _ = fs::remove_dir_all(&world_dir);
                    if moved && old.exists() {
                        let _ = fs::rename(&old, &world_dir);
                    }
                    return Err(e);
                }
                if moved {
                    let _ = fs::remove_dir_all(&old);
                }
                Ok(())
            })();
            let _ = fs::remove_dir_all(&tmp);
            res?;
            Ok::<Vec<WorldInfo>, String>(list_worlds_sync(&dir_clone))
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub async fn delete_backup(
        &self,
        instance_id: &str,
        folder_name: &str,
        backup_id: &str,
    ) -> Result<Vec<WorldInfo>, String> {
        let safe_folder = safe_segment(folder_name)?;
        let safe_backup = safe_segment(backup_id)?;
        let dir = self.get_instance_dir(instance_id).await?;
        let zip_path = backups_dir(&dir, &safe_folder).join(&safe_backup);
        let _ = fs::remove_file(&zip_path);
        self.list(instance_id).await
    }

    pub async fn delete_world(
        &self,
        instance_id: &str,
        folder_name: &str,
    ) -> Result<Vec<WorldInfo>, String> {
        let safe_folder = safe_segment(folder_name)?;
        let dir = self.get_instance_dir(instance_id).await?;
        let world_dir = dir.join("saves").join(&safe_folder);
        self.assert_writable(instance_id, &world_dir).await?;
        tokio::task::spawn_blocking(move || {
            if world_dir.exists() {
                fs::remove_dir_all(&world_dir).map_err(|e| e.to_string())?;
            }
            Ok::<(), String>(())
        })
        .await
        .map_err(|e| e.to_string())??;
        self.list(instance_id).await
    }
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &dst.join(entry.file_name()))?;
        } else {
            fs::copy(entry.path(), dst.join(entry.file_name())).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
