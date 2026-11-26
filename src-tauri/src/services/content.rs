use crate::i18n::{tr, tr_string};
use crate::services::curseforge::{curseforge_available, project_type_for_class, CurseForgeService};
use crate::services::hashes::{cf_fingerprint_cached, sha1_cached, write_content_manifest};
use crate::services::ziputil::{list_zip_entries, read_zip_entry_bytes};
use crate::store::JsonStore;
use crate::types::{
    ContentImportAdded, ContentImportResult, ContentImportSkipped, InstalledMod, LauncherInstance,
    LocalContentItem, ScreenshotInfo,
};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use chrono::{DateTime, Utc};
use once_cell::sync::Lazy;
use regex::Regex;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;

const KIND_ORDER: [&str; 4] = ["mod", "resourcepack", "shader", "datapack"];
const DISABLED_SUFFIX: &str = ".disabled";

static TOML_MOD_ID_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?im)^\s*modId\s*=\s*["']([^"']+)["']"#).unwrap());
static TOML_LOGO_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"logoFile\s*=\s*"([^"]+)""#).unwrap());

fn kind_dir(kind: &str) -> &'static str {
    match kind {
        "resourcepack" => "resourcepacks",
        "shader" => "shaderpacks",
        "datapack" => "datapacks",
        _ => "mods",
    }
}

fn kind_ext(kind: &str) -> &'static str {
    if kind == "mod" {
        ".jar"
    } else {
        ".zip"
    }
}

fn strip_disabled(name: &str) -> (&str, bool) {
    if name.len() >= DISABLED_SUFFIX.len()
        && name[name.len() - DISABLED_SUFFIX.len()..].eq_ignore_ascii_case(DISABLED_SUFFIX)
    {
        (&name[..name.len() - DISABLED_SUFFIX.len()], false)
    } else {
        (name, true)
    }
}

fn normalize_name(name: &str) -> String {
    strip_disabled(name).0.to_lowercase()
}

fn mime_for_ext(ext: &str) -> Option<&'static str> {
    match ext.to_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

fn entry_size(path: &Path) -> u64 {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return 0;
    };
    if meta.file_type().is_symlink() {
        return 0;
    }
    if !meta.is_dir() {
        return meta.len();
    }
    let mut total = 0u64;
    if let Ok(entries) = fs::read_dir(path) {
        for e in entries.flatten() {
            total = total.saturating_add(entry_size(&e.path()));
        }
    }
    total
}

fn world_datapack_dirs(instance_dir: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    let saves = instance_dir.join("saves");
    let Ok(entries) = fs::read_dir(&saves) else {
        return out;
    };
    for e in entries.flatten() {
        let p = e.path().join("datapacks");
        if p.is_dir() {
            out.push((e.file_name().to_string_lossy().to_string(), p));
        }
    }
    out
}

fn classify_entries(names: &[String]) -> Option<&'static str> {
    let mut list: Vec<String> = names
        .iter()
        .map(|n| n.to_lowercase().trim_start_matches("./").to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let roots: HashSet<String> = list
        .iter()
        .filter_map(|n| n.split('/').next().map(str::to_string))
        .collect();
    if roots.len() == 1 {
        let root = roots.into_iter().next().unwrap();
        if !matches!(root.as_str(), "shaders" | "assets" | "data" | "meta-inf")
            && list.iter().all(|n| n.starts_with(&format!("{root}/")))
        {
            list = list
                .into_iter()
                .map(|n| n[root.len() + 1..].to_string())
                .filter(|s| !s.is_empty())
                .collect();
        }
    }
    let has_pref = |p: &str| list.iter().any(|n| n == p || n.starts_with(&format!("{p}/")));
    if list.iter().any(|n| {
        matches!(
            n.as_str(),
            "fabric.mod.json" | "quilt.mod.json" | "meta-inf/mods.toml" | "meta-inf/neoforge.mods.toml"
        )
    }) {
        return Some("mod");
    }
    if has_pref("shaders") {
        return Some("shader");
    }
    if list.iter().any(|n| n == "pack.mcmeta") {
        if has_pref("data") && !has_pref("assets") {
            return Some("datapack");
        }
        return Some("resourcepack");
    }
    None
}

struct JarModMeta {
    mod_ids: Vec<String>,
    provides: Vec<String>,
    depends: Vec<String>,
}

fn is_builtin_mod_id(id: &str) -> bool {
    matches!(
        id,
        "minecraft"
            | "java"
            | "fabricloader"
            | "fabric_loader"
            | "fabric-loader"
            | "quilt_loader"
            | "quilt-loader"
            | "forge"
            | "neoforge"
            | "fml"
            | "mixinextras"
    )
}

