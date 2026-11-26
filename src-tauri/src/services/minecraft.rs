use crate::i18n::{tr, tr_string};
use crate::paths::get_minecraft_root;
use crate::services::auth::offline_uuid_undashed;
use crate::services::java::fallback_required_java_major;
use crate::services::ziputil::{create_zip_from_dir, extract_zip, extract_zip_filtered};
use crate::types::{AccountState, GameVersionInfo, LauncherInstance, QuickPlayTarget};
use futures_util::stream::{self, StreamExt};
use once_cell::sync::Lazy;
use regex::Regex;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const USER_AGENT: &str = "lynapp/2.0.0-beta.2";
const LAUNCHER_VERSION: &str = "2.0.0-beta.2";
const MANIFEST_URL: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const ASSET_OBJECT_ROOT: &str = "https://resources.download.minecraft.net";
const LEGACY_LIBRARIES_ROOT: &str = "https://libraries.minecraft.net";
const CACHE_TTL: Duration = Duration::from_secs(600);

static MAVEN_VERSION_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"<version>([^<]+)</version>").unwrap());
static VAR_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\$\{([^}]+)\}").unwrap());

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct VersionManifest {
    pub versions: Vec<ManifestEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ManifestEntry {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub url: String,
    #[serde(rename = "releaseTime", default)]
    pub release_time: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct DownloadInfo {
    pub sha1: Option<String>,
    pub size: Option<u64>,
    #[serde(default)]
    pub url: String,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RuleOs {
    pub name: Option<String>,
    pub arch: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Rule {
    pub action: String,
    pub os: Option<RuleOs>,
    pub features: Option<HashMap<String, bool>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum ArgValue {
    One(String),
    Many(Vec<String>),
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum ArgumentEntry {
    Simple(String),
    Conditional {
        rules: Option<Vec<Rule>>,
        value: ArgValue,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct LibraryDownloads {
    pub artifact: Option<DownloadInfo>,
    pub classifiers: Option<HashMap<String, DownloadInfo>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct LibraryEntry {
    pub name: Option<String>,
    pub url: Option<String>,
    pub downloads: Option<LibraryDownloads>,
    pub natives: Option<HashMap<String, String>>,
    pub rules: Option<Vec<Rule>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct VersionArguments {
    #[serde(default)]
    pub game: Vec<ArgumentEntry>,
    #[serde(default)]
    pub jvm: Vec<ArgumentEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct AssetIndexRef {
    #[serde(default)]
    pub id: String,
    pub sha1: Option<String>,
    #[serde(default)]
    pub url: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct VersionDownloads {
    #[serde(default)]
    pub client: DownloadInfo,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct JavaVersionRef {
    #[serde(rename = "majorVersion")]
    pub major_version: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct VersionJson {
    #[serde(default)]
    pub id: String,
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(rename = "mainClass", default)]
    pub main_class: String,
    #[serde(rename = "inheritsFrom")]
    pub inherits_from: Option<String>,
    #[serde(rename = "javaVersion")]
    pub java_version: Option<JavaVersionRef>,
    pub assets: Option<String>,
    #[serde(rename = "assetIndex", default)]
    pub asset_index: AssetIndexRef,
    #[serde(default)]
    pub downloads: VersionDownloads,
    #[serde(default)]
    pub libraries: Vec<LibraryEntry>,
    pub arguments: Option<VersionArguments>,
    #[serde(rename = "minecraftArguments")]
    pub minecraft_arguments: Option<String>,
    #[serde(skip)]
    pub prebuilt_client_jar: Option<PathBuf>,
}

#[derive(Debug, Clone, Deserialize)]
struct AssetIndex {
    objects: HashMap<String, AssetObject>,
    #[serde(rename = "virtual", default)]
    is_virtual: bool,
    #[serde(default)]
    map_to_resources: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct AssetObject {
    hash: String,
    size: u64,
}

#[derive(Debug, Clone)]
pub struct LaunchProgress {
    pub phase: String,
    pub done: usize,
    pub total: usize,
    pub received: Option<u64>,
    pub total_bytes: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct PreparedMinecraftLaunch {
    pub main_class: String,
    pub args: Vec<String>,
    pub natives_dir: PathBuf,
    pub launch_directory: PathBuf,
    pub log_path: PathBuf,
    pub warning: Option<String>,
}

struct Cached<T> {
    value: T,
    fetched_at: Instant,
}

impl<T: Clone> Cached<T> {
    fn fresh(&self) -> Option<T> {
        if self.fetched_at.elapsed() < CACHE_TTL {
            Some(self.value.clone())
        } else {
            None
        }
    }
}

fn get_versions_root() -> PathBuf {
    get_minecraft_root().join("versions")
}

fn get_libraries_root() -> PathBuf {
    get_minecraft_root().join("libraries")
}

fn get_assets_root() -> PathBuf {
    get_minecraft_root().join("assets")
}

fn get_version_dir(id: &str) -> PathBuf {
    get_versions_root().join(id)
}

pub fn has_non_ascii(s: &str) -> bool {
    !s.is_ascii()
}

fn sanitize_id_part(value: &str, fallback: &str) -> String {
    let out: String = value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if out.is_empty() {
        fallback.to_string()
    } else {
        out
    }
}

pub fn get_natives_root(instance_id: &str, version_id: &str) -> PathBuf {
    let safe_inst = sanitize_id_part(instance_id, "instance");
    let safe_ver = sanitize_id_part(version_id, "version");
    let primary = get_minecraft_root()
        .join("natives")
        .join(&safe_inst)
        .join(&safe_ver);
    #[cfg(windows)]
    {
        let tmp = std::env::temp_dir();
        if has_non_ascii(&primary.to_string_lossy()) && !has_non_ascii(&tmp.to_string_lossy()) {
            return tmp.join("lynapp").join("natives").join(&safe_inst).join(&safe_ver);
        }
    }
    primary
}

fn resolve_launch_instance_dir(instance_id: &str, instance_dir: &Path) -> PathBuf {
    #[cfg(not(windows))]
    {
        let _ = instance_id;
        return instance_dir.to_path_buf();
    }
    #[cfg(windows)]
    {
        if !has_non_ascii(&instance_dir.to_string_lossy()) {
            return instance_dir.to_path_buf();
        }
        let safe_inst = sanitize_id_part(instance_id, "instance");
        let links_dir = get_minecraft_root().join("instance-links");
        if has_non_ascii(&links_dir.to_string_lossy()) {
            return instance_dir.to_path_buf();
        }
        let link_path = links_dir.join(&safe_inst);
        if fs::create_dir_all(&links_dir).is_err() {
            return instance_dir.to_path_buf();
        }
        let target_real = fs::canonicalize(instance_dir).unwrap_or_else(|_| instance_dir.to_path_buf());
        let target_clean = target_real
            .to_string_lossy()
            .trim_start_matches("\\\\?\\")
            .to_string();

        let mut needs_create = true;
        if let Ok(meta) = fs::symlink_metadata(&link_path) {
            if meta.file_type().is_symlink() || meta.is_dir() {
                if let Ok(existing_real) = fs::canonicalize(&link_path) {
                    let existing_clean = existing_real
                        .to_string_lossy()
                        .trim_start_matches("\\\\?\\")
                        .to_string();
                    if existing_clean.eq_ignore_ascii_case(&target_clean) {
                        needs_create = false;
                    } else {
                        let _ = fs::remove_dir(&link_path);
                    }
                } else {
                    let _ = fs::remove_dir(&link_path);
                }
            }
        }
        if needs_create {
            use std::os::windows::process::CommandExt;
            let status = Command::new("cmd")
                .args(["/C", "mklink", "/J", &link_path.to_string_lossy(), &target_clean])
                .creation_flags(0x08000000)
                .status();
            if status.map(|s| !s.success()).unwrap_or(true) {
                return instance_dir.to_path_buf();
            }
        }
        if link_path.exists() {
            link_path
        } else {
            instance_dir.to_path_buf()
        }
    }
}

#[cfg(windows)]
fn can_pass_via_windows_acp(value: &str) -> bool {
    if !has_non_ascii(value) {
        return true;
    }
    let acp = unsafe { windows_sys::Win32::Globalization::GetACP() };
    if acp == 65001 {
        return true;
    }
    if acp == 1251 {
        return value
            .chars()
            .all(|c| (c >= '\u{0020}' && c <= '\u{007E}') || (c >= '\u{0400}' && c <= '\u{04FF}'));
    }
    false
}

#[cfg(not(windows))]
fn can_pass_via_windows_acp(_value: &str) -> bool {
    true
}

fn mojang_os_name() -> &'static str {
    #[cfg(windows)]
    {
        "windows"
    }
    #[cfg(target_os = "macos")]
    {
        "osx"
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        "linux"
    }
}

fn matches_arch(expected: &str) -> bool {
    match std::env::consts::ARCH {
        "x86" => matches!(expected, "x86" | "ia32"),
        "x86_64" => matches!(expected, "x64" | "x86_64" | "amd64"),
        "aarch64" => matches!(expected, "arm64" | "aarch64"),
        other => expected == other,
    }
}

fn rule_applies(rule: &Rule) -> bool {
    if let Some(os) = &rule.os {
        if let Some(name) = &os.name {
            if name != mojang_os_name() {
                return false;
            }
        }
        if let Some(arch) = &os.arch {
            if !matches_arch(arch) {
                return false;
            }
        }
    }
    if let Some(features) = &rule.features {
        for &expected in features.values() {
            if expected {
                return false;
            }
        }
    }
    true
}

fn is_allowed(rules: Option<&Vec<Rule>>) -> bool {
    let Some(list) = rules else {
        return true;
    };
    if list.is_empty() {
        return true;
    }
    let mut allowed = false;
    for rule in list {
        if rule_applies(rule) {
            allowed = rule.action == "allow";
        }
    }
    allowed
}

fn parse_maven_name(name: &str) -> (String, String, String, Option<String>, String) {
    let (coords, ext) = match name.split_once('@') {
        Some((c, e)) if !e.trim().is_empty() => (c, e.trim().to_string()),
        Some((c, _)) => (c, "jar".to_string()),
        None => (name, "jar".to_string()),
    };
    let parts: Vec<&str> = coords.split(':').collect();
    let group = parts.first().copied().unwrap_or("").to_string();
    let artifact = parts.get(1).copied().unwrap_or("").to_string();
    let version = parts.get(2).copied().unwrap_or("").to_string();
    let classifier = parts
        .get(3)
        .copied()
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    (group, artifact, version, classifier, ext)
}

fn maven_rel_path(name: &str) -> String {
    let (group, artifact, version, classifier, ext) = parse_maven_name(name);
    let file_name = match classifier {
        Some(c) => format!("{artifact}-{version}-{c}.{ext}"),
        None => format!("{artifact}-{version}.{ext}"),
    };
    format!(
        "{}/{artifact}/{version}/{file_name}",
        group.replace('.', "/")
    )
}

fn maven_classifier_rel_path(name: &str, classifier: &str) -> String {
    let (group, artifact, version, _, _) = parse_maven_name(name);
    format!(
        "{}/{artifact}/{version}/{artifact}-{version}-{classifier}.jar",
        group.replace('.', "/")
    )
}

fn library_identity(lib: &LibraryEntry) -> Option<String> {
    let name = lib.name.as_deref()?;
    let parts: Vec<&str> = name.split(':').collect();
    let group = parts.first().copied().filter(|s| !s.is_empty())?;
    let artifact = parts.get(1).copied().filter(|s| !s.is_empty())?;
    let classifier = parts
        .get(3)
        .map(|s| s.split('@').next().unwrap_or(""))
        .filter(|s| !s.is_empty());
    Some(match classifier {
        Some(c) => format!("{group}:{artifact}:{c}"),
        None => format!("{group}:{artifact}"),
    })
}

fn merge_libraries(vanilla: &[LibraryEntry], loader: &[LibraryEntry]) -> Vec<LibraryEntry> {
    let mut result = vanilla.to_vec();
    let mut indexes: HashMap<String, usize> = HashMap::new();
    for (idx, lib) in result.iter().enumerate() {
        if let Some(id) = library_identity(lib) {
            indexes.insert(id, idx);
        }
    }
    for lib in loader {
        if let Some(id) = library_identity(lib) {
            if let Some(&idx) = indexes.get(&id) {
                result[idx] = lib.clone();
                continue;
            }
            indexes.insert(id, result.len());
        }
        result.push(lib.clone());
    }
    result
}

fn merge_version_profile(parent: &VersionJson, profile: &VersionJson, id: String) -> VersionJson {
    let merged_args = match (&parent.arguments, &profile.arguments) {
        (None, None) => None,
        (Some(p), None) => Some(p.clone()),
        (None, Some(c)) => Some(c.clone()),
        (Some(p), Some(c)) => {
            let mut game = p.game.clone();
            game.extend(c.game.clone());
            let mut jvm = p.jvm.clone();
            jvm.extend(c.jvm.clone());
            Some(VersionArguments { game, jvm })
        }
    };
    VersionJson {
        id,
        kind: if !profile.kind.is_empty() {
            profile.kind.clone()
        } else {
            parent.kind.clone()
        },
        main_class: if !profile.main_class.is_empty() {
            profile.main_class.clone()
        } else {
            parent.main_class.clone()
        },
        inherits_from: profile.inherits_from.clone().or(parent.inherits_from.clone()),
        java_version: profile.java_version.clone().or(parent.java_version.clone()),
        assets: profile.assets.clone().or(parent.assets.clone()),
        asset_index: if !profile.asset_index.url.is_empty() {
            profile.asset_index.clone()
        } else {
            parent.asset_index.clone()
        },
        downloads: if !profile.downloads.client.url.is_empty() {
            profile.downloads.clone()
        } else {
            parent.downloads.clone()
        },
        libraries: merge_libraries(&parent.libraries, &profile.libraries),
        arguments: merged_args,
        minecraft_arguments: profile
            .minecraft_arguments
            .clone()
            .or(parent.minecraft_arguments.clone()),
        prebuilt_client_jar: None,
    }
}

fn natives_classifier(template: &str) -> String {
    let arch = match std::env::consts::ARCH {
        "x86" => "32",
        "aarch64" => "arm64",
        _ => "64",
    };
    template.replace("${arch}", arch)
}

fn replace_vars(input: &str, vars: &HashMap<&str, String>) -> String {
    VAR_RE
        .replace_all(input, |caps: &regex::Captures| {
            vars.get(caps.get(1).map(|m| m.as_str()).unwrap_or(""))
                .cloned()
                .unwrap_or_default()
        })
        .into_owned()
}

fn collect_args(entries: &[ArgumentEntry], vars: &HashMap<&str, String>) -> Vec<String> {
    let mut out = Vec::new();
    for entry in entries {
        match entry {
            ArgumentEntry::Simple(s) => out.push(replace_vars(s, vars)),
            ArgumentEntry::Conditional { rules, value } => {
                if is_allowed(rules.as_ref()) {
                    match value {
                        ArgValue::One(s) => out.push(replace_vars(s, vars)),
                        ArgValue::Many(list) => {
                            for s in list {
                                out.push(replace_vars(s, vars));
                            }
                        }
                    }
                }
            }
        }
    }
    out
}

fn sha1_bytes(bytes: &[u8]) -> String {
    let mut h = Sha1::new();
    h.update(bytes);
    hex::encode(h.finalize())
}

fn is_valid_download_sync(path: &Path, expected_sha1: Option<&str>) -> bool {
    if !path.exists() {
        return false;
    }
    match expected_sha1 {
        Some(exp) if !exp.is_empty() => fs::read(path)
            .map(|b| sha1_bytes(&b).eq_ignore_ascii_case(exp))
            .unwrap_or(false),
        _ => path.metadata().map(|m| m.len() > 0).unwrap_or(false),
    }
}

fn neoforge_prefix(game_version: &str) -> Option<String> {
    if game_version == "1.20.1" {
        return None;
    }
    let parts: Vec<&str> = game_version.trim().split('.').collect();
    if parts.first() == Some(&"1") && parts.len() >= 2 {
        let minor: u32 = parts[1].parse().ok()?;
        let patch: u32 = parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
        return Some(format!("{minor}.{patch}."));
    }
    if parts.len() >= 2 {
        let major: u32 = parts[0].parse().ok()?;
        let minor: u32 = parts[1].parse().ok()?;
        return Some(format!("{major}.{minor}."));
    }
    None
}

fn compare_loader_versions(a: &str, b: &str) -> std::cmp::Ordering {
    fn split_ver(v: &str) -> (Vec<u64>, String) {
        let mut split_at = None;
        let bytes = v.as_bytes();
        for i in 0..bytes.len().saturating_sub(1) {
            if bytes[i] == b'-' && bytes[i + 1].is_ascii_alphabetic() {
                split_at = Some(i);
                break;
            }
        }
        let (core, pre) = match split_at {
            Some(i) => (&v[..i], v[i + 1..].to_string()),
            None => (v, String::new()),
        };
        let nums = core
            .split(|c| c == '.' || c == '-')
            .map(|p| p.parse::<u64>().unwrap_or(0))
            .collect();
        (nums, pre)
    }
    let (an, ap) = split_ver(a);
    let (bn, bp) = split_ver(b);
    let max_len = an.len().max(bn.len());
    for i in 0..max_len {
        let lv = an.get(i).copied().unwrap_or(0);
        let rv = bn.get(i).copied().unwrap_or(0);
        if lv != rv {
            return lv.cmp(&rv);
        }
    }
    match (ap.is_empty(), bp.is_empty()) {
        (true, true) => std::cmp::Ordering::Equal,
        (true, false) => std::cmp::Ordering::Greater,
        (false, true) => std::cmp::Ordering::Less,
        (false, false) => ap.cmp(&bp),
    }
}

fn sort_loader_desc(mut versions: Vec<String>) -> Vec<String> {
    versions.sort_by(|a, b| compare_loader_versions(b, a));
    versions
}

fn pick_latest_loader(versions: &[String]) -> Option<String> {
    let sorted = sort_loader_desc(versions.to_vec());
    sorted
        .iter()
        .find(|v| {
            let l = v.to_lowercase();
            !l.contains("-beta") && !l.contains("-alpha") && !l.contains("-rc") && !l.contains("-pre")
        })
        .or_else(|| sorted.first())
        .cloned()
}

fn matches_version_token(text: &str, token: &str) -> bool {
    let clean = token.trim().to_lowercase();
    if clean.is_empty() {
        return false;
    }
    let pattern = format!(r"(?i)(?:^|[^0-9.]){}(?:$|[^0-9.])", regex::escape(&clean));
    Regex::new(&pattern)
        .map(|re| re.is_match(text))
        .unwrap_or(false)
}

fn console_java_path(java_path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        if java_path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.eq_ignore_ascii_case("javaw.exe"))
            .unwrap_or(false)
        {
            let candidate = java_path.with_file_name("java.exe");
            if candidate.exists() {
                return candidate;
            }
        }
    }
    java_path.to_path_buf()
}

fn is_quick_play_supported(game_version: &str, version: &VersionJson) -> bool {
    if let Some(args) = &version.arguments {
        if serde_json::to_string(&args.game)
            .map(|s| s.contains("quickPlay"))
            .unwrap_or(false)
        {
            return true;
        }
    }
    let parts: Vec<&str> = game_version.split('.').collect();
    if parts.first() == Some(&"1") {
        if let Some(minor) = parts.get(1).and_then(|s| s.parse::<u32>().ok()) {
            if minor >= 20 {
                return true;
            }
        }
    } else if parts
        .first()
        .and_then(|s| s.parse::<u32>().ok())
        .map(|m| m >= 20)
        .unwrap_or(false)
    {
        return true;
    }
    false
}

fn append_quick_play_args(
    game_args: &mut Vec<String>,
    game_version: &str,
    version: &VersionJson,
    quick_play: Option<&QuickPlayTarget>,
) {
    let Some(qp) = quick_play else {
        return;
    };
    let val = qp.value.trim();
    if val.is_empty() {
        return;
    }
    if qp.kind == "singleplayer" {
        if is_quick_play_supported(game_version, version) {
            game_args.push("--quickPlaySingleplayer".to_string());
            game_args.push(val.to_string());
        }
        return;
    }
    if is_quick_play_supported(game_version, version) {
        game_args.push("--quickPlayMultiplayer".to_string());
        game_args.push(val.to_string());
    } else {
        let (host, port) = if let Some(rest) = val.strip_prefix('[') {
            if let Some((h, after)) = rest.split_once(']') {
                let p = after
                    .strip_prefix(':')
                    .and_then(|s| s.parse::<u16>().ok())
                    .filter(|&p| p > 0)
                    .unwrap_or(25565);
                (h.to_string(), p)
            } else {
                (val.to_string(), 25565)
            }
        } else if val.matches(':').count() == 1 {
            if let Some((h, p_str)) = val.rsplit_once(':') {
                if let Ok(p) = p_str.parse::<u16>() {
                    if p > 0 && !h.is_empty() {
                        (h.to_string(), p)
                    } else {
                        (val.to_string(), 25565)
                    }
                } else {
                    (val.to_string(), 25565)
                }
            } else {
                (val.to_string(), 25565)
            }
        } else {
            (val.to_string(), 25565)
        };
        game_args.push("--server".to_string());
        game_args.push(host);
        game_args.push("--port".to_string());
        game_args.push(port.to_string());
    }
}

pub struct MinecraftService {
    client: Client,
    manifest_cache: Mutex<Option<Cached<VersionManifest>>>,
    loader_support_cache: Mutex<Option<Cached<HashMap<String, Vec<String>>>>>,
    loader_versions_cache: Mutex<HashMap<String, Cached<Vec<String>>>>,
}

impl MinecraftService {
    pub fn new() -> Self {
        let client = Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(60))
            .build()
            .unwrap_or_else(|_| Client::new());
        Self {
            client,
            manifest_cache: Mutex::new(None),
            loader_support_cache: Mutex::new(None),
            loader_versions_cache: Mutex::new(HashMap::new()),
        }
    }

    pub async fn get_manifest(&self) -> Result<VersionManifest, String> {
        if let Some(fresh) = self
            .manifest_cache
            .lock()
            .await
            .as_ref()
            .and_then(Cached::fresh)
        {
            return Ok(fresh);
        }
        let manifest_path = get_versions_root().join("version_manifest_v2.json");
        let fetched = async {
            let resp = self
                .client
                .get(MANIFEST_URL)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                return Err(format!("HTTP {}", resp.status().as_u16()));
            }
            let manifest: VersionManifest = resp.json().await.map_err(|e| e.to_string())?;
            if let Some(parent) = manifest_path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            if let Ok(raw) = serde_json::to_string(&manifest) {
                let _ = fs::write(&manifest_path, raw);
            }
            Ok::<VersionManifest, String>(manifest)
        }
        .await;

        let manifest = match fetched {
            Ok(m) => m,
            Err(_) => {
                let raw = fs::read_to_string(&manifest_path).map_err(|_| {
                    tr(
                        "Could not load the Minecraft version list (offline and no cache yet)",
                        "Не удалось загрузить список версий Minecraft (нет сети и сохранённой копии)",
                    )
                    .to_string()
                })?;
                serde_json::from_str::<VersionManifest>(&raw).map_err(|e| e.to_string())?
            }
        };

        *self.manifest_cache.lock().await = Some(Cached {
            value: manifest.clone(),
            fetched_at: Instant::now(),
        });
        Ok(manifest)
    }

    pub async fn list_game_versions(&self) -> Result<Vec<GameVersionInfo>, String> {
        let manifest = self.get_manifest().await?;
        Ok(manifest
            .versions
            .into_iter()
            .filter_map(|v| {
                let kind = match v.kind.as_str() {
                    "release" => "release",
                    "snapshot" => "snapshot",
                    "old_beta" => "beta",
                    "old_alpha" => "alpha",
                    _ => return None,
                };
                Some(GameVersionInfo {
                    id: v.id,
                    version_type: kind.to_string(),
                })
            })
            .collect())
    }

    pub async fn assert_version_exists(&self, game_version: &str) -> Result<(), String> {
        let manifest = self.get_manifest().await?;
        if !manifest.versions.iter().any(|v| v.id == game_version) {
            return Err(tr_string(
                format!("Minecraft version \"{game_version}\" does not exist. Pick one from the list."),
                format!("Версии Minecraft «{game_version}» не существует. Выберите версию из списка."),
            ));
        }
        Ok(())
    }

    async fn fetch_text(&self, url: &str) -> Result<String, String> {
        let resp = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}: {url}", resp.status().as_u16()));
        }
        resp.text().await.map_err(|e| e.to_string())
    }

    fn parse_maven_xml(xml: &str) -> Vec<String> {
        MAVEN_VERSION_RE
            .captures_iter(xml)
            .filter_map(|c| c.get(1).map(|m| m.as_str().to_string()))
            .collect()
    }

    pub async fn get_loader_support(&self) -> Result<HashMap<String, Vec<String>>, String> {
        if let Some(fresh) = self
            .loader_support_cache
            .lock()
            .await
            .as_ref()
            .and_then(Cached::fresh)
        {
            return Ok(fresh);
        }
        let manifest = self.get_manifest().await?;
        let releases: Vec<String> = manifest
            .versions
            .iter()
            .filter(|v| v.kind == "release")
            .map(|v| v.id.clone())
            .collect();
        let everything: Vec<String> = manifest.versions.iter().map(|v| v.id.clone()).collect();

        let (fabric_raw, quilt_raw, forge_xml, nf_xml) = tokio::join!(
            self.client.get("https://meta.fabricmc.net/v2/versions/game").send(),
            self.client.get("https://meta.quiltmc.org/v3/versions/game").send(),
            self.fetch_text("https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml"),
            self.fetch_text("https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml"),
        );

        let fabric_set: HashSet<String> = match fabric_raw {
            Ok(r) if r.status().is_success() => r
                .json::<Vec<Value>>()
                .await
                .unwrap_or_default()
                .into_iter()
                .filter_map(|v| v.get("version").and_then(Value::as_str).map(str::to_string))
                .collect(),
            _ => HashSet::new(),
        };
        let quilt_set: HashSet<String> = match quilt_raw {
            Ok(r) if r.status().is_success() => r
                .json::<Vec<Value>>()
                .await
                .unwrap_or_default()
                .into_iter()
                .filter_map(|v| v.get("version").and_then(Value::as_str).map(str::to_string))
                .collect(),
            _ => HashSet::new(),
        };
        let forge_builds = forge_xml
            .map(|x| Self::parse_maven_xml(&x))
            .unwrap_or_default();
        let nf_builds = nf_xml
            .map(|x| Self::parse_maven_xml(&x))
            .unwrap_or_default();

        let fabric: Vec<String> = if fabric_set.is_empty() {
            releases.clone()
        } else {
            everything
                .iter()
                .filter(|id| fabric_set.contains(*id))
                .cloned()
                .collect()
        };
        let quilt: Vec<String> = if quilt_set.is_empty() {
            releases.clone()
        } else {
            everything
                .iter()
                .filter(|id| quilt_set.contains(*id))
                .cloned()
                .collect()
        };
        let forge: Vec<String> = if forge_builds.is_empty() {
            releases.clone()
        } else {
            releases
                .iter()
                .filter(|rel| forge_builds.iter().any(|b| b.starts_with(&format!("{rel}-"))))
                .cloned()
                .collect()
        };
        let neoforge: Vec<String> = if nf_builds.is_empty() {
            releases.clone()
        } else {
            releases
                .iter()
                .filter(|rel| {
                    neoforge_prefix(rel)
                        .map(|pref| nf_builds.iter().any(|b| b.starts_with(&pref)))
                        .unwrap_or(false)
                })
                .cloned()
                .collect()
        };

        let mut map = HashMap::new();
        map.insert("fabric".to_string(), fabric);
        map.insert("quilt".to_string(), quilt);
        map.insert("forge".to_string(), forge);
        map.insert("neoforge".to_string(), neoforge);

        *self.loader_support_cache.lock().await = Some(Cached {
            value: map.clone(),
            fetched_at: Instant::now(),
        });
        Ok(map)
    }

    pub async fn list_loader_versions(
        &self,
        loader: &str,
        game_version: &str,
    ) -> Result<Vec<String>, String> {
        if loader == "vanilla" {
            return Ok(Vec::new());
        }
        let key = format!("{loader}:{game_version}");
        if let Some(fresh) = self
            .loader_versions_cache
            .lock()
            .await
            .get(&key)
            .and_then(Cached::fresh)
        {
            return Ok(fresh);
        }

        let versions = match loader {
            "fabric" => {
                let resp = self
                    .client
                    .get(format!(
                        "https://meta.fabricmc.net/v2/versions/loader/{game_version}"
                    ))
                    .send()
                    .await
                    .map_err(|e| e.to_string())?;
                if matches!(resp.status().as_u16(), 400 | 404) {
                    Vec::new()
                } else if !resp.status().is_success() {
                    return Err(format!("Fabric HTTP {}", resp.status().as_u16()));
                } else {
                    resp.json::<Vec<Value>>()
                        .await
                        .unwrap_or_default()
                        .into_iter()
                        .filter_map(|v| {
                            v.pointer("/loader/version")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                        })
                        .collect()
                }
            }
            "quilt" => {
                let resp = self
                    .client
                    .get(format!(
                        "https://meta.quiltmc.org/v3/versions/loader/{game_version}"
                    ))
                    .send()
                    .await
                    .map_err(|e| e.to_string())?;
                if matches!(resp.status().as_u16(), 400 | 404) {
                    Vec::new()
                } else if !resp.status().is_success() {
                    return Err(format!("Quilt HTTP {}", resp.status().as_u16()));
                } else {
                    resp.json::<Vec<Value>>()
                        .await
                        .unwrap_or_default()
                        .into_iter()
                        .filter_map(|v| {
                            v.pointer("/loader/version")
                                .or_else(|| v.get("version"))
                                .and_then(Value::as_str)
                                .map(str::to_string)
                        })
                        .collect()
                }
            }
            "forge" => {
                let xml = self
                    .fetch_text(
                        "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml",
                    )
                    .await?;
                let pref = format!("{game_version}-");
                sort_loader_desc(
                    Self::parse_maven_xml(&xml)
                        .into_iter()
                        .filter(|v| v.starts_with(&pref))
                        .collect(),
                )
            }
            "neoforge" => {
                let Some(pref) = neoforge_prefix(game_version) else {
                    return Ok(Vec::new());
                };
                let xml = self
                    .fetch_text(
                        "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml",
                    )
                    .await?;
                sort_loader_desc(
                    Self::parse_maven_xml(&xml)
                        .into_iter()
                        .filter(|v| v.starts_with(&pref))
                        .collect(),
                )
            }
            _ => Vec::new(),
        };

        if !versions.is_empty() {
            self.loader_versions_cache.lock().await.insert(
                key,
                Cached {
                    value: versions.clone(),
                    fetched_at: Instant::now(),
                },
            );
        }
        Ok(versions)
    }

    pub async fn assert_loader_compatible(
        &self,
        loader: &str,
        game_version: &str,
    ) -> Result<(), String> {
        if loader == "vanilla" {
            return Ok(());
        }
        let support = self.get_loader_support().await?;
        let supported = support
            .get(loader)
            .map(|list| list.iter().any(|v| v == game_version))
            .unwrap_or(false);
        if !supported {
            return Err(tr_string(
                format!("Loader \"{loader}\" does not support Minecraft {game_version}. Pick a compatible combination."),
                format!("Загрузчик «{loader}» не поддерживает Minecraft {game_version}. Выберите совместимое сочетание."),
            ));
        }
        let versions = self.list_loader_versions(loader, game_version).await?;
        if versions.is_empty() {
            return Err(tr_string(
                format!("No {loader} releases for Minecraft {game_version} yet."),
                format!("Для Minecraft {game_version} пока нет выпусков {loader}."),
            ));
        }
        Ok(())
    }

    async fn download_file(
        &self,
        url: &str,
        dest: &Path,
        expected_sha1: Option<&str>,
        cancel: Option<&CancellationToken>,
    ) -> Result<(), String> {
        if cancel.map(|c| c.is_cancelled()).unwrap_or(false) {
            return Err(tr("launch cancelled", "запуск отменён").to_string());
        }
        let dest_check = dest.to_path_buf();
        let sha_check = expected_sha1.map(str::to_string);
        let valid = tokio::task::spawn_blocking(move || {
            is_valid_download_sync(&dest_check, sha_check.as_deref())
        })
        .await
        .unwrap_or(false);
        if valid {
            return Ok(());
        }
        if url.is_empty() {
            return Err(tr_string(
                format!("Missing download URL for {}", dest.display()),
                format!("Отсутствует ссылка для загрузки {}", dest.display()),
            ));
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let resp = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}: {url}", resp.status().as_u16()));
        }
        let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
        if cancel.map(|c| c.is_cancelled()).unwrap_or(false) {
            return Err(tr("launch cancelled", "запуск отменён").to_string());
        }
        if let Some(exp) = expected_sha1.filter(|s| !s.is_empty()) {
            let actual = sha1_bytes(&bytes);
            if !actual.eq_ignore_ascii_case(exp) {
                return Err(tr_string(
                    format!("Downloaded file checksum mismatch: {}", dest.display()),
                    format!("Контрольная сумма файла не совпадает: {}", dest.display()),
                ));
            }
        }
        let tmp = PathBuf::from(format!(
            "{}.{}.{}.tmp",
            dest.to_string_lossy(),
            std::process::id(),
            Uuid::new_v4()
        ));
        fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
        if let Err(e) = fs::rename(&tmp, dest) {
            let _ = fs::remove_file(&tmp);
            return Err(e.to_string());
        }
        Ok(())
    }

    async fn get_version_json(
        &self,
        game_version: &str,
        cancel: Option<&CancellationToken>,
    ) -> Result<VersionJson, String> {
        let manifest = self.get_manifest().await?;
        let entry = manifest
            .versions
            .iter()
            .find(|v| v.id == game_version)
            .ok_or_else(|| {
                tr_string(
                    format!("Minecraft version not found in Mojang manifest: {game_version}"),
                    format!("Версия Minecraft не найдена в списке Mojang: {game_version}"),
                )
            })?;
        let path = get_version_dir(game_version).join(format!("{game_version}.json"));
        self.download_file(&entry.url, &path, None, cancel).await?;
        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str::<VersionJson>(&raw).map_err(|e| e.to_string())
    }

    pub async fn get_required_java_major(&self, game_version: &str) -> u32 {
        if let Ok(ver) = self.get_version_json(game_version, None).await {
            if let Some(major) = ver.java_version.and_then(|j| j.major_version) {
                if (8..=30).contains(&major) {
                    return major;
                }
            }
        }
        fallback_required_java_major(game_version)
    }

    async fn prepare_client_jar(
        &self,
        vanilla: &VersionJson,
        target_id: &str,
        cancel: Option<&CancellationToken>,
    ) -> Result<PathBuf, String> {
        let client_path = get_version_dir(target_id).join(format!("{target_id}.jar"));
        self.download_file(
            &vanilla.downloads.client.url,
            &client_path,
            vanilla.downloads.client.sha1.as_deref(),
            cancel,
        )
        .await?;
        Ok(client_path)
    }

    async fn apply_loader_profile<F>(
        &self,
        vanilla: &VersionJson,
        instance: &LauncherInstance,
        java_path: &Path,
        cancel: Option<&CancellationToken>,
        on_progress: &mut F,
    ) -> Result<VersionJson, String>
    where
        F: FnMut(LaunchProgress) + Send,
    {
        match instance.loader.as_str() {
            "fabric" => {
                let lv = match instance.loader_version.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                    Some(v) => v.to_string(),
                    None => {
                        let list = self.list_loader_versions("fabric", &instance.game_version).await?;
                        list.into_iter().next().ok_or_else(|| {
                            tr("Fabric loader version list is empty.", "Список версий загрузчика Fabric пуст.").to_string()
                        })?
                    }
                };
                let url = format!(
                    "https://meta.fabricmc.net/v2/versions/loader/{}/{lv}/profile/json",
                    instance.game_version
                );
                let path = get_versions_root().join(format!("fabric-{}-{lv}.json", instance.game_version));
                self.download_file(&url, &path, None, cancel).await?;
                let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
                let profile: VersionJson = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
                Ok(merge_version_profile(
                    vanilla,
                    &profile,
                    format!("fabric-{}-{lv}", instance.game_version),
                ))
            }
            "quilt" => {
                let lv = match instance.loader_version.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                    Some(v) => v.to_string(),
                    None => {
                        let list = self.list_loader_versions("quilt", &instance.game_version).await?;
                        pick_latest_loader(&list).ok_or_else(|| {
                            tr_string(
                                format!("No Quilt loader found for Minecraft {}.", instance.game_version),
                                format!("Загрузчик Quilt для Minecraft {} не найден.", instance.game_version),
                            )
                        })?
                    }
                };
                let url = format!(
                    "https://meta.quiltmc.org/v3/versions/loader/{}/{lv}/profile/json",
                    instance.game_version
                );
                let path = get_versions_root().join(format!("quilt-{}-{lv}.json", instance.game_version));
                self.download_file(&url, &path, None, cancel).await?;
                let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
                let profile: VersionJson = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
                Ok(merge_version_profile(
                    vanilla,
                    &profile,
                    format!("quilt-{}-{lv}", instance.game_version),
                ))
            }
            "forge" => {
                self.apply_forge_profile(vanilla, instance, java_path, cancel, on_progress)
                    .await
            }
            "neoforge" => {
                self.apply_neoforge_profile(vanilla, instance, java_path, cancel, on_progress)
                    .await
            }
            _ => Ok(vanilla.clone()),
        }
    }

    async fn resolve_forge_version(&self, game_version: &str, requested: Option<&str>) -> Result<String, String> {
        let versions = self.list_loader_versions("forge", game_version).await?;
        if let Some(req) = requested.map(str::trim).filter(|s| !s.is_empty()) {
            let prefixed = if req.starts_with(&format!("{game_version}-")) {
                req.to_string()
            } else {
                format!("{game_version}-{req}")
            };
            if let Some(found) = versions
                .iter()
                .find(|v| *v == req || *v == &prefixed || *v == &format!("{prefixed}-{game_version}"))
                .or_else(|| versions.iter().find(|v| v.starts_with(&format!("{prefixed}-"))))
            {
                return Ok(found.clone());
            }
            return Ok(prefixed);
        }
        pick_latest_loader(&versions).ok_or_else(|| {
            tr_string(
                format!("No Forge loader found for Minecraft {game_version}."),
                format!("Загрузчик Forge для Minecraft {game_version} не найден."),
            )
        })
    }

    fn load_installed_loader_profile(
        &self,
        loader: &str,
        game_version: &str,
        loader_version: &str,
        vanilla: &VersionJson,
    ) -> Result<VersionJson, String> {
        let versions_root = get_versions_root();
        let _ = fs::create_dir_all(&versions_root);
        let lower_lv = loader_version.to_lowercase();
        let short_lv = lower_lv
            .split_once('-')
            .map(|(_, r)| r.to_string())
            .unwrap_or_else(|| lower_lv.clone());
        let stripped = short_lv
            .strip_suffix(&format!("-{}", game_version.to_lowercase()))
            .unwrap_or("")
            .to_string();

        let mut best: Option<(i32, u128, String, VersionJson)> = None;
        for entry in fs::read_dir(&versions_root).map_err(|e| e.to_string())?.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let dir_name = entry.file_name().to_string_lossy().to_string();
            let json_path = path.join(format!("{dir_name}.json"));
            if !json_path.exists() {
                continue;
            }
            let Ok(raw) = fs::read_to_string(&json_path) else {
                continue;
            };
            let Ok(profile) = serde_json::from_str::<VersionJson>(&raw) else {
                continue;
            };
            let id = if profile.id.is_empty() {
                dir_name
            } else {
                profile.id.clone()
            };
            let text = format!(
                "{} {}",
                id,
                profile.inherits_from.as_deref().unwrap_or("")
            )
            .to_lowercase();
            if loader == "forge" {
                if !text.contains("forge") || text.contains("neoforge") {
                    continue;
                }
            } else if !text.contains("neoforge") {
                continue;
            }
            if let Some(inh) = &profile.inherits_from {
                if inh != game_version {
                    continue;
                }
            }
            let has_exact = matches_version_token(&id, &lower_lv)
                || matches_version_token(&id, &short_lv)
                || (!stripped.is_empty() && matches_version_token(&id, &stripped));
            if !has_exact {
                continue;
            }
            let mut score = 0;
            if matches_version_token(&text, game_version) {
                score += 20;
            }
            if matches_version_token(&id, &lower_lv) {
                score += 30;
            }
            if matches_version_token(&id, &short_lv) {
                score += 15;
            }
            if !profile.main_class.is_empty() {
                score += 5;
            }
            let mtime = json_path
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis())
                .unwrap_or(0);
            if best
                .as_ref()
                .map(|(bs, bm, _, _)| score > *bs || (score == *bs && mtime > *bm))
                .unwrap_or(true)
            {
                best = Some((score, mtime, id, profile));
            }
        }

        let (_, _, id, profile) = best.ok_or_else(|| {
            tr_string(
                format!("{loader} installed profile was not found after installer finished."),
                format!("После установки {loader} профиль версии не найден."),
            )
        })?;
        Ok(merge_version_profile(vanilla, &profile, id))
    }

    async fn run_client_installer(
        &self,
        java_path: &Path,
        installer_path: &Path,
        loader: &str,
    ) -> Result<(), String> {
        let mc_root = get_minecraft_root();
        fs::create_dir_all(&mc_root).map_err(|e| e.to_string())?;
        let profiles_path = mc_root.join("launcher_profiles.json");
        if !profiles_path.exists() {
            let _ = fs::write(
                &profiles_path,
                serde_json::to_string_pretty(&json!({
                    "profiles": {},
                    "settings": {},
                    "version": 3
                }))
                .unwrap_or_default(),
            );
        }
        let flag = if loader == "neoforge" {
            "--install-client"
        } else {
            "--installClient"
        };
        let java_bin = console_java_path(java_path);
        let inst_path = installer_path.to_path_buf();
        let loader_str = loader.to_string();

        tokio::task::spawn_blocking(move || {
            let mut cmd = Command::new(&java_bin);
            cmd.current_dir(&mc_root)
                .arg("-jar")
                .arg(&inst_path)
                .arg(flag)
                .arg(&mc_root);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000);
            }
            let out = cmd.output().map_err(|e| e.to_string())?;
            if !out.status.success() {
                let tail = format!(
                    "{}\n{}",
                    String::from_utf8_lossy(&out.stdout),
                    String::from_utf8_lossy(&out.stderr)
                );
                let lines: Vec<&str> = tail
                    .lines()
                    .map(str::trim)
                    .filter(|l| !l.is_empty())
                    .collect();
                let snippet = lines
                    .iter()
                    .rev()
                    .take(15)
                    .rev()
                    .copied()
                    .collect::<Vec<_>>()
                    .join("\n");
                return Err(tr_string(
                    format!("{loader_str} client installer failed:\n{snippet}"),
                    format!("Установщик {loader_str} завершился с ошибкой:\n{snippet}"),
                ));
            }
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    async fn apply_forge_profile<F>(
        &self,
        vanilla: &VersionJson,
        instance: &LauncherInstance,
        java_path: &Path,
        cancel: Option<&CancellationToken>,
        on_progress: &mut F,
    ) -> Result<VersionJson, String>
    where
        F: FnMut(LaunchProgress) + Send,
    {
        let lv = self
            .resolve_forge_version(&instance.game_version, instance.loader_version.as_deref())
            .await?;
        if let Ok(existing) =
            self.load_installed_loader_profile("forge", &instance.game_version, &lv, vanilla)
        {
            return Ok(existing);
        }
        let installer_url = format!(
            "https://maven.minecraftforge.net/net/minecraftforge/forge/{lv}/forge-{lv}-installer.jar"
        );
        let installer_path = get_minecraft_root()
            .join("installers")
            .join(format!("forge-{lv}-installer.jar"));

        match self
            .download_file(&installer_url, &installer_path, None, cancel)
            .await
        {
            Ok(()) => {
                on_progress(LaunchProgress {
                    phase: "loader".to_string(),
                    done: 0,
                    total: 0,
                    received: None,
                    total_bytes: None,
                });
                self.prepare_client_jar(vanilla, &instance.game_version, cancel)
                    .await?;
                self.run_client_installer(java_path, &installer_path, "forge")
                    .await?;
                self.load_installed_loader_profile("forge", &instance.game_version, &lv, vanilla)
            }
            Err(err) if err.contains("HTTP 404") => {
                self.apply_legacy_forge(vanilla, instance, &lv, cancel).await
            }
            Err(err) => Err(err),
        }
    }

    async fn apply_legacy_forge(
        &self,
        vanilla: &VersionJson,
        instance: &LauncherInstance,
        lv: &str,
        cancel: Option<&CancellationToken>,
    ) -> Result<VersionJson, String> {
        let profile_id = format!("{}-forge-{lv}", instance.game_version);
        let built_jar = get_version_dir(&profile_id).join(format!("{profile_id}.jar"));
        if built_jar.exists() {
            let mut v = vanilla.clone();
            v.id = profile_id;
            v.prebuilt_client_jar = Some(built_jar);
            return Ok(v);
        }
        let zip_url = format!(
            "https://maven.minecraftforge.net/net/minecraftforge/forge/{lv}/forge-{lv}-client.zip"
        );
        let zip_path = get_minecraft_root()
            .join("installers")
            .join(format!("forge-{lv}-client.zip"));
        self.download_file(&zip_url, &zip_path, None, cancel).await?;
        let vanilla_jar = self
            .prepare_client_jar(vanilla, &instance.game_version, cancel)
            .await?;
        let built_clone = built_jar.clone();
        let lv_owned = lv.to_string();
        tokio::task::spawn_blocking(move || {
            let work = get_minecraft_root()
                .join("installers")
                .join(format!("legacy-{lv_owned}"));
            let _ = fs::remove_dir_all(&work);
            let merged = work.join("merged");
            extract_zip(&vanilla_jar, &merged)?;
            extract_zip(&zip_path, &merged)?;
            let _ = fs::remove_dir_all(merged.join("META-INF"));
            if let Some(p) = built_clone.parent() {
                fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            let tmp = built_clone.with_extension("jar.tmp");
            create_zip_from_dir(&merged, &tmp, false, |_, _| true)?;
            let _ = fs::remove_file(&built_clone);
            fs::rename(&tmp, &built_clone).map_err(|e| e.to_string())?;
            let _ = fs::remove_dir_all(&work);
            Ok::<(), String>(())
        })
        .await
        .map_err(|e| e.to_string())??;

        let mut v = vanilla.clone();
        v.id = profile_id;
        v.prebuilt_client_jar = Some(built_jar);
        Ok(v)
    }

    async fn apply_neoforge_profile<F>(
        &self,
        vanilla: &VersionJson,
        instance: &LauncherInstance,
        java_path: &Path,
        cancel: Option<&CancellationToken>,
        on_progress: &mut F,
    ) -> Result<VersionJson, String>
    where
        F: FnMut(LaunchProgress) + Send,
    {
        let lv = match instance.loader_version.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(v) => v.to_string(),
            None => {
                let list = self
                    .list_loader_versions("neoforge", &instance.game_version)
                    .await?;
                pick_latest_loader(&list).ok_or_else(|| {
                    tr_string(
                        format!("No NeoForge loader found for Minecraft {}.", instance.game_version),
                        format!("Загрузчик NeoForge для Minecraft {} не найден.", instance.game_version),
                    )
                })?
            }
        };
        if let Ok(existing) =
            self.load_installed_loader_profile("neoforge", &instance.game_version, &lv, vanilla)
        {
            return Ok(existing);
        }
        let installer_url = format!(
            "https://maven.neoforged.net/releases/net/neoforged/neoforge/{lv}/neoforge-{lv}-installer.jar"
        );
        let installer_path = get_minecraft_root()
            .join("installers")
            .join(format!("neoforge-{lv}-installer.jar"));
        self.download_file(&installer_url, &installer_path, None, cancel)
            .await?;
        on_progress(LaunchProgress {
            phase: "loader".to_string(),
            done: 0,
            total: 0,
            received: None,
            total_bytes: None,
        });
        self.prepare_client_jar(vanilla, &instance.game_version, cancel)
            .await?;
        self.run_client_installer(java_path, &installer_path, "neoforge")
            .await?;
        self.load_installed_loader_profile("neoforge", &instance.game_version, &lv, vanilla)
    }

    async fn prepare_libraries<F>(
        &self,
        version: &VersionJson,
        natives_dir: &Path,
        cancel: Option<&CancellationToken>,
        on_progress: &mut F,
    ) -> Result<Vec<PathBuf>, String>
    where
        F: FnMut(LaunchProgress) + Send,
    {
        let allowed: Vec<&LibraryEntry> = version
            .libraries
            .iter()
            .filter(|l| is_allowed(l.rules.as_ref()))
            .collect();
        let total = allowed.len();
        let mut classpath = Vec::new();
        let lib_root = get_libraries_root();
        let os_key = mojang_os_name();

        for (idx, lib) in allowed.into_iter().enumerate() {
            if cancel.map(|c| c.is_cancelled()).unwrap_or(false) {
                return Err(tr("launch cancelled", "запуск отменён").to_string());
            }
            let artifact = lib.downloads.as_ref().and_then(|d| d.artifact.as_ref());
            if let Some(art) = artifact.filter(|a| a.path.is_some()) {
                let rel = art.path.as_deref().unwrap_or("");
                let dest = lib_root.join(rel);
                let url = if !art.url.is_empty() {
                    art.url.clone()
                } else if let (Some(base), Some(name)) = (&lib.url, &lib.name) {
                    format!("{}/{}", base.trim_end_matches('/'), maven_rel_path(name))
                } else if let Some(name) = &lib.name {
                    format!("{LEGACY_LIBRARIES_ROOT}/{}", maven_rel_path(name))
                } else {
                    String::new()
                };
                if !dest.exists() || !url.is_empty() {
                    if !url.is_empty() {
                        self.download_file(&url, &dest, art.sha1.as_deref(), cancel)
                            .await?;
                    }
                }
                classpath.push(dest);
            } else if let Some(name) = &lib.name {
                if lib.natives.is_none() || lib.url.is_some() {
                    let rel = maven_rel_path(name);
                    let dest = lib_root.join(&rel);
                    let url = match &lib.url {
                        Some(base) => format!("{}/{rel}", base.trim_end_matches('/')),
                        None => format!("{LEGACY_LIBRARIES_ROOT}/{rel}"),
                    };
                    if !dest.exists() {
                        self.download_file(&url, &dest, None, cancel).await?;
                    }
                    classpath.push(dest);
                }
            }

            if let Some(tmpl) = lib.natives.as_ref().and_then(|n| n.get(os_key)) {
                let classifier = natives_classifier(tmpl);
                let native_dl = lib
                    .downloads
                    .as_ref()
                    .and_then(|d| d.classifiers.as_ref())
                    .and_then(|c| c.get(&classifier));
                let (dest, url, sha1) = if let Some(dl) = native_dl {
                    let p = match &dl.path {
                        Some(rel) => lib_root.join(rel),
                        None => lib_root.join(maven_classifier_rel_path(
                            lib.name.as_deref().unwrap_or(""),
                            &classifier,
                        )),
                    };
                    let u = if !dl.url.is_empty() {
                        dl.url.clone()
                    } else if let Some(name) = &lib.name {
                        format!(
                            "{LEGACY_LIBRARIES_ROOT}/{}",
                            maven_classifier_rel_path(name, &classifier)
                        )
                    } else {
                        String::new()
                    };
                    (p, u, dl.sha1.clone())
                } else if let Some(name) = &lib.name {
                    let rel = maven_classifier_rel_path(name, &classifier);
                    let u = match &lib.url {
                        Some(base) => format!("{}/{rel}", base.trim_end_matches('/')),
                        None => format!("{LEGACY_LIBRARIES_ROOT}/{rel}"),
                    };
                    (lib_root.join(&rel), u, None)
                } else {
                    continue;
                };
                self.download_file(&url, &dest, sha1.as_deref(), cancel)
                    .await?;
                let nat_dst = natives_dir.to_path_buf();
                tokio::task::spawn_blocking(move || {
                    extract_zip_filtered(&dest, &nat_dst, |p| {
                        p == "META-INF" || p.starts_with("META-INF/")
                    })
                })
                .await
                .map_err(|e| e.to_string())??;
            }

            on_progress(LaunchProgress {
                phase: "libraries".to_string(),
                done: idx + 1,
                total,
                received: None,
                total_bytes: None,
            });
        }
        Ok(classpath)
    }

    async fn prepare_assets<F>(
        &self,
        version: &VersionJson,
        launch_dir: &Path,
        cancel: Option<&CancellationToken>,
        concurrency: usize,
        on_progress: &mut F,
    ) -> Result<PathBuf, String>
    where
        F: FnMut(LaunchProgress) + Send,
    {
        let assets_root = get_assets_root();
        let index_path = assets_root
            .join("indexes")
            .join(format!("{}.json", version.asset_index.id));
        self.download_file(
            &version.asset_index.url,
            &index_path,
            version.asset_index.sha1.as_deref(),
            cancel,
        )
        .await?;
        let raw = fs::read_to_string(&index_path).map_err(|e| e.to_string())?;
        let index: AssetIndex = serde_json::from_str(&raw).map_err(|e| e.to_string())?;

        let mut unique: HashMap<String, AssetObject> = HashMap::new();
        for obj in index.objects.values() {
            unique.entry(obj.hash.clone()).or_insert_with(|| obj.clone());
        }
        let list: Vec<AssetObject> = unique.into_values().collect();
        let total = list.len();
        let done_counter = Arc::new(AtomicUsize::new(0));
        let objects_dir = assets_root.join("objects");
        let limit = concurrency.clamp(1, 16);

        let mut results = stream::iter(list.into_iter().map(|obj| {
            let objects_dir = objects_dir.clone();
            let done_counter = done_counter.clone();
            async move {
                let prefix = &obj.hash[..2.min(obj.hash.len())];
                let dest = objects_dir.join(prefix).join(&obj.hash);
                let url = format!("{ASSET_OBJECT_ROOT}/{prefix}/{}", obj.hash);
                self.download_file(&url, &dest, Some(&obj.hash), cancel)
                    .await?;
                let d = done_counter.fetch_add(1, Ordering::Relaxed) + 1;
                Ok::<usize, String>(d)
            }
        }))
        .buffer_unordered(limit);

        while let Some(res) = results.next().await {
            let d = res?;
            on_progress(LaunchProgress {
                phase: "assets".to_string(),
                done: d,
                total,
                received: None,
                total_bytes: None,
            });
        }

        if index.map_to_resources || index.is_virtual {
            let target_dir = if index.map_to_resources {
                launch_dir.join("resources")
            } else {
                assets_root.join("virtual").join(&version.asset_index.id)
            };
            let objects_copy = index.objects;
            let obj_root = objects_dir.clone();
            let tgt = target_dir.clone();
            tokio::task::spawn_blocking(move || {
                for (name, obj) in objects_copy {
                    let dst = tgt.join(&name);
                    if dst.metadata().map(|m| m.len() == obj.size).unwrap_or(false) {
                        continue;
                    }
                    if let Some(parent) = dst.parent() {
                        let _ = fs::create_dir_all(parent);
                    }
                    let prefix = &obj.hash[..2.min(obj.hash.len())];
                    let src = obj_root.join(prefix).join(&obj.hash);
                    let _ = fs::copy(src, dst);
                }
            })
            .await
            .map_err(|e| e.to_string())?;
            return Ok(target_dir);
        }

        Ok(assets_root)
    }

    async fn ensure_authlib_injector(&self, cancel: Option<&CancellationToken>) -> Result<PathBuf, String> {
        let dir = get_minecraft_root().join("authlib-injector");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let jar = dir.join("authlib-injector.jar");
        if jar.exists() {
            return Ok(jar);
        }
        let resp = self
            .client
            .get("https://api.github.com/repos/yushijinhun/authlib-injector/releases/latest")
            .header("accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("authlib-injector HTTP {}", resp.status().as_u16()));
        }
        let body: Value = resp.json().await.map_err(|e| e.to_string())?;
        let url = body
            .get("assets")
            .and_then(Value::as_array)
            .and_then(|arr| {
                arr.iter().find_map(|a| {
                    let name = a.get("name").and_then(Value::as_str)?;
                    if name.to_lowercase().ends_with(".jar") {
                        a.get("browser_download_url")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    } else {
                        None
                    }
                })
            })
            .ok_or_else(|| "authlib-injector jar not found".to_string())?;
        self.download_file(&url, &jar, None, cancel).await?;
        Ok(jar)
    }

    async fn is_ely_available(&self) -> bool {
        let res = tokio::time::timeout(
            Duration::from_secs(6),
            self.client.get("https://ely.by/").send(),
        )
        .await;
        match res {
            Ok(Ok(resp)) => resp.status().is_success(),
            _ => false,
        }
    }

    pub async fn prepare_launch<F>(
        &self,
        instance: &LauncherInstance,
        account: &AccountState,
        memory_mb: u32,
        extra_jvm_args: &[String],
        java_path: &Path,
        cancel: Option<&CancellationToken>,
        concurrency: usize,
        quick_play: Option<&QuickPlayTarget>,
        mut on_progress: F,
    ) -> Result<PreparedMinecraftLaunch, String>
    where
        F: FnMut(LaunchProgress) + Send,
    {
        let inst_dir = PathBuf::from(&instance.directory);
        fs::create_dir_all(&inst_dir).map_err(|e| e.to_string())?;
        let launch_directory = resolve_launch_instance_dir(&instance.id, &inst_dir);

        let vanilla = self.get_version_json(&instance.game_version, cancel).await?;
        let version = self
            .apply_loader_profile(&vanilla, instance, java_path, cancel, &mut on_progress)
            .await?;
        let natives_dir = get_natives_root(&instance.id, &version.id);
        fs::create_dir_all(&natives_dir).map_err(|e| e.to_string())?;

        let client_jar = match &version.prebuilt_client_jar {
            Some(p) => p.clone(),
            None => self.prepare_client_jar(&vanilla, &version.id, cancel).await?,
        };
        let lib_cp = self
            .prepare_libraries(&version, &natives_dir, cancel, &mut on_progress)
            .await?;
        let game_assets = self
            .prepare_assets(&version, &launch_directory, cancel, concurrency, &mut on_progress)
            .await?;

        let sep = if cfg!(windows) { ";" } else { ":" };
        let mut seen = HashSet::new();
        let mut cp_parts = Vec::new();
        for item in lib_cp.into_iter().chain(std::iter::once(client_jar)) {
            let s = item.to_string_lossy().to_string();
            if seen.insert(s.clone()) {
                cp_parts.push(s);
            }
        }
        let classpath = cp_parts.join(sep);

        let mut warnings = Vec::new();
        let mut eff_qp = quick_play.cloned();
        if let Some(qp) = &eff_qp {
            if cfg!(windows)
                && qp.kind == "singleplayer"
                && has_non_ascii(&qp.value)
                && !can_pass_via_windows_acp(&qp.value)
            {
                eff_qp = None;
                warnings.push(
                    tr(
                        "Quick Play skipped because the Windows system codepage cannot pass a non-ASCII world name to Java; open the world from the in-game menu",
                        "Быстрый вход пропущен: системная кодировка Windows не передаёт нелатинское имя мира в Java — выберите мир в меню игры",
                    )
                    .to_string(),
                );
            }
        }

        let player_name = account
            .profile_name
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "Player".to_string());
        let player_uuid = account
            .minecraft_uuid
            .as_deref()
            .map(|u| u.replace('-', ""))
            .filter(|u| !u.is_empty())
            .unwrap_or_else(|| offline_uuid_undashed(&player_name));
        let offline = account.status == "offline";
        let access_token = if offline {
            "0".to_string()
        } else if account.kind == "ely" {
            account
                .ely_access_token
                .clone()
                .filter(|_| account.status == "signed-in")
                .ok_or_else(|| {
                    tr(
                        "Log in with Ely.by again before launching Minecraft.",
                        "Перед запуском Minecraft войдите через Ely.by ещё раз.",
                    )
                    .to_string()
                })?
        } else {
            account
                .minecraft_access_token
                .clone()
                .filter(|_| account.status == "signed-in")
                .ok_or_else(|| {
                    tr(
                        "Sign in with Microsoft or select an offline profile before launching Minecraft.",
                        "Перед запуском Minecraft войдите через Microsoft или выберите офлайн-профиль.",
                    )
                    .to_string()
                })?
        };

        let game_dir_arg = if cfg!(windows) && has_non_ascii(&launch_directory.to_string_lossy()) {
            ".".to_string()
        } else {
            launch_directory.to_string_lossy().to_string()
        };

        let mut vars: HashMap<&str, String> = HashMap::new();
        vars.insert("auth_player_name", player_name);
        vars.insert("version_name", version.id.clone());
        vars.insert("game_directory", game_dir_arg);
        vars.insert("assets_root", get_assets_root().to_string_lossy().to_string());
        vars.insert(
            "assets_index_name",
            if !version.asset_index.id.is_empty() {
                version.asset_index.id.clone()
            } else {
                version.assets.clone().unwrap_or_else(|| version.id.clone())
            },
        );
        vars.insert("auth_uuid", player_uuid.clone());
        vars.insert("auth_access_token", access_token.clone());
        vars.insert("clientid", if offline { String::new() } else { "lynapp".to_string() });
        vars.insert(
            "auth_xuid",
            if offline {
                String::new()
            } else {
                account.xbox_uhs.clone().unwrap_or_else(|| "0".to_string())
            },
        );
        vars.insert("user_type", if offline { "legacy" } else { "msa" }.to_string());
        vars.insert("version_type", version.kind.clone());
        vars.insert("natives_directory", natives_dir.to_string_lossy().to_string());
        vars.insert("launcher_name", "lynapp".to_string());
        vars.insert("launcher_version", LAUNCHER_VERSION.to_string());
        vars.insert("classpath", classpath);
        vars.insert("classpath_separator", sep.to_string());
        vars.insert("library_directory", get_libraries_root().to_string_lossy().to_string());
        vars.insert("user_properties", "{}".to_string());
        vars.insert("game_assets", game_assets.to_string_lossy().to_string());
        vars.insert(
            "auth_session",
            if offline {
                access_token
            } else {
                format!("token:{access_token}:{player_uuid}")
            },
        );

        let mut jvm_args = version
            .arguments
            .as_ref()
            .map(|a| collect_args(&a.jvm, &vars))
            .unwrap_or_default();
        if !jvm_args.iter().any(|a| a == "-cp" || a == "-classpath") {
            let mut prefix = vec![
                replace_vars("-Djava.library.path=${natives_directory}", &vars),
                "-cp".to_string(),
                replace_vars("${classpath}", &vars),
            ];
            prefix.extend(jvm_args);
            jvm_args = prefix;
        }

        let modern_game = version
            .arguments
            .as_ref()
            .map(|a| collect_args(&a.game, &vars))
            .unwrap_or_default();
        let legacy_game: Vec<String> = version
            .minecraft_arguments
            .as_deref()
            .unwrap_or("")
            .split_whitespace()
            .map(|s| replace_vars(s, &vars))
            .collect();
        let mut game_args = if modern_game.iter().any(|a| a == "--username") || legacy_game.is_empty() {
            modern_game
        } else {
            let mut merged = legacy_game;
            merged.extend(modern_game);
            merged
        };

        append_quick_play_args(&mut game_args, &instance.game_version, &version, eff_qp.as_ref());

        let mut args = Vec::new();
        if account.kind == "ely" {
            if self.is_ely_available().await {
                let injector = self.ensure_authlib_injector(cancel).await?;
                args.push(format!("-javaagent:{}=ely.by", injector.to_string_lossy()));
            } else {
                warnings.push(
                    tr(
                        "Ely.by is unavailable, the game runs with your nickname but without the Ely.by skin and login on Ely.by servers",
                        "Ely.by недоступен, игра запущена с вашим ником, но без скина Ely.by и входа на серверы с авторизацией Ely.by",
                    )
                    .to_string(),
                );
            }
        }
        args.push(format!("-Xms{memory_mb}M"));
        args.push(format!("-Xmx{memory_mb}M"));
        args.extend(extra_jvm_args.iter().cloned());
        args.extend(jvm_args);
        args.push(version.main_class.clone());
        args.extend(game_args);

        let log_path = inst_dir.join(".launcher").join("logs").join("latest.log");
        if let Some(p) = log_path.parent() {
            fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }

        Ok(PreparedMinecraftLaunch {
            main_class: version.main_class,
            args,
            natives_dir,
            launch_directory,
            log_path,
            warning: if warnings.is_empty() {
                None
            } else {
                Some(warnings.join("; "))
            },
        })
    }
}
