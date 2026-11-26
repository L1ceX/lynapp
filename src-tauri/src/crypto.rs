use base64::engine::general_purpose::STANDARD;
use base64::Engine;

pub const SECRET_PREFIX: &str = "dpapi:v1:";

#[cfg(windows)]
pub fn can_encrypt() -> bool {
    true
}

#[cfg(not(windows))]
pub fn can_encrypt() -> bool {
    false
}

#[cfg(windows)]
fn dpapi_unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    use std::ptr;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};

    let mut buf = data.to_vec();
    let mut input = CRYPT_INTEGER_BLOB {
        cbData: buf.len() as u32,
        pbData: buf.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };

    let ok = unsafe {
        CryptUnprotectData(
            &mut input,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            0,
            &mut output,
        )
    };
    if ok == 0 || output.pbData.is_null() {
        return Err("CryptUnprotectData failed".to_string());
    }
    let slice = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
    let out = slice.to_vec();
    unsafe {
        LocalFree(output.pbData as _);
    }
    Ok(out)
}

#[cfg(windows)]
fn read_electron_os_crypt_key() -> Option<[u8; 32]> {
    use std::sync::OnceLock;
    static KEY: OnceLock<Option<[u8; 32]>> = OnceLock::new();
    *KEY.get_or_init(|| {
        let root = crate::paths::get_launcher_root();
        let candidates = [root.join("app").join("Local State"), root.join("Local State")];
        for path in candidates {
            let Ok(raw) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) else {
                continue;
            };
            let Some(enc_b64) = val
                .get("os_crypt")
                .and_then(|v| v.get("encrypted_key"))
                .and_then(|v| v.as_str())
            else {
                continue;
            };
            let Ok(enc_bytes) = STANDARD.decode(enc_b64) else {
                continue;
            };
            let Some(dpapi_payload) = enc_bytes.strip_prefix(b"DPAPI") else {
                continue;
            };
            let Ok(plain_key) = dpapi_unprotect(dpapi_payload) else {
                continue;
            };
            if plain_key.len() == 32 {
                let mut key = [0u8; 32];
                key.copy_from_slice(&plain_key);
                return Some(key);
            }
        }
        None
    })
}

#[cfg(windows)]
fn decrypt_electron_v10(decoded: &[u8]) -> Result<String, String> {
    use aes_gcm::aead::Aead;
    use aes_gcm::{Aes256Gcm, KeyInit, Nonce};

    if decoded.len() <= 15 {
        return Err("Invalid v10 ciphertext".to_string());
    }
    let key = read_electron_os_crypt_key().ok_or_else(|| "Electron Local State key unavailable".to_string())?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let nonce = Nonce::from_slice(&decoded[3..15]);
    let plain = cipher
        .decrypt(nonce, &decoded[15..])
        .map_err(|_| "AES-GCM decryption failed".to_string())?;
    String::from_utf8(plain).map_err(|e| e.to_string())
}

#[cfg(windows)]
pub fn encrypt_secret(plain: &str) -> Result<String, String> {
    use std::ptr;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};

    let bytes = plain.as_bytes();
    let mut input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };

    let ok = unsafe {
        CryptProtectData(
            &mut input,
            ptr::null(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            0,
            &mut output,
        )
    };
    if ok == 0 || output.pbData.is_null() {
        return Err("CryptProtectData failed".to_string());
    }
    let slice = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
    let encoded = format!("{SECRET_PREFIX}{}", STANDARD.encode(slice));
    unsafe {
        LocalFree(output.pbData as _);
    }
    Ok(encoded)
}

#[cfg(not(windows))]
pub fn encrypt_secret(plain: &str) -> Result<String, String> {
    Ok(plain.to_string())
}

#[cfg(windows)]
pub fn decrypt_secret(cipher: &str) -> Result<(String, bool), String> {
    let raw_b64 = cipher
        .strip_prefix(SECRET_PREFIX)
        .ok_or_else(|| "Missing secret prefix".to_string())?;
    let decoded = STANDARD.decode(raw_b64).map_err(|e| e.to_string())?;
    if decoded.len() > 15 && (&decoded[..3] == b"v10" || &decoded[..3] == b"v11") {
        let plain = decrypt_electron_v10(&decoded)?;
        return Ok((plain, true));
    }
    let plain_bytes = dpapi_unprotect(&decoded)?;
    let text = String::from_utf8(plain_bytes).map_err(|e| e.to_string())?;
    Ok((text, false))
}

#[cfg(not(windows))]
pub fn decrypt_secret(_cipher: &str) -> Result<(String, bool), String> {
    Err("DPAPI unavailable".to_string())
}
