use crate::i18n::{tr, tr_string};
use crate::paths::{get_launcher_root, get_system_java_candidates};
use crate::services::ziputil::{extract_tar_gz, extract_zip};
use crate::types::{JavaInstallation, JavaRuntimeState};
use chrono::Utc;
use futures_util::StreamExt;
use once_cell::sync::Lazy;
use regex::Regex;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub const MANAGED_MAJORS: [u32; 4] = [25, 21, 17, 8];
const USER_AGENT: &str = "lynapp/2.0.0-beta.3";

static VERSION_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"version\s+"(\d+)(?:\.(\d+))?"#).unwrap());
static MC_MODERN_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^(\d+)\.(\d+)").unwrap());
static MC_LEGACY_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^1\.(\d+)(?:\.(\d+))?").unwrap());

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeMarker {
    major: u32,
    javaw_path: String,
    installed_at: String,
}

pub fn get_runtime_root() -> PathBuf {
    get_launcher_root().join("runtimes")
}

fn get_runtime_install_dir(major: u32) -> PathBuf {
    get_runtime_root().join(format!("temurin-jre-{major}"))
}

fn get_cache_dir() -> PathBuf {
    get_launcher_root().join("cache").join("java")
}

pub fn fallback_required_java_major(game_version: &str) -> u32 {
    let trimmed = game_version.trim();
    if !trimmed.starts_with("1.") {
        if let Some(caps) = MC_MODERN_RE.captures(trimmed) {
            let major: u32 = caps.get(1).and_then(|m| m.as_str().parse().ok()).unwrap_or(21);
            return if major >= 26 { 25 } else { 21 };
        }
    }
    if let Some(caps) = MC_LEGACY_RE.captures(trimmed) {
        let minor: u32 = caps.get(1).and_then(|m| m.as_str().parse().ok()).unwrap_or(21);
        let patch: u32 = caps.get(2).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
        if minor > 20 || (minor == 20 && patch >= 5) {
            return 21;
        }
        if minor >= 18 {
            return 17;
        }
        if minor == 17 {
            return 16;
        }
        return 8;
    }
    21
}

pub fn is_compatible_major(actual: u32, required: u32) -> bool {
    actual == required || (required == 16 && actual == 17)
}

fn download_major_for(required: u32) -> u32 {
    if required == 16 {
        17
    } else {
        required
    }
}

pub fn parse_java_major(output: &str) -> Option<u32> {
    let caps = VERSION_RE.captures(output)?;
    let first: u32 = caps.get(1)?.as_str().parse().ok()?;
    if first == 1 {
        caps.get(2).and_then(|m| m.as_str().parse().ok())
    } else {
        Some(first)
    }
}

pub fn normalize_java_bin(input: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        if input
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.eq_ignore_ascii_case("java.exe"))
            .unwrap_or(false)
        {
            let javaw = input.with_file_name("javaw.exe");
            if javaw.exists() {
                return javaw;
            }
        }
    }
    input.to_path_buf()
}

pub fn probe_java_major(path: &Path) -> Option<u32> {
    if !path.exists() {
        return None;
    }
    let probe_bin = {
        #[cfg(windows)]
        {
            if path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.eq_ignore_ascii_case("javaw.exe"))
                .unwrap_or(false)
            {
                let java = path.with_file_name("java.exe");
                if java.exists() {
                    java
                } else {
                    path.to_path_buf()
                }
            } else {
                path.to_path_buf()
            }
        }
        #[cfg(not(windows))]
        {
            path.to_path_buf()
        }
    };

    let mut cmd = Command::new(&probe_bin);
    cmd.arg("-version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let output = cmd.output().ok()?;
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    parse_java_major(&combined)
}

fn is_target_java_binary(parent: &Path, name: &str) -> bool {
    #[cfg(windows)]
    {
        let _ = parent;
        name.eq_ignore_ascii_case("javaw.exe")
    }
    #[cfg(not(windows))]
    {
        name == "java" && parent.file_name().and_then(|n| n.to_str()) == Some("bin")
    }
}

fn find_javaw_under(root: &Path, max_depth: i32) -> Option<PathBuf> {
    if max_depth < 0 || !root.exists() {
        return None;
    }
    let entries: Vec<_> = fs::read_dir(root).ok()?.flatten().collect();
    for entry in &entries {
        let p = entry.path();
        if p.is_file() {
            if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                if is_target_java_binary(root, name) {
                    return Some(p);
                }
            }
        }
    }
    for entry in &entries {
        let p = entry.path();
        if p.is_dir() {
            if let Some(found) = find_javaw_under(&p, max_depth - 1) {
                return Some(found);
            }
        }
    }
    None
}

