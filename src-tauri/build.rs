fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["tipsy_kv_get", "tipsy_kv_set_many", "tipsy_runtime_info", "tipsy_gallery_write", "tipsy_gallery_remove", "tipsy_extension_files", "tipsy_lan_control", "tipsy_update_check", "tipsy_update_download", "tipsy_update_install"])
    )).expect("failed to build application capabilities");
}
