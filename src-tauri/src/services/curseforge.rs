use crate::i18n::{tr, tr_string};
use crate::paths::get_launcher_root;
use crate::services::hashes::{cf_fingerprint_cached, write_content_manifest};
use crate::services::mods::{sanitize_file_part, target_directories};
use crate::store::JsonStore;
use crate::types::{
    ContentIncompatibility, ContentUpdateInfo, DownloadModpackPayload, InstallModPayload,
    InstalledMod, LauncherInstance, ModDependencyItem, ModGalleryItem, ModInstallPlan,
    ModProjectDetails, ModSearchPayload, ModSearchResponse, ModSearchResult, ModVersionInfo,
    PrepareModInstallPayload,
};
use chrono::Utc;
use futures_util::StreamExt;
use once_cell::sync::Lazy;
use regex::Regex;
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use uuid::Uuid;

const API: &str = "https://api.curseforge.com/v1";
const MINECRAFT_GAME_ID: u32 = 432;
const USER_AGENT: &str = "lynapp/2.0.0-beta.2";

static AUX_JAR_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)(?:^|[-_.+])(sources|javadoc|dev|deobf|preshadow)\.jar$").unwrap()
});
static TEXT_VER_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?:^|[^0-9.])(1\.(?:7\.10|8\.9|9\.4|10\.2|11\.2|12(?:\.[12])?|13\.2|14(?:\.[2-4])?|15\.2|16(?:\.[1-5])?|17\.1|18(?:\.[12])?|19(?:\.[1-4])?|20(?:\.[1-6])?|21(?:\.\d{1,2})?)|2[6-9]\.\d{1,2}(?:\.\d{1,2})?)").unwrap()
});
static CORE_VER_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?:^|[^0-9a-z])v?(\d+\.\d+(?:\.\d+)?(?:[-+._a-z0-9]*)?)").unwrap());
static MC_VER_EXACT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^1\.(?:7\.10|8\.9|9\.4|10\.2|11\.2|12(?:\.[12])?|13\.2|14(?:\.[2-4])?|15\.2|16(?:\.[1-5])?|17\.1|18(?:\.[12])?|19(?:\.[1-4])?|20(?:\.[1-6])?|21(?:\.\d{1,2})?)$").unwrap()
});

pub fn cf_api_key() -> String {
    if let Ok(v) = std::env::var("MAIN_VITE_CURSEFORGE_API_KEY") {
        if !v.trim().is_empty() {
            return v.trim().to_string();
        }
    }
    if let Ok(v) = std::env::var("CURSEFORGE_API_KEY") {
        if !v.trim().is_empty() {
            return v.trim().to_string();
        }
    }
    option_env!("MAIN_VITE_CURSEFORGE_API_KEY")
        .or(option_env!("CURSEFORGE_API_KEY"))
        .unwrap_or("")
        .trim()
        .to_string()
}

pub fn curseforge_available() -> bool {
    !cf_api_key().is_empty()
}

pub fn class_id_for(project_type: &str) -> u32 {
    match project_type {
        "resourcepack" => 12,
        "shader" => 6552,
        "datapack" => 6945,
        "modpack" => 4471,
        _ => 6,
    }
}

pub fn project_type_for_class(class_id: Option<u32>, fallback: &str) -> String {
    match class_id {
        Some(6) => "mod",
        Some(12) => "resourcepack",
        Some(6552) => "shader",
        Some(6945) => "datapack",
        Some(4471) => "modpack",
        _ => fallback,
    }
    .to_string()
}

fn class_folder(class_id: Option<u32>) -> &'static str {
    match class_id {
        Some(12) => "resourcepacks",
        Some(6552) => "shaderpacks",
        Some(6945) => "datapacks",
        _ => "mods",
    }
}

fn loader_by_type(id: u32) -> Option<&'static str> {
    match id {
        1 => Some("forge"),
        4 => Some("fabric"),
        5 => Some("quilt"),
        6 => Some("neoforge"),
        _ => None,
    }
}