fn list_runtime_javaw_paths() -> Vec<String> {
    let root = get_runtime_root();
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(&root) else {
        return out;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.contains(".tmp-") || name.contains(".old-") {
            continue;
        }
        if let Some(bin) = find_javaw_under(&p, 5) {
            out.push(bin.to_string_lossy().to_string());
        }
    }
    out
}

pub fn list_candidate_paths(extra: &[String]) -> Vec<String> {
    let mut seen = Vec::new();
    for item in extra
        .iter()
        .cloned()
        .chain(list_runtime_javaw_paths())
        .chain(get_system_java_candidates())
    {
        if !item.is_empty() && Path::new(&item).exists() && !seen.contains(&item) {
            seen.push(item);
        }
    }
    seen
}

fn normalize_cmp(s: &str) -> String {
    #[cfg(windows)]
    {
        s.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        s.to_string()
    }
}

fn candidate_source(path_str: &str, preferred: &[String]) -> &'static str {
    let norm = normalize_cmp(path_str);
    if preferred
        .iter()
        .any(|p| !p.is_empty() && normalize_cmp(p) == norm)
    {
        return "configured";
    }
    if norm.starts_with(&normalize_cmp(&get_runtime_root().to_string_lossy())) {
        return "downloaded";
    }
    "system"
}

pub fn describe_installation(major: u32, configured: Option<&str>) -> JavaInstallation {
    let preferred: Vec<String> = configured
        .filter(|s| !s.trim().is_empty())
        .map(|s| vec![s.to_string()])
        .unwrap_or_default();
    for candidate in list_candidate_paths(&preferred) {
        if let Some(found) = probe_java_major(Path::new(&candidate)) {
            if is_compatible_major(found, major) {
                let source = candidate_source(&candidate, &preferred);
                let message = match source {
                    "downloaded" => tr_string(
                        format!("Java {found} managed by lynapp"),
                        format!("Java {found}, установлена lynapp"),
                    ),
                    "configured" => tr_string(
                        format!("Custom Java {found}"),
                        format!("Своя Java {found}"),
                    ),
                    _ => tr_string(
                        format!("System Java {found}"),
                        format!("Системная Java {found}"),
                    ),
                };
                return JavaInstallation {
                    major,
                    path: candidate,
                    valid: true,
                    source: source.to_string(),
                    message,
                };
            }
        }
    }

    JavaInstallation {
        major,
        path: configured.unwrap_or("").to_string(),
        valid: false,
        source: "missing".to_string(),
        message: tr_string(
            format!("Java {major} is not installed"),
            format!("Java {major} не установлена"),
        ),
    }
}

pub fn get_installations(configured: &HashMap<String, String>) -> Vec<JavaInstallation> {
    MANAGED_MAJORS
        .iter()
        .map(|&major| {
            let key = major.to_string();
            describe_installation(major, configured.get(&key).map(|s| s.as_str()))
        })
        .collect()
}

pub fn find_compatible_path(major: u32) -> Option<String> {
    for candidate in list_candidate_paths(&[]) {
        if let Some(found) = probe_java_major(Path::new(&candidate)) {
            if is_compatible_major(found, major) {
                return Some(candidate);
            }
        }
    }
    None
}

pub fn inspect_picked_path(raw: &str) -> (Option<u32>, String) {
    let normalized = normalize_java_bin(Path::new(raw));
    let major = probe_java_major(&normalized);
    (major, normalized.to_string_lossy().to_string())
}

fn adoptium_os() -> &'static str {
    #[cfg(windows)]
    {
        "windows"
    }
    #[cfg(target_os = "macos")]
    {
        "mac"
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        "linux"
    }
}

fn adoptium_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "aarch64",
        "x86" => "x86",
        _ => "x64",
    }
}

fn adoptium_url(major: u32) -> String {
    format!(
        "https://api.adoptium.net/v3/binary/latest/{major}/ga/{}/{}/jre/hotspot/normal/eclipse?project=jdk",
        adoptium_os(),
        adoptium_arch()
    )
}

fn read_marker(runtime_dir: &Path) -> Option<String> {
    let raw = fs::read_to_string(runtime_dir.join(".lian-runtime.json")).ok()?;
    let marker: RuntimeMarker = serde_json::from_str(&raw).ok()?;
    Some(marker.javaw_path)
}

fn write_marker(runtime_dir: &Path, major: u32, javaw_path: &str) -> Result<(), String> {
    let marker = RuntimeMarker {
        major,
        javaw_path: javaw_path.to_string(),
        installed_at: Utc::now().to_rfc3339(),
    };
    let text = serde_json::to_string_pretty(&marker).map_err(|e| e.to_string())?;
    fs::write(runtime_dir.join(".lian-runtime.json"), text).map_err(|e| e.to_string())
}

