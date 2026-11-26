use crate::i18n::tr;
use crate::services::content::ContentService;
use crate::services::instances::InstanceService;
use crate::services::minecraft::MinecraftService;
use crate::types::{
    CreateInstancePayload, ExternalImportFailed, ExternalImportImported, ExternalImportResult,
    ExternalInstance, ExternalLauncher, UpdateInstancePatch, UpdateInstancePayload,
};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use chrono::DateTime;
use once_cell::sync::Lazy;
use regex::Regex;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

const ICON_LIMIT: u64 = 512 * 1024;
const WHITELIST: &[&str] = &[
    "mods",
    "resourcepacks",
    "texturepacks",
    "shaderpacks",
    "saves",
    "config",
    "defaultconfigs",
    "datapacks",
    "screenshots",
    "schematics",
    "journeymap",
    "xaerowaypoints",
    "xaeroworldmap",
    "options.txt",
    "optionsof.txt",
    "optionsshaders.txt",
    "servers.dat",
];

static RE_FABRIC: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^fabric-loader-([^-]+)-(.+)$").unwrap());
static RE_QUILT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^quilt-loader-([^-]+)-(.+)$").unwrap());
static RE_FORGE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^(\d+\.\d+(?:\.\d+)?)-forge-?(\d[\w.]*)").unwrap());
static RE_NEOFORGE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^neoforge-(\d[\w.-]*)$").unwrap());
static RE_NAMED: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^(fabric|forge|neoforge|quilt|forgeoptifine|optifine|vanilla)\s+(\d+\.\d+(?:\.\d+)?)$").unwrap()
});
static RE_VANILLA: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^(\d+\.\d+(?:\.\d+)?)(?:-optifine.*)?$").unwrap());
static RE_XMX: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)-Xmx(\d+)([gm])").unwrap());

#[derive(Clone)]
struct ScannedInstance {
    public: ExternalInstance,
    whitelist: bool,
}

#[derive(Clone)]
struct ScannedLauncher {
    key: String,
    id: String,
    root: String,
    instances: Vec<ScannedInstance>,
    error: Option<String>,
}

impl ScannedLauncher {
    fn into_public(self) -> ExternalLauncher {
        ExternalLauncher {
            key: self.key,
            id: self.id,
            root: self.root,
            instances: self.instances.into_iter().map(|i| i.public).collect(),
            error: self.error,
        }
    }
}

fn to_loader(val: Option<&str>) -> Option<String> {
    let lower = val?.trim().to_lowercase();
    match lower.as_str() {
        "vanilla" | "fabric" | "forge" | "quilt" | "neoforge" => Some(lower),
        _ => None,
    }
}

fn from_epoch(val: i64) -> Option<String> {
    if val <= 0 {
        return None;
    }
    let ms = if val < 1_000_000_000_000 {
        val * 1000
    } else {
        val
    };
    DateTime::from_timestamp_millis(ms).map(|dt| dt.to_rfc3339())
}

fn icon_to_data_url(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_str()?.to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => return None,
    };
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > ICON_LIMIT {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

fn content_counts(game_dir: &Path) -> (usize, usize) {
    let mods = fs::read_dir(game_dir.join("mods"))
        .ok()
        .map(|rd| {
            rd.flatten()
                .filter(|e| {
                    let n = e.file_name().to_string_lossy().to_lowercase();
                    e.path().is_file() && (n.ends_with(".jar") || n.ends_with(".jar.disabled"))
                })
                .count()
        })
        .unwrap_or(0);
    let worlds = fs::read_dir(game_dir.join("saves"))
        .ok()
        .map(|rd| rd.flatten().filter(|e| e.path().is_dir()).count())
        .unwrap_or(0);
    (mods, worlds)
}

fn parse_ini(text: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') || trimmed.starts_with('[') {
            continue;
        }
        if let Some((k, v)) = trimmed.split_once('=') {
            let mut val = v.trim().to_string();
            if val.len() >= 2 && val.starts_with('"') && val.ends_with('"') {
                val = val[1..val.len() - 1]
                    .replace("\\\"", "\"")
                    .replace("\\\\", "\\");
            }
            map.insert(k.trim().to_string(), val);
        }
    }
    map
}

