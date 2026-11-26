use flate2::read::GzDecoder;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use tar::Archive;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

fn sanitize_zip_rel(name: &str) -> Option<PathBuf> {
    let normalized = name.replace('\\', "/");
    let mut out = PathBuf::new();
    for comp in Path::new(&normalized).components() {
        match comp {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            _ => return None,
        }
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}

pub fn extract_zip_filtered<F>(zip_path: &Path, dest_dir: &Path, mut skip: F) -> Result<(), String>
where
    F: FnMut(&str) -> bool,
{
    let file = File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;
    fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let raw_name = entry.name().replace('\\', "/");
        if skip(&raw_name) {
            continue;
        }
        let Some(rel) = sanitize_zip_rel(&raw_name) else {
            continue;
        };
        let target = dest_dir.join(&rel);
        if entry.is_dir() || raw_name.ends_with('/') {
            fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out = File::create(&target).map_err(|e| e.to_string())?;
            io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn extract_zip(zip_path: &Path, dest_dir: &Path) -> Result<(), String> {
    extract_zip_filtered(zip_path, dest_dir, |_| false)
}

pub fn extract_tar_gz(archive_path: &Path, dest_dir: &Path) -> Result<(), String> {
    let file = File::open(archive_path).map_err(|e| e.to_string())?;
    let gz = GzDecoder::new(file);
    let mut archive = Archive::new(gz);
    fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    for entry_res in archive.entries().map_err(|e| e.to_string())? {
        let mut entry = entry_res.map_err(|e| e.to_string())?;
        let raw_path = entry.path().map_err(|e| e.to_string())?.to_path_buf();
        let Some(rel) = sanitize_zip_rel(&raw_path.to_string_lossy()) else {
            continue;
        };
        let target = dest_dir.join(rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        entry.unpack(&target).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn create_zip_from_dir<F>(
    src_dir: &Path,
    dest_zip: &Path,
    skip_locked: bool,
    mut filter: F,
) -> Result<(), String>
where
    F: FnMut(&Path, &str) -> bool,
{
    if let Some(parent) = dest_zip.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file = File::create(dest_zip).map_err(|e| e.to_string())?;
    let mut writer = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    let mut stack = vec![src_dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) if skip_locked => continue,
            Err(e) => return Err(e.to_string()),
        };
        for entry_res in entries {
            let entry = match entry_res {
                Ok(e) => e,
                Err(_) if skip_locked => continue,
                Err(e) => return Err(e.to_string()),
            };
            let full = entry.path();
            let meta = match fs::symlink_metadata(&full) {
                Ok(m) => m,
                Err(_) if skip_locked => continue,
                Err(e) => return Err(e.to_string()),
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            let rel = full
                .strip_prefix(src_dir)
                .unwrap_or(&full)
                .to_string_lossy()
                .replace('\\', "/");
            if !filter(&full, &rel) {
                continue;
            }
            if meta.is_dir() {
                stack.push(full);
            } else if meta.is_file() {
                let mut src_file = match File::open(&full) {
                    Ok(f) => f,
                    Err(_) if skip_locked => continue,
                    Err(e) => return Err(e.to_string()),
                };
                let entry_opts = if meta.len() >= 4_000_000_000 {
                    options.large_file(true)
                } else {
                    options
                };
                writer
                    .start_file(&rel, entry_opts)
                    .map_err(|e| e.to_string())?;
                if let Err(e) = io::copy(&mut src_file, &mut writer) {
                    if skip_locked {
                        continue;
                    }
                    return Err(e.to_string());
                }
            }
        }
    }

    writer.finish().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list_zip_entries(zip_path: &Path) -> Result<Vec<String>, String> {
    let file = File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut names = Vec::with_capacity(archive.len());
    for i in 0..archive.len() {
        if let Ok(entry) = archive.by_index(i) {
            names.push(entry.name().replace('\\', "/"));
        }
    }
    Ok(names)
}

pub fn read_zip_entry_bytes(zip_path: &Path, entry_name: &str) -> Result<Option<Vec<u8>>, String> {
    let file = File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;
    let target = entry_name.replace('\\', "/");
    let mut entry = match archive.by_name(&target) {
        Ok(e) => e,
        Err(_) => return Ok(None),
    };
    let mut buf = Vec::new();
    entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(Some(buf))
}

#[allow(dead_code)]
pub fn write_zip_entries(
    dest_zip: &Path,
    files: &[(String, Vec<u8>)],
    extra_disk_files: &[(String, PathBuf)],
) -> Result<(), String> {
    if let Some(parent) = dest_zip.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file = File::create(dest_zip).map_err(|e| e.to_string())?;
    let mut writer = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    for (name, bytes) in files {
        writer
            .start_file(name.replace('\\', "/"), options)
            .map_err(|e| e.to_string())?;
        writer.write_all(bytes).map_err(|e| e.to_string())?;
    }
    for (name, disk_path) in extra_disk_files {
        if let Ok(mut f) = File::open(disk_path) {
            let meta_len = f.metadata().map(|m| m.len()).unwrap_or(0);
            let opts = if meta_len >= 4_000_000_000 {
                options.large_file(true)
            } else {
                options
            };
            writer
                .start_file(name.replace('\\', "/"), opts)
                .map_err(|e| e.to_string())?;
            io::copy(&mut f, &mut writer).map_err(|e| e.to_string())?;
        }
    }
    writer.finish().map_err(|e| e.to_string())?;
    Ok(())
}
