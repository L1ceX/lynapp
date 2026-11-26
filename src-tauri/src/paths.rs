use std::fs;
use std::path::{Path, PathBuf};

pub fn get_launcher_root() -> PathBuf {
    let base = dirs::config_dir()
        .or_else(dirs::data_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("lynapp")
}

pub fn get_instances_root() -> PathBuf {
    get_launcher_root().join("instances")
}

pub fn get_store_path() -> PathBuf {
    get_launcher_root().join("launcher-data.json")
}

pub fn get_skins_dir() -> PathBuf {
    get_launcher_root().join("skins")
}

pub fn get_fonts_root() -> PathBuf {
    get_launcher_root().join("fonts")
}

pub fn get_java_root() -> PathBuf {
    get_launcher_root().join("java")
}

pub fn get_minecraft_root() -> PathBuf {
    get_launcher_root().join("minecraft")
}

pub fn sanitize_folder_name(input: &str) -> String {
    let mut out = String::new();
    let mut prev_space = false;
    for ch in input.chars() {
        let code = ch as u32;
        if code < 0x20 || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
            if !prev_space && !out.is_empty() {
                out.push(' ');
                prev_space = true;
            }
            continue;
        }
        if ch.is_whitespace() {
            if !prev_space && !out.is_empty() {
                out.push(' ');
                prev_space = true;
            }
            continue;
        }
        out.push(ch);
        prev_space = false;
    }
    let trimmed = out.trim_matches(|c: char| c == ' ' || c == '.').to_string();
    let mut safe: String = trimmed.chars().take(64).collect();
    safe = safe.trim_end_matches(|c: char| c == ' ' || c == '.').to_string();
    if safe.is_empty() {
        return "Instance".to_string();
    }
    let upper = safe.to_ascii_uppercase();
    let reserved = matches!(
        upper.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    );
    if reserved {
        safe.push('_');
    }
    safe
}

pub fn pick_instance_directory(
    name: &str,
    ignore_existing: Option<&Path>,
    reserved_dirs: &[String],
) -> PathBuf {
    let root = get_instances_root();
    let base = sanitize_folder_name(name);
    let matches_ignored = |p: &Path| -> bool {
        if let Some(ig) = ignore_existing {
            #[cfg(windows)]
            {
                return p.to_string_lossy().eq_ignore_ascii_case(&ig.to_string_lossy());
            }
            #[cfg(not(windows))]
            {
                return p == ig;
            }
        }
        false
    };
    let is_reserved = |p: &Path| -> bool {
        let ps = p.to_string_lossy();
        reserved_dirs.iter().any(|r| {
            #[cfg(windows)]
            {
                r.eq_ignore_ascii_case(&ps)
            }
            #[cfg(not(windows))]
            {
                r == ps.as_ref()
            }
        })
    };
    let is_free = |p: &Path| -> bool {
        matches_ignored(p) || (!p.exists() && !is_reserved(p))
    };
    let candidate = root.join(&base);
    if is_free(&candidate) {
        return candidate;
    }
    for i in 1..1000 {
        let next = root.join(format!("{base} ({i})"));
        if is_free(&next) {
            return next;
        }
    }
    root.join(format!("{base} ({})", uuid::Uuid::new_v4().simple()))
}

pub fn remove_instance_link(id: &str) {
    let safe_id: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' { c } else { '_' })
        .collect();
    let safe_id = if safe_id.is_empty() { "instance".to_string() } else { safe_id };
    let link = get_minecraft_root().join("instance-links").join(safe_id);
    if let Ok(meta) = fs::symlink_metadata(&link) {
        if meta.file_type().is_symlink() || meta.is_dir() {
            let _ = fs::remove_dir(&link);
        }
    }
}

pub fn is_inside_instances_root(dir: &Path) -> bool {
    let root = fs::canonicalize(get_instances_root()).unwrap_or_else(|_| get_instances_root());
    let resolved = fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    #[cfg(windows)]
    {
        let r = root.to_string_lossy().to_lowercase();
        let d = resolved.to_string_lossy().to_lowercase();
        d != r && (d.starts_with(&format!("{r}\\")) || d.starts_with(&format!("{r}/")))
    }
    #[cfg(not(windows))]
    {
        resolved != root && resolved.starts_with(&root)
    }
}

