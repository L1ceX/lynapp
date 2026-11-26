use crate::i18n::tr;
use crate::types::LauncherInstance;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;
use uuid::Uuid;

const CLIENT_ID: &str = "1561667019735302184";
const LOGO_URL: &str = "https://raw.githubusercontent.com/L1ceX/lynapp/main/build/icon.png";
const PROJECT_URL: &str = "https://github.com/L1ceX/lynapp";

#[derive(Clone)]
struct GameSession {
    instance: LauncherInstance,
    started_at: u64,
}

struct PresenceState {
    enabled: bool,
    hide_instance: bool,
    sessions: HashMap<String, GameSession>,
    launcher_started_at: u64,
    dirty: bool,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn clip(value: &str, max: usize) -> String {
    if value.chars().count() > max {
        let head: String = value.chars().take(max.saturating_sub(1)).collect();
        format!("{head}…")
    } else {
        value.to_string()
    }
}

fn loader_label(loader: &str) -> &str {
    match loader {
        "fabric" => "Fabric",
        "forge" => "Forge",
        "neoforge" => "NeoForge",
        "quilt" => "Quilt",
        _ => "Vanilla",
    }
}

fn build_activity(state: &PresenceState) -> Value {
    let buttons = json!([{
        "label": tr("Get lynapp", "Скачать lynapp"),
        "url": PROJECT_URL
    }]);
    let assets = json!({
        "large_image": LOGO_URL,
        "large_text": "lynapp"
    });

    if let Some(session) = state.sessions.values().max_by_key(|s| s.started_at) {
        let inst = &session.instance;
        let version = if inst.loader != "vanilla" {
            format!(
                "Minecraft {} · {}",
                inst.game_version,
                loader_label(&inst.loader)
            )
        } else {
            format!("Minecraft {}", inst.game_version)
        };
        let show_name = !state.hide_instance && inst.name.trim().len() >= 2;
        if show_name {
            json!({
                "assets": assets,
                "buttons": buttons,
                "details": clip(inst.name.trim(), 128),
                "state": clip(&version, 128),
                "timestamps": { "start": session.started_at }
            })
        } else {
            json!({
                "assets": assets,
                "buttons": buttons,
                "details": clip(&version, 128),
                "timestamps": { "start": session.started_at }
            })
        }
    } else {
        json!({
            "assets": assets,
            "buttons": buttons,
            "details": tr("In the launcher", "В лаунчере"),
            "timestamps": { "start": state.launcher_started_at }
        })
    }
}

fn write_frame<W: Write>(stream: &mut W, op: i32, payload: &Value) -> std::io::Result<()> {
    let body = serde_json::to_vec(payload).unwrap_or_default();
    let mut header = [0u8; 8];
    header[0..4].copy_from_slice(&op.to_le_bytes());
    header[4..8].copy_from_slice(&(body.len() as i32).to_le_bytes());
    stream.write_all(&header)?;
    stream.write_all(&body)?;
    stream.flush()
}

fn read_frame<R: Read>(stream: &mut R) -> std::io::Result<(i32, Value)> {
    let mut header = [0u8; 8];
    stream.read_exact(&mut header)?;
    let op = i32::from_le_bytes([header[0], header[1], header[2], header[3]]);
    let len = i32::from_le_bytes([header[4], header[5], header[6], header[7]]);
    if len < 0 || len > 1024 * 1024 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "invalid frame length",
        ));
    }
    let mut buf = vec![0u8; len as usize];
    stream.read_exact(&mut buf)?;
    let val = serde_json::from_slice(&buf).unwrap_or(Value::Null);
    Ok((op, val))
}

#[cfg(windows)]
fn open_discord_pipe() -> Option<std::fs::File> {
    use std::fs::OpenOptions;
    for i in 0..10 {
        let path = format!("\\\\?\\pipe\\discord-ipc-{i}");
        if let Ok(file) = OpenOptions::new().read(true).write(true).open(&path) {
            return Some(file);
        }
    }
    None
}