fn parse_version_id(id: &str) -> Option<(String, String, Option<String>)> {
    let t = id.trim();
    if let Some(c) = RE_FABRIC.captures(t) {
        return Some((c[2].to_string(), "fabric".to_string(), Some(c[1].to_string())));
    }
    if let Some(c) = RE_QUILT.captures(t) {
        return Some((c[2].to_string(), "quilt".to_string(), Some(c[1].to_string())));
    }
    if let Some(c) = RE_FORGE.captures(t) {
        return Some((c[1].to_string(), "forge".to_string(), Some(c[2].to_string())));
    }
    if let Some(c) = RE_NEOFORGE.captures(t) {
        let lv = c[1].to_string();
        let parts: Vec<&str> = lv.split('.').collect();
        let gv = if parts.len() >= 2 {
            let maj: u32 = parts[0].parse().unwrap_or(0);
            let min: u32 = parts[1].parse().unwrap_or(0);
            if maj >= 20 {
                if min == 0 {
                    format!("1.{maj}")
                } else {
                    format!("1.{maj}.{min}")
                }
            } else {
                String::new()
            }
        } else {
            String::new()
        };
        return Some((gv, "neoforge".to_string(), Some(lv)));
    }
    if let Some(c) = RE_NAMED.captures(t) {
        let kind = c[1].to_lowercase();
        let loader = match kind.as_str() {
            "forgeoptifine" => "forge",
            "optifine" => "vanilla",
            other => other,
        };
        return Some((c[2].to_string(), loader.to_string(), None));
    }
    if let Some(c) = RE_VANILLA.captures(t) {
        return Some((c[1].to_string(), "vanilla".to_string(), None));
    }
    None
}

fn finalize_instance(mut inst: ExternalInstance, whitelist: bool) -> ScannedInstance {
    let (mods, worlds) = content_counts(Path::new(&inst.directory));
    inst.mods = mods;
    inst.worlds = worlds;
    if inst.game_version.is_empty() {
        inst.issue = Some(
            tr(
                "Could not detect the game version",
                "Не удалось определить версию игры",
            )
            .to_string(),
        );
    } else if inst.loader.is_none() {
        inst.issue = Some(
            tr(
                "This loader is not supported by lynapp",
                "Этот загрузчик lynapp не поддерживает",
            )
            .to_string(),
        );
    }
    ScannedInstance {
        public: inst,
        whitelist,
    }
}

fn has_table(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
        [name],
        |_| Ok(()),
    )
    .is_ok()
}