fn read_jar_mod_meta(path: &Path) -> JarModMeta {
    let mut mod_ids = HashSet::new();
    let mut provides = HashSet::new();
    let mut depends = HashSet::new();
    let add = |set: &mut HashSet<String>, raw: &str| {
        let clean = raw.trim().to_lowercase();
        if !clean.is_empty() && !is_builtin_mod_id(&clean) {
            set.insert(clean);
        }
    };

    if let Ok(Some(bytes)) = read_zip_entry_bytes(path, "fabric.mod.json") {
        let text = String::from_utf8_lossy(&bytes).replace('\n', " ");
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            if let Some(id) = v.get("id").and_then(Value::as_str) {
                add(&mut mod_ids, id);
            }
            if let Some(arr) = v.get("provides").and_then(Value::as_array) {
                for p in arr {
                    if let Some(s) = p.as_str() {
                        add(&mut provides, s);
                    } else if let Some(s) = p.get("id").and_then(Value::as_str) {
                        add(&mut provides, s);
                    }
                }
            }
            if let Some(obj) = v.get("depends").and_then(Value::as_object) {
                for k in obj.keys() {
                    add(&mut depends, k);
                }
            }
        }
    }

    if let Ok(Some(bytes)) = read_zip_entry_bytes(path, "quilt.mod.json") {
        if let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
            if let Some(ql) = v.get("quilt_loader") {
                if let Some(id) = ql.get("id").and_then(Value::as_str) {
                    add(&mut mod_ids, id);
                }
                if let Some(arr) = ql.get("depends").and_then(Value::as_array) {
                    for d in arr {
                        if let Some(s) = d.as_str() {
                            add(&mut depends, s);
                        } else if d.get("optional").and_then(Value::as_bool) != Some(true) {
                            if let Some(s) = d.get("id").and_then(Value::as_str) {
                                add(&mut depends, s);
                            }
                        }
                    }
                }
            }
        }
    }

    for toml_name in ["META-INF/neoforge.mods.toml", "META-INF/mods.toml"] {
        if let Ok(Some(bytes)) = read_zip_entry_bytes(path, toml_name) {
            let text = String::from_utf8_lossy(&bytes);
            if let Some(cap) = TOML_MOD_ID_RE.captures(&text) {
                if let Some(m) = cap.get(1) {
                    add(&mut mod_ids, m.as_str());
                }
            }
        }
    }

    for id in &mod_ids {
        depends.remove(id);
    }
    for id in &provides {
        depends.remove(id);
    }
    JarModMeta {
        mod_ids: mod_ids.into_iter().collect(),
        provides: provides.into_iter().collect(),
        depends: depends.into_iter().collect(),
    }
}

