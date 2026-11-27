use crate::i18n::{tr, tr_string};
use crate::paths::get_launcher_root;
use futures_util::StreamExt;
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Mutex;

const GITHUB_RELEASES_URL: &str = "https://api.github.com/repos/L1ceX/lynapp/releases?per_page=30";
const CACHE_TTL_SECS: u64 = 300;

#[derive(Debug, Clone, Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Clone, Deserialize)]
struct GhRelease {
    tag_name: String,
    prerelease: bool,
    draft: bool,
    html_url: String,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[derive(Debug, Clone)]
struct PendingRelease {
    version: String,
    prerelease: bool,
    html_url: String,
    asset_url: Option<String>,
    asset_name: Option<String>,
}

struct UpdaterInner {
    pending_tauri: Option<PendingRelease>,
    pending_electron: Option<PendingRelease>,
    cached_releases: Vec<GhRelease>,
    fetched_at: Option<Instant>,
    last_status: Option<Value>,
    downloaded_path: Option<PathBuf>,
    downloading: bool,
    checking: bool,
    allow_beta: bool,
    preferred_edition: String,
}

pub struct UpdaterService {
    client: Client,
    current_version: String,
    inner: Mutex<UpdaterInner>,
}

fn normalize_edition(raw: Option<&str>) -> String {
    match raw {
        Some("electron") => "electron".to_string(),
        _ => "tauri".to_string(),
    }
}

fn parse_semver(raw: &str) -> Option<(u64, u64, u64, Option<String>)> {
    let trimmed = raw.trim().trim_start_matches('v').trim_start_matches('V');
    let (core, pre) = match trimmed.split_once('-') {
        Some((c, p)) => (c, Some(p.to_string())),
        None => (trimmed, None),
    };
    let mut parts = core.split('.');
    let maj = parts.next()?.parse::<u64>().ok()?;
    let min = parts.next().unwrap_or("0").parse::<u64>().ok()?;
    let pat = parts.next().unwrap_or("0").parse::<u64>().ok()?;
    Some((maj, min, pat, pre))
}

fn compare_pre(a: &str, b: &str) -> std::cmp::Ordering {
    let ap: Vec<&str> = a.split('.').collect();
    let bp: Vec<&str> = b.split('.').collect();
    for i in 0..ap.len().max(bp.len()) {
        match (ap.get(i), bp.get(i)) {
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some(x), Some(y)) => {
                let ord = match (x.parse::<u64>(), y.parse::<u64>()) {
                    (Ok(nx), Ok(ny)) => nx.cmp(&ny),
                    _ => x.cmp(y),
                };
                if ord != std::cmp::Ordering::Equal {
                    return ord;
                }
            }
            (None, None) => break,
        }
    }
    std::cmp::Ordering::Equal
}

fn compare_semver(a: &str, b: &str) -> std::cmp::Ordering {
    let (Some(sa), Some(sb)) = (parse_semver(a), parse_semver(b)) else {
        return std::cmp::Ordering::Equal;
    };
    let core_ord = (sa.0, sa.1, sa.2).cmp(&(sb.0, sb.1, sb.2));
    if core_ord != std::cmp::Ordering::Equal {
        return core_ord;
    }
    match (&sa.3, &sb.3) {
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, None) => std::cmp::Ordering::Equal,
        (Some(pa), Some(pb)) => compare_pre(pa, pb),
    }
}

fn is_newer_version(candidate: &str, current: &str) -> bool {
    compare_semver(candidate, current) == std::cmp::Ordering::Greater
}

fn pick_setup_asset(assets: &[GhAsset]) -> Option<&GhAsset> {
    #[cfg(windows)]
    {
        assets
            .iter()
            .find(|a| {
                let n = a.name.to_ascii_lowercase();
                n.ends_with(".exe") && n.contains("setup")
            })
            .or_else(|| {
                assets.iter().find(|a| {
                    let n = a.name.to_ascii_lowercase();
                    n.ends_with(".exe") && !n.contains("portable")
                })
            })
    }
    #[cfg(not(windows))]
    {
        assets
            .iter()
            .find(|a| a.name.to_ascii_lowercase().ends_with(".appimage"))
    }
}