pub fn reconcile_instance_directories(instances: &mut [crate::types::LauncherInstance]) -> bool {
    let needs_scan = instances.iter().any(|i| !Path::new(&i.directory).exists());
    if !needs_scan {
        return false;
    }
    let root = get_instances_root();
    let Ok(entries) = fs::read_dir(&root) else {
        return false;
    };
    let mut manifest_map: std::collections::HashMap<String, PathBuf> = std::collections::HashMap::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let manifest_path = path.join(".launcher").join("instance.json");
        let Ok(raw) = fs::read_to_string(&manifest_path) else {
            continue;
        };
        let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        if let Some(id) = val.get("id").and_then(|v| v.as_str()) {
            manifest_map.insert(id.to_string(), path);
        }
    }
    if manifest_map.is_empty() {
        return false;
    }
    let mut owned: std::collections::HashSet<String> = instances
        .iter()
        .filter(|i| Path::new(&i.directory).exists())
        .map(|i| {
            #[cfg(windows)]
            {
                i.directory.to_lowercase()
            }
            #[cfg(not(windows))]
            {
                i.directory.clone()
            }
        })
        .collect();
    let mut changed = false;
    for inst in instances.iter_mut() {
        if Path::new(&inst.directory).exists() {
            continue;
        }
        if let Some(found) = manifest_map.get(&inst.id) {
            let found_str = found.to_string_lossy().to_string();
            let key = {
                #[cfg(windows)]
                {
                    found_str.to_lowercase()
                }
                #[cfg(not(windows))]
                {
                    found_str.clone()
                }
            };
            if owned.contains(&key) {
                continue;
            }
            owned.insert(key);
            inst.directory = found_str;
            remove_instance_link(&inst.id);
            if let Ok(json) = serde_json::to_string_pretty(&inst) {
                let _ = fs::write(found.join(".launcher").join("instance.json"), json);
            }
            changed = true;
        }
    }
    changed
}

fn collect_java_bins_in_dirs(roots: &[PathBuf], binary_name: &str) -> Vec<String> {
    let mut found = Vec::new();
    for root in roots {
        if !root.exists() {
            continue;
        }
        if let Ok(entries) = fs::read_dir(root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let bin = path.join("bin").join(binary_name);
                if bin.exists() {
                    found.push(bin.to_string_lossy().to_string());
                }
            }
        }
    }
    found
}

pub fn get_system_java_candidates() -> Vec<String> {
    let java_home = std::env::var("JAVA_HOME").unwrap_or_default();
    let mut list = Vec::new();

    #[cfg(windows)]
    {
        let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".to_string());
        let pf86 = std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| "C:\\Program Files (x86)".to_string());
        let local = std::env::var("LOCALAPPDATA").unwrap_or_default();

        if !java_home.is_empty() {
            list.push(Path::new(&java_home).join("bin").join("javaw.exe").to_string_lossy().to_string());
        }
        let scan_roots = vec![
            Path::new(&pf).join("Java"),
            Path::new(&pf).join("Eclipse Adoptium"),
            Path::new(&pf).join("Microsoft"),
            Path::new(&pf).join("Zulu"),
            Path::new(&pf).join("BellSoft"),
            Path::new(&local).join("Programs").join("Eclipse Adoptium"),
            get_java_root(),
        ];
        list.extend(collect_java_bins_in_dirs(&scan_roots, "javaw.exe"));
        list.push(
            Path::new(&pf86)
                .join("Minecraft Launcher")
                .join("runtime")
                .join("java-runtime-gamma")
                .join("windows-x64")
                .join("java-runtime-gamma")
                .join("bin")
                .join("javaw.exe")
                .to_string_lossy()
                .to_string(),
        );
    }

    #[cfg(not(windows))]
    {
        let home = dirs::home_dir().unwrap_or_default();
        if !java_home.is_empty() {
            list.push(Path::new(&java_home).join("bin").join("java").to_string_lossy().to_string());
        }
        let scan_roots = vec![
            PathBuf::from("/usr/lib/jvm"),
            PathBuf::from("/usr/lib64/jvm"),
            PathBuf::from("/usr/java"),
            PathBuf::from("/opt/java"),
            home.join(".jdks"),
            home.join(".sdkman").join("candidates").join("java"),
            get_java_root(),
        ];
        list.extend(collect_java_bins_in_dirs(&scan_roots, "java"));
        list.push("/usr/bin/java".to_string());
        list.push("/usr/local/bin/java".to_string());
    }

    let mut unique = Vec::new();
    for item in list {
        if !item.is_empty() && !unique.contains(&item) {
            unique.push(item);
        }
    }
    unique
}