fn runtime_message(major: u32, required: u32, downloaded: bool) -> String {
    if major == required {
        if downloaded {
            tr_string(format!("Downloaded Java {major}"), format!("Скачана Java {major}"))
        } else {
            tr_string(format!("Using Java {major}"), format!("Используется Java {major}"))
        }
    } else if downloaded {
        tr_string(
            format!("Downloaded Java {major} for Minecraft Java {required} requirement"),
            format!("Скачана Java {major} (Minecraft требует Java {required})"),
        )
    } else {
        tr_string(
            format!("Using Java {major} for Minecraft Java {required} requirement"),
            format!("Используется Java {major} (Minecraft требует Java {required})"),
        )
    }
}

pub struct JavaService {
    client: Client,
    install_locks: Mutex<HashMap<u32, Arc<Mutex<()>>>>,
}

impl JavaService {
    pub fn new() -> Self {
        let client = Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(900))
            .build()
            .unwrap_or_else(|_| Client::new());
        Self {
            client,
            install_locks: Mutex::new(HashMap::new()),
        }
    }

    async fn lock_for_major(&self, major: u32) -> Arc<Mutex<()>> {
        let mut map = self.install_locks.lock().await;
        map.entry(major)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    pub async fn ensure_runtime<F>(
        &self,
        required_major: u32,
        preferred: &[String],
        cancel: Option<CancellationToken>,
        mut on_bytes: F,
    ) -> Result<JavaRuntimeState, String>
    where
        F: FnMut(u64, Option<u64>) + Send,
    {
        let pref_owned = preferred.to_vec();
        let existing = tokio::task::spawn_blocking(move || {
            for candidate in list_candidate_paths(&pref_owned) {
                if let Some(major) = probe_java_major(Path::new(&candidate)) {
                    if is_compatible_major(major, required_major) {
                        let source = candidate_source(&candidate, &pref_owned).to_string();
                        return Some((candidate, major, source));
                    }
                }
            }
            let dl_major = download_major_for(required_major);
            if let Some(marker_path) = read_marker(&get_runtime_install_dir(dl_major)) {
                if let Some(major) = probe_java_major(Path::new(&marker_path)) {
                    if is_compatible_major(major, required_major) {
                        return Some((marker_path, major, "downloaded".to_string()));
                    }
                }
            }
            None
        })
        .await
        .map_err(|e| e.to_string())?;

        if let Some((path, major, source)) = existing {
            return Ok(JavaRuntimeState {
                required_major,
                major,
                path,
                source,
                installed_now: false,
                message: runtime_message(major, required_major, false),
            });
        }

        let dl_major = download_major_for(required_major);
        let (path, major) = self.install_fresh(dl_major, cancel, &mut on_bytes).await?;
        if !is_compatible_major(major, required_major) {
            return Err(tr_string(
                format!("Downloaded Java {dl_major}, but archive contains Java {major}."),
                format!("Скачана Java {dl_major}, но в архиве оказалась Java {major}."),
            ));
        }

        Ok(JavaRuntimeState {
            required_major,
            major,
            path,
            source: "downloaded".to_string(),
            installed_now: true,
            message: runtime_message(major, required_major, true),
        })
    }

    pub async fn install_major(&self, required_major: u32) -> Result<String, String> {
        let dl_major = download_major_for(required_major);
        let (path, major) = self.install_fresh(dl_major, None, &mut |_, _| {}).await?;
        if !is_compatible_major(major, required_major) {
            return Err(tr_string(
                format!("Downloaded Java {dl_major}, but archive contains Java {major}."),
                format!("Скачана Java {dl_major}, но в архиве оказалась Java {major}."),
            ));
        }
        Ok(path)
    }

    async fn install_fresh<F>(
        &self,
        dl_major: u32,
        cancel: Option<CancellationToken>,
        on_bytes: &mut F,
    ) -> Result<(String, u32), String>
    where
        F: FnMut(u64, Option<u64>) + Send,
    {
        let lock = self.lock_for_major(dl_major).await;
        let _guard = lock.lock().await;

        let runtime_dir = get_runtime_install_dir(dl_major);
        if let Some(marker) = read_marker(&runtime_dir) {
            let marker_clone = marker.clone();
            if let Ok(Some(m)) =
                tokio::task::spawn_blocking(move || probe_java_major(Path::new(&marker_clone))).await
            {
                if m == dl_major {
                    return Ok((marker, m));
                }
            }
        }

        if cancel.as_ref().map(|c| c.is_cancelled()).unwrap_or(false) {
            return Err(tr("launch cancelled", "запуск отменён").to_string());
        }

        let cache_dir = get_cache_dir();
        fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
        let ext = if cfg!(windows) { "zip" } else { "tar.gz" };
        let archive_path = cache_dir.join(format!("temurin-jre-{dl_major}.{ext}"));

        let cached_ok = archive_path
            .metadata()
            .map(|m| m.len() > 0)
            .unwrap_or(false);

        if !cached_ok {
            let tmp_path = cache_dir.join(format!(
                "temurin-jre-{dl_major}.{}.{}.tmp",
                std::process::id(),
                Uuid::new_v4()
            ));
            let res = self
                .client
                .get(adoptium_url(dl_major))
                .send()
                .await
                .map_err(|e| e.to_string())?
                .error_for_status()
                .map_err(|e| e.to_string())?;
            let total = res.content_length();
            let mut stream = res.bytes_stream();
            let mut file = fs::File::create(&tmp_path).map_err(|e| e.to_string())?;
            let mut received = 0u64;

            while let Some(chunk_res) = stream.next().await {
                if cancel.as_ref().map(|c| c.is_cancelled()).unwrap_or(false) {
                    drop(file);
                    let _ = fs::remove_file(&tmp_path);
                    return Err(tr("launch cancelled", "запуск отменён").to_string());
                }
                let chunk = chunk_res.map_err(|e| {
                    let _ = fs::remove_file(&tmp_path);
                    e.to_string()
                })?;
                file.write_all(&chunk).map_err(|e| {
                    let _ = fs::remove_file(&tmp_path);
                    e.to_string()
                })?;
                received += chunk.len() as u64;
                on_bytes(received, total);
            }
            drop(file);
            let _ = fs::remove_file(&archive_path);
            fs::rename(&tmp_path, &archive_path).map_err(|e| {
                let _ = fs::remove_file(&tmp_path);
                e.to_string()
            })?;
        }

        let temp_dir = get_runtime_root().join(format!(
            "temurin-jre-{dl_major}.tmp-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        let archive_clone = archive_path.clone();
        let temp_clone = temp_dir.clone();
        let extract_res = tokio::task::spawn_blocking(move || {
            if archive_clone
                .to_string_lossy()
                .to_lowercase()
                .ends_with(".zip")
            {
                extract_zip(&archive_clone, &temp_clone)
            } else {
                extract_tar_gz(&archive_clone, &temp_clone)
            }
        })
        .await
        .map_err(|e| e.to_string())?;

        if let Err(err) = extract_res {
            let _ = fs::remove_dir_all(&temp_dir);
            let _ = fs::remove_file(&archive_path);
            return Err(tr_string(
                format!("Java archive extraction failed: {err}"),
                format!("Не удалось распаковать архив Java: {err}"),
            ));
        }

        let temp_scan = temp_dir.clone();
        let found = tokio::task::spawn_blocking(move || {
            let bin = find_javaw_under(&temp_scan, 5)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = fs::metadata(&bin) {
                    let mut perms = meta.permissions();
                    perms.set_mode(0o755);
                    let _ = fs::set_permissions(&bin, perms);
                }
            }
            let major = probe_java_major(&bin)?;
            let rel = bin.strip_prefix(&temp_scan).ok()?.to_path_buf();
            Some((rel, major))
        })
        .await
        .map_err(|e| e.to_string())?;

        let Some((rel_bin, major)) = found else {
            let _ = fs::remove_dir_all(&temp_dir);
            let _ = fs::remove_file(&archive_path);
            return Err(tr_string(
                format!("Downloaded Java {dl_major}, but Java binary was not found or invalid."),
                format!("Скачана Java {dl_major}, но исполняемый файл Java в архиве не найден или повреждён."),
            ));
        };

        let backup_dir = get_runtime_root().join(format!(
            "temurin-jre-{dl_major}.old-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        let mut moved_old = false;
        if runtime_dir.exists() {
            if let Err(e) = fs::rename(&runtime_dir, &backup_dir) {
                let _ = fs::remove_dir_all(&temp_dir);
                return Err(tr_string(
                    format!("Cannot replace Java runtime while Minecraft is using it: {e}"),
                    format!("Не удалось обновить Java, пока запущен Minecraft: {e}"),
                ));
            }
            moved_old = true;
        }
        if let Err(e) = fs::rename(&temp_dir, &runtime_dir) {
            if moved_old && !runtime_dir.exists() {
                let _ = fs::rename(&backup_dir, &runtime_dir);
            }
            let _ = fs::remove_dir_all(&temp_dir);
            return Err(e.to_string());
        }
        if moved_old {
            let _ = fs::remove_dir_all(&backup_dir);
        }

        let final_bin = runtime_dir.join(rel_bin).to_string_lossy().to_string();
        let _ = write_marker(&runtime_dir, major, &final_bin);
        Ok((final_bin, major))
    }
}
