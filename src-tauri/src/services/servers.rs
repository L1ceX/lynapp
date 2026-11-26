use crate::i18n::tr;
use crate::services::nbt::{parse_nbt, write_servers_dat, RawServerNbtEntry};
use crate::store::JsonStore;
use crate::types::{ServerEntry, ServerPingResult};
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use uuid::Uuid;

static COLOR_CODE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\u{00a7}[0-9a-fk-orx]").unwrap());
static SRV_WIN_PORT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)port\s*=\s*(\d+)").unwrap());
static SRV_WIN_HOST_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)svr hostname\s*=\s*(\S+)").unwrap());

fn encode_varint(mut v: u32) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        if (v & !0x7f) == 0 {
            out.push(v as u8);
            break;
        }
        out.push(((v & 0x7f) | 0x80) as u8);
        v >>= 7;
    }
    out
}

fn decode_varint(buf: &[u8], offset: usize) -> Option<(usize, usize)> {
    let mut num_read = 0usize;
    let mut result = 0usize;
    loop {
        let b = *buf.get(offset + num_read)?;
        result |= ((b & 0x7f) as usize) << (7 * num_read);
        num_read += 1;
        if num_read > 5 {
            return None;
        }
        if (b & 0x80) == 0 {
            break;
        }
    }
    Some((result, num_read))
}

fn encode_mc_string(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = encode_varint(b.len() as u32);
    out.extend_from_slice(b);
    out
}

fn flatten_motd(val: &Value) -> String {
    match val {
        Value::String(s) => s.clone(),
        Value::Object(map) => {
            let mut out = map
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if let Some(arr) = map.get("extra").and_then(Value::as_array) {
                for child in arr {
                    out.push_str(&flatten_motd(child));
                }
            }
            out
        }
        _ => String::new(),
    }
}

fn clean_motd(raw: &str) -> String {
    let stripped = COLOR_CODE_RE.replace_all(raw, "");
    stripped
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn parse_address(raw_ip: &str) -> (String, u16, bool) {
    let trimmed = raw_ip.trim();
    if let Some(rest) = trimmed.strip_prefix('[') {
        if let Some((host, after)) = rest.split_once(']') {
            if let Some(p_str) = after.strip_prefix(':') {
                if let Ok(port) = p_str.parse::<u16>() {
                    if port > 0 {
                        return (host.to_string(), port, true);
                    }
                }
            }
            return (host.to_string(), 25565, false);
        }
    }
    if trimmed.matches(':').count() == 1 {
        if let Some((host, p_str)) = trimmed.rsplit_once(':') {
            if !host.is_empty() {
                if let Ok(port) = p_str.parse::<u16>() {
                    if port > 0 {
                        return (host.to_string(), port, true);
                    }
                }
            }
        }
    }
    let clean = trimmed
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(trimmed);
    (clean.to_string(), 25565, false)
}

async fn resolve_srv(host: &str) -> Option<(String, u16)> {
    let query = format!("_minecraft._tcp.{host}");
    let fut = tokio::task::spawn_blocking(move || {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let out = std::process::Command::new("nslookup")
                .args(["-type=SRV", &query])
                .creation_flags(0x08000000)
                .output()
                .ok()?;
            let text = String::from_utf8_lossy(&out.stdout);
            let port = SRV_WIN_PORT_RE
                .captures(&text)?
                .get(1)?
                .as_str()
                .parse::<u16>()
                .ok()?;
            let target = SRV_WIN_HOST_RE
                .captures(&text)?
                .get(1)?
                .as_str()
                .trim_end_matches('.')
                .to_string();
            Some((target, port))
        }
        #[cfg(not(windows))]
        {
            let out = std::process::Command::new("dig")
                .args(["+short", "SRV", &query])
                .output()
                .ok()?;
            let text = String::from_utf8_lossy(&out.stdout);
            let line = text.lines().next()?;
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 4 {
                let port = parts[2].parse::<u16>().ok()?;
                let target = parts[3].trim_end_matches('.').to_string();
                return Some((target, port));
            }
            None
        }
    });
    tokio::time::timeout(Duration::from_millis(1500), fut)
        .await
        .ok()?
        .ok()?
}