fn loader_type_id(loader: &str) -> Option<u32> {
    match loader {
        "forge" => Some(1),
        "fabric" => Some(4),
        "quilt" => Some(5),
        "neoforge" => Some(6),
        _ => None,
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CfLogo {
    pub thumbnail_url: Option<String>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CfLinks {
    pub website_url: Option<String>,
    pub wiki_url: Option<String>,
    pub issues_url: Option<String>,
    pub source_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CfAuthor {
    pub name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CfCategoryRef {
    pub id: u32,
    pub name: String,
    #[serde(default)]
    pub is_class: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CfScreenshot {
    pub title: Option<String>,
    pub description: Option<String>,
    pub url: Option<String>,
    pub thumbnail_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CfFileIndex {
    pub game_version: Option<String>,
    pub mod_loader: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CfHash {
    pub value: String,
    pub algo: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CfDep {
    pub mod_id: u64,
    pub relation_type: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CfModule {
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CfFile {
    pub id: u64,
    pub mod_id: u64,
    pub display_name: Option<String>,
    pub file_name: String,
    pub release_type: Option<u32>,
    pub file_date: Option<String>,
    pub file_length: Option<u64>,
    pub download_url: Option<String>,
    #[serde(default)]
    pub game_versions: Vec<String>,
    #[serde(default)]
    pub hashes: Vec<CfHash>,
    #[serde(default)]
    pub dependencies: Vec<CfDep>,
    #[serde(default)]
    pub modules: Vec<CfModule>,
    pub file_fingerprint: Option<u32>,
    #[serde(default)]
    pub is_server_pack: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CfMod {
    pub id: u64,
    pub name: String,
    pub slug: Option<String>,
    pub summary: Option<String>,
    pub download_count: Option<u64>,
    pub favorite_count: Option<u64>,
    pub thumbs_up_count: Option<u64>,
    pub date_modified: Option<String>,
    pub date_released: Option<String>,
    pub class_id: Option<u32>,
    pub allow_mod_distribution: Option<bool>,
    pub logo: Option<CfLogo>,
    #[serde(default)]
    pub authors: Vec<CfAuthor>,
    #[serde(default)]
    pub categories: Vec<CfCategoryRef>,
    pub links: Option<CfLinks>,
    #[serde(default)]
    pub screenshots: Vec<CfScreenshot>,
    #[serde(default)]
    pub latest_files: Vec<CfFile>,
    #[serde(default)]
    pub latest_files_indexes: Vec<CfFileIndex>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CfFingerprintMatch {
    pub id: u64,
    pub file: CfFile,
}

#[derive(Debug, Clone)]
pub struct CfTrackedItem {
    pub provider: String,
    pub project_id: Option<String>,
    pub version_id: Option<String>,
    pub project_type: String,
    pub file_name: String,
    pub found_path: PathBuf,
    pub sha1: Option<String>,
    pub current_version_number: Option<String>,
    pub installed_date: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct CurseForgeManifest {
    pub manifest_type: Option<String>,
    pub name: Option<String>,
    pub overrides: Option<String>,
    pub minecraft: Option<CfManifestMinecraft>,
    #[serde(default)]
    pub files: Vec<CfManifestFile>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CfManifestMinecraft {
    pub version: Option<String>,
    #[serde(default)]
    pub mod_loaders: Vec<CfManifestLoader>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CfManifestLoader {
    pub id: Option<String>,
    #[serde(default)]
    pub primary: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CfManifestFile {
    #[serde(rename = "projectID")]
    pub project_id: Option<u64>,
    #[serde(rename = "fileID")]
    pub file_id: Option<u64>,
    pub required: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct ResolvedPackFile {
    pub path: String,
    pub url: String,
    pub sha1: Option<String>,
    pub size: Option<u64>,
    pub project_id: String,
    pub file_id: String,
    pub name: String,
    pub slug: Option<String>,
    pub icon_url: Option<String>,
    pub project_type: String,
}

pub fn curseforge_dependencies(manifest: &CurseForgeManifest) -> HashMap<String, String> {
    let mut deps = HashMap::new();
    let gv = manifest
        .minecraft
        .as_ref()
        .and_then(|m| m.version.as_deref())
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    if !gv.is_empty() {
        deps.insert("minecraft".to_string(), gv.clone());
    }
    if let Some(mc) = &manifest.minecraft {
        let loader = mc
            .mod_loaders
            .iter()
            .find(|l| l.primary)
            .or_else(|| mc.mod_loaders.first());
        if let Some(id) = loader.and_then(|l| l.id.as_deref()).map(str::trim) {
            if let Some((kind, ver)) = id.split_once('-') {
                match kind.to_lowercase().as_str() {
                    "fabric" => {
                        deps.insert("fabric-loader".to_string(), ver.to_string());
                    }
                    "quilt" => {
                        deps.insert("quilt-loader".to_string(), ver.to_string());
                    }
                    "forge" => {
                        deps.insert("forge".to_string(), ver.to_string());
                    }
                    "neoforge" => {
                        let clean = ver.strip_prefix(&format!("{gv}-")).unwrap_or(ver);
                        deps.insert("neoforge".to_string(), clean.to_string());
                    }
                    _ => {}
                }
            }
        }
    }
    deps
}

fn sha1_of(file: &CfFile) -> Option<String> {
    file.hashes
        .iter()
        .find(|h| h.algo == 1)
        .map(|h| h.value.to_lowercase())
}

fn is_non_version_tag(s: &str) -> bool {
    matches!(
        s.to_lowercase().as_str(),
        "client"
            | "server"
            | "forge"
            | "fabric"
            | "quilt"
            | "neoforge"
            | "rift"
            | "liteloader"
            | "cauldron"
            | "bukkit"
            | "spigot"
            | "paper"
    ) || s.to_lowercase().starts_with("java ")
}

fn is_pre_neoforge(ver: &str) -> bool {
    let lower = ver.trim().to_lowercase();
    if lower.starts_with("b1.")
        || lower.starts_with("a1.")
        || lower.starts_with("inf")
        || lower.starts_with("c0.")
        || lower.starts_with("rd-")
    {
        return true;
    }
    let parts: Vec<&str> = lower.split('.').collect();
    if parts.first() == Some(&"1") && parts.len() >= 2 {
        if let Ok(minor) = parts[1].parse::<u32>() {
            let patch = parts.get(2).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
            return minor < 20 || (minor == 20 && patch <= 1);
        }
    }
    false
}

fn extract_versions_from_text(text: &str) -> Vec<String> {
    let mut set = Vec::new();
    for cap in TEXT_VER_RE.captures_iter(text) {
        if let Some(m) = cap.get(1) {
            let s = m.as_str().to_string();
            if !set.contains(&s) {
                set.push(s);
            }
        }
    }
    set
}

pub fn infer_file_game_versions(file: &CfFile, fallback: &[String]) -> Vec<String> {
    let direct: Vec<String> = file
        .game_versions
        .iter()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty() && !is_non_version_tag(v))
        .collect();
    if !direct.is_empty() {
        return direct;
    }
    let text = format!("{} {}", file.file_name, file.display_name.as_deref().unwrap_or(""));
    let from_text = extract_versions_from_text(&text);
    if !from_text.is_empty() {
        return from_text;
    }
    fallback.to_vec()
}

pub fn infer_file_loaders(file: &CfFile, fallback: &[String]) -> Vec<String> {
    let modules: HashSet<String> = file.modules.iter().map(|m| m.name.to_lowercase()).collect();
    let has_quilt_json = modules.contains("quilt.mod.json") || modules.contains("quilt.json");
    let has_fabric_json = modules.contains("fabric.mod.json");
    let has_mcmod_info = modules.contains("mcmod.info");
    let has_meta_inf = modules.contains("meta-inf");

    let text = format!(
        "{} {}",
        file.file_name,
        file.display_name.as_deref().unwrap_or("")
    )
    .to_lowercase();
    let name_nf = text.contains("neoforge") || text.contains("neoforged");
    let stripped = text.replace("neoforged", "").replace("neoforge", "");
    let name_forge = stripped.contains("forge");
    let name_fabric = text.contains("fabric");
    let name_quilt = text.contains("quilt");

    let gv_set: HashSet<String> = file.game_versions.iter().map(|v| v.to_lowercase()).collect();
    let gv_forge = gv_set.contains("forge");
    let gv_nf = gv_set.contains("neoforge");
    let gv_fabric = gv_set.contains("fabric");
    let gv_quilt = gv_set.contains("quilt");
    let all_four = gv_forge && gv_nf && gv_fabric && gv_quilt;

    let dep_ids: HashSet<u64> = file.dependencies.iter().map(|d| d.mod_id).collect();
    let dep_fabric = dep_ids.contains(&306612) || dep_ids.contains(&308769);
    let dep_quilt = dep_ids.contains(&634179) || dep_ids.contains(&720410);

    if !modules.is_empty() {
        if has_quilt_json || has_fabric_json {
            let explicit_non_fabric =
                (name_nf || name_forge) && !name_fabric && !name_quilt && !dep_fabric && !dep_quilt;
            let tagged_non_fabric =
                !all_four && (gv_nf || gv_forge) && !gv_fabric && !gv_quilt && !dep_fabric && !dep_quilt;
            if !explicit_non_fabric && !tagged_non_fabric {
                let mut out = Vec::new();
                if has_quilt_json || (gv_quilt && !all_four) || name_quilt || dep_quilt {
                    out.push("quilt".to_string());
                }
                if has_fabric_json || (gv_fabric && !all_four) || name_fabric || dep_fabric {
                    out.push("fabric".to_string());
                }
                if has_mcmod_info || name_forge || (gv_forge && !all_four && !name_fabric && !name_quilt) {
                    out.push("forge".to_string());
                }
                if name_nf || (gv_nf && !all_four && !name_fabric && !name_quilt) {
                    out.push("neoforge".to_string());
                }
                return out;
            }
        }
        if has_meta_inf || has_mcmod_info {
            if has_mcmod_info {
                return vec!["forge".to_string()];
            }
            if name_nf && !name_forge {
                return vec!["neoforge".to_string()];
            }
            if name_forge && !name_nf {
                return vec!["forge".to_string()];
            }
            let vers = infer_file_game_versions(file, &[]);
            if !vers.is_empty() && vers.iter().all(|v| is_pre_neoforge(v)) {
                return vec!["forge".to_string()];
            }
            if !all_four {
                let mut tagged = Vec::new();
                if gv_forge {
                    tagged.push("forge".to_string());
                }
                if gv_nf {
                    tagged.push("neoforge".to_string());
                }
                if !tagged.is_empty() {
                    return tagged;
                }
            }
            let fb: Vec<String> = fallback
                .iter()
                .filter(|l| l.as_str() == "forge" || l.as_str() == "neoforge")
                .cloned()
                .collect();
            return if fb.is_empty() {
                vec!["forge".to_string(), "neoforge".to_string()]
            } else {
                fb
            };
        }
    }

    let mut explicit = Vec::new();
    if name_quilt || dep_quilt || (gv_quilt && !all_four) {
        explicit.push("quilt".to_string());
    }
    if name_fabric || dep_fabric || (gv_fabric && !all_four) {
        explicit.push("fabric".to_string());
    }
    if name_nf || (gv_nf && !all_four) {
        explicit.push("neoforge".to_string());
    }
    if name_forge || (gv_forge && !all_four) {
        explicit.push("forge".to_string());
    }
    if !explicit.is_empty() {
        let vers = infer_file_game_versions(file, &[]);
        if explicit.iter().any(|l| l == "neoforge")
            && !name_nf
            && !vers.is_empty()
            && vers.iter().all(|v| is_pre_neoforge(v))
        {
            explicit.retain(|l| l != "neoforge");
            if !explicit.iter().any(|l| l == "forge") {
                explicit.push("forge".to_string());
            }
        }
        return explicit;
    }

    fallback.to_vec()
}

fn infer_mod_loaders(files: &[CfFile], mod_opt: Option<&CfMod>) -> Vec<String> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    if let Some(m) = mod_opt {
        for idx in &m.latest_files_indexes {
            if let Some(l) = idx.mod_loader.and_then(loader_by_type) {
                *counts.entry(l.to_string()).or_insert(0) += 1;
            }
        }
    }
    for f in files {
        for l in infer_file_loaders(f, &[]) {
            *counts.entry(l).or_insert(0) += 1;
        }
    }
    let mut pairs: Vec<(String, usize)> = counts.into_iter().collect();
    pairs.sort_by(|a, b| b.1.cmp(&a.1));
    pairs.into_iter().map(|(l, _)| l).collect()
}

fn infer_mod_versions(files: &[CfFile], mod_opt: Option<&CfMod>) -> Vec<String> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    if let Some(m) = mod_opt {
        for idx in &m.latest_files_indexes {
            if let Some(gv) = &idx.game_version {
                *counts.entry(gv.clone()).or_insert(0) += 1;
            }
        }
    }
    for f in files {
        for v in infer_file_game_versions(f, &[]) {
            *counts.entry(v).or_insert(0) += 1;
        }
    }
    let mut pairs: Vec<(String, usize)> = counts.into_iter().collect();
    pairs.sort_by(|a, b| b.1.cmp(&a.1));
    pairs.into_iter().map(|(v, _)| v).collect()
}

fn is_usable_cf_file(file: &CfFile, project_type: &str) -> bool {
    if file.is_server_pack {
        return false;
    }
    let lower = file.file_name.to_lowercase();
    if project_type == "mod" {
        return lower.ends_with(".jar") && !AUX_JAR_RE.is_match(&lower);
    }
    if matches!(
        project_type,
        "modpack" | "resourcepack" | "shader" | "datapack"
    ) {
        return lower.ends_with(".zip");
    }
    true
}

fn target_loaders_for(project_type: &str, loader: &str) -> Vec<String> {
    if project_type != "mod" && project_type != "modpack" {
        return Vec::new();
    }
    if loader.is_empty() || loader == "vanilla" || loader == "*" {
        return Vec::new();
    }
    if loader == "quilt" && project_type == "mod" {
        return vec!["quilt".to_string(), "fabric".to_string()];
    }
    vec![loader.to_string()]
}

fn pick_file(files: &[CfFile]) -> Option<CfFile> {
    if files.is_empty() {
        return None;
    }
    let mut sorted = files.to_vec();
    sorted.sort_by(|a, b| {
        b.file_date
            .as_deref()
            .unwrap_or("")
            .cmp(a.file_date.as_deref().unwrap_or(""))
            .then_with(|| b.id.cmp(&a.id))
    });
    let newest = &sorted[0];
    let newest_day = newest
        .file_date
        .as_deref()
        .map(|d| &d[..d.len().min(10)])
        .unwrap_or("");
    if newest.release_type != Some(1) && !newest_day.is_empty() {
        if let Some(rel) = sorted.iter().find(|f| {
            f.release_type == Some(1)
                && f.file_date
                    .as_deref()
                    .map(|d| &d[..d.len().min(10)])
                    .unwrap_or("")
                    == newest_day
        }) {
            return Some(rel.clone());
        }
    }
    Some(newest.clone())
}

fn clean_version_number(file: &CfFile) -> String {
    if let Some(dn) = file.display_name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        return dn.to_string();
    }
    let base = file
        .file_name
        .strip_suffix(".jar")
        .or_else(|| file.file_name.strip_suffix(".zip"))
        .or_else(|| file.file_name.strip_suffix(".mrpack"))
        .unwrap_or(&file.file_name);
    if base.is_empty() {
        file.id.to_string()
    } else {
        base.to_string()
    }
}

fn extract_core_version_token(raw: &str) -> String {
    let lower = raw
        .to_lowercase()
        .replace(".jar", "")
        .replace(".zip", "")
        .replace(".mrpack", "");
    let matches: Vec<String> = CORE_VER_RE
        .captures_iter(&lower)
        .filter_map(|c| c.get(1).map(|m| m.as_str().to_string()))
        .filter(|v| !MC_VER_EXACT_RE.is_match(v))
        .collect();
    if let Some(last) = matches.last() {
        return last.clone();
    }
    lower.trim().to_string()
}

fn strip_leading_v(s: &str) -> String {
    let t = s.trim().to_lowercase();
    if t.starts_with('v') && t.as_bytes().get(1).map(|b| b.is_ascii_digit()).unwrap_or(false) {
        t[1..].to_string()
    } else {
        t
    }
}

fn is_same_release_version(
    candidate: &CfFile,
    current_file: Option<&CfFile>,
    mr_version: Option<&str>,
) -> bool {
    let cand_clean = strip_leading_v(&clean_version_number(candidate));
    if let Some(cur) = current_file {
        let cur_clean = strip_leading_v(&clean_version_number(cur));
        if !cand_clean.is_empty() && cand_clean == cur_clean {
            return true;
        }
    }
    if let Some(mr) = mr_version {
        let mr_clean = strip_leading_v(mr);
        if !mr_clean.is_empty()
            && (cand_clean == mr_clean
                || extract_core_version_token(&candidate.file_name) == mr_clean
                || extract_core_version_token(&cand_clean) == extract_core_version_token(&mr_clean))
        {
            return true;
        }
    }
    false
}

fn cf_file_page_url(website: Option<&str>, file_id: u64) -> Option<String> {
    website.map(|w| format!("{}/files/{file_id}", w.trim_end_matches('/')))
}

fn to_cf_version_info(
    file: &CfFile,
    instance: &LauncherInstance,
    project_type: &str,
    fallback_loaders: &[String],
    fallback_versions: &[String],
    blocked: bool,
    website_url: Option<String>,
) -> ModVersionInfo {
    let usable = is_usable_cf_file(file, project_type);
    let game_versions = infer_file_game_versions(file, fallback_versions);
    let eff_fb_loaders: &[String] = if fallback_loaders.len() <= 1 {
        fallback_loaders
    } else {
        &[]
    };
    let loaders = if project_type == "mod" || project_type == "modpack" {
        infer_file_loaders(file, eff_fb_loaders)
    } else {
        Vec::new()
    };
    let wanted = target_loaders_for(project_type, &instance.loader);
    let version_ok = game_versions.is_empty() || game_versions.iter().any(|v| v == &instance.game_version);
    let loader_ok = if (project_type == "mod" || project_type == "modpack") && instance.loader == "vanilla" {
        false
    } else if wanted.is_empty() {
        true
    } else if !loaders.is_empty() {
        loaders.iter().any(|l| wanted.contains(l))
    } else {
        fallback_loaders.len() <= 1
    };
    let version_type = match file.release_type {
        Some(3) => "alpha",
        Some(2) => "beta",
        _ => "release",
    }
    .to_string();
    ModVersionInfo {
        id: file.id.to_string(),
        name: file
            .display_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&file.file_name)
            .to_string(),
        version_number: clean_version_number(file),
        version_type,
        date_published: file.file_date.clone().unwrap_or_default(),
        game_versions,
        loaders,
        file_name: file.file_name.clone(),
        size: file.file_length.unwrap_or(0),
        compatible: usable && version_ok && loader_ok,
        provider: Some("curseforge".to_string()),
        project_id: Some(file.mod_id.to_string()),
        distribution_blocked: if blocked { Some(true) } else { None },
        website_url: if blocked { website_url } else { None },
    }
}

fn cf_incompatibility(
    file: &CfFile,
    instance: &LauncherInstance,
    fallback_loaders: &[String],
    fallback_versions: &[String],
) -> Option<ContentIncompatibility> {
    let supported_gv = infer_file_game_versions(file, fallback_versions);
    let supported_loaders = infer_file_loaders(file, fallback_loaders);
    let wanted = target_loaders_for("mod", &instance.loader);
    let wrong_game = !supported_gv.is_empty() && !supported_gv.iter().any(|v| v == &instance.game_version);
    let wrong_loader = instance.loader == "vanilla"
        || (!wanted.is_empty()
            && !supported_loaders.is_empty()
            && !supported_loaders.iter().any(|l| wanted.contains(l)));
    if !wrong_game && !wrong_loader {
        return None;
    }
    Some(ContentIncompatibility {
        game_version: if wrong_game {
            Some(instance.game_version.clone())
        } else {
            None
        },
        loader: if wrong_loader {
            Some(instance.loader.clone())
        } else {
            None
        },
        supported_game_versions: supported_gv,
        supported_loaders,
    })
}

fn latest_mod_date(m: &CfMod) -> Option<String> {
    let mut dates: Vec<&str> = Vec::new();
    if let Some(d) = m.date_modified.as_deref() {
        dates.push(d);
    }
    if let Some(d) = m.date_released.as_deref() {
        dates.push(d);
    }
    for f in &m.latest_files {
        if let Some(d) = f.file_date.as_deref() {
            dates.push(d);
        }
    }
    dates.into_iter().max().map(str::to_string)
}

fn title_match_rank(m: &CfMod, query: &str) -> i32 {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return 0;
    }
    let q_slug = q.split_whitespace().collect::<Vec<_>>().join("-");
    let name = m.name.trim().to_lowercase();
    let slug = m.slug.as_deref().unwrap_or("").trim().to_lowercase();
    if name == q || slug == q || slug == q_slug {
        return 4;
    }
    if name.starts_with(&q) || slug.starts_with(&q_slug) {
        return 3;
    }
    if name.contains(&q) || slug.contains(&q_slug) {
        return 2;
    }
    let tokens: Vec<&str> = q.split_whitespace().collect();
    if tokens.len() > 1 && tokens.iter().all(|t| name.contains(t) || slug.contains(t)) {
        return 1;
    }
    0
}

pub struct CurseForgeService {
    client: Client,
    store: Arc<JsonStore>,
    cat_cache: Mutex<HashMap<u32, Vec<CfCategoryRef>>>,
    files_cache: Mutex<HashMap<String, (Instant, Vec<CfFile>)>>,
}

impl CurseForgeService {
    pub fn new(store: Arc<JsonStore>) -> Self {
        let client = Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| Client::new());
        Self {
            client,
            store,
            cat_cache: Mutex::new(HashMap::new()),
            files_cache: Mutex::new(HashMap::new()),
        }
    }

    async fn request_json<T: for<'de> Deserialize<'de>>(
        &self,
        path_and_query: &str,
        post_body: Option<Value>,
    ) -> Result<T, String> {
        let key = cf_api_key();
        if key.is_empty() {
            return Err(tr(
                "CurseForge is not available in this build",
                "CurseForge недоступен в этой сборке",
            )
            .to_string());
        }
        let url = format!("{API}{path_and_query}");
        let mut req = match post_body {
            Some(body) => self.client.post(url).json(&body),
            None => self.client.get(url),
        };
        req = req.header("x-api-key", key).header("accept", "application/json");
        let resp = req.send().await.map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        if status == 401 || status == 403 {
            return Err(tr_string(
                format!("CurseForge rejected the API key (HTTP {status})"),
                format!("CurseForge не принял ключ API (HTTP {status})"),
            ));
        }
        if status >= 300 {
            return Err(tr_string(
                format!("CurseForge returned HTTP {status}"),
                format!("CurseForge вернул ошибку: HTTP {status}"),
            ));
        }
        resp.json::<T>().await.map_err(|e| e.to_string())
    }

    async fn categories(&self, project_type: &str) -> Result<Vec<CfCategoryRef>, String> {
        let cid = class_id_for(project_type);
        if let Some(cached) = self.cat_cache.lock().await.get(&cid) {
            return Ok(cached.clone());
        }
        #[derive(Deserialize)]
        struct Body {
            #[serde(default)]
            data: Vec<CfCategoryRef>,
        }
        let body: Body = self
            .request_json(
                &format!("/categories?gameId={MINECRAFT_GAME_ID}&classId={cid}"),
                None,
            )
            .await?;
        let mut list: Vec<CfCategoryRef> = body.data.into_iter().filter(|c| !c.is_class).collect();
        list.sort_by(|a, b| a.name.cmp(&b.name));
        self.cat_cache.lock().await.insert(cid, list.clone());
        Ok(list)
    }

    pub async fn get_category_tags(&self, project_type: &str) -> Result<Vec<String>, String> {
        Ok(self
            .categories(project_type)
            .await?
            .into_iter()
            .map(|c| c.name)
            .collect())
    }

    fn to_search_result(m: &CfMod, project_type: &str) -> ModSearchResult {
        ModSearchResult {
            id: m.id.to_string(),
            provider: "curseforge".to_string(),
            title: m.name.clone(),
            slug: m.slug.clone(),
            author: m.authors.first().and_then(|a| a.name.clone()),
            summary: m.summary.clone().unwrap_or_default(),
            icon_url: m
                .logo
                .as_ref()
                .and_then(|l| l.thumbnail_url.clone().or_else(|| l.url.clone())),
            downloads: m.download_count,
            follows: m.favorite_count.or(m.thumbs_up_count),
            date_modified: latest_mod_date(m),
            categories: m.categories.iter().map(|c| c.name.clone()).collect(),
            project_type: project_type.to_string(),
            website_url: m.links.as_ref().and_then(|l| l.website_url.clone()),
            distribution_blocked: if m.allow_mod_distribution == Some(false) {
                Some(true)
            } else {
                None
            },
        }
    }

    pub async fn search(&self, payload: &ModSearchPayload) -> Result<ModSearchResponse, String> {
        let data = self.store.get_data().await;
        let instance = match &payload.instance_id {
            Some(id) => Some(
                data.instances
                    .iter()
                    .find(|i| &i.id == id)
                    .cloned()
                    .ok_or_else(|| tr("Instance not found", "Инстанция не найдена").to_string())?,
            ),
            None => None,
        };

        let page_size = payload.limit.unwrap_or(20).clamp(5, 50);
        let index = payload.offset.unwrap_or(0).min(10000 - page_size);
        let query = payload.query.trim();
        let sort_key = payload.sort.as_deref().unwrap_or("relevance");
        let sort_field = if sort_key == "relevance" && !query.is_empty() {
            2
        } else {
            match sort_key {
                "downloads" => 6,
                "follows" => 2,
                "newest" => 11,
                "updated" => 3,
                _ => 1,
            }
        };

        let mut params = vec![
            ("gameId".to_string(), MINECRAFT_GAME_ID.to_string()),
            ("classId".to_string(), class_id_for(&payload.project_type).to_string()),
            ("sortField".to_string(), sort_field.to_string()),
            ("sortOrder".to_string(), "desc".to_string()),
            ("index".to_string(), index.to_string()),
            ("pageSize".to_string(), page_size.to_string()),
        ];
        if !query.is_empty() {
            params.push(("searchFilter".to_string(), query.to_string()));
        }
        if let Some(cats) = &payload.categories {
            if !cats.is_empty() {
                if let Ok(known) = self.categories(&payload.project_type).await {
                    let ids: Vec<u32> = cats
                        .iter()
                        .filter_map(|name| known.iter().find(|c| &c.name == name).map(|c| c.id))
                        .take(10)
                        .collect();
                    if !ids.is_empty() {
                        params.push((
                            "categoryIds".to_string(),
                            serde_json::to_string(&ids).unwrap_or_default(),
                        ));
                    }
                }
            }
        }

        let explicit_ver = payload.versions.as_ref().and_then(|v| v.first()).map(String::as_str);
        let game_version = match explicit_ver {
            Some("*") => None,
            Some(v) => Some(v.to_string()),
            None if payload.project_type == "modpack" => None,
            None => instance.as_ref().map(|i| i.game_version.clone()),
        };

        let explicit_loader = payload.loaders.as_ref().and_then(|l| l.first()).map(String::as_str);
        let raw_loader = match explicit_loader {
            Some("*") => None,
            Some(l) => Some(l.to_string()),
            None if payload.project_type == "mod" => instance
                .as_ref()
                .filter(|i| i.loader != "vanilla")
                .map(|i| i.loader.clone()),
            None => None,
        };
        let loader_type = raw_loader.as_deref().and_then(|l| {
            if l == "quilt" && payload.project_type == "mod" {
                loader_type_id("fabric")
            } else {
                loader_type_id(l)
            }
        });

        let mut primary_params = params.clone();
        if let Some(ref gv) = game_version {
            primary_params.push(("gameVersion".to_string(), gv.clone()));
        }
        if let Some(lt) = loader_type {
            if payload.project_type == "mod"
                || (payload.project_type == "modpack"
                    && explicit_loader.is_some()
                    && explicit_loader != Some("*"))
            {
                primary_params.push(("modLoaderType".to_string(), lt.to_string()));
            }
        }

        let qs = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(&primary_params)
            .finish();

        #[derive(Deserialize)]
        struct Pag {
            #[serde(rename = "totalCount")]
            total_count: Option<u64>,
        }
        #[derive(Deserialize)]
        struct Resp {
            #[serde(default)]
            data: Vec<CfMod>,
            pagination: Option<Pag>,
        }
        let body: Resp = self.request_json(&format!("/mods/search?{qs}"), None).await?;
        let mut mods = body.data;
        let total = body
            .pagination
            .and_then(|p| p.total_count)
            .unwrap_or(mods.len() as u64);

        if sort_key == "relevance" && !query.is_empty() && mods.len() > 1 {
            mods.sort_by(|a, b| title_match_rank(b, query).cmp(&title_match_rank(a, query)));
        }

        let results = mods
            .iter()
            .take(page_size as usize)
            .map(|m| Self::to_search_result(m, &payload.project_type))
            .collect();
        Ok(ModSearchResponse {
            results,
            total_hits: total.min(10000),
        })
    }

    async fn fetch_file_pages(
        &self,
        mod_id: &str,
        game_version: Option<&str>,
        max_pages: usize,
    ) -> Result<Vec<CfFile>, String> {
        #[derive(Deserialize)]
        struct Pag {
            #[serde(rename = "totalCount")]
            total_count: Option<usize>,
        }
        #[derive(Deserialize)]
        struct Body {
            #[serde(default)]
            data: Vec<CfFile>,
            pagination: Option<Pag>,
        }
        let mut out = Vec::new();
        for page in 0..max_pages {
            let mut qs = format!("pageSize=50&index={}", page * 50);
            if let Some(gv) = game_version {
                qs.push_str(&format!("&gameVersion={}", url::form_urlencoded::byte_serialize(gv.as_bytes()).collect::<String>()));
            }
            let body: Body = self
                .request_json(&format!("/mods/{mod_id}/files?{qs}"), None)
                .await?;
            let count = body.data.len();
            out.extend(body.data);
            let total = body.pagination.and_then(|p| p.total_count).unwrap_or(out.len());
            if count < 50 || (page + 1) * 50 >= total {
                break;
            }
        }
        Ok(out)
    }

    async fn all_files_for(
        &self,
        mod_id: &str,
        game_version: Option<&str>,
        force_fresh: bool,
    ) -> Result<Vec<CfFile>, String> {
        let key = format!("{mod_id}|{}", game_version.unwrap_or(""));
        if !force_fresh {
            if let Some((at, files)) = self.files_cache.lock().await.get(&key) {
                if at.elapsed() < Duration::from_secs(120) {
                    return Ok(files.clone());
                }
            }
        }
        let mut by_id: HashMap<u64, CfFile> = HashMap::new();
        let recent = self.fetch_file_pages(mod_id, None, 1).await?;
        let recent_count = recent.len();
        for f in recent {
            by_id.insert(f.id, f);
        }
        if let Some(gv) = game_version.filter(|v| !v.is_empty() && *v != "*") {
            let extra = self.fetch_file_pages(mod_id, Some(gv), 4).await.unwrap_or_default();
            for f in extra {
                by_id.insert(f.id, f);
            }
        } else if recent_count >= 50 {
            let more = self.fetch_file_pages(mod_id, None, 4).await.unwrap_or_default();
            for f in more {
                by_id.insert(f.id, f);
            }
        }
        let mut files: Vec<CfFile> = by_id.into_values().collect();
        files.sort_by(|a, b| {
            b.file_date
                .as_deref()
                .unwrap_or("")
                .cmp(a.file_date.as_deref().unwrap_or(""))
                .then_with(|| b.id.cmp(&a.id))
        });
        if !files.is_empty() {
            self.files_cache
                .lock()
                .await
                .insert(key, (Instant::now(), files.clone()));
        }
        Ok(files)
    }

    async fn files_for(
        &self,
        mod_id: &str,
        game_version: Option<&str>,
        loaders: &[String],
        force_fresh: bool,
        project_type: &str,
    ) -> Result<Vec<CfFile>, String> {
        let raw = self.all_files_for(mod_id, game_version, force_fresh).await?;
        let usable: Vec<CfFile> = raw
            .into_iter()
            .filter(|f| is_usable_cf_file(f, project_type))
            .collect();
        if usable.is_empty() {
            return Ok(Vec::new());
        }
        let fb_loaders = infer_mod_loaders(&usable, None);
        let eff_fb: &[String] = if fb_loaders.len() <= 1 {
            &fb_loaders
        } else {
            &[]
        };
        let fb_vers = infer_mod_versions(&usable, None);
        let wanted: Vec<&str> = loaders
            .iter()
            .map(String::as_str)
            .filter(|l| !l.is_empty() && *l != "vanilla" && *l != "*")
            .collect();

        let ver_matched: Vec<CfFile> = if let Some(gv) = game_version.filter(|v| *v != "*") {
            usable
                .into_iter()
                .filter(|f| infer_file_game_versions(f, &fb_vers).iter().any(|v| v == gv))
                .collect()
        } else {
            usable
        };
        if wanted.is_empty() {
            return Ok(ver_matched);
        }
        Ok(ver_matched
            .into_iter()
            .filter(|f| {
                let inferred = infer_file_loaders(f, eff_fb);
                if inferred.is_empty() {
                    fb_loaders.len() <= 1
                } else {
                    inferred.iter().any(|l| wanted.contains(&l.as_str()))
                }
            })
            .collect())
    }

    async fn get_mod(&self, mod_id: &str) -> Option<CfMod> {
        #[derive(Deserialize)]
        struct Body {
            data: CfMod,
        }
        self.request_json::<Body>(&format!("/mods/{mod_id}"), None)
            .await
            .ok()
            .map(|b| b.data)
    }

    pub async fn get_mods_by_ids(&self, mod_ids: &[u64]) -> HashMap<u64, CfMod> {
        let mut out = HashMap::new();
        if !curseforge_available() || mod_ids.is_empty() {
            return out;
        }
        let unique: Vec<u64> = mod_ids
            .iter()
            .copied()
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        #[derive(Deserialize)]
        struct Body {
            #[serde(default)]
            data: Vec<CfMod>,
        }
        for chunk in unique.chunks(500) {
            if let Ok(body) = self
                .request_json::<Body>("/mods", Some(json!({ "modIds": chunk, "filterPcOnly": true })))
                .await
            {
                for m in body.data {
                    out.insert(m.id, m);
                }
            }
        }
        out
    }

    pub async fn match_fingerprints(&self, fps: &[u32]) -> HashMap<u32, CfFingerprintMatch> {
        let mut out = HashMap::new();
        if !curseforge_available() || fps.is_empty() {
            return out;
        }
        let unique: Vec<u32> = fps
            .iter()
            .copied()
            .filter(|&fp| fp > 0)
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        #[derive(Deserialize)]
        struct Inner {
            #[serde(rename = "exactMatches", default)]
            exact_matches: Vec<CfFingerprintMatch>,
        }
        #[derive(Deserialize)]
        struct Body {
            data: Option<Inner>,
        }
        for chunk in unique.chunks(500) {
            if let Ok(body) = self
                .request_json::<Body>(
                    &format!("/fingerprints/{MINECRAFT_GAME_ID}"),
                    Some(json!({ "fingerprints": chunk })),
                )
                .await
            {
                if let Some(inner) = body.data {
                    for m in inner.exact_matches {
                        if let Some(fp) = m.file.file_fingerprint {
                            out.insert(fp, m);
                        }
                    }
                }
            }
        }
        out
    }

    async fn modrinth_urls_by_sha1(&self, hashes: &[String]) -> HashMap<String, String> {
        let mut out = HashMap::new();
        if hashes.is_empty() {
            return out;
        }
        let resp = self
            .client
            .post("https://api.modrinth.com/v2/version_files")
            .json(&json!({ "hashes": hashes, "algorithm": "sha1" }))
            .send()
            .await;
        let Ok(resp) = resp else {
            return out;
        };
        if !resp.status().is_success() {
            return out;
        }
        if let Ok(map) = resp.json::<HashMap<String, Value>>().await {
            for ver in map.values() {
                if let Some(files) = ver.get("files").and_then(Value::as_array) {
                    for f in files {
                        if let (Some(sha1), Some(url)) = (
                            f.pointer("/hashes/sha1").and_then(Value::as_str),
                            f.get("url").and_then(Value::as_str),
                        ) {
                            out.insert(sha1.to_lowercase(), url.to_string());
                        }
                    }
                }
            }
        }
        out
    }

    pub async fn list_versions(
        &self,
        instance_id: &str,
        project_id: &str,
        project_type: &str,
    ) -> Result<Vec<ModVersionInfo>, String> {
        let data = self.store.get_data().await;
        let instance = data
            .instances
            .iter()
            .find(|i| i.id == instance_id)
            .cloned()
            .ok_or_else(|| tr("Instance not found", "Инстанция не найдена").to_string())?;
        let raw = self
            .all_files_for(project_id, Some(&instance.game_version), true)
            .await?;
        let usable: Vec<CfFile> = raw
            .into_iter()
            .filter(|f| is_usable_cf_file(f, project_type))
            .collect();
        let fb_loaders = infer_mod_loaders(&usable, None);
        let fb_vers = infer_mod_versions(&usable, None);
        let missing_sha1s: Vec<String> = usable
            .iter()
            .filter(|f| f.download_url.is_none())
            .filter_map(sha1_of)
            .collect();
        let any_missing = usable.iter().any(|f| f.download_url.is_none());
        let (mr_urls, mod_meta) = if any_missing {
            tokio::join!(
                self.modrinth_urls_by_sha1(&missing_sha1s),
                self.get_mod(project_id)
            )
        } else {
            (HashMap::new(), None)
        };
        let base_web = mod_meta
            .as_ref()
            .and_then(|m| m.links.as_ref())
            .and_then(|l| l.website_url.as_deref());
        Ok(usable
            .iter()
            .map(|f| {
                let sha = sha1_of(f);
                let blocked =
                    f.download_url.is_none() && !sha.as_deref().map(|s| mr_urls.contains_key(s)).unwrap_or(false);
                let web = cf_file_page_url(base_web, f.id).or_else(|| base_web.map(str::to_string));
                to_cf_version_info(f, &instance, project_type, &fb_loaders, &fb_vers, blocked, web)
            })
            .collect())
    }

    pub async fn get_project_details(
        &self,
        project_id: &str,
        project_type: &str,
    ) -> Result<ModProjectDetails, String> {
        #[derive(Deserialize)]
        struct ModBody {
            data: CfMod,
        }
        #[derive(Deserialize)]
        struct DescBody {
            data: String,
        }
        let mod_path = format!("/mods/{project_id}");
        let desc_path = format!("/mods/{project_id}/description");
        let (mod_res, desc_res) = tokio::join!(
            self.request_json::<ModBody>(&mod_path, None),
            self.request_json::<DescBody>(&desc_path, None),
        );
        let m = mod_res?.data;
        let desc = desc_res.map(|d| d.data).unwrap_or_default();
        let mut vers_set = Vec::new();
        let mut loaders_set = Vec::new();
        for idx in &m.latest_files_indexes {
            if let Some(gv) = &idx.game_version {
                if !vers_set.contains(gv) {
                    vers_set.push(gv.clone());
                }
            }
            if let Some(l) = idx.mod_loader.and_then(loader_by_type) {
                let s = l.to_string();
                if !loaders_set.contains(&s) {
                    loaders_set.push(s);
                }
            }
        }
        Ok(ModProjectDetails {
            id: m.id.to_string(),
            provider: "curseforge".to_string(),
            project_type: project_type.to_string(),
            title: m.name.clone(),
            slug: m.slug.clone(),
            author: m.authors.first().and_then(|a| a.name.clone()),
            summary: m.summary.clone().unwrap_or_default(),
            body: if desc.is_empty() {
                m.summary.clone().unwrap_or_default()
            } else {
                desc
            },
            body_format: "html".to_string(),
            icon_url: m
                .logo
                .as_ref()
                .and_then(|l| l.thumbnail_url.clone().or_else(|| l.url.clone())),
            downloads: m.download_count,
            follows: m.favorite_count.or(m.thumbs_up_count),
            date_published: m.date_released.clone(),
            date_modified: latest_mod_date(&m),
            license: None,
            categories: m.categories.iter().map(|c| c.name.clone()).collect(),
            game_versions: vers_set,
            loaders: loaders_set,
            gallery: m
                .screenshots
                .iter()
                .filter_map(|s| {
                    let url = s.url.clone().or_else(|| s.thumbnail_url.clone())?;
                    Some(ModGalleryItem {
                        url,
                        title: s.title.clone(),
                        description: s.description.clone(),
                    })
                })
                .collect(),
            website_url: m.links.as_ref().and_then(|l| l.website_url.clone()),
            source_url: m.links.as_ref().and_then(|l| l.source_url.clone()),
            issues_url: m.links.as_ref().and_then(|l| l.issues_url.clone()),
            wiki_url: m.links.as_ref().and_then(|l| l.wiki_url.clone()),
            discord_url: None,
            distribution_blocked: if m.allow_mod_distribution == Some(false) {
                Some(true)
            } else {
                None
            },
        })
    }

    pub async fn prepare_install(
        &self,
        payload: &PrepareModInstallPayload,
    ) -> Result<ModInstallPlan, String> {
        let data = self.store.get_data().await;
        let instance = data
            .instances
            .iter()
            .find(|i| i.id == payload.instance_id)
            .cloned()
            .ok_or_else(|| tr("Instance not found", "Инстанция не найдена").to_string())?;
        let raw = self
            .all_files_for(&payload.project_id, Some(&instance.game_version), true)
            .await?;
        let usable: Vec<CfFile> = raw
            .into_iter()
            .filter(|f| is_usable_cf_file(f, &payload.project_type))
            .collect();
        let fb_loaders = infer_mod_loaders(&usable, None);
        let fb_vers = infer_mod_versions(&usable, None);
        let versions: Vec<ModVersionInfo> = usable
            .iter()
            .map(|f| to_cf_version_info(f, &instance, &payload.project_type, &fb_loaders, &fb_vers, false, None))
            .collect();
        let has_compatible = versions.iter().any(|v| v.compatible);

        let target_file = if let Some(vid) = &payload.version_id {
            usable.iter().find(|f| f.id.to_string() == *vid).cloned()
        } else {
            let compat: Vec<CfFile> = usable
                .iter()
                .enumerate()
                .filter(|(i, _)| versions[*i].compatible)
                .map(|(_, f)| f.clone())
                .collect();
            pick_file(&compat)
        };

        let Some(target_file) = target_file else {
            return Ok(ModInstallPlan {
                target_version: None,
                has_compatible_version: has_compatible,
                versions,
                dependencies: Vec::new(),
            });
        };

        let target_version = to_cf_version_info(
            &target_file,
            &instance,
            &payload.project_type,
            &fb_loaders,
            &fb_vers,
            false,
            None,
        );
        if payload.project_type != "mod" {
            return Ok(ModInstallPlan {
                target_version: Some(target_version),
                has_compatible_version: has_compatible,
                versions,
                dependencies: Vec::new(),
            });
        }

        let mut dep_map: HashMap<u64, &'static str> = HashMap::new();
        for d in &target_file.dependencies {
            if (d.relation_type == 3 || d.relation_type == 2)
                && d.mod_id.to_string() != payload.project_id
            {
                let kind = if d.relation_type == 3 {
                    "required"
                } else {
                    "optional"
                };
                let entry = dep_map.entry(d.mod_id).or_insert(kind);
                if *entry == "optional" && kind == "required" {
                    *entry = "required";
                }
            }
        }
        if dep_map.is_empty() {
            return Ok(ModInstallPlan {
                target_version: Some(target_version),
                has_compatible_version: has_compatible,
                versions,
                dependencies: Vec::new(),
            });
        }

        let eff_loaders = target_loaders_for("mod", &instance.loader);
        let all_ids: Vec<u64> = dep_map.keys().copied().collect();
        let mods_by_id = self.get_mods_by_ids(&all_ids).await;
        let mods_dir = PathBuf::from(&instance.directory).join("mods");
        let mut deps = Vec::new();
        for mod_id in all_ids {
            let dep_type = dep_map[&mod_id];
            let files = self
                .files_for(
                    &mod_id.to_string(),
                    Some(&instance.game_version),
                    &eff_loaders,
                    false,
                    "mod",
                )
                .await
                .unwrap_or_default();
            let chosen = pick_file(&files);
            let m = mods_by_id.get(&mod_id);
            let slug = m.and_then(|x| x.slug.clone());
            let installed = instance.mods.iter().any(|im| {
                if im.project_type.as_deref().unwrap_or("mod") != "mod" {
                    return false;
                }
                let id_match = im.project_id == mod_id.to_string()
                    || slug
                        .as_deref()
                        .zip(im.slug.as_deref())
                        .map(|(a, b)| a.eq_ignore_ascii_case(b))
                        .unwrap_or(false);
                if !id_match {
                    return false;
                }
                match &im.file_name {
                    None => true,
                    Some(fnm) => {
                        let base = fnm.strip_suffix(".disabled").unwrap_or(fnm);
                        mods_dir.join(fnm).exists()
                            || mods_dir.join(base).exists()
                            || mods_dir.join(format!("{base}.disabled")).exists()
                    }
                }
            });
            let dist_blocked = chosen
                .as_ref()
                .map(|c| c.download_url.is_none() && m.and_then(|x| x.allow_mod_distribution) == Some(false))
                .unwrap_or(false);
            deps.push(ModDependencyItem {
                project_id: mod_id.to_string(),
                provider: "curseforge".to_string(),
                version_id: chosen.as_ref().map(|c| c.id.to_string()),
                version_number: chosen.as_ref().map(clean_version_number),
                title: m
                    .map(|x| x.name.clone())
                    .or_else(|| slug.clone())
                    .unwrap_or_else(|| mod_id.to_string()),
                slug,
                author: m.and_then(|x| x.authors.first()).and_then(|a| a.name.clone()),
                summary: m.and_then(|x| x.summary.clone()).unwrap_or_default(),
                icon_url: m
                    .and_then(|x| x.logo.as_ref())
                    .and_then(|l| l.thumbnail_url.clone().or_else(|| l.url.clone())),
                dependency_type: dep_type.to_string(),
                installed,
                compatible: chosen.is_some(),
                distribution_blocked: if dist_blocked { Some(true) } else { None },
                website_url: m.and_then(|x| x.links.as_ref()).and_then(|l| l.website_url.clone()),
            });
        }
        deps.sort_by(|a, b| {
            (a.dependency_type != "required")
                .cmp(&(b.dependency_type != "required"))
                .then_with(|| a.installed.cmp(&b.installed))
                .then_with(|| a.title.cmp(&b.title))
        });

        Ok(ModInstallPlan {
            target_version: Some(target_version),
            has_compatible_version: has_compatible,
            versions,
            dependencies: deps,
        })
    }

    pub async fn install<F>(
        &self,
        payload: &InstallModPayload,
        mut on_bytes: F,
    ) -> Result<LauncherInstance, String>
    where
        F: FnMut(u64, Option<u64>) + Send,
    {
        let data = self.store.get_data().await;
        let instance = data
            .instances
            .iter()
            .find(|i| i.id == payload.instance_id)
            .cloned()
            .ok_or_else(|| tr("Instance not found", "Инстанция не найдена").to_string())?;
        if payload.project_type == "mod" && instance.loader == "vanilla" {
            return Err(tr(
                "Choose Fabric, Forge, Quilt, or NeoForge before installing mods.",
                "Перед установкой модов выберите Fabric, Forge, Quilt или NeoForge.",
            )
            .to_string());
        }

        let file = if let Some(vid) = &payload.version_id {
            #[derive(Deserialize)]
            struct Body {
                data: CfFile,
            }
            self.request_json::<Body>(&format!("/mods/{}/files/{vid}", payload.project_id), None)
                .await?
                .data
        } else {
            let loaders = target_loaders_for(&payload.project_type, &instance.loader);
            let candidates = self
                .files_for(
                    &payload.project_id,
                    Some(&instance.game_version),
                    &loaders,
                    true,
                    &payload.project_type,
                )
                .await?;
            pick_file(&candidates).ok_or_else(|| {
                tr_string(
                    format!("No compatible CurseForge file for {} ({})", payload.name, instance.game_version),
                    format!("На CurseForge нет подходящего файла для {} ({})", payload.name, instance.game_version),
                )
            })?
        };

        let mut download_url = file.download_url.clone();
        if download_url.is_none() {
            if let Some(sha) = sha1_of(&file) {
                download_url = self.modrinth_urls_by_sha1(&[sha.clone()]).await.remove(&sha);
            }
        }
        let Some(url) = download_url else {
            let mod_meta = self.get_mod(&payload.project_id).await;
            let web = mod_meta
                .and_then(|m| m.links)
                .and_then(|l| l.website_url)
                .unwrap_or_default();
            return Err(tr_string(
                format!("The author of {} does not allow downloads through other launchers. Download it from CurseForge{}.", payload.name, if web.is_empty() { String::new() } else { format!(": {web}") }),
                format!("Автор {} запретил скачивание через сторонние лаунчеры. Скачайте файл на сайте CurseForge{}.", payload.name, if web.is_empty() { String::new() } else { format!(": {web}") }),
            ));
        };

        let resp = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        let total = resp.content_length();
        let mut stream = resp.bytes_stream();
        let mut bytes = Vec::new();
        let mut received = 0u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| e.to_string())?;
            bytes.extend_from_slice(&chunk);
            received += chunk.len() as u64;
            on_bytes(received, total);
        }

        let destinations = target_directories(&instance, &payload.project_type);
        let slug_lower = payload.slug.as_deref().map(str::to_lowercase);
        let prev = instance.mods.iter().find(|m| {
            m.project_type.as_deref().unwrap_or("mod") == payload.project_type
                && (payload.replace_mod_id.as_deref() == Some(m.id.as_str())
                    || m.project_id == payload.project_id
                    || slug_lower
                        .as_deref()
                        .zip(m.slug.as_deref())
                        .map(|(a, b)| a.eq_ignore_ascii_case(b))
                        .unwrap_or(false))
        });
        let prev_base = prev
            .and_then(|p| p.file_name.as_deref())
            .map(|f| f.strip_suffix(".disabled").unwrap_or(f).to_string());
        let keep_disabled = prev
            .and_then(|p| p.file_name.as_deref())
            .map(|f| f.to_lowercase().ends_with(".disabled"))
            .unwrap_or(false);
        let downloaded_name = sanitize_file_part(&file.file_name);
        let final_name = if keep_disabled {
            format!("{downloaded_name}.disabled")
        } else {
            downloaded_name.clone()
        };

        for dir in &destinations {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            let tmp = dir.join(format!("{downloaded_name}.{}.download", Uuid::new_v4()));
            fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
            let target = dir.join(&final_name);
            if let Err(e) = fs::rename(&tmp, &target) {
                let _ = fs::remove_file(&tmp);
                return Err(e.to_string());
            }
            if let Some(ref pb) = prev_base {
                if !pb.eq_ignore_ascii_case(&final_name) {
                    let _ = fs::remove_file(dir.join(pb));
                    let dis = format!("{pb}.disabled");
                    if !dis.eq_ignore_ascii_case(&final_name) {
                        let _ = fs::remove_file(dir.join(dis));
                    }
                }
            }
        }

        let prev_id = prev.map(|p| p.id.clone());
        let file_id_str = file.id.to_string();
        let updated = self
            .store
            .update(|d| {
                let target = d
                    .instances
                    .iter_mut()
                    .find(|i| i.id == payload.instance_id)
                    .ok_or_else(|| tr("Instance not found", "Инстанция не найдена").to_string())?;
                let now = Utc::now().to_rfc3339();
                if let Some(existing) = target.mods.iter_mut().find(|m| {
                    m.project_type.as_deref().unwrap_or("mod") == payload.project_type
                        && (payload.replace_mod_id.as_deref() == Some(m.id.as_str())
                            || prev_id.as_deref() == Some(m.id.as_str())
                            || m.project_id == payload.project_id)
                }) {
                    existing.provider = "curseforge".to_string();
                    existing.project_id = payload.project_id.clone();
                    existing.version_id = Some(file_id_str);
                    existing.file_name = Some(final_name);
                    existing.name = payload.name.clone();
                    if payload.slug.is_some() {
                        existing.slug = payload.slug.clone();
                    }
                    if payload.icon_url.is_some() {
                        existing.icon_url = payload.icon_url.clone();
                    }
                    existing.installed_at = now.clone();
                    existing.status = "installed".to_string();
                } else {
                    target.mods.push(InstalledMod {
                        id: Uuid::new_v4().to_string(),
                        provider: "curseforge".to_string(),
                        project_id: payload.project_id.clone(),
                        version_id: Some(file_id_str),
                        name: payload.name.clone(),
                        slug: payload.slug.clone(),
                        file_name: Some(final_name),
                        icon_url: payload.icon_url.clone(),
                        installed_at: now.clone(),
                        status: "installed".to_string(),
                        project_type: Some(payload.project_type.clone()),
                    });
                }
                target.updated_at = now;
                Ok(target.clone())
            })
            .await?;
        write_content_manifest(&PathBuf::from(&updated.directory), &updated.mods);
        Ok(updated)
    }

    pub async fn download_modpack_file<F>(
        &self,
        payload: &DownloadModpackPayload,
        mut on_bytes: F,
    ) -> Result<String, String>
    where
        F: FnMut(u64, Option<u64>) + Send,
    {
        let data = self.store.get_data().await;
        let instance = data
            .instances
            .iter()
            .find(|i| i.id == payload.instance_id)
            .cloned()
            .ok_or_else(|| tr("Instance not found", "Инстанция не найдена").to_string())?;
        let file = if let Some(vid) = &payload.version_id {
            #[derive(Deserialize)]
            struct Body {
                data: CfFile,
            }
            self.request_json::<Body>(&format!("/mods/{}/files/{vid}", payload.project_id), None)
                .await
                .ok()
                .map(|b| b.data)
        } else {
            None
        };
        let file = match file {
            Some(f) => f,
            None => {
                let mut candidates = self
                    .files_for(&payload.project_id, Some(&instance.game_version), &[], true, "modpack")
                    .await
                    .unwrap_or_default();
                if candidates.is_empty() {
                    candidates = self
                        .all_files_for(&payload.project_id, None, true)
                        .await
                        .unwrap_or_default()
                        .into_iter()
                        .filter(|f| f.file_name.to_lowercase().ends_with(".zip"))
                        .collect();
                }
                pick_file(&candidates).ok_or_else(|| {
                    tr_string(
                        format!("No modpack file for {} on CurseForge", payload.name),
                        format!("На CurseForge нет файла сборки {}", payload.name),
                    )
                })?
            }
        };
        let Some(url) = file.download_url else {
            return Err(tr(
                "The author disabled third-party launcher downloads for this modpack.",
                "Автор запретил скачивание этой сборки через сторонние лаунчеры.",
            )
            .to_string());
        };
        let dir = get_launcher_root().join("cache").join("modpacks");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let target = dir.join(format!("download-{}.zip", Uuid::new_v4()));
        let resp = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        let total = resp.content_length();
        let mut stream = resp.bytes_stream();
        let mut out_bytes = Vec::new();
        let mut received = 0u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| e.to_string())?;
            out_bytes.extend_from_slice(&chunk);
            received += chunk.len() as u64;
            on_bytes(received, total);
        }
        fs::write(&target, out_bytes).map_err(|e| e.to_string())?;
        Ok(target.to_string_lossy().to_string())
    }

    pub async fn resolve_manifest(
        &self,
        manifest: &CurseForgeManifest,
    ) -> Result<(Vec<ResolvedPackFile>, Vec<String>), String> {
        let entries: Vec<&CfManifestFile> = manifest
            .files
            .iter()
            .filter(|f| f.project_id.is_some() && f.file_id.is_some() && f.required != Some(false))
            .collect();
        if entries.is_empty() {
            return Ok((Vec::new(), Vec::new()));
        }
        #[derive(Deserialize)]
        struct FilesBody {
            #[serde(default)]
            data: Vec<CfFile>,
        }
        let file_ids: Vec<u64> = entries.iter().filter_map(|e| e.file_id).collect();
        let mut cf_files = Vec::new();
        for chunk in file_ids.chunks(500) {
            let body: FilesBody = self
                .request_json("/mods/files", Some(json!({ "fileIds": chunk })))
                .await?;
            cf_files.extend(body.data);
        }
        let mod_ids: Vec<u64> = entries.iter().filter_map(|e| e.project_id).collect();
        let mods = self.get_mods_by_ids(&mod_ids).await;
        let by_id: HashMap<u64, CfFile> = cf_files.into_iter().map(|f| (f.id, f)).collect();
        let blocked_sha1s: Vec<String> = entries
            .iter()
            .filter_map(|e| by_id.get(&e.file_id?))
            .filter(|f| f.download_url.is_none())
            .filter_map(sha1_of)
            .collect();
        let fallback_urls = self.modrinth_urls_by_sha1(&blocked_sha1s).await;

        let mut files = Vec::new();
        let mut skipped = Vec::new();
        for entry in entries {
            let pid = entry.project_id.unwrap();
            let fid = entry.file_id.unwrap();
            let m = mods.get(&pid);
            let f = by_id.get(&fid);
            let label = m
                .map(|x| x.name.clone())
                .or_else(|| f.and_then(|x| x.display_name.clone()))
                .unwrap_or_else(|| format!("#{pid}"));
            let Some(file) = f else {
                skipped.push(label);
                continue;
            };
            let sha1 = sha1_of(file);
            let url = file
                .download_url
                .clone()
                .or_else(|| sha1.as_ref().and_then(|s| fallback_urls.get(s).cloned()));
            let Some(url) = url else {
                skipped.push(format!("{label} ({})", file.file_name));
                continue;
            };
            let folder = class_folder(m.and_then(|x| x.class_id));
            files.push(ResolvedPackFile {
                path: format!("{folder}/{}", sanitize_file_part(&file.file_name)),
                url,
                sha1,
                size: file.file_length,
                project_id: pid.to_string(),
                file_id: fid.to_string(),
                name: label,
                slug: m.and_then(|x| x.slug.clone()),
                icon_url: m.and_then(|x| x.logo.as_ref()).and_then(|l| l.thumbnail_url.clone()),
                project_type: project_type_for_class(m.and_then(|x| x.class_id), "mod"),
            });
        }
        Ok((files, skipped))
    }

    pub async fn check_updates_for_items(
        &self,
        instance: &LauncherInstance,
        items: &[CfTrackedItem],
    ) -> HashMap<String, ContentUpdateInfo> {
        let mut out = HashMap::new();
        if !curseforge_available() || items.is_empty() {
            return out;
        }

        let mut fp_by_key: HashMap<String, u32> = HashMap::new();
        for item in items {
            if let Ok(fp) = cf_fingerprint_cached(&item.found_path) {
                if fp > 0 {
                    fp_by_key.insert(format!("{}:{}", item.project_type, item.file_name), fp);
                }
            }
        }
        let fps: Vec<u32> = fp_by_key.values().copied().collect();
        let matches = self.match_fingerprints(&fps).await;

        for item in items {
            let key = format!("{}:{}", item.project_type, item.file_name);
            let fp = fp_by_key.get(&key).copied().unwrap_or(0);
            let matched = if fp > 0 { matches.get(&fp) } else { None };
            let mod_id = item
                .project_id
                .as_deref()
                .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))
                .map(str::to_string)
                .or_else(|| matched.map(|m| m.id.to_string()));
            let Some(mod_id) = mod_id else {
                continue;
            };

            let Ok(raw_files) = self
                .all_files_for(&mod_id, Some(&instance.game_version), false)
                .await
            else {
                continue;
            };
            let usable: Vec<CfFile> = raw_files
                .iter()
                .filter(|f| is_usable_cf_file(f, &item.project_type))
                .cloned()
                .collect();
            if usable.is_empty() {
                continue;
            }
            let fb_loaders = infer_mod_loaders(&usable, None);
            let fb_vers = infer_mod_versions(&usable, None);
            let base_lower = item
                .file_name
                .strip_suffix(".disabled")
                .unwrap_or(&item.file_name)
                .to_lowercase();
            let item_sha1 = item.sha1.as_deref().map(str::to_lowercase);

            let matched_self = matched
                .filter(|m| m.id.to_string() == mod_id)
                .map(|m| m.file.clone());
            let now = matched_self
                .or_else(|| {
                    if fp > 0 {
                        raw_files.iter().find(|f| f.file_fingerprint == Some(fp)).cloned()
                    } else {
                        None
                    }
                })
                .or_else(|| {
                    item_sha1.as_deref().and_then(|s| {
                        raw_files
                            .iter()
                            .find(|f| sha1_of(f).as_deref() == Some(s))
                            .cloned()
                    })
                })
                .or_else(|| {
                    item.version_id.as_deref().and_then(|vid| {
                        raw_files.iter().find(|f| f.id.to_string() == vid).cloned()
                    })
                })
                .or_else(|| {
                    raw_files
                        .iter()
                        .find(|f| {
                            f.file_name.to_lowercase() == base_lower
                                || sanitize_file_part(&f.file_name).to_lowercase() == base_lower
                        })
                        .cloned()
                });

            let can_update = !(item.project_type == "mod" && instance.loader == "vanilla");
            let compat: Vec<CfFile> = if can_update {
                usable
                    .iter()
                    .filter(|f| {
                        to_cf_version_info(f, instance, &item.project_type, &fb_loaders, &fb_vers, false, None)
                            .compatible
                    })
                    .cloned()
                    .collect()
            } else {
                Vec::new()
            };
            let latest_file = pick_file(&compat);
            let now_info = now.as_ref().map(|f| {
                to_cf_version_info(f, instance, &item.project_type, &fb_loaders, &fb_vers, false, None)
            });
            let now_compat = now_info.as_ref().map(|v| v.compatible).unwrap_or(true);
            let baseline_date = now
                .as_ref()
                .and_then(|f| f.file_date.as_deref())
                .or(item.installed_date.as_deref())
                .unwrap_or("");

            let same_ver = latest_file
                .as_ref()
                .map(|lf| {
                    now_compat
                        && (now.is_some() || item.current_version_number.is_some())
                        && is_same_release_version(lf, now.as_ref(), item.current_version_number.as_deref())
                })
                .unwrap_or(false);

            let mut is_newer = latest_file
                .as_ref()
                .map(|lf| {
                    !same_ver
                        && match &now {
                            Some(nf) => lf.id != nf.id,
                            None => sanitize_file_part(&lf.file_name).to_lowercase() != base_lower,
                        }
                        && (!now_compat
                            || baseline_date.is_empty()
                            || lf.file_date.as_deref().unwrap_or("") > baseline_date)
                })
                .unwrap_or(false);

            let mut blocked = false;
            let mut web_url = None;
            if is_newer {
                if let Some(ref lf) = latest_file {
                    if lf.download_url.is_none() {
                        let mr_has = match sha1_of(lf) {
                            Some(s) => self.modrinth_urls_by_sha1(&[s.clone()]).await.contains_key(&s),
                            None => false,
                        };
                        if !mr_has {
                            if item.provider == "modrinth" {
                                is_newer = false;
                            } else {
                                blocked = true;
                                let meta = self.get_mod(&mod_id).await;
                                let base_web = meta
                                    .as_ref()
                                    .and_then(|m| m.links.as_ref())
                                    .and_then(|l| l.website_url.as_deref());
                                web_url = cf_file_page_url(base_web, lf.id)
                                    .or_else(|| base_web.map(str::to_string));
                            }
                        }
                    }
                }
            }

            out.insert(
                key,
                ContentUpdateInfo {
                    project_id: mod_id,
                    project_type: item.project_type.clone(),
                    file_name: item.file_name.clone(),
                    current_version_id: now.as_ref().map(|f| f.id.to_string()).or_else(|| item.version_id.clone()),
                    current_version_number: now
                        .as_ref()
                        .map(clean_version_number)
                        .or_else(|| item.current_version_number.clone()),
                    latest: if is_newer {
                        latest_file.as_ref().map(|lf| {
                            to_cf_version_info(
                                lf,
                                instance,
                                &item.project_type,
                                &fb_loaders,
                                &fb_vers,
                                blocked,
                                web_url,
                            )
                        })
                    } else {
                        None
                    },
                    incompatible: now.as_ref().and_then(|f| {
                        if item.project_type == "mod" {
                            cf_incompatibility(f, instance, &fb_loaders, &fb_vers)
                        } else {
                            None
                        }
                    }),
                },
            );
        }

        out
    }
}
