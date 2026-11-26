use crate::i18n::{tr, tr_string};
use crate::paths::get_launcher_root;
use crate::services::curseforge::{
    curseforge_dependencies, CurseForgeManifest, CurseForgeService, ResolvedPackFile,
};
use crate::services::hashes::write_content_manifest;
use crate::services::instances::InstanceService;
use crate::services::minecraft::MinecraftService;
use crate::services::ziputil::{create_zip_from_dir, extract_zip};
use crate::store::JsonStore;
use crate::types::{
    CreateInstancePayload, ExportEntry, InstalledMod, LauncherInstance, MrpackBeginResult,
    MrpackTargetResult,
};
use chrono::{DateTime, Utc};
use futures_util::stream::{self, StreamExt};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use sha2::Sha512;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MrpackHashes {
    sha1: Option<String>,
    sha512: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MrpackEnv {
    client: Option<String>,
    server: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MrpackIndexFile {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    hashes: Option<MrpackHashes>,
    #[serde(skip_serializing_if = "Option::is_none")]
    env: Option<MrpackEnv>,
    #[serde(default)]
    downloads: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MrpackIndex {
    format_version: Option<u32>,
    game: Option<String>,
    version_id: Option<String>,
    name: Option<String>,
    summary: Option<String>,
    #[serde(default)]
    dependencies: HashMap<String, String>,
    #[serde(default)]
    files: Vec<MrpackIndexFile>,
}

#[allow(dead_code)]
struct PendingImport {
    tmp: PathBuf,
    files: Vec<MrpackIndexFile>,
    at: Instant,
    created: bool,
    overrides: Vec<String>,
    cf_meta: HashMap<String, ResolvedPackFile>,
}

#[allow(dead_code)]
struct DownloadedEntry {
    rel: String,
    file_name: String,
    sha512: Option<String>,
    sha1: Option<String>,
}

fn pick_loader(deps: &HashMap<String, String>, game_version: &str) -> (String, Option<String>) {
    if let Some(v) = deps.get("fabric-loader").map(String::as_str).map(str::trim).filter(|s| !s.is_empty()) {
        return ("fabric".to_string(), Some(v.to_string()));
    }
    if let Some(v) = deps.get("quilt-loader").map(String::as_str).map(str::trim).filter(|s| !s.is_empty()) {
        return ("quilt".to_string(), Some(v.to_string()));
    }
    if let Some(v) = deps.get("forge").map(String::as_str).map(str::trim).filter(|s| !s.is_empty()) {
        let lv = if v.starts_with(&format!("{game_version}-")) {
            v.to_string()
        } else {
            format!("{game_version}-{v}")
        };
        return ("forge".to_string(), Some(lv));
    }
    if let Some(v) = deps.get("neoforge").map(String::as_str).map(str::trim).filter(|s| !s.is_empty()) {
        return ("neoforge".to_string(), Some(v.to_string()));
    }
    ("vanilla".to_string(), None)
}

fn safe_rel_target(root: &Path, entry_path: &str) -> Result<PathBuf, String> {
    let raw = entry_path.replace('\\', "/");
    if raw.is_empty() || raw.starts_with('/') || raw.contains('\0') {
        return Err(tr_string(
            format!("Unsafe path inside the modpack: {entry_path}"),
            format!("Недопустимый путь внутри сборки: {entry_path}"),
        ));
    }
    let mut parts = Vec::new();
    for comp in Path::new(&raw).components() {
        match comp {
            Component::Normal(p) => {
                let s = p.to_string_lossy();
                if s.contains(':') {
                    return Err(tr_string(
                        format!("Unsafe path inside the modpack: {entry_path}"),
                        format!("Недопустимый путь внутри сборки: {entry_path}"),
                    ));
                }
                parts.push(p.to_os_string());
            }
            Component::CurDir => {}
            _ => {
                return Err(tr_string(
                    format!("Unsafe path inside the modpack: {entry_path}"),
                    format!("Недопустимый путь внутри сборки: {entry_path}"),
                ));
            }
        }
    }
    if parts.is_empty() {
        return Err(tr_string(
            format!("Unsafe path inside the modpack: {entry_path}"),
            format!("Недопустимый путь внутри сборки: {entry_path}"),
        ));
    }
    let head = parts[0]
        .to_string_lossy()
        .trim_end_matches(['.', ' '])
        .to_lowercase();
    if head.is_empty() || head == ".launcher" {
        return Err(tr_string(
            format!("Unsafe path inside the modpack: {entry_path}"),
            format!("Недопустимый путь внутри сборки: {entry_path}"),
        ));
    }
    let mut target = root.to_path_buf();
    for p in parts {
        target.push(p);
    }
    Ok(target)
}

fn entry_location(rel: &str) -> Option<(&'static str, String)> {
    let clean = rel
        .replace('\\', "/")
        .trim_start_matches("./")
        .trim_start_matches('/')
        .to_string();
    let parts: Vec<&str> = clean.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() == 2 {
        let pt = match parts[0].to_lowercase().as_str() {
            "mods" => "mod",
            "resourcepacks" => "resourcepack",
            "shaderpacks" => "shader",
            "datapacks" => "datapack",
            _ => return None,
        };
        return Some((pt, parts[0].to_string()));
    }
    if parts.len() == 4
        && parts[0].eq_ignore_ascii_case("saves")
        && parts[2].eq_ignore_ascii_case("datapacks")
    {
        return Some((
            "datapack",
            format!("{}/{}/{}", parts[0], parts[1], parts[2]),
        ));
    }
    None
}

fn verify_bytes(bytes: &[u8], hashes: Option<&MrpackHashes>, entry_path: &str) -> Result<(), String> {
    let Some(h) = hashes else {
        return Ok(());
    };
    if let Some(exp) = h.sha512.as_deref().filter(|s| !s.is_empty()) {
        let mut hasher = Sha512::new();
        hasher.update(bytes);
        let actual = hex::encode(hasher.finalize());
        if !actual.eq_ignore_ascii_case(exp) {
            return Err(tr_string(
                format!("Checksum mismatch: {entry_path}"),
                format!("Контрольная сумма не совпадает: {entry_path}"),
            ));
        }
        return Ok(());
    }
    if let Some(exp) = h.sha1.as_deref().filter(|s| !s.is_empty()) {
        let mut hasher = Sha1::new();
        hasher.update(bytes);
        let actual = hex::encode(hasher.finalize());
        if !actual.eq_ignore_ascii_case(exp) {
            return Err(tr_string(
                format!("Checksum mismatch: {entry_path}"),
                format!("Контрольная сумма не совпадает: {entry_path}"),
            ));
        }
    }
    Ok(())
}

fn copy_overrides(src: &Path, instance_dir: &Path, prefix: &str) -> Result<(), String> {
    let Ok(entries) = fs::read_dir(src) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.eq_ignore_ascii_case("session.lock") {
            continue;
        }
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        let target = safe_rel_target(instance_dir, &rel)?;
        let path = entry.path();
        if path.is_dir() {
            fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            copy_overrides(&path, instance_dir, &rel)?;
        } else if path.is_file() {
            if let Some(p) = target.parent() {
                fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            fs::copy(&path, &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    for e in entries.flatten() {
        let p = e.path();
        if let Ok(m) = fs::symlink_metadata(&p) {
            if m.file_type().is_symlink() {
                continue;
            }
            if m.is_dir() {
                total = total.saturating_add(dir_size(&p));
            } else {
                total = total.saturating_add(m.len());
            }
        }
    }
    total
}

fn copy_tree_no_lock(src: &Path, dst: &Path) -> Result<(), String> {
    let meta = fs::metadata(src).map_err(|e| e.to_string())?;
    if meta.is_file() {
        if let Some(p) = dst.parent() {
            fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        fs::copy(src, dst).map_err(|e| e.to_string())?;
        return Ok(());
    }
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        if name.to_string_lossy().eq_ignore_ascii_case("session.lock") {
            continue;
        }
        copy_tree_no_lock(&entry.path(), &dst.join(&name))?;
    }
    Ok(())
}

pub struct ModpackService {
    client: Client,
    store: Arc<JsonStore>,
    instances: Arc<InstanceService>,
    minecraft: Arc<MinecraftService>,
    curseforge: Arc<CurseForgeService>,
    pending: Mutex<HashMap<String, PendingImport>>,
    active_cancels: Mutex<HashMap<String, CancellationToken>>,
}

impl ModpackService {
    pub fn new(
        store: Arc<JsonStore>,
        instances: Arc<InstanceService>,
        minecraft: Arc<MinecraftService>,
        curseforge: Arc<CurseForgeService>,
    ) -> Self {
        let client = Client::builder()
            .user_agent("lynapp/2.0.0-beta.1")
            .timeout(Duration::from_secs(900))
            .build()
            .unwrap_or_else(|_| Client::new());
        Self {
            client,
            store,
            instances,
            minecraft,
            curseforge,
            pending: Mutex::new(HashMap::new()),
            active_cancels: Mutex::new(HashMap::new()),
        }
    }

    async fn unpack_index(
        &self,
        file_path: &str,
    ) -> Result<(PathBuf, MrpackIndex, Vec<String>, Vec<String>, HashMap<String, ResolvedPackFile>), String> {
        let lower = file_path.to_lowercase();
        let src = PathBuf::from(file_path);
        if (!lower.ends_with(".mrpack") && !lower.ends_with(".zip")) || !src.exists() {
            return Err(tr(
                "Drop a modpack file (.mrpack or a CurseForge .zip) to import it",
                "Перетащите файл сборки (.mrpack или .zip CurseForge), чтобы импортировать его",
            )
            .to_string());
        }
        let tmp = get_launcher_root()
            .join("cache")
            .join("modpacks")
            .join(format!("import-{}", Uuid::new_v4()));
        let tmp_clone = tmp.clone();
        let extract_res =
            tokio::task::spawn_blocking(move || extract_zip(&src, &tmp_clone))
                .await
                .map_err(|e| e.to_string())?;
        if extract_res.is_err() {
            let _ = fs::remove_dir_all(&tmp);
            return Err(tr(
                "Could not unpack the modpack file (corrupt archive?)",
                "Не удалось распаковать файл сборки (архив повреждён?)",
            )
            .to_string());
        }

        let mr_index_path = tmp.join("modrinth.index.json");
        let cf_manifest_path = tmp.join("manifest.json");
        if !mr_index_path.exists() && cf_manifest_path.exists() {
            let raw = fs::read_to_string(&cf_manifest_path).map_err(|e| {
                let _ = fs::remove_dir_all(&tmp);
                e.to_string()
            })?;
            let manifest: CurseForgeManifest = serde_json::from_str(&raw).map_err(|_| {
                let _ = fs::remove_dir_all(&tmp);
                tr(
                    "manifest.json is broken: not a valid CurseForge modpack",
                    "Файл manifest.json повреждён: это не сборка CurseForge",
                )
                .to_string()
            })?;
            let (resolved_files, skipped) = match self.curseforge.resolve_manifest(&manifest).await {
                Ok(v) => v,
                Err(e) => {
                    let _ = fs::remove_dir_all(&tmp);
                    return Err(e);
                }
            };
            let mut cf_meta = HashMap::new();
            let mut idx_files = Vec::new();
            for rf in resolved_files {
                let hashes = rf.sha1.clone().map(|s| MrpackHashes {
                    sha1: Some(s),
                    sha512: None,
                });
                idx_files.push(MrpackIndexFile {
                    path: rf.path.clone(),
                    hashes,
                    env: None,
                    downloads: vec![rf.url.clone()],
                    file_size: rf.size,
                });
                cf_meta.insert(rf.path.clone(), rf);
            }
            let overrides_name = manifest
                .overrides
                .as_deref()
                .unwrap_or("overrides")
                .trim_end_matches(['/', '\\'])
                .to_string();
            let index = MrpackIndex {
                format_version: Some(1),
                game: Some("minecraft".to_string()),
                version_id: None,
                name: manifest.name.clone(),
                summary: None,
                dependencies: curseforge_dependencies(&manifest),
                files: idx_files,
            };
            return Ok((tmp, index, vec![overrides_name], skipped, cf_meta));
        }

        let raw = fs::read_to_string(&mr_index_path).map_err(|_| {
            let _ = fs::remove_dir_all(&tmp);
            tr(
                "modrinth.index.json is missing or broken: not a valid .mrpack",
                "Файл modrinth.index.json отсутствует или повреждён: это не модпак .mrpack",
            )
            .to_string()
        })?;
        let index: MrpackIndex = serde_json::from_str(&raw).map_err(|_| {
            let _ = fs::remove_dir_all(&tmp);
            tr(
                "modrinth.index.json is missing or broken: not a valid .mrpack",
                "Файл modrinth.index.json отсутствует или повреждён: это не модпак .mrpack",
            )
            .to_string()
        })?;
        if index.format_version != Some(1) || index.game.as_deref() != Some("minecraft") {
            let _ = fs::remove_dir_all(&tmp);
            return Err(tr(
                "Unsupported .mrpack format (need formatVersion 1 for Minecraft)",
                "Неподдерживаемый формат .mrpack (нужен formatVersion 1 для Minecraft)",
            )
            .to_string());
        }
        Ok((
            tmp,
            index,
            vec!["overrides".to_string(), "client-overrides".to_string()],
            Vec::new(),
            HashMap::new(),
        ))
    }

    fn wanted_files(index: &MrpackIndex) -> Result<Vec<MrpackIndexFile>, String> {
        let probe = get_launcher_root().join("cache").join("modpacks").join("probe");
        let mut out = Vec::new();
        for f in &index.files {
            if f.path.is_empty() || f.downloads.is_empty() {
                continue;
            }
            if f.env
                .as_ref()
                .and_then(|e| e.client.as_deref())
                == Some("unsupported")
            {
                continue;
            }
            safe_rel_target(&probe, &f.path)?;
            out.push(f.clone());
        }
        Ok(out)
    }

    pub async fn begin_import(&self, file_path: &str) -> Result<MrpackBeginResult, String> {
        let (tmp, index, overrides, skipped, cf_meta) = self.unpack_index(file_path).await?;
        let res = async {
            let gv = index
                .dependencies
                .get("minecraft")
                .map(String::as_str)
                .map(str::trim)
                .unwrap_or("")
                .to_string();
            if gv.is_empty() {
                return Err(tr(
                    "The modpack does not declare a Minecraft version",
                    "В сборке не указана версия Minecraft",
                )
                .to_string());
            }
            self.minecraft.assert_version_exists(&gv).await?;
            let (loader, loader_version) = pick_loader(&index.dependencies, &gv);
            self.minecraft.assert_loader_compatible(&loader, &gv).await?;
            let wanted = Self::wanted_files(&index)?;
            let fallback_name = Path::new(file_path)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "Modpack".to_string());
            let name = index
                .name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(&fallback_name)
                .to_string();
            let instance = self
                .instances
                .create(CreateInstancePayload {
                    name,
                    game_version: gv,
                    loader,
                    loader_version,
                })
                .await?;
            let total_files = wanted.len();
            self.pending.lock().await.insert(
                instance.id.clone(),
                PendingImport {
                    tmp: tmp.clone(),
                    files: wanted,
                    at: Instant::now(),
                    created: true,
                    overrides,
                    cf_meta,
                },
            );
            Ok(MrpackBeginResult {
                instance,
                total_files,
                skipped: if skipped.is_empty() { None } else { Some(skipped) },
            })
        }
        .await;
        if res.is_err() {
            let _ = fs::remove_dir_all(&tmp);
        }
        res
    }

    pub async fn begin_import_to_instance(
        &self,
        file_path: &str,
        instance_id: &str,
    ) -> Result<MrpackTargetResult, String> {
        let (tmp, index, overrides, skipped, cf_meta) = self.unpack_index(file_path).await?;
        let res = async {
            let data = self.store.get_data().await;
            let inst = data
                .instances
                .iter()
                .find(|i| i.id == instance_id)
                .cloned()
                .ok_or_else(|| tr("Instance not found", "Инстанция не найдена").to_string())?;
            let gv = index
                .dependencies
                .get("minecraft")
                .map(String::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| inst.game_version.clone());
            let (picked_loader, _) = pick_loader(&index.dependencies, &gv);
            let pack_loader = if index.dependencies.contains_key("minecraft") {
                picked_loader
            } else {
                inst.loader.clone()
            };
            let wanted = Self::wanted_files(&index)?;
            let total_files = wanted.len();
            let fallback_name = Path::new(file_path)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "Modpack".to_string());
            let pack_name = index
                .name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(&fallback_name)
                .to_string();

            if let Some(old) = self.pending.lock().await.remove(instance_id) {
                let _ = fs::remove_dir_all(&old.tmp);
            }
            self.pending.lock().await.insert(
                instance_id.to_string(),
                PendingImport {
                    tmp: tmp.clone(),
                    files: wanted,
                    at: Instant::now(),
                    created: false,
                    overrides,
                    cf_meta,
                },
            );
            Ok(MrpackTargetResult {
                total_files,
                pack_name,
                pack_game_version: gv,
                pack_loader,
                skipped: if skipped.is_empty() { None } else { Some(skipped) },
            })
        }
        .await;
        if res.is_err() {
            let _ = fs::remove_dir_all(&tmp);
        }
        res
    }

    pub async fn cancel_import(&self, instance_id: &str) {
        if let Some(tok) = self.active_cancels.lock().await.get(instance_id) {
            tok.cancel();
        }
        if let Some(job) = self.pending.lock().await.remove(instance_id) {
            let _ = fs::remove_dir_all(&job.tmp);
            if job.created {
                let _ = self.instances.remove(instance_id).await;
            }
        }
    }

    pub async fn finish_import(
        &self,
        app: &AppHandle,
        instance_id: &str,
    ) -> Result<LauncherInstance, String> {
        let Some(job) = self.pending.lock().await.remove(instance_id) else {
            return Err(tr(
                "Import session expired, start the import again",
                "Сеанс импорта истёк, начните импорт заново",
            )
            .to_string());
        };
        let data = self.store.get_data().await;
        let Some(instance) = data.instances.iter().find(|i| i.id == instance_id).cloned() else {
            let _ = fs::remove_dir_all(&job.tmp);
            return Err(tr(
                "The instance was deleted before the import finished",
                "Инстанция была удалена до завершения импорта",
            )
            .to_string());
        };

        let cancel = CancellationToken::new();
        self.active_cancels
            .lock()
            .await
            .insert(instance_id.to_string(), cancel.clone());

        let limit = (data.settings.concurrent_downloads as usize).clamp(1, 16);
        let stage_dir = job.tmp.join("stage");
        let _ = fs::create_dir_all(&stage_dir);
        let total = job.files.len();
        let done_cnt = Arc::new(AtomicUsize::new(0));
        let downloaded = Arc::new(Mutex::new(Vec::<DownloadedEntry>::new()));

        let res = async {
            let mut futs = stream::iter(job.files.iter().cloned().map(|file| {
                let stage_dir = stage_dir.clone();
                let done_cnt = done_cnt.clone();
                let downloaded = downloaded.clone();
                let cancel = cancel.clone();
                let app = app.clone();
                let inst_id = instance_id.to_string();
                async move {
                    if cancel.is_cancelled() {
                        return Err(tr("Import cancelled", "Импорт отменён").to_string());
                    }
                    let mut bytes_opt = None;
                    let mut last_err = None;
                    for url in &file.downloads {
                        if cancel.is_cancelled() {
                            return Err(tr("Import cancelled", "Импорт отменён").to_string());
                        }
                        match self.client.get(url).send().await {
                            Ok(resp) if resp.status().is_success() => match resp.bytes().await {
                                Ok(b) => match verify_bytes(&b, file.hashes.as_ref(), &file.path) {
                                    Ok(()) => {
                                        bytes_opt = Some(b);
                                        break;
                                    }
                                    Err(e) => last_err = Some(e),
                                },
                                Err(e) => last_err = Some(e.to_string()),
                            },
                            Ok(resp) => last_err = Some(format!("HTTP {}", resp.status().as_u16())),
                            Err(e) => last_err = Some(e.to_string()),
                        }
                    }
                    let bytes = bytes_opt.ok_or_else(|| {
                        last_err.unwrap_or_else(|| format!("Failed to download {}", file.path))
                    })?;
                    let target = safe_rel_target(&stage_dir, &file.path)?;
                    if let Some(p) = target.parent() {
                        fs::create_dir_all(p).map_err(|e| e.to_string())?;
                    }
                    fs::write(&target, &bytes).map_err(|e| e.to_string())?;
                    let rel = file
                        .path
                        .replace('\\', "/")
                        .trim_start_matches("./")
                        .trim_start_matches('/')
                        .to_string();
                    let file_name = target
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    downloaded.lock().await.push(DownloadedEntry {
                        rel,
                        file_name,
                        sha512: file
                            .hashes
                            .as_ref()
                            .and_then(|h| h.sha512.as_deref())
                            .map(str::to_lowercase),
                        sha1: file
                            .hashes
                            .as_ref()
                            .and_then(|h| h.sha1.as_deref())
                            .map(str::to_lowercase),
                    });
                    let d = done_cnt.fetch_add(1, Ordering::Relaxed) + 1;
                    let _ = app.emit(
                        "instances:mrpack-progress",
                        json!({
                            "instanceId": inst_id,
                            "done": d,
                            "total": total,
                            "fileName": file.path
                        }),
                    );
                    Ok::<(), String>(())
                }
            }))
            .buffer_unordered(limit);

            while let Some(r) = futs.next().await {
                r?;
            }

            let inst_dir = PathBuf::from(&instance.directory);
            let tmp_ov = job.tmp.clone();
            let stage_ov = stage_dir.clone();
            let overrides_list = job.overrides.clone();
            let inst_dir_clone = inst_dir.clone();
            tokio::task::spawn_blocking(move || {
                for ov_name in overrides_list {
                    let ov_dir = tmp_ov.join(&ov_name);
                    if ov_dir.exists() {
                        copy_overrides(&ov_dir, &stage_ov, "")?;
                    }
                }
                copy_overrides(&stage_ov, &inst_dir_clone, "")
            })
            .await
            .map_err(|e| e.to_string())??;

            let entries = downloaded.lock().await;
            self.link_modrinth_entries(instance_id, &entries).await;
            if !job.cf_meta.is_empty() {
                self.link_cf_entries(instance_id, &entries, &job.cf_meta)
                    .await;
            }
            let _ = app.emit(
                "instances:mrpack-progress",
                json!({
                    "instanceId": instance_id,
                    "done": total,
                    "total": total,
                    "fileName": ""
                }),
            );
            let fresh = self.store.get_data().await;
            Ok(fresh
                .instances
                .into_iter()
                .find(|i| i.id == instance_id)
                .unwrap_or(instance))
        }
        .await;

        self.active_cancels.lock().await.remove(instance_id);
        let _ = fs::remove_dir_all(&job.tmp);
        if res.is_err() && job.created {
            let _ = self.instances.remove(instance_id).await;
        }
        res
    }

    async fn link_modrinth_entries(&self, instance_id: &str, entries: &[DownloadedEntry]) {
        let hashes: Vec<String> = entries
            .iter()
            .filter(|e| entry_location(&e.rel).is_some())
            .filter_map(|e| e.sha512.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        if hashes.is_empty() {
            return;
        }
        let versions: HashMap<String, Value> = match self
            .client
            .post("https://api.modrinth.com/v2/version_files")
            .json(&json!({ "hashes": hashes, "algorithm": "sha512" }))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => r.json().await.unwrap_or_default(),
            _ => return,
        };
        let pids: Vec<String> = versions
            .values()
            .filter_map(|v| v.get("project_id").and_then(Value::as_str).map(str::to_string))
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let mut projects: HashMap<String, Value> = HashMap::new();
        for chunk in pids.chunks(60) {
            if let Ok(ids_json) = serde_json::to_string(chunk) {
                if let Ok(r) = self
                    .client
                    .get("https://api.modrinth.com/v2/projects")
                    .query(&[("ids", &ids_json)])
                    .send()
                    .await
                {
                    if let Ok(list) = r.json::<Vec<Value>>().await {
                        for p in list {
                            if let Some(id) = p.get("id").and_then(Value::as_str) {
                                projects.insert(id.to_string(), p);
                            }
                        }
                    }
                }
            }
        }

        let id_owned = instance_id.to_string();
        if let Ok(updated) = self
            .store
            .update(|d| {
                let target = d
                    .instances
                    .iter_mut()
                    .find(|i| i.id == id_owned)
                    .ok_or_else(|| "not found".to_string())?;
                let now = Utc::now().to_rfc3339();
                for entry in entries {
                    let Some((pt, _)) = entry_location(&entry.rel) else {
                        continue;
                    };
                    let Some(hash) = entry.sha512.as_deref() else {
                        continue;
                    };
                    let Some(ver) = versions.get(hash) else {
                        continue;
                    };
                    let (Some(vid), Some(pid)) = (
                        ver.get("id").and_then(Value::as_str),
                        ver.get("project_id").and_then(Value::as_str),
                    ) else {
                        continue;
                    };
                    let proj = projects.get(pid);
                    let name = proj
                        .and_then(|p| p.get("title"))
                        .and_then(Value::as_str)
                        .unwrap_or(&entry.file_name)
                        .to_string();
                    let slug = proj
                        .and_then(|p| p.get("slug"))
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let icon_url = proj
                        .and_then(|p| p.get("icon_url"))
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    if let Some(ex) = target.mods.iter_mut().find(|m| {
                        m.project_type.as_deref().unwrap_or("mod") == pt
                            && ((m.provider == "modrinth" && m.project_id == pid)
                                || m.file_name
                                    .as_deref()
                                    .map(|f| f.eq_ignore_ascii_case(&entry.file_name))
                                    .unwrap_or(false))
                    }) {
                        ex.provider = "modrinth".to_string();
                        ex.project_id = pid.to_string();
                        ex.version_id = Some(vid.to_string());
                        ex.file_name = Some(entry.file_name.clone());
                        ex.name = name;
                        ex.slug = slug.or(ex.slug.clone());
                        ex.icon_url = icon_url.or(ex.icon_url.clone());
                        ex.installed_at = now.clone();
                    } else {
                        target.mods.push(InstalledMod {
                            id: Uuid::new_v4().to_string(),
                            provider: "modrinth".to_string(),
                            project_id: pid.to_string(),
                            version_id: Some(vid.to_string()),
                            name,
                            slug,
                            file_name: Some(entry.file_name.clone()),
                            icon_url,
                            installed_at: now.clone(),
                            status: "installed".to_string(),
                            project_type: Some(pt.to_string()),
                        });
                    }
                }
                target.updated_at = now;
                Ok(target.clone())
            })
            .await
        {
            write_content_manifest(&PathBuf::from(&updated.directory), &updated.mods);
        }
    }

    async fn link_cf_entries(
        &self,
        instance_id: &str,
        entries: &[DownloadedEntry],
        meta: &HashMap<String, ResolvedPackFile>,
    ) {
        let id_owned = instance_id.to_string();
        if let Ok(updated) = self
            .store
            .update(|d| {
                let target = d
                    .instances
                    .iter_mut()
                    .find(|i| i.id == id_owned)
                    .ok_or_else(|| "not found".to_string())?;
                let now = Utc::now().to_rfc3339();
                for entry in entries {
                    let Some(info) = meta.get(&entry.rel) else {
                        continue;
                    };
                    if let Some(ex) = target.mods.iter_mut().find(|m| {
                        m.project_type.as_deref().unwrap_or("mod") == info.project_type
                            && ((m.provider == "curseforge" && m.project_id == info.project_id)
                                || m.file_name
                                    .as_deref()
                                    .map(|f| f.eq_ignore_ascii_case(&entry.file_name))
                                    .unwrap_or(false))
                    }) {
                        ex.provider = "curseforge".to_string();
                        ex.project_id = info.project_id.clone();
                        ex.version_id = Some(info.file_id.clone());
                        ex.file_name = Some(entry.file_name.clone());
                        ex.name = info.name.clone();
                        ex.slug = info.slug.clone().or(ex.slug.clone());
                        ex.icon_url = info.icon_url.clone().or(ex.icon_url.clone());
                        ex.installed_at = now.clone();
                    } else {
                        target.mods.push(InstalledMod {
                            id: Uuid::new_v4().to_string(),
                            provider: "curseforge".to_string(),
                            project_id: info.project_id.clone(),
                            version_id: Some(info.file_id.clone()),
                            name: info.name.clone(),
                            slug: info.slug.clone(),
                            file_name: Some(entry.file_name.clone()),
                            icon_url: info.icon_url.clone(),
                            installed_at: now.clone(),
                            status: "installed".to_string(),
                            project_type: Some(info.project_type.clone()),
                        });
                    }
                }
                target.updated_at = now;
                Ok(target.clone())
            })
            .await
        {
            write_content_manifest(&PathBuf::from(&updated.directory), &updated.mods);
        }
    }

    pub async fn list_export_entries(&self, instance_id: &str) -> Result<Vec<ExportEntry>, String> {
        let data = self.store.get_data().await;
        let inst = data
            .instances
            .iter()
            .find(|i| i.id == instance_id)
            .cloned()
            .ok_or_else(|| tr("Instance not found", "Инстанция не найдена").to_string())?;
        let dir = PathBuf::from(&inst.directory);
        tokio::task::spawn_blocking(move || {
            let Ok(entries) = fs::read_dir(&dir) else {
                return Vec::new();
            };
            let mut out = Vec::new();
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name == ".launcher" {
                    continue;
                }
                let p = entry.path();
                if let Ok(meta) = fs::metadata(&p) {
                    let is_dir = meta.is_dir();
                    let size = if is_dir { dir_size(&p) } else { meta.len() };
                    let modified = meta
                        .modified()
                        .ok()
                        .map(|t| DateTime::<Utc>::from(t).to_rfc3339());
                    out.push(ExportEntry {
                        name,
                        is_dir,
                        size,
                        modified,
                    });
                }
            }
            out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
            out
        })
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn export_instance(
        &self,
        instance_id: &str,
        out_path: &str,
        include: Option<Vec<String>>,
    ) -> Result<String, String> {
        let data = self.store.get_data().await;
        let instance = data
            .instances
            .iter()
            .find(|i| i.id == instance_id)
            .cloned()
            .ok_or_else(|| tr("Instance not found", "Инстанция не найдена").to_string())?;

        let mut deps = HashMap::new();
        deps.insert("minecraft".to_string(), instance.game_version.clone());
        let lv = match instance.loader_version.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(v) => v.to_string(),
            None if instance.loader != "vanilla" => self
                .minecraft
                .list_loader_versions(&instance.loader, &instance.game_version)
                .await
                .unwrap_or_default()
                .into_iter()
                .next()
                .unwrap_or_default(),
            None => String::new(),
        };
        if !lv.is_empty() {
            match instance.loader.as_str() {
                "fabric" => {
                    deps.insert("fabric-loader".to_string(), lv);
                }
                "quilt" => {
                    deps.insert("quilt-loader".to_string(), lv);
                }
                "forge" => {
                    let short = lv
                        .strip_prefix(&format!("{}-", instance.game_version))
                        .unwrap_or(&lv)
                        .to_string();
                    deps.insert("forge".to_string(), short);
                }
                "neoforge" => {
                    deps.insert("neoforge".to_string(), lv);
                }
                _ => {}
            }
        }

        let ver_ids: Vec<String> = instance
            .mods
            .iter()
            .filter(|m| m.provider == "modrinth")
            .filter_map(|m| m.version_id.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let mut ver_map: HashMap<String, Value> = HashMap::new();
        for chunk in ver_ids.chunks(60) {
            if let Ok(ids_json) = serde_json::to_string(chunk) {
                if let Ok(r) = self
                    .client
                    .get("https://api.modrinth.com/v2/versions")
                    .query(&[("ids", &ids_json)])
                    .send()
                    .await
                {
                    if let Ok(list) = r.json::<Vec<Value>>().await {
                        for v in list {
                            if let Some(id) = v.get("id").and_then(Value::as_str) {
                                ver_map.insert(id.to_string(), v);
                            }
                        }
                    }
                }
            }
        }

        let inst_dir = PathBuf::from(&instance.directory);
        let out_pb = PathBuf::from(out_path);
        let included: Option<HashSet<String>> = include.map(|v| v.into_iter().collect());
        let tmp = get_launcher_root()
            .join("cache")
            .join("modpacks")
            .join(format!("export-{}", Uuid::new_v4()));

        let res = tokio::task::spawn_blocking(move || {
            let ov_dir = tmp.join("overrides");
            fs::create_dir_all(&ov_dir).map_err(|e| e.to_string())?;
            let mut files = Vec::new();
            let mut known_files = HashSet::new();

            for m in &instance.mods {
                let Some(fnm) = m.file_name.as_deref() else {
                    continue;
                };
                known_files.insert(fnm.to_lowercase());
                known_files.insert(format!("{fnm}.disabled").to_lowercase());
                if fnm.to_lowercase().ends_with(".disabled") {
                    continue;
                }
                let kind = m.project_type.as_deref().unwrap_or("mod");
                let folder = match kind {
                    "resourcepack" => "resourcepacks",
                    "shader" => "shaderpacks",
                    "datapack" => "datapacks",
                    _ => "mods",
                };
                if let Some(ref inc) = included {
                    if !inc.contains(folder) {
                        continue;
                    }
                }
                let src = inst_dir.join(folder).join(fnm);
                if !src.exists() {
                    continue;
                }
                let api_file = m
                    .version_id
                    .as_deref()
                    .and_then(|vid| ver_map.get(vid))
                    .and_then(|v| v.get("files"))
                    .and_then(Value::as_array)
                    .and_then(|arr| {
                        arr.iter()
                            .find(|f| {
                                f.get("filename")
                                    .and_then(Value::as_str)
                                    .map(|n| n.eq_ignore_ascii_case(fnm))
                                    .unwrap_or(false)
                            })
                            .or_else(|| arr.iter().find(|f| f.get("primary").and_then(Value::as_bool) == Some(true)))
                            .or_else(|| arr.first())
                    });
                if let Some(af) = api_file {
                    if let (Some(url), Some(fname), Some(sz)) = (
                        af.get("url").and_then(Value::as_str),
                        af.get("filename").and_then(Value::as_str),
                        af.get("size").and_then(Value::as_u64),
                    ) {
                        files.push(MrpackIndexFile {
                            path: format!("{folder}/{fname}"),
                            hashes: Some(MrpackHashes {
                                sha1: af.pointer("/hashes/sha1").and_then(Value::as_str).map(str::to_string),
                                sha512: af.pointer("/hashes/sha512").and_then(Value::as_str).map(str::to_string),
                            }),
                            env: Some(MrpackEnv {
                                client: Some("required".to_string()),
                                server: Some(if kind == "mod" { "optional" } else { "unsupported" }.to_string()),
                            }),
                            downloads: vec![url.to_string()],
                            file_size: Some(sz),
                        });
                        continue;
                    }
                }
                copy_tree_no_lock(&src, &ov_dir.join(folder).join(fnm))?;
            }

            for folder in ["mods", "resourcepacks", "shaderpacks", "datapacks"] {
                if let Some(ref inc) = included {
                    if !inc.contains(folder) {
                        continue;
                    }
                }
                if let Ok(rd) = fs::read_dir(inst_dir.join(folder)) {
                    for e in rd.flatten() {
                        let name = e.file_name().to_string_lossy().to_string();
                        if known_files.contains(&name.to_lowercase())
                            || name.to_lowercase().ends_with(".disabled")
                        {
                            continue;
                        }
                        copy_tree_no_lock(&e.path(), &ov_dir.join(folder).join(&name))?;
                    }
                }
            }

            let extras: Vec<String> = match &included {
                Some(inc) => inc
                    .iter()
                    .filter(|n| !matches!(n.as_str(), "mods" | "resourcepacks" | "shaderpacks" | "datapacks"))
                    .cloned()
                    .collect(),
                None => vec![
                    "config".into(),
                    "defaultconfigs".into(),
                    "options.txt".into(),
                    "optionsof.txt".into(),
                    "optionsshaders.txt".into(),
                    "servers.dat".into(),
                ],
            };
            for extra in extras {
                if extra.is_empty() || extra == ".launcher" || extra.contains("..") || extra.contains('/') || extra.contains('\\') {
                    continue;
                }
                let src = inst_dir.join(&extra);
                if src.exists() {
                    copy_tree_no_lock(&src, &ov_dir.join(&extra))?;
                }
            }

            let index = MrpackIndex {
                format_version: Some(1),
                game: Some("minecraft".to_string()),
                version_id: Some(Uuid::new_v4().to_string()),
                name: Some(instance.name.clone()),
                summary: Some(format!("{} / {}", instance.game_version, instance.loader)),
                dependencies: deps,
                files,
            };
            let idx_text = serde_json::to_string_pretty(&index).map_err(|e| e.to_string())?;
            fs::write(tmp.join("modrinth.index.json"), idx_text).map_err(|e| e.to_string())?;

            let stage = PathBuf::from(format!("{}.{}.zip", out_pb.to_string_lossy(), std::process::id()));
            create_zip_from_dir(&tmp, &stage, true, |_, _| true)?;
            let _ = fs::remove_file(&out_pb);
            fs::rename(&stage, &out_pb).map_err(|e| e.to_string())?;
            let _ = fs::remove_dir_all(&tmp);
            Ok::<String, String>(out_pb.to_string_lossy().to_string())
        })
        .await
        .map_err(|e| e.to_string())?;
        res
    }
}
