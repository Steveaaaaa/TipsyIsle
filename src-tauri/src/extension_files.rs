use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager, Runtime};

pub fn file<R: Runtime>(app: &AppHandle<R>, area: &str, relative: &str) -> Result<PathBuf, String> {
    if !matches!(area, "packages" | "images" | "files") || relative.split('/').any(|part| {
        part.is_empty() || part.starts_with('.') || part.ends_with([' ', '.']) || part.chars().any(|c| c.is_control() || "<>:\"\\|?*".contains(c))
    }) && !relative.is_empty() { return Err("扩展文件路径无效".into()); }
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("extension-data").join(area).join(relative))
}

#[tauri::command]
pub async fn tipsy_extension_files(app: AppHandle, action: String, area: String, path: String, data: Option<Vec<u8>>) -> Result<serde_json::Value, String> {
    let target = file(&app, &area, &path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let error = |e: std::io::Error| e.to_string();
        match action.as_str() {
            "write" if !path.is_empty() => {
                fs::create_dir_all(target.parent().ok_or("扩展目录无效")?).map_err(error)?;
                fs::write(target, data.ok_or("没有文件内容")?).map_err(error)?;
                Ok(serde_json::Value::Null)
            }
            "remove" if !path.is_empty() => match if area == "packages" { fs::remove_dir_all(target) } else { fs::remove_file(target) } {
                Ok(()) => Ok(serde_json::json!(true)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!(false)),
                Err(e) => Err(e.to_string()),
            },
            "list" => {
                let items = match fs::read_dir(target) {
                    Ok(items) => items,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(serde_json::json!([])),
                    Err(e) => return Err(e.to_string()),
                };
                let mut result = Vec::new();
                for item in items {
                    let item = item.map_err(error)?;
                    let metadata = item.metadata().map_err(error)?;
                    let modified = metadata.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|t| t.as_millis()).unwrap_or(0);
                    result.push(serde_json::json!({ "name": item.file_name().to_string_lossy(), "folder": metadata.is_dir(), "modified": modified }));
                }
                Ok(serde_json::json!(result))
            }
            "exists" => Ok(serde_json::json!(target.is_file())),
            _ => Err("未知扩展文件操作".into()),
        }
    }).await.map_err(|e| e.to_string())?
}