fn scan_modrinth(roots: &[PathBuf]) -> Option<ScannedLauncher> {
    let root = roots.iter().find(|r| r.join("app.db").exists())?;
    let temp = std::env::temp_dir().join(format!("lynapp-mr-{}", Uuid::new_v4()));
    let _ = fs::create_dir_all(&temp);
    let result = (|| -> Result<ScannedLauncher, String> {
        for suffix in ["", "-wal", "-shm"] {
            let src = root.join(format!("app.db{suffix}"));
            if src.exists() {
                let _ = fs::copy(&src, temp.join(format!("app.db{suffix}")));
            }
        }
        let conn = Connection::open(temp.join("app.db")).map_err(|e| e.to_string())?;
        let mut profiles_root = root.join("profiles");
        if has_table(&conn, "settings") {
            if let Ok(custom) = conn.query_row::<Option<String>, _, _>(
                "SELECT custom_dir FROM settings LIMIT 1",
                [],
                |r| r.get(0),
            ) {
                if let Some(cd) = custom {
                    let cand = PathBuf::from(&cd).join("profiles");
                    if cand.exists() {
                        profiles_root = cand;
                    }
                }
            }
        }

        let mut instances = Vec::new();
        if has_table(&conn, "instances") && has_table(&conn, "instance_content_sets") {
            let has_ov = has_table(&conn, "instance_launch_overrides");
            let sql = if has_ov {
                "SELECT i.id, i.path, i.name, s.game_version, s.loader, s.loader_version, i.icon_path, i.last_played, json(o.overrides) \
                 FROM instances i \
                 LEFT JOIN instance_content_sets s ON s.id = i.applied_content_set_id \
                 LEFT JOIN instance_launch_overrides o ON o.instance_id = i.id \
                 WHERE i.install_stage = 'installed'"
            } else {
                "SELECT i.id, i.path, i.name, s.game_version, s.loader, s.loader_version, i.icon_path, i.last_played, NULL \
                 FROM instances i \
                 LEFT JOIN instance_content_sets s ON s.id = i.applied_content_set_id \
                 WHERE i.install_stage = 'installed'"
            };
            if let Ok(mut stmt) = conn.prepare(sql) {
                if let Ok(rows) = stmt.query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0).unwrap_or_default(),
                        row.get::<_, String>(1).unwrap_or_default(),
                        row.get::<_, Option<String>>(2).unwrap_or(None),
                        row.get::<_, Option<String>>(3).unwrap_or(None),
                        row.get::<_, Option<String>>(4).unwrap_or(None),
                        row.get::<_, Option<String>>(5).unwrap_or(None),
                        row.get::<_, Option<String>>(6).unwrap_or(None),
                        row.get::<_, Option<i64>>(7).unwrap_or(None),
                        row.get::<_, Option<String>>(8).unwrap_or(None),
                    ))
                }) {
                    for r in rows.flatten() {
                        let (id, rel_path, name_opt, gv, loader, lv, icon_p, last_played, ov_json) = r;
                        let dir = profiles_root.join(&rel_path);
                        if !dir.exists() {
                            continue;
                        }
                        let mut max_mem = None;
                        let mut extra_args = None;
                        if let Some(ov) = ov_json {
                            if let Ok(v) = serde_json::from_str::<Value>(&ov) {
                                if let Some(m) = v.pointer("/memory/maximum").and_then(Value::as_u64) {
                                    if m >= 512 {
                                        max_mem = Some(m as u32);
                                    }
                                }
                                if let Some(arr) = v.get("extra_launch_args").and_then(Value::as_array) {
                                    let joined: Vec<&str> = arr.iter().filter_map(Value::as_str).collect();
                                    if !joined.is_empty() {
                                        extra_args = Some(joined.join(" "));
                                    }
                                }
                            }
                        }
                        instances.push(finalize_instance(
                            ExternalInstance {
                                key: format!("modrinth:{}|{id}", root.display()),
                                launcher: "modrinth".to_string(),
                                name: name_opt.filter(|s| !s.is_empty()).unwrap_or(rel_path),
                                game_version: gv.unwrap_or_default(),
                                loader: to_loader(loader.as_deref()),
                                loader_version: lv.filter(|s| !s.is_empty()),
                                directory: dir.to_string_lossy().to_string(),
                                mods: 0,
                                worlds: 0,
                                last_played: last_played.and_then(from_epoch),
                                icon_data_url: icon_p.as_deref().and_then(|p| icon_to_data_url(Path::new(p))),
                                max_memory_mb: max_mem,
                                extra_jvm_args: extra_args,
                                issue: None,
                            },
                            false,
                        ));
                    }
                }
            }
        } else if has_table(&conn, "profiles") {
            if let Ok(mut stmt) = conn.prepare(
                "SELECT path, name, game_version, mod_loader, mod_loader_version, icon_path, last_played FROM profiles",
            ) {
                if let Ok(rows) = stmt.query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0).unwrap_or_default(),
                        row.get::<_, Option<String>>(1).unwrap_or(None),
                        row.get::<_, Option<String>>(2).unwrap_or(None),
                        row.get::<_, Option<String>>(3).unwrap_or(None),
                        row.get::<_, Option<String>>(4).unwrap_or(None),
                        row.get::<_, Option<String>>(5).unwrap_or(None),
                        row.get::<_, Option<i64>>(6).unwrap_or(None),
                    ))
                }) {
                    for r in rows.flatten() {
                        let (rel_path, name_opt, gv, loader, lv, icon_p, last_played) = r;
                        let dir = profiles_root.join(&rel_path);
                        if !dir.exists() {
                            continue;
                        }
                        instances.push(finalize_instance(
                            ExternalInstance {
                                key: format!("modrinth:{}|{rel_path}", root.display()),
                                launcher: "modrinth".to_string(),
                                name: name_opt.filter(|s| !s.is_empty()).unwrap_or(rel_path),
                                game_version: gv.unwrap_or_default(),
                                loader: to_loader(loader.as_deref()),
                                loader_version: lv.filter(|s| !s.is_empty()),
                                directory: dir.to_string_lossy().to_string(),
                                mods: 0,
                                worlds: 0,
                                last_played: last_played.and_then(from_epoch),
                                icon_data_url: icon_p.as_deref().and_then(|p| icon_to_data_url(Path::new(p))),
                                max_memory_mb: None,
                                extra_jvm_args: None,
                                issue: None,
                            },
                            false,
                        ));
                    }
                }
            }
        }
        let root_str = root.to_string_lossy().to_string();
        Ok(ScannedLauncher {
            key: format!("modrinth:{root_str}"),
            id: "modrinth".to_string(),
            root: root_str,
            instances,
            error: None,
        })
    })();
    let _ = fs::remove_dir_all(&temp);
    match result {
        Ok(l) => Some(l),
        Err(e) => {
            let root_str = root.to_string_lossy().to_string();
            Some(ScannedLauncher {
                key: format!("modrinth:{root_str}"),
                id: "modrinth".to_string(),
                root: root_str,
                instances: Vec::new(),
                error: Some(e),
            })
        }
    }
}

