mod compatibility;
mod storage;
mod gallery;
mod extension_files;
mod lan_sync;
mod lan_discovery;
mod updates;
use tauri::{Manager, State};
#[tauri::command]
fn tipsy_runtime_info(host: State<'_, compatibility::CompatibilityHost>) -> serde_json::Value {
    serde_json::json!({ "compatibilityOrigin": host.origin, "appUpdates": cfg!(any(target_os = "android", all(target_os = "windows", target_arch = "x86_64"))) })
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(updates::plugin())
        .setup(|app| {
            let directory = app.path().app_data_dir()?;
            std::fs::create_dir_all(&directory)?;
            app.manage(storage::KvState::open(&directory.join("tipsy-isle.sqlite"))?);
            app.manage(lan_sync::LanHost::default());
            app.manage(compatibility::start(app.handle().clone())?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![storage::tipsy_kv_get, storage::tipsy_kv_set_many, tipsy_runtime_info, gallery::tipsy_gallery_write, gallery::tipsy_gallery_remove, extension_files::tipsy_extension_files, lan_sync::tipsy_lan_control, updates::tipsy_update_check, updates::tipsy_update_download, updates::tipsy_update_install])
        .run(tauri::generate_context!())
        .expect("error while running TipsyIsle application");
}
