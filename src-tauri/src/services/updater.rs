use crate::i18n::{tr, tr_string};
use crate::paths::get_launcher_root;
use futures_util::StreamExt;
use reqwest::Client;
use serde::Deserialize;
use serde_json::json;
use std::fs::{self, File};
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Mutex;

const GITHUB_RELEASES_URL: &str = "https://api.github.com/repos/L1ceX/lynapp/releases?per_page=15";

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
    html_url: String,
    asset_url: Option<String>,
    asset_name: Option<String>,
}

struct UpdaterInner {
    pending: Option<PendingRelease>,
    downloaded_path: Option<PathBuf>,
    downloading: bool,
    checking: bool,
    allow_beta: bool,
}

pub struct UpdaterService {
    client: Client,
    current_version: String,
    inner: Mutex<UpdaterInner>,
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

fn is_newer_version(candidate: &str, current: &str) -> bool {
    let (Some(cand), Some(curr)) = (parse_semver(candidate), parse_semver(current)) else {
        return false;
    };
    let core_ord = (cand.0, cand.1, cand.2).cmp(&(curr.0, curr.1, curr.2));
    if core_ord != std::cmp::Ordering::Equal {
        return core_ord == std::cmp::Ordering::Greater;
    }
    match (&cand.3, &curr.3) {
        (None, Some(_)) => true,
        (Some(_), None) => false,
        (None, None) => false,
        (Some(a), Some(b)) => compare_pre(a, b) == std::cmp::Ordering::Greater,
    }
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
                pending: None,
                downloaded_path: None,
                downloading: false,
                checking: false,
                allow_beta: false,
            }),
        })
    }

    pub async fn check(&self, app: &AppHandle, allow_beta: bool) {
        {
            let mut guard = self.inner.lock().await;
            guard.allow_beta = allow_beta;
            if guard.checking || guard.downloading {
                return;
            }
            guard.checking = true;
        }

        let _ = app.emit("updater:status", json!({ "kind": "checking" }));

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
                    self.inner.lock().await.checking = false;
                    let _ = app.emit(
                        "updater:status",
                        json!({ "kind": "error", "message": e.to_string() }),
                    );
                    return;
                }
            },
            Ok(resp) => {
                self.inner.lock().await.checking = false;
                let code = resp.status().as_u16();
                let _ = app.emit(
                    "updater:status",
                    json!({
                        "kind": "error",
                        "message": tr_string(
                            format!("Update server returned HTTP {code}"),
                            format!("Сервер обновлений вернул HTTP {code}")
                        )
                    }),
                );
                return;
            }
            Err(e) => {
                self.inner.lock().await.checking = false;
                let _ = app.emit(
                    "updater:status",
                    json!({ "kind": "error", "message": e.to_string() }),
                );
                return;
            }
        };

        let best = releases
            .into_iter()
            .filter(|r| !r.draft && (allow_beta || !r.prerelease))
            .find(|r| is_newer_version(&r.tag_name, &self.current_version));

        let mut guard = self.inner.lock().await;
        guard.checking = false;
        if let Some(rel) = best {
            let clean_ver = rel
                .tag_name
                .trim()
                .trim_start_matches('v')
                .trim_start_matches('V')
                .to_string();
            let asset = pick_setup_asset(&rel.assets);
            guard.pending = Some(PendingRelease {
                version: clean_ver.clone(),
                html_url: rel.html_url.clone(),
                asset_url: asset.map(|a| a.browser_download_url.clone()),
                asset_name: asset.map(|a| a.name.clone()),
            });
            guard.downloaded_path = None;
            let _ = app.emit(
                "updater:status",
                json!({ "kind": "available", "version": clean_ver }),
            );
        } else {
            guard.pending = None;
            let _ = app.emit("updater:status", json!({ "kind": "up-to-date" }));
        }
    }

    pub async fn download(&self, app: &AppHandle) -> Result<(), String> {
        let pending = {
            let mut guard = self.inner.lock().await;
            if guard.downloading {
                return Ok(());
            }
            let Some(p) = guard.pending.clone() else {
                return Err(tr("No update available", "Нет доступного обновления").to_string());
            };
            guard.downloading = true;
            p
        };

        let Some(url) = pending.asset_url.clone() else {
            self.inner.lock().await.downloading = false;
            let _ = app.opener().open_url(&pending.html_url, None::<&str>);
            return Ok(());
        };

        let _ = app.emit(
            "updater:status",
            json!({ "kind": "downloading", "version": pending.version, "percent": 0 }),
        );

        let resp = match self.client.get(&url).send().await {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                self.inner.lock().await.downloading = false;
                let msg = format!("HTTP {}", r.status().as_u16());
                let _ = app.emit(
                    "updater:status",
                    json!({ "kind": "error", "message": msg }),
                );
                return Err(msg);
            }
            Err(e) => {
                self.inner.lock().await.downloading = false;
                let msg = e.to_string();
                let _ = app.emit(
                    "updater:status",
                    json!({ "kind": "error", "message": msg }),
                );
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
                self.inner.lock().await.downloading = false;
                let msg = e.to_string();
                let _ = app.emit(
                    "updater:status",
                    json!({ "kind": "error", "message": msg }),
                );
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
                        self.inner.lock().await.downloading = false;
                        let msg = e.to_string();
                        let _ = app.emit(
                            "updater:status",
                            json!({ "kind": "error", "message": msg }),
                        );
                        return Err(msg);
                    }
                    received += bytes.len() as u64;
                    if last_emit.elapsed().as_millis() >= 150 {
                        last_emit = Instant::now();
                        let pct = total
                            .filter(|&t| t > 0)
                            .map(|t| ((received.saturating_mul(100)) / t).min(100))
                            .unwrap_or(0);
                        let _ = app.emit(
                            "updater:status",
                            json!({ "kind": "downloading", "version": pending.version, "percent": pct }),
                        );
                    }
                }
                Err(e) => {
                    drop(file);
                    let _ = fs::remove_file(&tmp);
                    self.inner.lock().await.downloading = false;
                    let msg = e.to_string();
                    let _ = app.emit(
                        "updater:status",
                        json!({ "kind": "error", "message": msg }),
                    );
                    return Err(msg);
                }
            }
        }
        drop(file);
        let _ = fs::remove_file(&dest);
        if let Err(e) = fs::rename(&tmp, &dest) {
            let _ = fs::remove_file(&tmp);
            self.inner.lock().await.downloading = false;
            let msg = e.to_string();
            let _ = app.emit(
                "updater:status",
                json!({ "kind": "error", "message": msg }),
            );
            return Err(msg);
        }

        let mut guard = self.inner.lock().await;
        guard.downloading = false;
        guard.downloaded_path = Some(dest);
        let _ = app.emit(
            "updater:status",
            json!({ "kind": "ready", "version": pending.version }),
        );
        Ok(())
    }

    pub async fn install(&self, app: &AppHandle) -> Result<(), String> {
        let path = self.inner.lock().await.downloaded_path.clone();
        let Some(installer) = path.filter(|p| p.exists()) else {
            if let Some(url) = self.inner.lock().await.pending.as_ref().map(|p| p.html_url.clone()) {
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