fn scan_prism(
    root: &Path,
    forced_id: Option<&str>,
    instances_override: Option<&Path>,
    single_instance: Option<&Path>,
) -> Option<ScannedLauncher> {
    if !single_instance.unwrap_or(root).exists() {
        return None;
    }
    let id = forced_id.unwrap_or_else(|| {
        if root.join("polymc.cfg").exists() || root.join("polymc.exe").exists() {
            "polymc"
        } else if root.join("multimc.cfg").exists() || root.join("MultiMC.exe").exists() {
            "multimc"
        } else {
            "prism"
        }
    });
    let cfg_name = match id {
        "polymc" => "polymc.cfg",
        "multimc" => "multimc.cfg",
        _ => "prismlauncher.cfg",
    };
    let mut instances_dir = instances_override
        .map(Path::to_path_buf)
        .unwrap_or_else(|| root.join("instances"));
    if instances_override.is_none() {
        if let Ok(raw) = fs::read_to_string(root.join(cfg_name)) {
            let cfg = parse_ini(&raw);
            if let Some(custom) = cfg.get("InstanceDir").filter(|s| !s.is_empty()) {
                let p = PathBuf::from(custom);
                instances_dir = if p.is_absolute() { p } else { root.join(p) };
            }
        }
    }

    let folders: Vec<(String, PathBuf)> = if let Some(single) = single_instance {
        vec![(
            single
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "Instance".to_string()),
            single.to_path_buf(),
        )]
    } else {
        fs::read_dir(&instances_dir)
            .ok()?
            .flatten()
            .filter(|e| e.path().is_dir())
            .map(|e| (e.file_name().to_string_lossy().to_string(), e.path()))
            .collect()
    };

    let mut instances = Vec::new();
    for (folder_name, dir) in folders {
        let Ok(cfg_raw) = fs::read_to_string(dir.join("instance.cfg")) else {
            continue;
        };
        let cfg = parse_ini(&cfg_raw);
        let pack: Option<Value> = fs::read_to_string(dir.join("mmc-pack.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok());
        let comps: Vec<&Value> = pack
            .as_ref()
            .and_then(|p| p.get("components"))
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter(|c| c.get("disabled").and_then(Value::as_bool) != Some(true))
                    .collect()
            })
            .unwrap_or_default();
        let ver_of = |uid: &str| -> Option<String> {
            comps
                .iter()
                .find(|c| c.get("uid").and_then(Value::as_str) == Some(uid))
                .and_then(|c| c.get("version").and_then(Value::as_str))
                .map(str::to_string)
        };
        let mc_ver = ver_of("net.minecraft").unwrap_or_default();
        let mut loader = Some("vanilla".to_string());
        let mut lv = None;
        for (uid, l) in [
            ("net.fabricmc.fabric-loader", "fabric"),
            ("org.quiltmc.quilt-loader", "quilt"),
            ("net.neoforged", "neoforge"),
            ("net.minecraftforge", "forge"),
        ] {
            if let Some(v) = ver_of(uid) {
                loader = Some(l.to_string());
                lv = Some(v);
                break;
            }
        }
        if comps
            .iter()
            .any(|c| c.get("uid").and_then(Value::as_str) == Some("com.mumfrey.liteloader"))
        {
            loader = None;
        }
        let game_dir = if dir.join(".minecraft").exists() {
            dir.join(".minecraft")
        } else if dir.join("minecraft").exists() {
            dir.join("minecraft")
        } else {
            dir.join(".minecraft")
        };
        let max_mem = if cfg.get("OverrideMemory").map(String::as_str) == Some("true") {
            cfg.get("MaxMemAlloc")
                .and_then(|s| s.parse::<u32>().ok())
                .filter(|&m| m >= 512)
        } else {
            None
        };
        let extra_jvm = if cfg.get("OverrideJavaArgs").map(String::as_str) == Some("true") {
            cfg.get("JvmArgs").filter(|s| !s.is_empty()).cloned()
        } else {
            None
        };
        let last_played = cfg
            .get("lastLaunchTime")
            .and_then(|s| s.parse::<i64>().ok())
            .and_then(from_epoch);

        instances.push(finalize_instance(
            ExternalInstance {
                key: format!("{id}:{}|{folder_name}", instances_dir.display()),
                launcher: id.to_string(),
                name: cfg
                    .get("name")
                    .filter(|s| !s.is_empty())
                    .cloned()
                    .unwrap_or(folder_name),
                game_version: mc_ver,
                loader,
                loader_version: lv,
                directory: game_dir.to_string_lossy().to_string(),
                mods: 0,
                worlds: 0,
                last_played,
                icon_data_url: None,
                max_memory_mb: max_mem,
                extra_jvm_args: extra_jvm,
                issue: None,
            },
            false,
        ));
    }

    let reported = single_instance
        .unwrap_or(&instances_dir)
        .to_string_lossy()
        .to_string();
    Some(ScannedLauncher {
        key: format!("{id}:{reported}"),
        id: id.to_string(),
        root: reported,
        instances,
        error: None,
    })
}