fn release_summary(opt: &Option<PendingRelease>) -> Value {
    match opt {
        Some(r) => json!({ "version": r.version, "prerelease": r.prerelease }),
        None => Value::Null,
    }
}

fn to_pending(rel: &GhRelease) -> PendingRelease {
    let ver = rel.tag_name.trim_start_matches('v').trim_start_matches('V').to_string();
    let asset = pick_setup_asset(&rel.assets);
    PendingRelease {
        version: ver,
        prerelease: rel.prerelease,
        html_url: rel.html_url.clone(),
        asset_url: asset.map(|a| a.browser_download_url.clone()),
        asset_name: asset.map(|a| a.name.clone()),
    }
}

fn select_best_releases(
    releases: &[GhRelease],
    allow_beta: bool,
) -> (Option<PendingRelease>, Option<PendingRelease>) {
    let mut best_tauri: Option<PendingRelease> = None;
    let mut best_electron: Option<PendingRelease> = None;
    for rel in releases {
        if rel.draft {
            continue;
        }
        let ver = rel.tag_name.trim_start_matches('v').trim_start_matches('V');
        let Some(parsed) = parse_semver(ver) else {
            continue;
        };
        let is_pre = rel.prerelease || parsed.3.is_some();
        if !allow_beta && is_pre {
            continue;
        }
        let candidate = to_pending(rel);
        if parsed.0 >= 2 {
            let replace = best_tauri
                .as_ref()
                .map(|cur| compare_semver(&candidate.version, &cur.version) == std::cmp::Ordering::Greater)
                .unwrap_or(true);
            if replace {
                best_tauri = Some(candidate);
            }
        } else if parsed.0 == 1 {
            let replace = best_electron
                .as_ref()
                .map(|cur| compare_semver(&candidate.version, &cur.version) == std::cmp::Ordering::Greater)
                .unwrap_or(true);
            if replace {
                best_electron = Some(candidate);
            }
        }
    }
    (best_tauri, best_electron)
}

fn build_status_payload(
    edition: &str,
    current_version: &str,
    best_tauri: &Option<PendingRelease>,
    best_electron: &Option<PendingRelease>,
) -> Value {
    let lt = release_summary(best_tauri);
    let le = release_summary(best_electron);
    if edition == "electron" {
        if let Some(ref target) = best_electron {
            json!({
                "kind": "available",
                "edition": "electron",
                "version": target.version,
                "latestTauri": lt,
                "latestElectron": le
            })
        } else {
            json!({
                "kind": "up-to-date",
                "edition": "electron",
                "latestTauri": lt,
                "latestElectron": le
            })
        }
    } else if let Some(ref target) = best_tauri {
        if is_newer_version(&target.version, current_version) {
            json!({
                "kind": "available",
                "edition": "tauri",
                "version": target.version,
                "latestTauri": lt,
                "latestElectron": le
            })
        } else {
            json!({
                "kind": "up-to-date",
                "edition": "tauri",
                "latestTauri": lt,
                "latestElectron": le
            })
        }
    } else {
        json!({
            "kind": "up-to-date",
            "edition": "tauri",
            "latestTauri": lt,
            "latestElectron": le
        })
    }
}

impl UpdaterService {
    pub fn new(current_version: String) -> Arc<Self> {
        let client = Client::builder()
            .user_agent(format!("lynapp/{current_version}"))
            .timeout(Duration::from_secs(25))
            .build()
            .unwrap_or_else(|_| Client::new());
        Arc::new(Self {
            client,
            current_version,
            inner: Mutex::new(UpdaterInner {
                pending_tauri: None,
                pending_electron: None,
                cached_releases: Vec::new(),
                fetched_at: None,
                last_status: None,
                downloaded_path: None,
                downloading: false,
                checking: false,
                allow_beta: false,
                preferred_edition: "tauri".to_string(),
            }),
        })
    }

    pub async fn check(&self, app: &AppHandle, allow_beta: bool, preferred_edition: Option<&str>) {
        let _ = self
            .check_with_options(app, allow_beta, preferred_edition, false)
            .await;
    }

