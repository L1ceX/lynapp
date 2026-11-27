use crate::i18n::{tr, tr_string};
use crate::paths::get_launcher_root;
use crate::services::curseforge::{CfTrackedItem, CurseForgeService};
use crate::services::hashes::{sha1_cached, write_content_manifest};
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

const USER_AGENT: &str = "lynapp/2.0.0-beta.3";

static AUX_MOD_JAR_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)(?:^|[-_.+])(sources|javadoc|dev|deobf|preshadow)\.jar$").unwrap()
});

#[derive(Debug, Clone, Deserialize)]
struct MrFile {
    url: String,
    filename: String,
    #[serde(default)]
    primary: bool,
    #[serde(default)]
    size: u64,
}

#[derive(Debug, Clone, Deserialize)]
struct MrDep {
    version_id: Option<String>,
    project_id: Option<String>,
    dependency_type: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct MrVersion {
    id: String,
    project_id: Option<String>,
    name: Option<String>,
    version_number: Option<String>,
    version_type: Option<String>,
    date_published: Option<String>,
    #[serde(default)]
    game_versions: Vec<String>,
    #[serde(default)]
    files: Vec<MrFile>,
    #[serde(default)]
    loaders: Vec<String>,
    #[serde(default)]
    dependencies: Vec<MrDep>,
}

#[derive(Debug, Clone, Deserialize)]
struct MrCategoryTag {
    name: String,
    project_type: String,
}

pub fn content_folder(project_type: &str) -> &'static str {
    match project_type {
        "resourcepack" => "resourcepacks",
        "shader" => "shaderpacks",
        "datapack" => "datapacks",
        "modpack" => "modpacks",
        _ => "mods",
    }
}

pub fn sanitize_file_part(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || (c as u32) < 0x20
            {
                '-'
            } else if c.is_whitespace() {
                '-'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().to_string();
    if trimmed.is_empty() {
        return "download".to_string();
    }
    if trimmed.chars().count() <= 100 {
        return trimmed;
    }
    let disabled_suffix = if trimmed.to_lowercase().ends_with(".disabled") {
        &trimmed[trimmed.len() - 9..]
    } else {
        ""
    };
    let stem = &trimmed[..trimmed.len() - disabled_suffix.len()];
    if let Some(dot) = stem.rfind('.') {
        if dot > 0 && stem.len() - dot <= 16 {
            let ext = format!("{}{}", &stem[dot..], disabled_suffix);
            let max_base = 100usize.saturating_sub(ext.len()).max(1);
            let base: String = trimmed.chars().take(max_base).collect();
            return format!("{base}{ext}");
        }
    }
    trimmed.chars().take(100).collect()
}

pub fn target_directories(instance: &LauncherInstance, project_type: &str) -> Vec<PathBuf> {
    let root = PathBuf::from(&instance.directory);
    if project_type != "datapack" {
        return vec![root.join(content_folder(project_type))];
    }
    let saves = root.join("saves");
    let mut dirs = Vec::new();
    if let Ok(entries) = fs::read_dir(&saves) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                dirs.push(p.join("datapacks"));
            }
        }
    }
    if dirs.is_empty() {
        vec![root.join("datapacks")]
    } else {
        dirs
    }
}

fn loaders_for(project_type: &str, instance: &LauncherInstance) -> Vec<String> {
    if project_type == "mod" || project_type == "modpack" {
        if instance.loader == "vanilla" {
            return Vec::new();
        }
        if instance.loader == "quilt" {
            return vec!["quilt".to_string(), "fabric".to_string()];
        }
        return vec![instance.loader.clone()];
    }
    if project_type == "datapack" {
        return vec!["datapack".to_string()];
    }
    if project_type == "resourcepack" {
        return vec!["minecraft".to_string()];
    }
    vec![
        "iris".to_string(),
        "optifine".to_string(),
        "canvas".to_string(),
        "vanilla".to_string(),
    ]
}

