use once_cell::sync::Lazy;
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Mutex;

static SHA1_CACHE: Lazy<Mutex<HashMap<String, String>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static CF_FP_CACHE: Lazy<Mutex<HashMap<String, u32>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn cache_key(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    Some(format!("{}|{}|{}", path.to_string_lossy(), meta.len(), mtime))
}

pub fn sha1_cached(path: &Path) -> Result<String, String> {
    let key = cache_key(path);
    if let Some(ref k) = key {
        if let Some(hit) = SHA1_CACHE.lock().unwrap().get(k) {
            return Ok(hit.clone());
        }
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let mut h = Sha1::new();
    h.update(&bytes);
    let digest = hex::encode(h.finalize());
    if let Some(k) = key {
        let mut map = SHA1_CACHE.lock().unwrap();
        if map.len() > 4000 {
            map.clear();
        }
        map.insert(k, digest.clone());
    }
    Ok(digest)
}

pub fn cf_murmur2(data: &[u8]) -> u32 {
    let normalized_len = data
        .iter()
        .filter(|&&b| b != 9 && b != 10 && b != 13 && b != 32)
        .count() as u32;
    let m: u32 = 0x5bd1e995;
    let mut h: u32 = 1 ^ normalized_len;
    let mut chunk: u32 = 0;
    let mut shift: u32 = 0;

    for &b in data {
        if b == 9 || b == 10 || b == 13 || b == 32 {
            continue;
        }
        chunk |= (b as u32) << shift;
        shift += 8;
        if shift == 32 {
            let mut k = chunk.wrapping_mul(m);
            k ^= k >> 24;
            k = k.wrapping_mul(m);
            h = h.wrapping_mul(m) ^ k;
            chunk = 0;
            shift = 0;
        }
    }

    if shift > 0 {
        h ^= chunk;
        h = h.wrapping_mul(m);
    }

    h ^= h >> 13;
    h = h.wrapping_mul(m);
    h ^= h >> 15;
    h
}

pub fn cf_fingerprint_cached(path: &Path) -> Result<u32, String> {
    let key = cache_key(path);
    if let Some(ref k) = key {
        if let Some(&hit) = CF_FP_CACHE.lock().unwrap().get(k) {
            return Ok(hit);
        }
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let fp = cf_murmur2(&bytes);
    if let Some(k) = key {
        let mut map = CF_FP_CACHE.lock().unwrap();
        if map.len() > 4000 {
            map.clear();
        }
        map.insert(k, fp);
    }
    Ok(fp)
}

pub fn write_content_manifest(instance_dir: &Path, mods: &[crate::types::InstalledMod]) {
    let launcher_dir = instance_dir.join(".launcher");
    let _ = fs::create_dir_all(&launcher_dir);
    let target = launcher_dir.join("content.json");
    let tmp = launcher_dir.join(format!(
        "content.json.{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    if let Ok(text) = serde_json::to_string_pretty(mods) {
        if fs::write(&tmp, text).is_ok() {
            for attempt in 0..6 {
                match fs::rename(&tmp, &target) {
                    Ok(_) => return,
                    Err(_) if attempt < 5 => {
                        std::thread::sleep(std::time::Duration::from_millis(60 * (attempt + 1)));
                    }
                    Err(_) => {
                        let _ = fs::remove_file(&tmp);
                        return;
                    }
                }
            }
        } else {
            let _ = fs::remove_file(&tmp);
        }
    }
}