    pub async fn check_with_options(
        &self,
        app: &AppHandle,
        allow_beta: bool,
        preferred_edition: Option<&str>,
        force: bool,
    ) -> Value {
        let edition = normalize_edition(preferred_edition);
        let checking_payload = {
            let mut guard = self.inner.lock().await;
            guard.allow_beta = allow_beta;
            guard.preferred_edition = edition.clone();
            if guard.downloading {
                let status = guard.last_status.clone().unwrap_or_else(|| {
                    json!({
                        "kind": "downloading",
                        "edition": guard.preferred_edition,
                        "latestTauri": release_summary(&guard.pending_tauri),
                        "latestElectron": release_summary(&guard.pending_electron)
                    })
                });
                drop(guard);
                let _ = app.emit("updater:status", status.clone());
                return status;
            }
            let cache_fresh = !force
                && !guard.cached_releases.is_empty()
                && guard
                    .fetched_at
                    .map(|t| t.elapsed() < Duration::from_secs(CACHE_TTL_SECS))
                    .unwrap_or(false);
            if cache_fresh && !guard.checking {
                let (best_tauri, best_electron) =
                    select_best_releases(&guard.cached_releases, allow_beta);
                let payload = build_status_payload(
                    &edition,
                    &self.current_version,
                    &best_tauri,
                    &best_electron,
                );
                guard.pending_tauri = best_tauri;
                guard.pending_electron = best_electron;
                guard.last_status = Some(payload.clone());
                drop(guard);
                let _ = app.emit("updater:status", payload.clone());
                return payload;
            }
            if guard.checking {
                return guard.last_status.clone().unwrap_or_else(|| {
                    json!({
                        "kind": "checking",
                        "edition": guard.preferred_edition,
                        "latestTauri": release_summary(&guard.pending_tauri),
                        "latestElectron": release_summary(&guard.pending_electron)
                    })
                });
            }
            guard.checking = true;
            let p = json!({
                "kind": "checking",
                "edition": edition,
                "latestTauri": release_summary(&guard.pending_tauri),
                "latestElectron": release_summary(&guard.pending_electron)
            });
            guard.last_status = Some(p.clone());
            p
        };

        let _ = app.emit("updater:status", checking_payload);

        let res = self
            .client
            .get(GITHUB_RELEASES_URL)
            .header("Accept", "application/vnd.github+json")
            .send()
            .await;

        let releases = match res {
            Ok(resp) if resp.status().is_success() => match resp.json::<Vec<GhRelease>>().await {
                Ok(list) => list,
                Err(e) => {
                    let mut guard = self.inner.lock().await;
                    guard.checking = false;
                    let payload = json!({
                        "kind": "error",
                        "edition": guard.preferred_edition,
                        "message": e.to_string(),
                        "latestTauri": release_summary(&guard.pending_tauri),
                        "latestElectron": release_summary(&guard.pending_electron)
                    });
                    guard.last_status = Some(payload.clone());
                    drop(guard);
                    let _ = app.emit("updater:status", payload.clone());
                    return payload;
                }
            },
            Ok(resp) => {
                let code = resp.status().as_u16();
                let mut guard = self.inner.lock().await;
                guard.checking = false;
                let payload = json!({
                    "kind": "error",
                    "edition": guard.preferred_edition,
                    "message": tr_string(
                        format!("Update server returned HTTP {code}"),
                        format!("Сервер обновлений вернул HTTP {code}")
                    ),
                    "latestTauri": release_summary(&guard.pending_tauri),
                    "latestElectron": release_summary(&guard.pending_electron)
                });
                guard.last_status = Some(payload.clone());
                drop(guard);
                let _ = app.emit("updater:status", payload.clone());
                return payload;
            }
            Err(e) => {
                let mut guard = self.inner.lock().await;
                guard.checking = false;
                let payload = json!({
                    "kind": "error",
                    "edition": guard.preferred_edition,
                    "message": e.to_string(),
                    "latestTauri": release_summary(&guard.pending_tauri),
                    "latestElectron": release_summary(&guard.pending_electron)
                });
                guard.last_status = Some(payload.clone());
                drop(guard);
                let _ = app.emit("updater:status", payload.clone());
                return payload;
            }
        };

        let payload = {
            let mut guard = self.inner.lock().await;
            guard.checking = false;
            guard.cached_releases = releases;
            guard.fetched_at = Some(Instant::now());
            let (best_tauri, best_electron) =
                select_best_releases(&guard.cached_releases, guard.allow_beta);
            let p = build_status_payload(
                &guard.preferred_edition,
                &self.current_version,
                &best_tauri,
                &best_electron,
            );
            guard.pending_tauri = best_tauri;
            guard.pending_electron = best_electron;
            guard.downloaded_path = None;
            guard.last_status = Some(p.clone());
            p
        };
        let _ = app.emit("updater:status", payload.clone());
        payload
    }