fn scan_curseforge(root: &Path, single: Option<&Path>) -> Option<ScannedLauncher> {
    if !single.unwrap_or(root).exists() {
        return None;
    }
    let folders: Vec<(String, PathBuf)> = if let Some(s) = single {
        vec![(
            s.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
            s.to_path_buf(),
        )]
    } else {
        fs::read_dir(root)
            .ok()?
            .flatten()
            .filter(|e| e.path().is_dir())
            .map(|e| (e.file_name().to_string_lossy().to_string(), e.path()))
            .collect()
    };
    let mut instances = Vec::new();
    for (folder_name, dir) in folders {
        let Ok(raw) = fs::read_to_string(dir.join("minecraftinstance.json")) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let loader_name = v
            .pointer("/baseModLoader/name")
            .and_then(Value::as_str)
            .unwrap_or("");
        let (loader, lv) = if loader_name.is_empty() {
            (Some("vanilla".to_string()), None)
        } else if let Some((k, ver)) = loader_name.split_once('-') {
            (to_loader(Some(k)), Some(ver.to_string()))
        } else {
            (to_loader(Some(loader_name)), None)
        };
        let gv = v
            .get("gameVersion")
            .or_else(|| v.pointer("/baseModLoader/minecraftVersion"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let mem = v
            .get("allocatedMemory")
            .and_then(Value::as_u64)
            .filter(|&m| m >= 512)
            .map(|m| m as u32);
        instances.push(finalize_instance(
            ExternalInstance {
                key: format!("curseforge:{}|{folder_name}", root.display()),
                launcher: "curseforge".to_string(),
                name: v
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .unwrap_or(folder_name),
                game_version: gv,
                loader,
                loader_version: lv,
                directory: dir.to_string_lossy().to_string(),
                mods: 0,
                worlds: 0,
                last_played: v.get("lastPlayed").and_then(Value::as_str).map(str::to_string),
                icon_data_url: None,
                max_memory_mb: mem,
                extra_jvm_args: v
                    .get("javaArgsOverride")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string),
                issue: None,
            },
            false,
        ));
    }
    let reported = single.unwrap_or(root).to_string_lossy().to_string();
    Some(ScannedLauncher {
        key: format!("curseforge:{reported}"),
        id: "curseforge".to_string(),
        root: reported,
        instances,
        error: None,
    })
}

fn scan_minecraft(root: &Path, kind: &str) -> Option<ScannedLauncher> {
    let profiles_path = root.join("launcher_profiles.json");
    let has_profiles = profiles_path.exists();
    let versions_dir = root.join("versions");
    let installed_vers: Vec<String> = if kind == "legacy" || !has_profiles || root.join("home").exists() {
        fs::read_dir(&versions_dir)
            .ok()
            .map(|rd| {
                rd.flatten()
                    .filter(|e| {
                        let name = e.file_name().to_string_lossy().to_string();
                        e.path().is_dir() && e.path().join(format!("{name}.json")).exists()
                    })
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .collect()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    if !has_profiles && installed_vers.is_empty() {
        return None;
    }

    let mut instances = Vec::new();
    let mut covered = HashSet::new();
    if has_profiles {
        if let Ok(raw) = fs::read_to_string(&profiles_path) {
            if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                if let Some(map) = v.get("profiles").and_then(Value::as_object) {
                    for (pid, prof) in map {
                        let ptype = prof.get("type").and_then(Value::as_str).unwrap_or("");
                        if ptype == "latest-snapshot" {
                            continue;
                        }
                        let vid = prof
                            .get("lastVersionId")
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        if vid.is_empty() || vid == "latest-release" {
                            continue;
                        }
                        covered.insert(vid.to_string());
                        let parsed = parse_version_id(vid);
                        let (gv, loader, lv) = match parsed {
                            Some((g, l, v)) => (g, Some(l), v),
                            None => (String::new(), None, None),
                        };
                        let gdir = prof
                            .get("gameDir")
                            .and_then(Value::as_str)
                            .map(PathBuf::from)
                            .filter(|p| p.exists())
                            .unwrap_or_else(|| root.to_path_buf());
                        let mem = prof
                            .get("javaArgs")
                            .and_then(Value::as_str)
                            .and_then(|a| RE_XMX.captures(a))
                            .and_then(|c| {
                                let num = c[1].parse::<u32>().ok()?;
                                let mult = if c[2].eq_ignore_ascii_case("g") { 1024 } else { 1 };
                                let total = num * mult;
                                if total >= 512 { Some(total) } else { None }
                            });
                        instances.push(finalize_instance(
                            ExternalInstance {
                                key: format!("{kind}:{}|{pid}", root.display()),
                                launcher: kind.to_string(),
                                name: prof
                                    .get("name")
                                    .and_then(Value::as_str)
                                    .map(str::trim)
                                    .filter(|s| !s.is_empty())
                                    .unwrap_or(vid)
                                    .to_string(),
                                game_version: gv,
                                loader,
                                loader_version: lv,
                                directory: gdir.to_string_lossy().to_string(),
                                mods: 0,
                                worlds: 0,
                                last_played: prof
                                    .get("lastUsed")
                                    .and_then(Value::as_str)
                                    .map(str::to_string),
                                icon_data_url: None,
                                max_memory_mb: mem,
                                extra_jvm_args: None,
                                issue: None,
                            },
                            true,
                        ));
                    }
                }
            }
        }
    }

    for vid in installed_vers {
        if covered.contains(&vid) {
            continue;
        }
        let parsed = parse_version_id(&vid);
        let (gv, loader, lv) = match parsed {
            Some((g, l, v)) => (g, Some(l), v),
            None => (String::new(), None, None),
        };
        let home_dir = root.join("home").join(&vid);
        let dir = if home_dir.exists() {
            home_dir
        } else {
            root.to_path_buf()
        };
        instances.push(finalize_instance(
            ExternalInstance {
                key: format!("{kind}:{}|version:{vid}", root.display()),
                launcher: kind.to_string(),
                name: vid,
                game_version: gv,
                loader,
                loader_version: lv,
                directory: dir.to_string_lossy().to_string(),
                mods: 0,
                worlds: 0,
                last_played: None,
                icon_data_url: None,
                max_memory_mb: None,
                extra_jvm_args: None,
                issue: None,
            },
            true,
        ));
    }

    if instances.is_empty() {
        return None;
    }
    let root_str = root.to_string_lossy().to_string();
    Some(ScannedLauncher {
        key: format!("{kind}:{root_str}"),
        id: kind.to_string(),
        root: root_str,
        instances,
        error: None,
    })
}

fn scan_legacy(install_dir: &Path) -> Option<ScannedLauncher> {
    let fallback = install_dir.join("game");
    let game_dir = fs::read_to_string(install_dir.join("tl.properties"))
        .ok()
        .and_then(|raw| {
            raw.lines().find_map(|line| {
                let t = line.trim();
                let rest = t
                    .strip_prefix("minecraft.gamedir=")
                    .or_else(|| t.strip_prefix("minecraft.gamedir:"))?;
                let cleaned = rest
                    .trim()
                    .replace("\\:", ":")
                    .replace("\\\\", "\\");
                let p = PathBuf::from(cleaned);
                if p.exists() { Some(p) } else { None }
            })
        })
        .or_else(|| if fallback.exists() { Some(fallback) } else { None })?;
    scan_minecraft(&game_dir, "legacy")
}

fn scan_root(folder: &Path) -> Option<ScannedLauncher> {
    if !folder.exists() {
        return None;
    }
    if folder.join("app.db").exists() {
        return scan_modrinth(&[folder.to_path_buf()]);
    }
    if folder.join("tl.properties").exists() {
        return scan_legacy(folder);
    }
    if folder.join("launcher_profiles.json").exists() || folder.join("versions").exists() {
        return scan_minecraft(folder, "minecraft");
    }
    if folder.join("instance.cfg").exists() {
        let inst_parent = folder.parent()?;
        let root_parent = inst_parent.parent().unwrap_or(inst_parent);
        return scan_prism(root_parent, None, Some(inst_parent), Some(folder));
    }
    if folder.join("prismlauncher.cfg").exists()
        || folder.join("polymc.cfg").exists()
        || folder.join("multimc.cfg").exists()
        || folder.join("prismlauncher.exe").exists()
    {
        return scan_prism(folder, None, None, None);
    }
    if folder.join("minecraftinstance.json").exists() {
        return scan_curseforge(folder.parent().unwrap_or(folder), Some(folder));
    }
    if folder.join("Instances").exists() {
        return scan_curseforge(&folder.join("Instances"), None);
    }
    None
}

fn scan_all_sync(extra_roots: &[String]) -> Vec<ScannedLauncher> {
    let mut found = Vec::new();
    let home = dirs::home_dir().unwrap_or_default();

    #[cfg(windows)]
    {
        let roaming = dirs::config_dir().unwrap_or_else(|| home.join("AppData").join("Roaming"));
        if let Some(l) = scan_modrinth(&[
            roaming.join("ModrinthApp"),
            roaming.join("com.modrinth.theseus"),
        ]) {
            found.push(l);
        }
        if let Some(l) = scan_prism(&roaming.join("PrismLauncher"), Some("prism"), None, None) {
            found.push(l);
        }
        if let Some(l) = scan_prism(&roaming.join("PolyMC"), Some("polymc"), None, None) {
            found.push(l);
        }
        if let Some(l) = scan_curseforge(&home.join("curseforge").join("minecraft").join("Instances"), None) {
            found.push(l);
        }
        if let Some(l) = scan_minecraft(&roaming.join(".minecraft"), "minecraft") {
            found.push(l);
        }
        if let Some(l) = scan_legacy(&roaming.join(".tlauncher").join("legacy").join("Minecraft")) {
            found.push(l);
        }
    }

    #[cfg(not(windows))]
    {
        let data_home = dirs::data_dir().unwrap_or_else(|| home.join(".local/share"));
        let config_home = dirs::config_dir().unwrap_or_else(|| home.join(".config"));
        let flatpak = home.join(".var/app");
        if let Some(l) = scan_modrinth(&[
            data_home.join("ModrinthApp"),
            config_home.join("ModrinthApp"),
            data_home.join("com.modrinth.theseus"),
            flatpak.join("com.modrinth.ModrinthApp/data/ModrinthApp"),
        ]) {
            found.push(l);
        }
        if let Some(l) = scan_prism(&data_home.join("PrismLauncher"), Some("prism"), None, None) {
            found.push(l);
        }
        if let Some(l) = scan_prism(&data_home.join("PolyMC"), Some("polymc"), None, None) {
            found.push(l);
        }
        if let Some(l) = scan_minecraft(&home.join(".minecraft"), "minecraft") {
            found.push(l);
        }
    }

    for extra in extra_roots {
        if let Some(l) = scan_root(Path::new(extra)) {
            found.push(l);
        }
    }

    let mut seen = HashSet::new();
    found
        .into_iter()
        .filter(|l| seen.insert(l.root.to_lowercase()))
        .collect()
}

fn copy_game_dir(src: &Path, dst: &Path, whitelist: bool) -> Result<(), String> {
    if !src.exists() {
        return Ok(());
    }
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        let lower = name.to_lowercase();
        if lower == "session.lock" {
            continue;
        }
        if whitelist {
            if !WHITELIST.contains(&lower.as_str()) {
                continue;
            }
        } else if matches!(lower.as_str(), "logs" | "crash-reports" | ".launcher") {
            continue;
        }
        copy_recursive_skip_lock(&entry.path(), &dst.join(&name))?;
    }
    Ok(())
}

fn copy_recursive_skip_lock(src: &Path, dst: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(src).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        return Ok(());
    }
    if meta.is_file() {
        if let Some(p) = dst.parent() {
            fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        fs::copy(src, dst).map_err(|e| e.to_string())?;
        return Ok(());
    }
    if meta.is_dir() {
        fs::create_dir_all(dst).map_err(|e| e.to_string())?;
        for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_name().to_string_lossy().eq_ignore_ascii_case("session.lock") {
                continue;
            }
            copy_recursive_skip_lock(&entry.path(), &dst.join(entry.file_name()))?;
        }
    }
    Ok(())
}

pub struct ExternalImportService {
    instances: Arc<InstanceService>,
    content: Arc<ContentService>,
    _minecraft: Arc<MinecraftService>,
}

impl ExternalImportService {
    pub fn new(
        instances: Arc<InstanceService>,
        content: Arc<ContentService>,
        minecraft: Arc<MinecraftService>,
    ) -> Self {
        Self {
            instances,
            content,
            _minecraft: minecraft,
        }
    }

    pub async fn scan(&self, extra_roots: Vec<String>) -> Result<Vec<ExternalLauncher>, String> {
        tokio::task::spawn_blocking(move || {
            scan_all_sync(&extra_roots)
                .into_iter()
                .map(ScannedLauncher::into_public)
                .collect()
        })
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn scan_folder(&self, folder: String) -> Result<Option<ExternalLauncher>, String> {
        tokio::task::spawn_blocking(move || scan_root(Path::new(&folder)).map(ScannedLauncher::into_public))
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn import_instances(
        &self,
        app: &AppHandle,
        keys: Vec<String>,
        extra_roots: Vec<String>,
    ) -> Result<ExternalImportResult, String> {
        let launchers = tokio::task::spawn_blocking(move || scan_all_sync(&extra_roots))
            .await
            .map_err(|e| e.to_string())?;
        let mut by_key: HashMap<String, ScannedInstance> = HashMap::new();
        for l in launchers {
            for i in l.instances {
                by_key.insert(i.public.key.clone(), i);
            }
        }

        let total = keys.len();
        let mut imported = Vec::new();
        let mut failed = Vec::new();

        for (index, key) in keys.into_iter().enumerate() {
            let Some(item) = by_key.get(&key).cloned() else {
                failed.push(ExternalImportFailed {
                    key: key.clone(),
                    name: key.clone(),
                    reason: tr(
                        "The instance is no longer available",
                        "Инстанция больше не найдена",
                    )
                    .to_string(),
                });
                let _ = app.emit(
                    "import:progress",
                    json!({ "key": key, "index": index, "total": total, "phase": "failed" }),
                );
                continue;
            };
            let Some(loader) = item.public.loader.clone() else {
                let reason = item
                    .public
                    .issue
                    .clone()
                    .unwrap_or_else(|| tr("Unsupported instance", "Инстанция не поддерживается").to_string());
                failed.push(ExternalImportFailed {
                    key: key.clone(),
                    name: item.public.name.clone(),
                    reason: reason.clone(),
                });
                let _ = app.emit(
                    "import:progress",
                    json!({ "key": key, "index": index, "total": total, "phase": "failed", "message": reason }),
                );
                continue;
            };

            let _ = app.emit(
                "import:progress",
                json!({ "key": key, "index": index, "total": total, "phase": "create" }),
            );
            let created = match self
                .instances
                .create(CreateInstancePayload {
                    name: item.public.name.clone(),
                    game_version: item.public.game_version.clone(),
                    loader,
                    loader_version: item.public.loader_version.clone(),
                })
                .await
            {
                Ok(c) => c,
                Err(reason) => {
                    failed.push(ExternalImportFailed {
                        key: key.clone(),
                        name: item.public.name.clone(),
                        reason: reason.clone(),
                    });
                    let _ = app.emit(
                        "import:progress",
                        json!({ "key": key, "index": index, "total": total, "phase": "failed", "message": reason }),
                    );
                    continue;
                }
            };

            let _ = app.emit(
                "import:progress",
                json!({ "key": key, "index": index, "total": total, "phase": "copy" }),
            );
            let src = PathBuf::from(&item.public.directory);
            let dst = PathBuf::from(&created.directory);
            let wl = item.whitelist;
            let copy_res = tokio::task::spawn_blocking(move || copy_game_dir(&src, &dst, wl))
                .await
                .map_err(|e| e.to_string())
                .and_then(|r| r);

            if let Err(reason) = copy_res {
                let _ = self.instances.remove(&created.id).await;
                failed.push(ExternalImportFailed {
                    key: key.clone(),
                    name: item.public.name.clone(),
                    reason: reason.clone(),
                });
                let _ = app.emit(
                    "import:progress",
                    json!({ "key": key, "index": index, "total": total, "phase": "failed", "message": reason }),
                );
                continue;
            }

            if item.public.max_memory_mb.is_some() || item.public.extra_jvm_args.is_some() {
                let _ = self
                    .instances
                    .update_instance(UpdateInstancePayload {
                        id: created.id.clone(),
                        patch: UpdateInstancePatch {
                            name: None,
                            game_version: None,
                            loader: None,
                            loader_version: None,
                            java_path: None,
                            max_memory_mb: item.public.max_memory_mb,
                            extra_jvm_args: item.public.extra_jvm_args.clone(),
                        },
                    })
                    .await;
            }

            let _ = app.emit(
                "import:progress",
                json!({ "key": key, "index": index, "total": total, "phase": "detect" }),
            );
            let _ = self.content.detect_from_modrinth(&created.id).await;
            imported.push(ExternalImportImported {
                key: key.clone(),
                instance_id: created.id,
                name: created.name,
            });
            let _ = app.emit(
                "import:progress",
                json!({ "key": key, "index": index, "total": total, "phase": "done" }),
            );
        }

        Ok(ExternalImportResult { imported, failed })
    }
}
