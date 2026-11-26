use std::fs;
use std::path::Path;

fn load_dotenv(path: &Path) {
    let Ok(content) = fs::read_to_string(path) else {
        return;
    };
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((k, v)) = trimmed.split_once('=') else {
            continue;
        };
        let key = k.trim();
        if matches!(
            key,
            "MAIN_VITE_CURSEFORGE_API_KEY"
                | "CURSEFORGE_API_KEY"
                | "MAIN_VITE_ELY_CLIENT_ID"
                | "MAIN_VITE_ELY_CLIENT_SECRET"
        ) {
            let mut val = v.trim().to_string();
            if (val.starts_with('"') && val.ends_with('"'))
                || (val.starts_with('\'') && val.ends_with('\''))
            {
                val = val[1..val.len() - 1].to_string();
            }
            val = val.replace("\\$", "$");
            if !val.is_empty() {
                println!("cargo:rustc-env={key}={val}");
            }
        }
    }
}

fn main() {
    let local_env = Path::new("../.env");
    let sibling_env = Path::new("../../minecraft-launcher/.env");
    if local_env.exists() {
        println!("cargo:rerun-if-changed=../.env");
        load_dotenv(local_env);
    } else if sibling_env.exists() {
        println!("cargo:rerun-if-changed=../../minecraft-launcher/.env");
        load_dotenv(sibling_env);
    }
    tauri_build::build()
}
