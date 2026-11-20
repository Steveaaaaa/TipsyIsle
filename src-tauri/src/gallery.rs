use std::{fs, path::{Component, Path, PathBuf}};
use tauri::{AppHandle, Manager, Runtime};

pub fn file<R: Runtime>(app: &AppHandle<R>, story: &str, relative: &str) -> Result<PathBuf, String> {
    if story.is_empty() || !story.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-' || c == b'~') { return Err("无效的故事标识".into()); }
    let path = Path::new(relative);
    if path.components().any(|part| !matches!(part, Component::Normal(_))) || relative.contains(':') || relative.contains('\\') { return Err("无效的图库路径".into()); }
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("galleries").join(story).join(path))
}

#[tauri::command]
pub async fn tipsy_gallery_write(app: AppHandle, story_id: String, path: String, data: Vec<u8>) -> Result<(), String> {
    let extension = Path::new(&path).extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
    if path != "manifest.json" && !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif" | "avif" | "svg" | "bmp") { return Err("图库仅接受图片".into()); }
    let target = file(&app, &story_id, &path)?;
    fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(&target, &data).map_err(|e| e.to_string())?;
    if path == "manifest.json" {
        let manifest: serde_json::Value = serde_json::from_slice(&data).map_err(|e| e.to_string())?;
        let version = manifest["version"].as_str().ok_or("缺少图库版本")?;
        for item in fs::read_dir(target.parent().unwrap()).map_err(|e| e.to_string())? {
            let item = item.map_err(|e| e.to_string())?;
            if item.file_type().map_err(|e| e.to_string())?.is_dir() && item.file_name() != version { fs::remove_dir_all(item.path()).map_err(|e| e.to_string())?; }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn tipsy_gallery_remove(app: AppHandle, story_id: String) -> Result<(), String> {
    let directory = file(&app, &story_id, "")?;
    tauri::async_runtime::spawn_blocking(move || {
        if directory.exists() { fs::remove_dir_all(directory).map_err(|e| e.to_string())?; }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

pub fn decode_path(path: &str) -> Option<String> {
    let bytes = path.as_bytes(); let mut decoded = Vec::with_capacity(bytes.len()); let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            decoded.push(u8::from_str_radix(std::str::from_utf8(bytes.get(i+1..i+3)?).ok()?, 16).ok()?); i += 3;
        } else { decoded.push(bytes[i]); i += 1; }
    }
    String::from_utf8(decoded).ok()
}

pub fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "webp" => "image/webp", "gif" => "image/gif",
        "svg" => "image/svg+xml", "avif" => "image/avif", "bmp" => "image/bmp", "json" => "application/json", _ => "application/octet-stream"
    }
}