fn read_archive_icon_data_url(archive: &Path, kind: &str) -> Option<String> {
    let entries = list_zip_entries(archive).ok()?;
    let find_entry = |wanted: &str| -> Option<String> {
        let lower = wanted.to_lowercase().replace('\\', "/");
        entries
            .iter()
            .find(|e| e.to_lowercase() == lower)
            .or_else(|| entries.iter().find(|e| e.to_lowercase().ends_with(&format!("/{lower}"))))
            .cloned()
    };
    let load_img = |wanted: &str| -> Option<String> {
        let found = find_entry(wanted)?;
        let ext = Path::new(&found).extension()?.to_str()?;
        let mime = mime_for_ext(ext)?;
        let bytes = read_zip_entry_bytes(archive, &found).ok()??;
        if bytes.len() > 2 * 1024 * 1024 {
            return None;
        }
        Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
    };

    if kind == "mod" {
        if let Some(fb) = find_entry("fabric.mod.json") {
            if let Ok(Some(raw)) = read_zip_entry_bytes(archive, &fb) {
                if let Ok(v) = serde_json::from_slice::<Value>(&raw) {
                    if let Some(icon) = v.get("icon").and_then(Value::as_str) {
                        if let Some(url) = load_img(icon) {
                            return Some(url);
                        }
                    }
                }
            }
        }
        for toml_name in ["META-INF/neoforge.mods.toml", "META-INF/mods.toml"] {
            if let Some(t) = find_entry(toml_name) {
                if let Ok(Some(raw)) = read_zip_entry_bytes(archive, &t) {
                    let text = String::from_utf8_lossy(&raw);
                    if let Some(logo) = TOML_LOGO_RE.captures(&text).and_then(|c| c.get(1)) {
                        if let Some(url) = load_img(logo.as_str()) {
                            return Some(url);
                        }
                    }
                }
            }
        }
        for cand in ["pack.png", "icon.png", "logo.png"] {
            if let Some(url) = load_img(cand) {
                return Some(url);
            }
        }
    } else if let Some(url) = load_img("pack.png") {
        return Some(url);
    }
    None
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HashCacheEntry {
    sha1: String,
    project_id: Option<String>,
    checked_at: i64,
    #[serde(default)]
    cf_checked: bool,
}

pub struct ContentService {
    client: Client,
    store: Arc<JsonStore>,
    curseforge: Arc<CurseForgeService>,
}

impl ContentService {
    pub fn new(store: Arc<JsonStore>, curseforge: Arc<CurseForgeService>) -> Self {
        let client = Client::builder()
            .user_agent("lynapp/2.0.0-beta.2")
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| Client::new());
        Self {
            client,
            store,
            curseforge,
        }
    }

    pub async fn list(&self, instance_id: &str) -> Result<Vec<LocalContentItem>, String> {
        let data = self.store.get_data().await;
        let instance = data
            .instances
            .iter()
            .find(|i| i.id == instance_id)
            .cloned()
            .ok_or_else(|| tr("Instance not found", "Инстанция не найдена").to_string())?;

        tokio::task::spawn_blocking(move || Self::list_sync(&instance))
            .await
            .map_err(|e| e.to_string())
    }

    fn list_sync(instance: &LauncherInstance) -> Vec<LocalContentItem> {
        let inst_dir = PathBuf::from(&instance.directory);
        let mut items = Vec::new();
        let mut seen = HashSet::new();

        for kind in KIND_ORDER {
            let dir = inst_dir.join(kind_dir(kind));
            let _ = fs::create_dir_all(&dir);
            let Ok(entries) = fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let full = entry.path();
                let Ok(meta) = fs::metadata(&full) else {
                    continue;
                };
                let is_dir = meta.is_dir();
                if is_dir && kind == "mod" {
                    continue;
                }
                let file_name = entry.file_name().to_string_lossy().to_string();
                let (base, enabled) = strip_disabled(&file_name);
                let lower_base = base.to_lowercase();
                if !is_dir && !lower_base.ends_with(kind_ext(kind)) {
                    continue;
                }
                let record = instance.mods.iter().find(|m| {
                    m.project_type.as_deref().unwrap_or("mod") == kind
                        && m.file_name
                            .as_deref()
                            .map(|f| normalize_name(f) == lower_base)
                            .unwrap_or(false)
                });
                let icon_url = record
                    .and_then(|r| r.icon_url.clone())
                    .or_else(|| {
                        if is_dir {
                            fs::read(full.join("pack.png"))
                                .ok()
                                .map(|b| format!("data:image/png;base64,{}", STANDARD.encode(b)))
                        } else {
                            read_archive_icon_data_url(&full, kind)
                        }
                    });
                let modified = meta
                    .modified()
                    .ok()
                    .map(|t| DateTime::<Utc>::from(t).to_rfc3339())
                    .unwrap_or_else(|| Utc::now().to_rfc3339());
                seen.insert(format!("{kind}:{lower_base}"));
                items.push(LocalContentItem {
                    kind: kind.to_string(),
                    file_name: file_name.clone(),
                    display_name: record.map(|r| r.name.clone()).unwrap_or_else(|| base.to_string()),
                    world: None,
                    icon_url,
                    size: entry_size(&full),
                    modified,
                    enabled,
                    source: match record {
                        Some(r) if r.provider == "curseforge" => "curseforge",
                        Some(_) => "modrinth",
                        None => "manual",
                    }
                    .to_string(),
                    duplicate_of: None,
                    dependents: None,
                });
            }
        }

        let mut seen_world = HashSet::new();
        for (world, dir) in world_datapack_dirs(&inst_dir) {
            let Ok(entries) = fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let full = entry.path();
                let Ok(meta) = fs::metadata(&full) else {
                    continue;
                };
                let is_dir = meta.is_dir();
                let file_name = entry.file_name().to_string_lossy().to_string();
                let (base, enabled) = strip_disabled(&file_name);
                let lower_base = base.to_lowercase();
                if !is_dir && !lower_base.ends_with(".zip") {
                    continue;
                }
                if !seen_world.insert(format!("{world}:{lower_base}")) {
                    continue;
                }
                let record = instance.mods.iter().find(|m| {
                    m.project_type.as_deref().unwrap_or("mod") == "datapack"
                        && m.file_name
                            .as_deref()
                            .map(|f| normalize_name(f) == lower_base)
                            .unwrap_or(false)
                });
                let modified = meta
                    .modified()
                    .ok()
                    .map(|t| DateTime::<Utc>::from(t).to_rfc3339())
                    .unwrap_or_else(|| Utc::now().to_rfc3339());
                seen.insert(format!("datapack:{lower_base}"));
                items.push(LocalContentItem {
                    kind: "datapack".to_string(),
                    file_name: file_name.clone(),
                    display_name: format!(
                        "{} ({world})",
                        record.map(|r| r.name.as_str()).unwrap_or(base)
                    ),
                    world: Some(world.clone()),
                    icon_url: record.and_then(|r| r.icon_url.clone()),
                    size: entry_size(&full),
                    modified,
                    enabled,
                    source: match record {
                        Some(r) if r.provider == "curseforge" => "curseforge",
                        Some(_) => "modrinth",
                        None => "manual",
                    }
                    .to_string(),
                    duplicate_of: None,
                    dependents: None,
                });
            }
        }

        for m in &instance.mods {
            let kind = m.project_type.as_deref().unwrap_or("mod");
            let Some(fnm) = m.file_name.as_deref() else {
                continue;
            };
            if !KIND_ORDER.contains(&kind) || seen.contains(&format!("{kind}:{}", normalize_name(fnm)))
            {
                continue;
            }
            items.push(LocalContentItem {
                kind: kind.to_string(),
                file_name: fnm.to_string(),
                display_name: m.name.clone(),
                world: None,
                icon_url: m.icon_url.clone(),
                size: 0,
                modified: m.installed_at.clone(),
                enabled: false,
                source: "missing".to_string(),
                duplicate_of: None,
                dependents: None,
            });
        }

        Self::annotate_relations(&inst_dir, instance, &mut items);

        items.sort_by(|a, b| {
            let ai = KIND_ORDER.iter().position(|&k| k == a.kind).unwrap_or(9);
            let bi = KIND_ORDER.iter().position(|&k| k == b.kind).unwrap_or(9);
            ai.cmp(&bi)
                .then_with(|| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()))
        });
        items
    }

    fn annotate_relations(
        inst_dir: &Path,
        instance: &LauncherInstance,
        items: &mut [LocalContentItem],
    ) {
        let mod_indices: Vec<usize> = items
            .iter()
            .enumerate()
            .filter(|(_, i)| i.kind == "mod" && i.source != "missing")
            .map(|(idx, _)| idx)
            .collect();
        if mod_indices.len() < 2 {
            return;
        }
        let mods_dir = inst_dir.join("mods");
        let mut metas: HashMap<usize, JarModMeta> = HashMap::new();
        let mut records: HashMap<usize, Option<&InstalledMod>> = HashMap::new();
        for &idx in &mod_indices {
            let lower = normalize_name(&items[idx].file_name);
            let rec = instance.mods.iter().find(|m| {
                m.project_type.as_deref().unwrap_or("mod") == "mod"
                    && m.file_name
                        .as_deref()
                        .map(|f| normalize_name(f) == lower)
                        .unwrap_or(false)
            });
            records.insert(idx, rec);
            metas.insert(idx, read_jar_mod_meta(&mods_dir.join(&items[idx].file_name)));
        }

        for i in 0..mod_indices.len() {
            let a = mod_indices[i];
            if !items[a].enabled {
                continue;
            }
            for j in (i + 1)..mod_indices.len() {
                let b = mod_indices[j];
                if !items[b].enabled {
                    continue;
                }
                let same_proj = match (records[&a], records[&b]) {
                    (Some(ra), Some(rb)) => ra.provider == rb.provider && ra.project_id == rb.project_id,
                    _ => false,
                };
                let same_id = match (metas[&a].mod_ids.first(), metas[&b].mod_ids.first()) {
                    (Some(ma), Some(mb)) => ma == mb,
                    _ => false,
                };
                if same_proj || same_id {
                    let b_name = items[b].file_name.clone();
                    let a_name = items[a].file_name.clone();
                    if items[a].duplicate_of.is_none() {
                        items[a].duplicate_of = Some(b_name);
                    }
                    if items[b].duplicate_of.is_none() {
                        items[b].duplicate_of = Some(a_name);
                    }
                }
            }
        }

        for &p_idx in &mod_indices {
            let mut offered: HashSet<String> = HashSet::new();
            for id in &metas[&p_idx].mod_ids {
                offered.insert(id.clone());
            }
            for id in &metas[&p_idx].provides {
                offered.insert(id.clone());
            }
            if let Some(rec) = records[&p_idx] {
                if let Some(s) = &rec.slug {
                    offered.insert(s.to_lowercase());
                }
                if rec.project_id == "P7dR8mSH" || rec.project_id == "306612" {
                    offered.insert("fabric".to_string());
                    offered.insert("fabric-api".to_string());
                }
            }
            if offered.is_empty() {
                continue;
            }
            let mut dependents = Vec::new();
            for &c_idx in &mod_indices {
                if c_idx == p_idx || !items[c_idx].enabled {
                    continue;
                }
                if metas[&c_idx].depends.iter().any(|d| offered.contains(d)) {
                    let dn = items[c_idx].display_name.clone();
                    if !dependents.contains(&dn) {
                        dependents.push(dn);
                    }
                }
            }
            if !dependents.is_empty() {
                items[p_idx].dependents = Some(dependents);
            }
        }
    }

    fn find_entry(
        inst_dir: &Path,
        file_name: &str,
        only_kind: Option<&str>,
        world: Option<&str>,
    ) -> Result<Option<(String, PathBuf, String)>, String> {
        if file_name.is_empty()
            || file_name.contains("..")
            || file_name.contains('/')
            || file_name.contains('\\')
        {
            return Err(tr_string(
                format!("Unsafe file name: {file_name}"),
                format!("Недопустимое имя файла: {file_name}"),
            ));
        }
        let (base, enabled) = strip_disabled(file_name);
        let variant = if enabled {
            format!("{file_name}{DISABLED_SUFFIX}")
        } else {
            base.to_string()
        };

        if let Some(w) = world {
            if w.is_empty() || w.contains("..") || w.contains('/') || w.contains('\\') {
                return Err(tr("Unsafe world name", "Недопустимое имя мира").to_string());
            }
            let wdir = inst_dir.join("saves").join(w).join("datapacks");
            for cand in [file_name, variant.as_str()] {
                if wdir.join(cand).exists() {
                    return Ok(Some(("datapack".to_string(), wdir, cand.to_string())));
                }
            }
            return Ok(None);
        }

        let kinds: Vec<&str> = match only_kind {
            Some(k) => vec![k],
            None => KIND_ORDER.to_vec(),
        };
        for k in kinds {
            let dir = inst_dir.join(kind_dir(k));
            if dir.join(file_name).exists() {
                return Ok(Some((k.to_string(), dir, file_name.to_string())));
            }
            if dir.join(&variant).exists() {
                return Ok(Some((k.to_string(), dir, variant)));
            }
        }
        Ok(None)
    }

    pub async fn toggle(
        &self,
        instance_id: &str,
        file_name: &str,
        kind: Option<&str>,
        world: Option<&str>,
    ) -> Result<Vec<LocalContentItem>, String> {
        let data = self.store.get_data().await;
        let instance = data
            .instances
            .iter()
            .find(|i| i.id == instance_id)
            .cloned()
            .ok_or_else(|| tr("Instance not found", "Инстанция не найдена").to_string())?;
        let inst_dir = PathBuf::from(&instance.directory);
        let Some((found_kind, dir, actual_name)) = Self::find_entry(&inst_dir, file_name, kind, world)? else {
            return Err(tr_string(
                format!("File not found: {file_name}"),
                format!("Файл не найден: {file_name}"),
            ));
        };
        let (base, enabled) = strip_disabled(&actual_name);
        let next_name = if enabled {
            format!("{actual_name}{DISABLED_SUFFIX}")
        } else {
            base.to_string()
        };
        let dest = dir.join(&next_name);
        if dest.exists() {
            return Err(tr_string(
                format!("Cannot toggle {actual_name}: {next_name} already exists"),
                format!("Не удалось переключить {actual_name}: {next_name} уже существует"),
            ));
        }
        fs::rename(dir.join(&actual_name), &dest).map_err(|e| e.to_string())?;

        let norm = normalize_name(&actual_name);
        let id_owned = instance_id.to_string();
        let next_clone = next_name.clone();
        let updated = self
            .store
            .update(|d| {
                let target = d
                    .instances
                    .iter_mut()
                    .find(|i| i.id == id_owned)
                    .ok_or_else(|| tr("Instance not found", "Инстанция не найдена").to_string())?;
                if let Some(rec) = target.mods.iter_mut().find(|m| {
                    m.project_type.as_deref().unwrap_or("mod") == found_kind
                        && m.file_name
                            .as_deref()
                            .map(|f| normalize_name(f) == norm)
                            .unwrap_or(false)
                }) {
                    rec.file_name = Some(next_clone);
                }
                target.updated_at = Utc::now().to_rfc3339();
                Ok(target.clone())
            })
            .await?;
        write_content_manifest(&PathBuf::from(&updated.directory), &updated.mods);
        self.list(instance_id).await
    }

    pub async fn remove(
        &self,
        instance_id: &str,
        file_name: &str,
        kind: Option<&str>,
        world: Option<&str>,
    ) -> Result<Vec<LocalContentItem>, String> {
        let data = self.store.get_data().await;
        let instance = data
            .instances
            .iter()
            .find(|i| i.id == instance_id)
            .cloned()
            .ok_or_else(|| tr("Instance not found", "Инстанция не найдена").to_string())?;
        let inst_dir = PathBuf::from(&instance.directory);
        let loc = Self::find_entry(&inst_dir, file_name, kind, world)?;

        if let Some((found_kind, dir, actual_name)) = loc {
            let full = dir.join(&actual_name);
            if full.is_dir() {
                let _ = fs::remove_dir_all(&full);
            } else {
                let _ = fs::remove_file(&full);
            }
            let norm = normalize_name(&actual_name);
            let id_owned = instance_id.to_string();
            let updated = self
                .store
                .update(|d| {
                    let target = d
                        .instances
                        .iter_mut()
                        .find(|i| i.id == id_owned)
                        .ok_or_else(|| tr("Instance not found", "Инстанция не найдена").to_string())?;
                    target.mods.retain(|m| {
                        !(m.project_type.as_deref().unwrap_or("mod") == found_kind
                            && m.file_name
                                .as_deref()
                                .map(|f| normalize_name(f) == norm)
                                .unwrap_or(false))
                    });
                    target.updated_at = Utc::now().to_rfc3339();
                    Ok(target.clone())
                })
                .await?;
            write_content_manifest(&PathBuf::from(&updated.directory), &updated.mods);
            return self.list(instance_id).await;
        }

        let norm = normalize_name(file_name);
        let id_owned = instance_id.to_string();
        let kind_owned = kind.map(str::to_string);
        let updated = self
            .store
            .update(|d| {
                let target = d
                    .instances
                    .iter_mut()
                    .find(|i| i.id == id_owned)
                    .ok_or_else(|| tr("Instance not found", "Инстанция не найдена").to_string())?;
                target.mods.retain(|m| {
                    let matches_file = m
                        .file_name
                        .as_deref()
                        .map(|f| normalize_name(f) == norm)
                        .unwrap_or(false);
                    let matches_kind = kind_owned
                        .as_deref()
                        .map(|k| m.project_type.as_deref().unwrap_or("mod") == k)
                        .unwrap_or(true);
                    !(matches_file && matches_kind)
                });
                target.updated_at = Utc::now().to_rfc3339();
                Ok(target.clone())
            })
            .await?;
        write_content_manifest(&PathBuf::from(&updated.directory), &updated.mods);
        self.list(instance_id).await
    }

    pub async fn import_files(
        &self,
        instance_id: &str,
        paths: &[String],
    ) -> Result<ContentImportResult, String> {
        let data = self.store.get_data().await;
        let instance = data
            .instances
            .iter()
            .find(|i| i.id == instance_id)
            .cloned()
            .ok_or_else(|| tr("Instance not found", "Инстанция не найдена").to_string())?;
        let inst_dir = PathBuf::from(&instance.directory);

        let mut added = Vec::new();
        let mut skipped = Vec::new();
        for src_str in paths {
            let src = PathBuf::from(src_str);
            let name = src
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| src_str.clone());
            let Ok(meta) = fs::metadata(&src) else {
                skipped.push(ContentImportSkipped {
                    file_name: name,
                    reason: "failed".to_string(),
                });
                continue;
            };
            let base_lower = normalize_name(&name);
            let kind = if meta.is_dir() {
                let entries: Vec<String> = fs::read_dir(&src)
                    .ok()
                    .map(|rd| {
                        rd.flatten()
                            .map(|e| {
                                let n = e.file_name().to_string_lossy().to_string();
                                if e.path().is_dir() {
                                    format!("{n}/")
                                } else {
                                    n
                                }
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                classify_entries(&entries)
            } else if base_lower.ends_with(".jar") {
                Some("mod")
            } else if base_lower.ends_with(".zip") {
                let entries = list_zip_entries(&src).unwrap_or_default();
                classify_entries(&entries)
            } else {
                skipped.push(ContentImportSkipped {
                    file_name: name,
                    reason: "unsupported".to_string(),
                });
                continue;
            };

            let Some(kind) = kind else {
                skipped.push(ContentImportSkipped {
                    file_name: name,
                    reason: "unknown".to_string(),
                });
                continue;
            };

            let mut destinations = if kind == "datapack" {
                world_datapack_dirs(&inst_dir)
                    .into_iter()
                    .map(|(_, d)| d)
                    .collect::<Vec<_>>()
            } else {
                Vec::new()
            };
            if destinations.is_empty() {
                destinations.push(inst_dir.join(kind_dir(kind)));
            }
            let (base, _) = strip_disabled(&name);
            if destinations
                .iter()
                .any(|d| d.join(base).exists() || d.join(format!("{base}{DISABLED_SUFFIX}")).exists())
            {
                skipped.push(ContentImportSkipped {
                    file_name: name,
                    reason: "exists".to_string(),
                });
                continue;
            }
            let mut ok = true;
            for d in &destinations {
                if fs::create_dir_all(d).is_err() {
                    ok = false;
                    break;
                }
                let target = d.join(&name);
                let copy_res = if meta.is_dir() {
                    copy_dir_simple(&src, &target)
                } else {
                    fs::copy(&src, &target).map(|_| ()).map_err(|e| e.to_string())
                };
                if copy_res.is_err() {
                    ok = false;
                    break;
                }
            }
            if ok {
                added.push(ContentImportAdded {
                    file_name: name,
                    kind: kind.to_string(),
                });
            } else {
                skipped.push(ContentImportSkipped {
                    file_name: name,
                    reason: "failed".to_string(),
                });
            }
        }
        Ok(ContentImportResult { added, skipped })
    }

    pub async fn detect_from_modrinth(&self, instance_id: &str) -> Result<LauncherInstance, String> {
        let data = self.store.get_data().await;
        let instance = data
            .instances
            .iter()
            .find(|i| i.id == instance_id)
            .cloned()
            .ok_or_else(|| tr("Instance not found", "Инстанция не найдена").to_string())?;
        let inst_dir = PathBuf::from(&instance.directory);
        let cache_path = inst_dir.join(".launcher").join("hash-cache.json");
        let mut cache: HashMap<String, HashCacheEntry> = fs::read_to_string(&cache_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();

        let known: HashSet<String> = instance
            .mods
            .iter()
            .filter_map(|m| {
                Some(format!(
                    "{}:{}",
                    m.project_type.as_deref().unwrap_or("mod"),
                    normalize_name(m.file_name.as_deref()?)
                ))
            })
            .collect();

        struct Unlinked {
            kind: String,
            file_name: String,
            full_path: PathBuf,
            cache_key: String,
            sha1: String,
        }

        let now_ms = Utc::now().timestamp_millis();
        let can_cf = curseforge_available();
        let mut to_lookup = Vec::new();
        let mut seen_unlinked = HashSet::new();
        let wdirs: Vec<PathBuf> = world_datapack_dirs(&inst_dir)
            .into_iter()
            .map(|(_, d)| d)
            .collect();

        for kind in KIND_ORDER {
            let mut dirs = vec![inst_dir.join(kind_dir(kind))];
            if kind == "datapack" {
                dirs.extend(wdirs.clone());
            }
            for dir in dirs {
                let Ok(entries) = fs::read_dir(&dir) else {
                    continue;
                };
                for entry in entries.flatten() {
                    let full = entry.path();
                    if !full.is_file() {
                        continue;
                    }
                    let fnm = entry.file_name().to_string_lossy().to_string();
                    let lower_base = normalize_name(&fnm);
                    if !lower_base.ends_with(kind_ext(kind)) {
                        continue;
                    }
                    let k = format!("{kind}:{lower_base}");
                    if known.contains(&k) || !seen_unlinked.insert(k) {
                        continue;
                    }
                    let Ok(meta) = fs::metadata(&full) else {
                        continue;
                    };
                    let mtime = meta
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis())
                        .unwrap_or(0);
                    let ckey = format!("{kind}/{lower_base}|{}|{mtime}", meta.len());
                    if let Some(c) = cache.get(&ckey) {
                        if c.project_id.is_none()
                            && (!can_cf || c.cf_checked)
                            && now_ms - c.checked_at < 3 * 24 * 60 * 60 * 1000
                        {
                            continue;
                        }
                    }
                    let sha1 = cache
                        .get(&ckey)
                        .map(|c| c.sha1.clone())
                        .or_else(|| sha1_cached(&full).ok());
                    if let Some(sha1) = sha1 {
                        to_lookup.push(Unlinked {
                            kind: kind.to_string(),
                            file_name: fnm,
                            full_path: full,
                            cache_key: ckey,
                            sha1,
                        });
                    }
                }
            }
        }
        if to_lookup.is_empty() {
            return Ok(instance);
        }

        let hashes: Vec<String> = to_lookup
            .iter()
            .map(|u| u.sha1.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let versions: HashMap<String, Value> = match self
            .client
            .post("https://api.modrinth.com/v2/version_files")
            .json(&json!({ "hashes": hashes, "algorithm": "sha1" }))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => r.json().await.unwrap_or_default(),
            _ => HashMap::new(),
        };

        let proj_ids: Vec<String> = versions
            .values()
            .filter_map(|v| v.get("project_id").and_then(Value::as_str).map(str::to_string))
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let mut projects: HashMap<String, Value> = HashMap::new();
        for chunk in proj_ids.chunks(60) {
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

        struct MatchedItem {
            kind: String,
            file_name: String,
            provider: String,
            project_id: String,
            version_id: String,
            name: String,
            slug: Option<String>,
            icon_url: Option<String>,
        }

        let mut matched = Vec::new();
        let mut unmatched_idx = Vec::new();
        for (idx, u) in to_lookup.iter().enumerate() {
            if let Some(v) = versions.get(&u.sha1) {
                if let (Some(vid), Some(pid)) = (
                    v.get("id").and_then(Value::as_str),
                    v.get("project_id").and_then(Value::as_str),
                ) {
                    let p = projects.get(pid);
                    cache.insert(
                        u.cache_key.clone(),
                        HashCacheEntry {
                            sha1: u.sha1.clone(),
                            project_id: Some(pid.to_string()),
                            checked_at: now_ms,
                            cf_checked: true,
                        },
                    );
                    matched.push(MatchedItem {
                        kind: u.kind.clone(),
                        file_name: u.file_name.clone(),
                        provider: "modrinth".to_string(),
                        project_id: pid.to_string(),
                        version_id: vid.to_string(),
                        name: p
                            .and_then(|x| x.get("title"))
                            .and_then(Value::as_str)
                            .unwrap_or_else(|| strip_disabled(&u.file_name).0)
                            .to_string(),
                        slug: p
                            .and_then(|x| x.get("slug"))
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        icon_url: p
                            .and_then(|x| x.get("icon_url"))
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    });
                    continue;
                }
            }
            unmatched_idx.push(idx);
        }

        if !unmatched_idx.is_empty() && can_cf {
            let mut fps = HashMap::new();
            for &idx in &unmatched_idx {
                if let Ok(fp) = cf_fingerprint_cached(&to_lookup[idx].full_path) {
                    if fp > 0 {
                        fps.insert(idx, fp);
                    }
                }
            }
            let fp_list: Vec<u32> = fps.values().copied().collect();
            let cf_matches = self.curseforge.match_fingerprints(&fp_list).await;
            let mod_ids: Vec<u64> = cf_matches.values().map(|m| m.id).collect();
            let cf_mods = self.curseforge.get_mods_by_ids(&mod_ids).await;
            for idx in unmatched_idx {
                let u = &to_lookup[idx];
                let hit = fps.get(&idx).and_then(|fp| cf_matches.get(fp));
                if let Some(m) = hit {
                    let cm = cf_mods.get(&m.id);
                    cache.insert(
                        u.cache_key.clone(),
                        HashCacheEntry {
                            sha1: u.sha1.clone(),
                            project_id: Some(m.id.to_string()),
                            checked_at: now_ms,
                            cf_checked: true,
                        },
                    );
                    matched.push(MatchedItem {
                        kind: project_type_for_class(cm.and_then(|x| x.class_id), &u.kind),
                        file_name: u.file_name.clone(),
                        provider: "curseforge".to_string(),
                        project_id: m.id.to_string(),
                        version_id: m.file.id.to_string(),
                        name: cm
                            .map(|x| x.name.clone())
                            .unwrap_or_else(|| strip_disabled(&u.file_name).0.to_string()),
                        slug: cm.and_then(|x| x.slug.clone()),
                        icon_url: cm
                            .and_then(|x| x.logo.as_ref())
                            .and_then(|l| l.thumbnail_url.clone().or_else(|| l.url.clone())),
                    });
                } else {
                    cache.insert(
                        u.cache_key.clone(),
                        HashCacheEntry {
                            sha1: u.sha1.clone(),
                            project_id: None,
                            checked_at: now_ms,
                            cf_checked: true,
                        },
                    );
                }
            }
        } else {
            for idx in unmatched_idx {
                let u = &to_lookup[idx];
                cache.insert(
                    u.cache_key.clone(),
                    HashCacheEntry {
                        sha1: u.sha1.clone(),
                        project_id: None,
                        checked_at: now_ms,
                        cf_checked: false,
                    },
                );
            }
        }

        if let Some(p) = cache_path.parent() {
            let _ = fs::create_dir_all(p);
        }
        if let Ok(text) = serde_json::to_string(&cache) {
            let _ = fs::write(&cache_path, text);
        }
        if matched.is_empty() {
            return Ok(instance);
        }

        let id_owned = instance_id.to_string();
        let updated = self
            .store
            .update(|d| {
                let target = d
                    .instances
                    .iter_mut()
                    .find(|i| i.id == id_owned)
                    .ok_or_else(|| tr("Instance not found", "Инстанция не найдена").to_string())?;
                let now = Utc::now().to_rfc3339();
                for item in matched {
                    if let Some(existing) = target.mods.iter_mut().find(|m| {
                        m.provider == item.provider
                            && m.project_id == item.project_id
                            && m.project_type.as_deref().unwrap_or("mod") == item.kind
                    }) {
                        existing.file_name = Some(item.file_name);
                        existing.version_id = Some(item.version_id);
                        continue;
                    }
                    target.mods.push(InstalledMod {
                        id: Uuid::new_v4().to_string(),
                        provider: item.provider,
                        project_id: item.project_id,
                        version_id: Some(item.version_id),
                        name: item.name,
                        slug: item.slug,
                        file_name: Some(item.file_name),
                        icon_url: item.icon_url,
                        installed_at: now.clone(),
                        status: "installed".to_string(),
                        project_type: Some(item.kind),
                    });
                }
                target.updated_at = now;
                Ok(target.clone())
            })
            .await?;
        write_content_manifest(&PathBuf::from(&updated.directory), &updated.mods);
        Ok(updated)
    }

    pub async fn list_screenshots(&self, instance_id: &str) -> Result<Vec<ScreenshotInfo>, String> {
        let data = self.store.get_data().await;
        let inst = data
            .instances
            .iter()
            .find(|i| i.id == instance_id)
            .cloned()
            .ok_or_else(|| tr("Instance not found", "Инстанция не найдена").to_string())?;
        let dir = PathBuf::from(&inst.directory).join("screenshots");
        tokio::task::spawn_blocking(move || {
            let Ok(entries) = fs::read_dir(&dir) else {
                return Vec::new();
            };
            let mut out = Vec::new();
            for entry in entries.flatten() {
                let p = entry.path();
                if !p.is_file() {
                    continue;
                }
                let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
                let Some(mime) = mime_for_ext(ext) else {
                    continue;
                };
                if let (Ok(meta), Ok(bytes)) = (fs::metadata(&p), fs::read(&p)) {
                    let modified = meta
                        .modified()
                        .ok()
                        .map(|t| DateTime::<Utc>::from(t).to_rfc3339())
                        .unwrap_or_else(|| Utc::now().to_rfc3339());
                    out.push(ScreenshotInfo {
                        file_name: entry.file_name().to_string_lossy().to_string(),
                        size: meta.len(),
                        modified,
                        data_url: format!("data:{mime};base64,{}", STANDARD.encode(bytes)),
                    });
                }
            }
            out.sort_by(|a, b| b.modified.cmp(&a.modified));
            out
        })
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn copy_screenshot(&self, instance_id: &str, file_name: &str) -> Result<bool, String> {
        if file_name.is_empty() || file_name.contains("..") || file_name.contains('/') || file_name.contains('\\') {
            return Ok(false);
        }
        let data = self.store.get_data().await;
        let Some(inst) = data.instances.iter().find(|i| i.id == instance_id).cloned() else {
            return Ok(false);
        };
        let path = PathBuf::from(&inst.directory).join("screenshots").join(file_name);
        tokio::task::spawn_blocking(move || {
            let Ok(img) = image::open(&path) else {
                return false;
            };
            let rgba = img.to_rgba8();
            let (w, h) = rgba.dimensions();
            let Ok(mut cb) = arboard::Clipboard::new() else {
                return false;
            };
            cb.set_image(arboard::ImageData {
                width: w as usize,
                height: h as usize,
                bytes: std::borrow::Cow::Owned(rgba.into_raw()),
            })
            .is_ok()
        })
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn delete_screenshot(
        &self,
        instance_id: &str,
        file_name: &str,
    ) -> Result<Vec<ScreenshotInfo>, String> {
        if file_name.is_empty() || file_name.contains("..") || file_name.contains('/') || file_name.contains('\\') {
            return Err(tr("Invalid file name", "Недопустимое имя файла").to_string());
        }
        let data = self.store.get_data().await;
        let inst = data
            .instances
            .iter()
            .find(|i| i.id == instance_id)
            .cloned()
            .ok_or_else(|| tr("Instance not found", "Инстанция не найдена").to_string())?;
        let path = PathBuf::from(&inst.directory).join("screenshots").join(file_name);
        let _ = fs::remove_file(&path);
        self.list_screenshots(instance_id).await
    }
}

fn copy_dir_simple(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        if ty.is_dir() {
            copy_dir_simple(&entry.path(), &dst.join(entry.file_name()))?;
        } else {
            fs::copy(entry.path(), dst.join(entry.file_name())).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