fn pick_version_file<'a>(version: &'a MrVersion, project_type: &str) -> Option<&'a MrFile> {
    let non_aux: Vec<&MrFile> = if project_type == "mod" {
        version
            .files
            .iter()
            .filter(|f| !AUX_MOD_JAR_RE.is_match(&f.filename))
            .collect()
    } else {
        version.files.iter().collect()
    };
    let pool: Vec<&MrFile> = if non_aux.is_empty() {
        version.files.iter().collect()
    } else {
        non_aux
    };
    let ext = match project_type {
        "mod" => ".jar",
        "modpack" => ".mrpack",
        _ => ".zip",
    };
    let matching: Vec<&MrFile> = pool
        .iter()
        .copied()
        .filter(|f| f.filename.to_lowercase().ends_with(ext))
        .collect();
    if !matching.is_empty() {
        return matching.iter().copied().find(|f| f.primary).or_else(|| matching.first().copied());
    }
    pool.iter().copied().find(|f| f.primary).or_else(|| pool.first().copied())
}

fn mr_incompatibility(version: &MrVersion, instance: &LauncherInstance) -> Option<ContentIncompatibility> {
    let loaders = loaders_for("mod", instance);
    let wrong_game = !version.game_versions.is_empty()
        && !version.game_versions.iter().any(|v| v == &instance.game_version);
    let wrong_loader = instance.loader == "vanilla"
        || (!loaders.is_empty()
            && !version.loaders.is_empty()
            && !version.loaders.iter().any(|l| loaders.contains(l)));
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
        supported_game_versions: version.game_versions.clone(),
        supported_loaders: version.loaders.clone(),
    })
}

fn to_version_info(
    version: &MrVersion,
    instance: &LauncherInstance,
    project_type: &str,
) -> ModVersionInfo {
    let file = pick_version_file(version, project_type);
    let loaders = loaders_for(project_type, instance);
    let loader_matched = if (project_type == "mod" || project_type == "modpack") && instance.loader == "vanilla" {
        false
    } else {
        loaders.is_empty() || version.loaders.iter().any(|l| loaders.contains(l))
    };
    ModVersionInfo {
        id: version.id.clone(),
        name: version
            .name
            .clone()
            .or_else(|| version.version_number.clone())
            .unwrap_or_else(|| version.id.clone()),
        version_number: version
            .version_number
            .clone()
            .unwrap_or_else(|| version.id.clone()),
        version_type: version
            .version_type
            .clone()
            .unwrap_or_else(|| "release".to_string()),
        date_published: version.date_published.clone().unwrap_or_default(),
        game_versions: version.game_versions.clone(),
        loaders: version.loaders.clone(),
        file_name: file.map(|f| f.filename.clone()).unwrap_or_default(),
        size: file.map(|f| f.size).unwrap_or(0),
        compatible: version.game_versions.iter().any(|v| v == &instance.game_version) && loader_matched,
        provider: Some("modrinth".to_string()),
        project_id: version.project_id.clone(),
        distribution_blocked: None,
        website_url: None,
    }
}

pub struct ModService {
    client: Client,
    store: Arc<JsonStore>,
    curseforge: Arc<CurseForgeService>,
    cat_cache: Mutex<Option<Vec<MrCategoryTag>>>,
    update_cache: Mutex<HashMap<String, (Instant, String, Vec<ContentUpdateInfo>)>>,
}