fn read_raw_entries(instance_dir: &Path) -> Result<Vec<RawServerNbtEntry>, String> {
    let file = instance_dir.join("servers.dat");
    if !file.exists() {
        return Ok(Vec::new());
    }
    let buf = fs::read(&file).map_err(|_| {
        tr(
            "Could not read servers.dat (file is locked)",
            "Не удалось прочитать servers.dat (файл занят)",
        )
        .to_string()
    })?;
    let root = parse_nbt(&buf).map_err(|_| {
        tr(
            "servers.dat is corrupt and cannot be parsed",
            "Файл servers.dat повреждён и не может быть прочитан",
        )
        .to_string()
    })?;
    let mut out = Vec::new();
    if let Some(list) = root.get("servers").and_then(|v| v.as_list()) {
        for item in list {
            let Some(comp) = item.as_compound() else {
                continue;
            };
            let ip = comp
                .get("ip")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .unwrap_or("")
                .to_string();
            if ip.is_empty() {
                continue;
            }
            let name = comp
                .get("name")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| ip.clone());
            let icon = comp
                .get("icon")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let accept_textures = comp
                .get("acceptTextures")
                .and_then(|v| v.as_i64())
                .map(|v| v as i8);
            let hidden = comp
                .get("hidden")
                .and_then(|v| v.as_i64())
                .map(|v| v as i8);
            out.push(RawServerNbtEntry {
                name,
                ip,
                icon,
                accept_textures,
                hidden,
            });
        }
    }
    Ok(out)
}

fn write_entries_atomic(instance_dir: &Path, entries: &[RawServerNbtEntry]) -> Result<(), String> {
    let file = instance_dir.join("servers.dat");
    let tmp = instance_dir.join(format!(
        "servers.dat.{}.{}.tmp",
        std::process::id(),
        Uuid::new_v4()
    ));
    let bytes = write_servers_dat(entries)?;
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    for attempt in 0..6 {
        match fs::rename(&tmp, &file) {
            Ok(_) => return Ok(()),
            Err(_) if attempt < 5 => {
                std::thread::sleep(Duration::from_millis(80 * (attempt + 1)));
            }
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                return Err(e.to_string());
            }
        }
    }
    Ok(())
}

fn to_server_entries(raw: Vec<RawServerNbtEntry>) -> Vec<ServerEntry> {
    raw.into_iter()
        .map(|item| ServerEntry {
            name: item.name,
            ip: item.ip,
            icon_data_url: item.icon.map(|ic| {
                if ic.starts_with("data:image/") {
                    ic
                } else {
                    format!("data:image/png;base64,{ic}")
                }
            }),
        })
        .collect()
}

pub struct ServerService {
    store: Arc<JsonStore>,
    write_lock: Mutex<()>,
}

impl ServerService {
    pub fn new(store: Arc<JsonStore>) -> Self {
        Self {
            store,
            write_lock: Mutex::new(()),
        }
    }

    async fn get_instance_dir(&self, instance_id: &str) -> Result<PathBuf, String> {
        let data = self.store.get_data().await;
        let inst = data
            .instances
            .iter()
            .find(|i| i.id == instance_id)
            .ok_or_else(|| tr("Instance not found", "Инстанция не найдена").to_string())?;
        Ok(PathBuf::from(&inst.directory))
    }

    pub async fn list(&self, instance_id: &str) -> Result<Vec<ServerEntry>, String> {
        let dir = self.get_instance_dir(instance_id).await?;
        let raw = tokio::task::spawn_blocking(move || read_raw_entries(&dir))
            .await
            .map_err(|e| e.to_string())??;
        Ok(to_server_entries(raw))
    }

    pub async fn add(
        &self,
        instance_id: &str,
        name: &str,
        ip: &str,
    ) -> Result<Vec<ServerEntry>, String> {
        let clean_ip = ip.trim().to_string();
        if clean_ip.is_empty() {
            return Err(tr("Enter a server address", "Введите адрес сервера").to_string());
        }
        let clean_name = if name.trim().is_empty() {
            clean_ip.clone()
        } else {
            name.trim().to_string()
        };
        let dir = self.get_instance_dir(instance_id).await?;
        let _guard = self.write_lock.lock().await;
        let raw = tokio::task::spawn_blocking(move || {
            let mut existing = read_raw_entries(&dir)?;
            if let Some(found) = existing
                .iter_mut()
                .find(|e| e.ip.eq_ignore_ascii_case(&clean_ip))
            {
                found.name = clean_name;
                found.ip = clean_ip;
            } else {
                existing.push(RawServerNbtEntry {
                    name: clean_name,
                    ip: clean_ip,
                    icon: None,
                    accept_textures: None,
                    hidden: None,
                });
            }
            write_entries_atomic(&dir, &existing)?;
            Ok::<Vec<RawServerNbtEntry>, String>(existing)
        })
        .await
        .map_err(|e| e.to_string())??;
        Ok(to_server_entries(raw))
    }