    pub async fn download(&self, app: &AppHandle, edition: Option<String>) -> Result<(), String> {
        let (target_edition, pending, lt, le) = {
            let mut guard = self.inner.lock().await;
            if guard.downloading {
                return Ok(());
            }
            let target_ed = match edition.as_deref() {
                Some("tauri") => "tauri".to_string(),
                Some("electron") => "electron".to_string(),
                _ => guard.preferred_edition.clone(),
            };
            let chosen = if target_ed == "electron" {
                guard.pending_electron.clone()
            } else {
                guard.pending_tauri.clone()
            };
            let Some(p) = chosen else {
                return Err(tr("No update available", "Нет доступного обновления").to_string());
            };
            guard.downloading = true;
            (
                target_ed,
                p,
                release_summary(&guard.pending_tauri),
                release_summary(&guard.pending_electron),
            )
        };

        let Some(url) = pending.asset_url.clone() else {
            let payload = json!({
                "kind": "available",
                "edition": target_edition,
                "version": pending.version,
                "latestTauri": lt,
                "latestElectron": le
            });
            {
                let mut guard = self.inner.lock().await;
                guard.downloading = false;
                guard.last_status = Some(payload.clone());
            }
            let _ = app.opener().open_url(&pending.html_url, None::<&str>);
            let _ = app.emit("updater:status", payload);
            return Ok(());
        };

        let start_payload = json!({
            "kind": "downloading",
            "edition": target_edition,
            "version": pending.version,
            "percent": 0,
            "latestTauri": lt,
            "latestElectron": le
        });
        self.inner.lock().await.last_status = Some(start_payload.clone());
        let _ = app.emit("updater:status", start_payload);

        let dl_client = Client::builder()
            .user_agent(format!("lynapp/{}", self.current_version))
            .timeout(Duration::from_secs(600))
            .build()
            .unwrap_or_else(|_| self.client.clone());

        let resp = match dl_client.get(&url).send().await {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                let msg = format!("HTTP {}", r.status().as_u16());
                let payload = json!({
                    "kind": "error",
                    "edition": target_edition,
                    "message": msg,
                    "latestTauri": lt,
                    "latestElectron": le
                });
                {
                    let mut guard = self.inner.lock().await;
                    guard.downloading = false;
                    guard.last_status = Some(payload.clone());
                }
                let _ = app.emit("updater:status", payload);
                return Err(msg);
            }
            Err(e) => {
                let msg = e.to_string();
                let payload = json!({
                    "kind": "error",
                    "edition": target_edition,
                    "message": msg,
                    "latestTauri": lt,
                    "latestElectron": le
                });
                {
                    let mut guard = self.inner.lock().await;
                    guard.downloading = false;
                    guard.last_status = Some(payload.clone());
                }
                let _ = app.emit("updater:status", payload);
                return Err(msg);
            }
        };

        let total = resp.content_length();
        let dir = get_launcher_root().join("cache").join("updates");
        let _ = fs::create_dir_all(&dir);
        let file_name = pending
            .asset_name
            .clone()
            .unwrap_or_else(|| format!("lynapp-setup-{}.exe", pending.version));
        let dest = dir.join(&file_name);
        let tmp = dir.join(format!("{file_name}.part"));