#[cfg(unix)]
fn open_discord_pipe() -> Option<std::os::unix::net::UnixStream> {
    use std::os::unix::net::UnixStream;
    let runtime_dir = std::env::var("XDG_RUNTIME_DIR")
        .or_else(|_| std::env::var("TMPDIR"))
        .unwrap_or_else(|_| "/tmp".to_string());
    let dirs = [
        runtime_dir.clone(),
        format!("{runtime_dir}/app/com.discordapp.Discord"),
        format!("{runtime_dir}/app/dev.vencord.Vesktop"),
        format!("{runtime_dir}/snap.discord"),
        "/tmp".to_string(),
    ];
    for i in 0..10 {
        for dir in &dirs {
            let path = format!("{dir}/discord-ipc-{i}");
            if let Ok(stream) = UnixStream::connect(&path) {
                return Some(stream);
            }
        }
    }
    None
}

pub struct DiscordPresence {
    state: Arc<Mutex<PresenceState>>,
}

impl DiscordPresence {
    pub fn new() -> Arc<Self> {
        let state = Arc::new(Mutex::new(PresenceState {
            enabled: false,
            hide_instance: false,
            sessions: HashMap::new(),
            launcher_started_at: now_ms(),
            dirty: false,
        }));
        let instance = Arc::new(Self {
            state: state.clone(),
        });
        Self::spawn_worker(state);
        instance
    }

    fn spawn_worker(state: Arc<Mutex<PresenceState>>) {
        std::thread::spawn(move || {
            let mut pipe = None;
            let mut ready = false;
            loop {
                let (enabled, activity_opt) = {
                    let guard = state.blocking_lock();
                    let enabled = guard.enabled;
                    let act = if enabled && (guard.dirty || !ready) {
                        Some(build_activity(&guard))
                    } else {
                        None
                    };
                    (enabled, act)
                };

                if !enabled {
                    pipe = None;
                    ready = false;
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    continue;
                }

                if pipe.is_none() {
                    if let Some(mut stream) = open_discord_pipe() {
                        let hs = json!({ "v": 1, "client_id": CLIENT_ID });
                        if write_frame(&mut stream, 0, &hs).is_ok() {
                            if let Ok((1, msg)) = read_frame(&mut stream) {
                                if msg.get("evt").and_then(Value::as_str) == Some("READY") {
                                    ready = true;
                                    pipe = Some(stream);
                                }
                            }
                        }
                    }
                    if pipe.is_none() {
                        std::thread::sleep(std::time::Duration::from_secs(15));
                        continue;
                    }
                }

                if let (Some(stream), Some(activity)) = (pipe.as_mut(), activity_opt) {
                    let frame = json!({
                        "cmd": "SET_ACTIVITY",
                        "args": {
                            "pid": std::process::id(),
                            "activity": activity
                        },
                        "nonce": Uuid::new_v4().to_string()
                    });
                    if write_frame(stream, 1, &frame).is_ok() {
                        let _ = read_frame(stream);
                        let mut guard = state.blocking_lock();
                        guard.dirty = false;
                    } else {
                        pipe = None;
                        ready = false;
                    }
                }

                std::thread::sleep(std::time::Duration::from_secs(2));
            }
        });
    }

    pub async fn apply_settings(&self, enabled: bool, hide_instance: bool) {
        let mut guard = self.state.lock().await;
        guard.enabled = enabled;
        guard.hide_instance = hide_instance;
        guard.dirty = true;
    }

    pub async fn game_started(&self, instance: &LauncherInstance) {
        let mut guard = self.state.lock().await;
        guard.sessions.insert(
            instance.id.clone(),
            GameSession {
                instance: instance.clone(),
                started_at: now_ms(),
            },
        );
        guard.dirty = true;
    }

    pub async fn game_stopped(&self, id: &str) {
        let mut guard = self.state.lock().await;
        if guard.sessions.remove(id).is_some() {
            guard.dirty = true;
        }
    }
}