impl ModService {
    pub fn new(store: Arc<JsonStore>, curseforge: Arc<CurseForgeService>) -> Self {
        let client = Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| Client::new());
        Self {
            client,
            store,
            curseforge,
            cat_cache: Mutex::new(None),
            update_cache: Mutex::new(HashMap::new()),
        }
    }

    pub async fn get_category_tags(&self, project_type: &str) -> Result<Vec<String>, String> {
        let cached = self.cat_cache.lock().await.clone();
        let tags = match cached {
            Some(c) => c,
            None => {
                let resp = self
                    .client
                    .get("https://api.modrinth.com/v2/tag/category")
                    .send()
                    .await
                    .map_err(|e| e.to_string())?
                    .error_for_status()
                    .map_err(|e| e.to_string())?;
                let list: Vec<MrCategoryTag> = resp.json().await.map_err(|e| e.to_string())?;
                *self.cat_cache.lock().await = Some(list.clone());
                list
            }
        };
        Ok(tags
            .into_iter()
            .filter(|t| t.project_type == project_type)
            .map(|t| t.name)
            .collect())
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

        let limit = payload.limit.unwrap_or(20).clamp(5, 100);
        let offset = payload.offset.unwrap_or(0);
        let mut facets: Vec<Vec<String>> = vec![vec![format!("project_type:{}", payload.project_type)]];

        let explicit_wild_ver = payload
            .versions
            .as_ref()
            .map(|v| v.iter().any(|s| s == "*"))
            .unwrap_or(false);
        let explicit_vers: Vec<String> = payload
            .versions
            .clone()
            .unwrap_or_default()
            .into_iter()
            .filter(|v| !v.is_empty() && v != "*")
            .collect();
        let versions = if explicit_wild_ver {
            Vec::new()
        } else if !explicit_vers.is_empty() {
            explicit_vers
        } else if payload.project_type == "modpack" {
            Vec::new()
        } else if let Some(ref inst) = instance {
            vec![inst.game_version.clone()]
        } else {
            Vec::new()
        };
        if !versions.is_empty() {
            facets.push(versions.into_iter().map(|v| format!("versions:{v}")).collect());
        }

        if payload.project_type == "mod" || payload.project_type == "modpack" {
            let explicit_wild_loader = payload
                .loaders
                .as_ref()
                .map(|l| l.iter().any(|s| s == "*"))
                .unwrap_or(false);
            let explicit_loaders: Vec<String> = payload
                .loaders
                .clone()
                .unwrap_or_default()
                .into_iter()
                .filter(|l| !l.is_empty() && l != "*")
                .collect();
            let loaders = if explicit_wild_loader {
                Vec::new()
            } else if !explicit_loaders.is_empty() {
                explicit_loaders
            } else if payload.project_type == "modpack" {
                Vec::new()
            } else if let Some(ref inst) = instance {
                if inst.loader != "vanilla" {
                    vec![inst.loader.clone()]
                } else {
                    Vec::new()
                }
            } else {
                Vec::new()
            };
            if !loaders.is_empty() {
                facets.push(loaders.into_iter().map(|l| format!("categories:{l}")).collect());
            }
        }

        if let Some(cats) = &payload.categories {
            if !cats.is_empty() {
                facets.push(cats.iter().map(|c| format!("categories:{c}")).collect());
            }
        }

        let facets_json = serde_json::to_string(&facets).unwrap_or_else(|_| "[]".to_string());
        let resp = self
            .client
            .get("https://api.modrinth.com/v2/search")
            .query(&[
                ("query", payload.query.trim()),
                ("limit", &limit.to_string()),
                ("offset", &offset.to_string()),
                ("index", payload.sort.as_deref().unwrap_or("relevance")),
                ("facets", &facets_json),
            ])
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        let body: Value = resp.json().await.map_err(|e| e.to_string())?;
        let hits = body
            .get("hits")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let total = body
            .get("total_hits")
            .and_then(Value::as_u64)
            .unwrap_or(hits.len() as u64);

        let results = hits
            .into_iter()
            .filter_map(|h| {
                Some(ModSearchResult {
                    id: h.get("project_id")?.as_str()?.to_string(),
                    provider: "modrinth".to_string(),
                    title: h.get("title")?.as_str()?.to_string(),
                    slug: h.get("slug").and_then(Value::as_str).map(str::to_string),
                    author: h.get("author").and_then(Value::as_str).map(str::to_string),
                    summary: h
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    icon_url: h.get("icon_url").and_then(Value::as_str).map(str::to_string),
                    downloads: h.get("downloads").and_then(Value::as_u64),
                    follows: h.get("follows").and_then(Value::as_u64),
                    date_modified: h
                        .get("date_modified")
                        .or_else(|| h.get("date_created"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    categories: h
                        .get("categories")
                        .and_then(Value::as_array)
                        .map(|a| {
                            a.iter()
                                .filter_map(Value::as_str)
                                .map(str::to_string)
                                .collect()
                        })
                        .unwrap_or_default(),
                    project_type: payload.project_type.clone(),
                    website_url: None,
                    distribution_blocked: None,
                })
            })
            .collect();

        Ok(ModSearchResponse {
            results,
            total_hits: total,
        })
    }

    async fn get_version_by_id(&self, version_id: &str) -> Option<MrVersion> {
        let resp = self
            .client
            .get(format!("https://api.modrinth.com/v2/version/{version_id}"))
            .send()
            .await
            .ok()?;
        if !resp.status().is_success() {
            return None;
        }
        resp.json().await.ok()
    }

    async fn get_versions(
        &self,
        project_id: &str,
        instance: &LauncherInstance,
        project_type: &str,
        any_version: bool,
        any_loader: bool,
    ) -> Vec<MrVersion> {
        let mut req = self
            .client
            .get(format!("https://api.modrinth.com/v2/project/{project_id}/version"));
        let mut query: Vec<(&str, String)> = Vec::new();
        if !any_version {
            query.push((
                "game_versions",
                serde_json::to_string(&[&instance.game_version]).unwrap_or_default(),
            ));
        }
        let loaders = if project_type == "mod" || project_type == "modpack" {
            if any_loader {
                Vec::new()
            } else {
                loaders_for(project_type, instance)
            }
        } else if project_type == "datapack" {
            vec!["datapack".to_string()]
        } else if project_type == "resourcepack" {
            vec!["minecraft".to_string()]
        } else {
            Vec::new()
        };
        if !loaders.is_empty() {
            query.push(("loaders", serde_json::to_string(&loaders).unwrap_or_default()));
        }
        if !query.is_empty() {
            req = req.query(&query);
        }
        let Ok(resp) = req.send().await else {
            return Vec::new();
        };
        if !resp.status().is_success() {
            return Vec::new();
        }
        resp.json::<Vec<MrVersion>>().await.unwrap_or_default()
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
        if (payload.project_type == "shader" || payload.project_type == "modpack")
            && instance.loader == "vanilla"
        {
            return Err(tr(
                "Shaders and modpacks need Fabric, Forge, Quilt, or NeoForge. Vanilla supports resource and data packs.",
                "Для шейдеров и модпаков нужен Fabric, Forge, Quilt или NeoForge. Ванильная версия поддерживает только ресурспаки и датапаки.",
            )
            .to_string());
        }

        let version = if let Some(vid) = &payload.version_id {
            self.get_version_by_id(vid).await
        } else {
            let mut list = self
                .get_versions(&payload.project_id, &instance, &payload.project_type, false, false)
                .await;
            if list.is_empty() {
                let wild_v = payload
                    .game_versions
                    .as_ref()
                    .map(|v| v.iter().any(|s| s == "*"))
                    .unwrap_or(false);
                let wild_l = payload
                    .loaders
                    .as_ref()
                    .map(|l| l.iter().any(|s| s == "*"))
                    .unwrap_or(false);
                if wild_v || wild_l {
                    list = self
                        .get_versions(&payload.project_id, &instance, &payload.project_type, wild_v, wild_l)
                        .await;
                }
            }
            list.into_iter().find(|v| !v.files.is_empty())
        };
        let Some(version) = version else {
            return Err(tr_string(
                format!("No compatible Modrinth file for {} ({})", payload.name, instance.game_version),
                format!("На Modrinth нет подходящего файла для {} ({})", payload.name, instance.game_version),
            ));
        };
        let Some(file) = pick_version_file(&version, &payload.project_type).cloned() else {
            return Err(tr_string(
                format!("No compatible Modrinth file for {} ({})", payload.name, instance.game_version),
                format!("На Modrinth нет подходящего файла для {} ({})", payload.name, instance.game_version),
            ));
        };

        let resp = self
            .client
            .get(&file.url)
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
        let downloaded_name = sanitize_file_part(&file.filename);
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
                    existing.provider = "modrinth".to_string();
                    existing.project_id = payload.project_id.clone();
                    existing.version_id = Some(version.id.clone());
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
                        provider: "modrinth".to_string(),
                        project_id: payload.project_id.clone(),
                        version_id: Some(version.id.clone()),
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
        let mut picked_url: Option<String> = None;
        if let Some(vid) = &payload.version_id {
            if let Some(v) = self.get_version_by_id(vid).await {
                picked_url = pick_version_file(&v, "modpack").map(|f| f.url.clone());
            }
        }
        if picked_url.is_none() {
            let mut list = self
                .get_versions(&payload.project_id, &instance, "modpack", false, false)
                .await;
            if list.is_empty() {
                list = self
                    .get_versions(&payload.project_id, &instance, "modpack", true, true)
                    .await;
            }
            for v in list {
                if let Some(f) = v.files.iter().find(|f| f.filename.to_lowercase().ends_with(".mrpack")) {
                    picked_url = Some(f.url.clone());
                    break;
                }
            }
        }
        let Some(url) = picked_url else {
            return Err(tr_string(
                format!("No .mrpack file for {}", payload.name),
                format!("Нет файла .mrpack для {}", payload.name),
            ));
        };
        let dir = get_launcher_root().join("cache").join("modpacks");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let target = dir.join(format!("download-{}.mrpack", Uuid::new_v4()));
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
        fs::write(&target, bytes).map_err(|e| e.to_string())?;
        Ok(target.to_string_lossy().to_string())
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
        let resp = self
            .client
            .get(format!("https://api.modrinth.com/v2/project/{project_id}/version"))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        let raw: Vec<MrVersion> = resp.json().await.map_err(|e| e.to_string())?;
        let mut out: Vec<ModVersionInfo> = raw
            .iter()
            .filter(|v| !v.files.is_empty())
            .map(|v| to_version_info(v, &instance, project_type))
            .collect();
        out.sort_by(|a, b| b.date_published.cmp(&a.date_published));
        Ok(out)
    }

    pub async fn get_project_details(
        &self,
        project_id: &str,
        project_type: &str,
    ) -> Result<ModProjectDetails, String> {
        let resp = self
            .client
            .get(format!("https://api.modrinth.com/v2/project/{project_id}"))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        let proj: Value = resp.json().await.map_err(|e| e.to_string())?;
        let id = proj
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or(project_id)
            .to_string();
        let slug = proj
            .get("slug")
            .and_then(Value::as_str)
            .map(str::to_string);
        let slug_or_id = slug.as_deref().unwrap_or(&id);
        let type_path = match project_type {
            "resourcepack" => "resourcepack",
            "shader" => "shader",
            "datapack" => "datapack",
            "modpack" => "modpack",
            _ => "mod",
        };
        let str_arr = |key: &str| -> Vec<String> {
            proj.get(key)
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default()
        };
        let gallery = proj
            .get("gallery")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|g| {
                        let url = g
                            .get("url")
                            .or_else(|| g.get("raw_url"))
                            .and_then(Value::as_str)?
                            .to_string();
                        Some(ModGalleryItem {
                            url,
                            title: g.get("title").and_then(Value::as_str).map(str::to_string),
                            description: g
                                .get("description")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(ModProjectDetails {
            id: id.clone(),
            provider: "modrinth".to_string(),
            project_type: project_type.to_string(),
            title: proj
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or(slug_or_id)
                .to_string(),
            slug: slug.clone(),
            author: None,
            summary: proj
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            body: proj
                .get("body")
                .or_else(|| proj.get("description"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            body_format: "markdown".to_string(),
            icon_url: proj.get("icon_url").and_then(Value::as_str).map(str::to_string),
            downloads: proj.get("downloads").and_then(Value::as_u64),
            follows: proj.get("followers").and_then(Value::as_u64),
            date_published: proj.get("published").and_then(Value::as_str).map(str::to_string),
            date_modified: proj.get("updated").and_then(Value::as_str).map(str::to_string),
            license: proj
                .pointer("/license/name")
                .or_else(|| proj.pointer("/license/id"))
                .and_then(Value::as_str)
                .map(str::to_string),
            categories: str_arr("categories"),
            game_versions: str_arr("game_versions"),
            loaders: str_arr("loaders"),
            gallery,
            website_url: Some(format!("https://modrinth.com/{type_path}/{slug_or_id}")),
            source_url: proj.get("source_url").and_then(Value::as_str).map(str::to_string),
            issues_url: proj.get("issues_url").and_then(Value::as_str).map(str::to_string),
            wiki_url: proj.get("wiki_url").and_then(Value::as_str).map(str::to_string),
            discord_url: proj.get("discord_url").and_then(Value::as_str).map(str::to_string),
            distribution_blocked: None,
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
        let resp = self
            .client
            .get(format!(
                "https://api.modrinth.com/v2/project/{}/version",
                payload.project_id
            ))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        let mut raw: Vec<MrVersion> = resp
            .json::<Vec<MrVersion>>()
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|v| !v.files.is_empty())
            .collect();
        raw.sort_by(|a, b| {
            b.date_published
                .as_deref()
                .unwrap_or("")
                .cmp(a.date_published.as_deref().unwrap_or(""))
        });
        let versions: Vec<ModVersionInfo> = raw
            .iter()
            .map(|v| to_version_info(v, &instance, &payload.project_type))
            .collect();
        let has_compat = versions.iter().any(|v| v.compatible);

        let target_raw = if let Some(vid) = &payload.version_id {
            raw.iter().find(|v| &v.id == vid).cloned()
        } else {
            versions
                .iter()
                .position(|v| v.compatible)
                .and_then(|idx| raw.get(idx).cloned())
        };
        let Some(target_raw) = target_raw else {
            return Ok(ModInstallPlan {
                target_version: None,
                has_compatible_version: has_compat,
                versions,
                dependencies: Vec::new(),
            });
        };
        let target_version = to_version_info(&target_raw, &instance, &payload.project_type);
        if payload.project_type != "mod" {
            return Ok(ModInstallPlan {
                target_version: Some(target_version),
                has_compatible_version: has_compat,
                versions,
                dependencies: Vec::new(),
            });
        }

        let mut dep_map: HashMap<String, (String, Option<String>)> = HashMap::new();
        for d in &target_raw.dependencies {
            let dtype = d.dependency_type.as_deref().unwrap_or("");
            if dtype != "required" && dtype != "optional" {
                continue;
            }
            let Some(pid) = d.project_id.clone() else {
                continue;
            };
            if pid == payload.project_id {
                continue;
            }
            let entry = dep_map
                .entry(pid)
                .or_insert_with(|| (dtype.to_string(), d.version_id.clone()));
            if entry.0 == "optional" && dtype == "required" {
                entry.0 = "required".to_string();
            }
        }
        if dep_map.is_empty() {
            return Ok(ModInstallPlan {
                target_version: Some(target_version),
                has_compatible_version: has_compat,
                versions,
                dependencies: Vec::new(),
            });
        }

        let ids: Vec<String> = dep_map.keys().cloned().collect();
        let mut proj_meta: HashMap<String, Value> = HashMap::new();
        if let Ok(ids_json) = serde_json::to_string(&ids) {
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
                            proj_meta.insert(id.to_string(), p);
                        }
                    }
                }
            }
        }

        let mods_dir = PathBuf::from(&instance.directory).join("mods");
        let mut deps = Vec::new();
        for pid in ids {
            let (dtype, pinned) = &dep_map[&pid];
            let list = self.get_versions(&pid, &instance, "mod", false, false).await;
            let chosen = pinned
                .as_deref()
                .and_then(|vid| list.iter().find(|v| v.id == vid))
                .or_else(|| list.first())
                .cloned();
            let meta = proj_meta.get(&pid);
            let slug = meta
                .and_then(|m| m.get("slug"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let installed = instance.mods.iter().any(|im| {
                if im.project_type.as_deref().unwrap_or("mod") != "mod" {
                    return false;
                }
                let id_match = im.project_id == pid
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
            deps.push(ModDependencyItem {
                project_id: pid.clone(),
                provider: "modrinth".to_string(),
                version_id: chosen.as_ref().map(|v| v.id.clone()).or_else(|| pinned.clone()),
                version_number: chosen
                    .as_ref()
                    .and_then(|v| v.version_number.clone().or_else(|| v.name.clone())),
                title: meta
                    .and_then(|m| m.get("title"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| slug.clone())
                    .unwrap_or(pid),
                slug,
                author: None,
                summary: meta
                    .and_then(|m| m.get("description"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                icon_url: meta
                    .and_then(|m| m.get("icon_url"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                dependency_type: dtype.clone(),
                installed,
                compatible: chosen.is_some(),
                distribution_blocked: None,
                website_url: None,
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
            has_compatible_version: has_compat,
            versions,
            dependencies: deps,
        })
    }

    async fn post_version_files(&self, url: &str, body: Value) -> (HashMap<String, MrVersion>, bool) {
        let resp = self.client.post(url).json(&body).send().await;
        let Ok(resp) = resp else {
            return (HashMap::new(), false);
        };
        if !resp.status().is_success() {
            return (HashMap::new(), false);
        }
        match resp.json::<HashMap<String, MrVersion>>().await {
            Ok(m) => (m, true),
            Err(_) => (HashMap::new(), false),
        }
    }

    pub async fn check_updates(&self, instance_id: &str) -> Result<Vec<ContentUpdateInfo>, String> {
        let data = self.store.get_data().await;
        let instance = data
            .instances
            .iter()
            .find(|i| i.id == instance_id)
            .cloned()
            .ok_or_else(|| tr("Instance not found", "Инстанция не найдена").to_string())?;

        struct Tracked {
            provider: String,
            project_id: String,
            version_id: Option<String>,
            project_type: String,
            file_name: String,
            found_path: PathBuf,
            sha1: String,
            installed_at: String,
        }

        let mut tracked = Vec::new();
        for m in &instance.mods {
            let pt = m.project_type.as_deref().unwrap_or("mod");
            let Some(fnm) = m.file_name.as_deref() else {
                continue;
            };
            if pt == "modpack" {
                continue;
            }
            let mut dirs = vec![PathBuf::from(&instance.directory).join(content_folder(pt))];
            if pt == "datapack" {
                dirs.extend(target_directories(&instance, "datapack"));
            }
            let base = fnm.strip_suffix(".disabled").unwrap_or(fnm);
            let candidates = [base.to_string(), fnm.to_string(), format!("{base}.disabled")];
            let found = candidates.iter().find_map(|cand| {
                dirs.iter()
                    .map(|d| d.join(cand))
                    .find(|p| p.exists())
            });
            let Some(found_path) = found else {
                continue;
            };
            let Ok(sha1) = sha1_cached(&found_path) else {
                continue;
            };
            tracked.push(Tracked {
                provider: m.provider.clone(),
                project_id: m.project_id.clone(),
                version_id: m.version_id.clone(),
                project_type: pt.to_string(),
                file_name: fnm.to_string(),
                found_path,
                sha1,
                installed_at: m.installed_at.clone(),
            });
        }
        if tracked.is_empty() {
            return Ok(Vec::new());
        }

        let mut sig_parts: Vec<String> = tracked
            .iter()
            .map(|t| format!("{}:{}:{}:{}", t.provider, t.project_type, t.file_name, t.sha1))
            .collect();
        sig_parts.sort();
        let signature = format!(
            "{}|{}|{}",
            instance.game_version,
            instance.loader,
            sig_parts.join(",")
        );
        if let Some((at, sig, res)) = self.update_cache.lock().await.get(instance_id) {
            if sig == &signature && at.elapsed() < Duration::from_secs(300) {
                return Ok(res.clone());
            }
        }

        let mr_hashes: Vec<String> = tracked
            .iter()
            .filter(|t| t.provider == "modrinth")
            .map(|t| t.sha1.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let mut any_err = false;
        let current = if !mr_hashes.is_empty() {
            let (m, ok) = self
                .post_version_files(
                    "https://api.modrinth.com/v2/version_files",
                    json!({ "hashes": mr_hashes, "algorithm": "sha1" }),
                )
                .await;
            if !ok {
                any_err = true;
            }
            m
        } else {
            HashMap::new()
        };

        let mut latest_by_hash: HashMap<String, MrVersion> = HashMap::new();
        let types: HashSet<String> = tracked
            .iter()
            .filter(|t| t.provider == "modrinth")
            .map(|t| t.project_type.clone())
            .collect();
        for pt in types {
            if pt == "mod" && instance.loader == "vanilla" {
                continue;
            }
            let group: Vec<String> = tracked
                .iter()
                .filter(|t| t.provider == "modrinth" && t.project_type == pt)
                .map(|t| t.sha1.clone())
                .collect::<HashSet<_>>()
                .into_iter()
                .collect();
            let loaders = loaders_for(&pt, &instance);
            let (m, ok) = self
                .post_version_files(
                    "https://api.modrinth.com/v2/version_files/update",
                    json!({
                        "hashes": group,
                        "algorithm": "sha1",
                        "loaders": loaders,
                        "game_versions": [instance.game_version]
                    }),
                )
                .await;
            if !ok {
                any_err = true;
            }
            latest_by_hash.extend(m);
        }

        let mut by_key: HashMap<String, ContentUpdateInfo> = HashMap::new();
        let mut cf_items = Vec::new();
        for item in &tracked {
            let key = format!("{}:{}", item.project_type, item.file_name);
            if item.provider == "modrinth" {
                let now = current.get(&item.sha1);
                let can_update = !(item.project_type == "mod" && instance.loader == "vanilla");
                let latest = if can_update {
                    latest_by_hash.get(&item.sha1)
                } else {
                    None
                };
                let now_compat = now
                    .map(|n| to_version_info(n, &instance, &item.project_type).compatible)
                    .unwrap_or(true);
                let same_quilt = match (now, latest) {
                    (Some(n), Some(l))
                        if now_compat
                            && instance.loader == "quilt"
                            && item.project_type == "mod"
                            && n.loaders.iter().any(|x| x == "quilt")
                            && !l.loaders.iter().any(|x| x == "quilt") =>
                    {
                        let nv = n
                            .version_number
                            .as_deref()
                            .unwrap_or("")
                            .trim()
                            .trim_start_matches(['v', 'V'])
                            .to_lowercase();
                        let lv = l
                            .version_number
                            .as_deref()
                            .unwrap_or("")
                            .trim()
                            .trim_start_matches(['v', 'V'])
                            .to_lowercase();
                        !nv.is_empty() && nv == lv
                    }
                    _ => false,
                };
                let newer = can_update
                    && !same_quilt
                    && match (now, latest) {
                        (Some(n), Some(l)) => {
                            l.id != n.id
                                && (!now_compat
                                    || l.date_published.as_deref().unwrap_or("")
                                        > n.date_published.as_deref().unwrap_or(""))
                        }
                        _ => false,
                    };
                let info = ContentUpdateInfo {
                    project_id: item.project_id.clone(),
                    project_type: item.project_type.clone(),
                    file_name: item.file_name.clone(),
                    current_version_id: now.map(|n| n.id.clone()),
                    current_version_number: now.and_then(|n| n.version_number.clone()),
                    latest: if newer {
                        latest.map(|l| to_version_info(l, &instance, &item.project_type))
                    } else {
                        None
                    },
                    incompatible: now.and_then(|n| {
                        if item.project_type == "mod" {
                            mr_incompatibility(n, &instance)
                        } else {
                            None
                        }
                    }),
                };
                let has_latest = info.latest.is_some();
                by_key.insert(key, info);
                if !has_latest && can_update {
                    cf_items.push(CfTrackedItem {
                        provider: "modrinth".to_string(),
                        project_id: None,
                        version_id: None,
                        project_type: item.project_type.clone(),
                        file_name: item.file_name.clone(),
                        found_path: item.found_path.clone(),
                        sha1: Some(item.sha1.clone()),
                        current_version_number: now.and_then(|n| n.version_number.clone()),
                        installed_date: now
                            .and_then(|n| n.date_published.clone())
                            .or_else(|| Some(item.installed_at.clone())),
                    });
                }
            } else {
                cf_items.push(CfTrackedItem {
                    provider: "curseforge".to_string(),
                    project_id: Some(item.project_id.clone()),
                    version_id: item.version_id.clone(),
                    project_type: item.project_type.clone(),
                    file_name: item.file_name.clone(),
                    found_path: item.found_path.clone(),
                    sha1: Some(item.sha1.clone()),
                    current_version_number: None,
                    installed_date: Some(item.installed_at.clone()),
                });
            }
        }

        if !cf_items.is_empty() {
            let cf_updates = self
                .curseforge
                .check_updates_for_items(&instance, &cf_items)
                .await;
            for (k, cf_info) in cf_updates {
                match by_key.get_mut(&k) {
                    Some(existing) if existing.latest.is_none() && cf_info.latest.is_some() => {
                        existing.latest = cf_info.latest;
                    }
                    None => {
                        by_key.insert(k, cf_info);
                    }
                    _ => {}
                }
            }
        }

        let result: Vec<ContentUpdateInfo> = by_key.into_values().collect();
        if !result.is_empty() && !any_err {
            self.update_cache
                .lock()
                .await
                .insert(instance_id.to_string(), (Instant::now(), signature, result.clone()));
        }
        Ok(result)
    }
}