        let mut file = match File::create(&tmp) {
            Ok(f) => f,
            Err(e) => {
                let msg = e.to_string();
                let payload = json!({
                    "kind": "error",
                    "edition": target_edition,
                    "message": msg,
                    "latestTauri": lt,
                    "latestElectron": le
                });
                {
                    let mut guard = self.inner.lock().await;
                    guard.downloading = false;
                    guard.last_status = Some(payload.clone());
                }
                let _ = app.emit("updater:status", payload);
                return Err(msg);
            }
        };

        let mut received: u64 = 0;
        let mut last_emit = Instant::now() - Duration::from_secs(1);
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(bytes) => {
                    if let Err(e) = file.write_all(&bytes) {
                        drop(file);
                        let _ = fs::remove_file(&tmp);
                        let msg = e.to_string();
                        let payload = json!({
                            "kind": "error",
                            "edition": target_edition,
                            "message": msg,
                            "latestTauri": lt,
                            "latestElectron": le
                        });
                        {
                            let mut guard = self.inner.lock().await;
                            guard.downloading = false;
                            guard.last_status = Some(payload.clone());
                        }
                        let _ = app.emit("updater:status", payload);
                        return Err(msg);
                    }
                    received += bytes.len() as u64;
                    if last_emit.elapsed().as_millis() >= 150 {
                        last_emit = Instant::now();
                        let pct = total
                            .filter(|&t| t > 0)
                            .map(|t| ((received.saturating_mul(100)) / t).min(100))
                            .unwrap_or(0);
                        let payload = json!({
                            "kind": "downloading",
                            "edition": target_edition,
                            "version": pending.version,
                            "percent": pct,
                            "latestTauri": lt,
                            "latestElectron": le
                        });
                        let _ = app.emit("updater:status", payload);
                    }
                }
                Err(e) => {
                    drop(file);
                    let _ = fs::remove_file(&tmp);
                    let msg = e.to_string();
                    let payload = json!({
                        "kind": "error",
                        "edition": target_edition,
                        "message": msg,
                        "latestTauri": lt,
                        "latestElectron": le
                    });
                    {
                        let mut guard = self.inner.lock().await;
                        guard.downloading = false;
                        guard.last_status = Some(payload.clone());
                    }
                    let _ = app.emit("updater:status", payload);
                    return Err(msg);
                }
            }
        }
        drop(file);
        let _ = fs::remove_file(&dest);
        if let Err(e) = fs::rename(&tmp, &dest) {
            let _ = fs::remove_file(&tmp);
            let msg = e.to_string();
            let payload = json!({
                "kind": "error",
                "edition": target_edition,
                "message": msg,
                "latestTauri": lt,
                "latestElectron": le
            });
            {
                let mut guard = self.inner.lock().await;
                guard.downloading = false;
                guard.last_status = Some(payload.clone());
            }
            let _ = app.emit("updater:status", payload);
            return Err(msg);
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = fs::metadata(&dest) {
                let mut perms = meta.permissions();
                perms.set_mode(0o755);
                let _ = fs::set_permissions(&dest, perms);
            }
        }

        let ready_payload = json!({
            "kind": "ready",
            "edition": target_edition,
            "version": pending.version,
            "latestTauri": lt,
            "latestElectron": le
        });
        {
            let mut guard = self.inner.lock().await;
            guard.downloading = false;
            guard.downloaded_path = Some(dest);
            guard.last_status = Some(ready_payload.clone());
        }
        let _ = app.emit("updater:status", ready_payload);
        Ok(())
    }

    pub async fn install(&self, app: &AppHandle) -> Result<(), String> {
        let (path, fallback_url) = {
            let guard = self.inner.lock().await;
            let url = if guard.preferred_edition == "electron" {
                guard.pending_electron.as_ref().map(|p| p.html_url.clone())
            } else {
                guard.pending_tauri.as_ref().map(|p| p.html_url.clone())
            };
            (guard.downloaded_path.clone(), url)
        };
        let Some(installer) = path.filter(|p| p.exists()) else {
            if let Some(url) = fallback_url {
                let _ = app.opener().open_url(&url, None::<&str>);
                return Ok(());
            }
            return Err(tr("Update installer not found", "Файл обновления не найден").to_string());
        };
        Command::new(&installer)
            .spawn()
            .map_err(|e| e.to_string())?;
        app.exit(0);
        Ok(())
    }
}