    pub async fn remove(&self, instance_id: &str, ip: &str) -> Result<Vec<ServerEntry>, String> {
        let target_ip = ip.trim().to_string();
        let dir = self.get_instance_dir(instance_id).await?;
        let _guard = self.write_lock.lock().await;
        let raw = tokio::task::spawn_blocking(move || {
            let mut existing = read_raw_entries(&dir)?;
            existing.retain(|e| !e.ip.eq_ignore_ascii_case(&target_ip));
            write_entries_atomic(&dir, &existing)?;
            Ok::<Vec<RawServerNbtEntry>, String>(existing)
        })
        .await
        .map_err(|e| e.to_string())??;
        Ok(to_server_entries(raw))
    }

    pub async fn ping(&self, raw_ip: &str) -> ServerPingResult {
        let ip = raw_ip.trim().to_string();
        let offline = ServerPingResult {
            ip: ip.clone(),
            online: false,
            latency_ms: None,
            players_online: None,
            players_max: None,
            version_name: None,
            motd: None,
            icon_data_url: None,
        };
        if ip.is_empty() {
            return offline;
        }
        let (host, port, explicit_port) = parse_address(&ip);
        let (connect_host, connect_port) = if !explicit_port {
            resolve_srv(&host).await.unwrap_or((host.clone(), port))
        } else {
            (host.clone(), port)
        };

        let started = Instant::now();
        let addr = format!("{connect_host}:{connect_port}");
        let mut stream = match tokio::time::timeout(Duration::from_millis(4500), TcpStream::connect(&addr)).await {
            Ok(Ok(s)) => s,
            _ => return offline,
        };
        let latency_ms = started.elapsed().as_millis() as u64;

        let mut payload = encode_varint(0x00);
        payload.extend_from_slice(&encode_varint(767));
        payload.extend_from_slice(&encode_mc_string(&host));
        payload.extend_from_slice(&connect_port.to_be_bytes());
        payload.extend_from_slice(&encode_varint(1));

        let mut packet = encode_varint(payload.len() as u32);
        packet.extend_from_slice(&payload);
        packet.extend_from_slice(&[0x01, 0x00]);

        if stream.write_all(&packet).await.is_err() {
            return offline;
        }

        let mut acc = Vec::new();
        let mut chunk = [0u8; 4096];
        let read_res = tokio::time::timeout(Duration::from_millis(4500), async {
            loop {
                let n = stream.read(&mut chunk).await.ok()?;
                if n == 0 || acc.len() + n > 2 * 1024 * 1024 {
                    return None;
                }
                acc.extend_from_slice(&chunk[..n]);
                if let Some((pkt_len, pkt_len_sz)) = decode_varint(&acc, 0) {
                    if pkt_len == 0 || pkt_len > 2 * 1024 * 1024 {
                        return None;
                    }
                    if acc.len() >= pkt_len_sz + pkt_len {
                        let (pkt_id, id_sz) = decode_varint(&acc, pkt_len_sz)?;
                        if pkt_id != 0 {
                            return None;
                        }
                        let str_off = pkt_len_sz + id_sz;
                        let (str_len, str_len_sz) = decode_varint(&acc, str_off)?;
                        let json_start = str_off + str_len_sz;
                        if acc.len() < json_start + str_len {
                            continue;
                        }
                        return String::from_utf8(acc[json_start..json_start + str_len].to_vec()).ok();
                    }
                }
            }
        })
        .await;

        let Ok(Some(json_str)) = read_res else {
            return offline;
        };
        let Ok(parsed) = serde_json::from_str::<Value>(&json_str) else {
            return offline;
        };
        let version_name = parsed
            .pointer("/version/name")
            .and_then(Value::as_str)
            .map(clean_motd);
        let motd = parsed
            .get("description")
            .map(|d| clean_motd(&flatten_motd(d)))
            .unwrap_or_default();
        let proxy_offline = version_name
            .as_deref()
            .map(|v| v.to_lowercase().contains("offline"))
            .unwrap_or(false)
            || motd.to_lowercase().contains("this server is offline");
        let icon_data_url = parsed
            .get("favicon")
            .and_then(Value::as_str)
            .filter(|s| s.starts_with("data:image/"))
            .map(str::to_string);

        ServerPingResult {
            ip,
            online: !proxy_offline,
            latency_ms: Some(latency_ms),
            players_online: parsed.pointer("/players/online").and_then(Value::as_u64),
            players_max: parsed.pointer("/players/max").and_then(Value::as_u64),
            version_name: if proxy_offline { None } else { version_name },
            motd: Some(motd),
            icon_data_url,
        }
    }
}
