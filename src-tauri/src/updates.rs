use tauri::{plugin::{Builder, TauriPlugin}, AppHandle, Manager, Runtime};

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("tipsy-updates-native")
        .setup(|app, _api| {
            app.manage(UpdateState::default());
            #[cfg(target_os = "android")]
            app.manage(_api.register_android_plugin("com.xiaoleng.tipsyisle", "UpdateInstaller")?);
            Ok(())
        })
        .build()
}

#[derive(Default)]
struct UpdateState {
    #[cfg(any(target_os = "android", all(target_os = "windows", target_arch = "x86_64")))]
    downloaded: tauri::async_runtime::Mutex<Option<(String, std::path::PathBuf)>>,
}

#[tauri::command]
pub async fn tipsy_update_check(app: AppHandle) -> Result<UpdateCheck, UpdateError> {
    #[cfg(any(target_os = "android", all(target_os = "windows", target_arch = "x86_64")))]
    return native::latest(&app).await.map(|(release, candidate, status)| UpdateCheck { release: release.map(|update| update.details), candidate: Some(candidate), http_status: Some(status) });
    #[cfg(not(any(target_os = "android", all(target_os = "windows", target_arch = "x86_64"))))]
    { let _ = app; Ok(UpdateCheck { release: None, candidate: None, http_status: None }) }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck { release: Option<UpdateDetails>, candidate: Option<String>, http_status: Option<u16> }

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateError {
    stage: &'static str,
    code: &'static str,
    message: &'static str,
    http_status: Option<u16>,
    candidate: Option<String>,
}

impl UpdateError {
    fn new(stage: &'static str, code: &'static str, message: &'static str) -> Self {
        Self { stage, code, message, http_status: None, candidate: None }
    }
    fn status(mut self, status: u16) -> Self { self.http_status = Some(status); self }
    fn candidate(mut self, candidate: String) -> Self { self.candidate = Some(candidate); self }
}

#[derive(serde::Serialize)]
pub struct UpdateDetails {
    version: String,
    title: Option<String>,
    notes: Option<String>,
}

#[tauri::command]
pub async fn tipsy_update_download(app: AppHandle, version: String) -> Result<(), UpdateError> {
    #[cfg(any(target_os = "android", all(target_os = "windows", target_arch = "x86_64")))]
    return native::download(&app, &version).await;
    #[cfg(not(any(target_os = "android", all(target_os = "windows", target_arch = "x86_64"))))]
    { let _ = (app, version); Err(UpdateError::new("下载", "UNSUPPORTED_PLATFORM", "当前平台不支持应用内更新。")) }
}

#[tauri::command]
pub async fn tipsy_update_install(app: AppHandle, version: String) -> Result<String, String> {
    #[cfg(any(target_os = "android", all(target_os = "windows", target_arch = "x86_64")))]
    return native::install(&app, &version).await;
    #[cfg(not(any(target_os = "android", all(target_os = "windows", target_arch = "x86_64"))))]
    { let _ = (app, version); Err("当前平台不支持应用内更新。".into()) }
}

#[cfg(any(target_os = "android", all(target_os = "windows", target_arch = "x86_64")))]
mod native {
    use super::{AppHandle, Manager, UpdateDetails, UpdateError, UpdateState};
    use reqwest::{redirect::Policy, Client, Response};
    use serde::Deserialize;
    use std::{path::Path, time::Duration};
    use tokio::io::AsyncWriteExt;

    const REPO: &str = "Steveaaaaa/TipsyIsle";
    const MAX_INSTALLER_BYTES: u64 = 256 * 1024 * 1024;
    const MAX_METADATA_BYTES: u64 = 512 * 1024;

    #[derive(Deserialize)]
    struct ReleaseInfo {
        tag_name: String,
        name: Option<String>,
        body: Option<String>,
        draft: bool,
        prerelease: bool,
        assets: Vec<ReleaseAsset>,
    }

    #[derive(Deserialize)]
    struct ReleaseAsset { name: String, size: u64, state: String }

    pub(super) struct Update { pub(super) details: UpdateDetails, file: String, size: u64 }

    fn client(timeout: Duration, assets: bool) -> Result<Client, String> {
        Client::builder()
            .user_agent(concat!("TipsyIsle/", env!("CARGO_PKG_VERSION")))
            .https_only(true)
            .connect_timeout(Duration::from_secs(5))
            .read_timeout(Duration::from_secs(15))
            .timeout(timeout)
            .redirect(if assets { Policy::custom(|attempt| {
                let official = matches!(attempt.url().host_str(), Some("github.com" | "release-assets.githubusercontent.com" | "objects.githubusercontent.com"));
                if official && attempt.url().scheme() == "https" && attempt.previous().len() < 5 { attempt.follow() }
                else { attempt.error("unexpected GitHub download redirect") }
            }) } else { Policy::none() })
            .build().map_err(|_| "无法连接 GitHub。".into())
    }

    fn available(release: ReleaseInfo, current: &semver::Version, target: &str) -> Result<Option<Update>, String> {
        let Some(tag) = release.tag_name.strip_prefix('v') else { return Ok(None) };
        let Ok(version) = semver::Version::parse(tag) else { return Ok(None) };
        if release.draft || release.prerelease || !version.pre.is_empty() || !version.build.is_empty() || &version <= current {
            return Ok(None);
        }
        let file = format!("TipsyIsle-{version}-{target}");
        let asset = release.assets.iter().find(|asset| asset.name == file && asset.state == "uploaded")
            .filter(|asset| (1..=MAX_INSTALLER_BYTES).contains(&asset.size))
            .ok_or("这个版本还没有适用于本机的安装包。")?;
        Ok(Some(Update {
            details: UpdateDetails { version: version.to_string(), title: release.name, notes: release.body },
            file,
            size: asset.size,
        }))
    }

    fn transport_error(error: reqwest::Error, stage: &'static str, message: &'static str) -> UpdateError {
        let code = if error.is_timeout() && error.is_connect() { "CONNECT_TIMEOUT" }
            else if error.is_timeout() { "REQUEST_TIMEOUT" }
            else if error.is_connect() { "CONNECT_FAILED" }
            else if error.is_redirect() { "REDIRECT_FAILED" }
            else { "REQUEST_FAILED" };
        UpdateError::new(stage, code, message)
    }

    pub(super) async fn latest(app: &AppHandle) -> Result<(Option<Update>, String, u16), UpdateError> {
        let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
        let mut response = client(Duration::from_secs(10), false)
            .map_err(|_| UpdateError::new("建立更新连接", "CLIENT_INIT", "无法连接 GitHub。"))?.get(url)
            .header("Accept", "application/vnd.github+json")
            .send().await.map_err(|error| transport_error(error, "请求 api.github.com", "无法连接 GitHub，请稍后重试。"))?;
        let status = response.status().as_u16();
        if !response.status().is_success() { return Err(UpdateError::new("请求 api.github.com", "HTTP_ERROR", "GitHub 暂时无法提供更新信息，请稍后重试。").status(status)); }
        let mut json = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|error| transport_error(error, "读取更新信息", "更新信息读取失败。").status(status))? {
            if json.len() as u64 + chunk.len() as u64 > MAX_METADATA_BYTES { return Err(UpdateError::new("读取更新信息", "METADATA_TOO_LARGE", "更新信息过长。").status(status)); }
            json.extend_from_slice(&chunk);
        }
        let release: ReleaseInfo = serde_json::from_slice(&json).map_err(|_| UpdateError::new("解析版本信息", "INVALID_METADATA", "无法读取 GitHub 的版本信息。").status(status))?;
        let candidate = release.tag_name.clone();
        if candidate.strip_prefix('v').and_then(|tag| semver::Version::parse(tag).ok()).is_none() {
            return Err(UpdateError::new("解析版本标签", "INVALID_VERSION", "无法读取 GitHub 的版本信息。").status(status));
        }
        let target = if cfg!(target_os = "android") { "android-arm64.apk" } else { "windows-x64-setup.exe" };
        match available(release, &app.package_info().version, target) {
            Ok(update) => Ok((update, candidate, status)),
            Err(_) => Err(UpdateError::new("匹配本机安装包", "INSTALLER_UNAVAILABLE", "这个版本还没有适用于本机的安装包。")
                .status(status).candidate(candidate)),
        }
    }

    async fn write_installer(mut response: Response, path: &Path, size: u64) -> Result<(), UpdateError> {
        let incomplete = || UpdateError::new("读取安装包", "INCOMPLETE_DOWNLOAD", "下载文件不完整，请重试。");
        let write_error = || UpdateError::new("写入安装包", "INSTALLER_IO", "无法保存安装包，请检查剩余空间。");
        let mut output = tokio::fs::OpenOptions::new().write(true).create_new(true).open(path).await
            .map_err(|_| write_error())?;
        let mut received = 0_u64;
        while let Some(chunk) = response.chunk().await.map_err(|error| transport_error(error, "读取安装包", "下载中断，请重试。"))? {
            received += chunk.len() as u64;
            if received > size { return Err(incomplete()); }
            output.write_all(&chunk).await.map_err(|_| write_error())?;
        }
        if received != size { return Err(incomplete()); }
        output.flush().await.map_err(|_| write_error())
    }

    pub(super) async fn download(app: &AppHandle, version: &str) -> Result<(), UpdateError> {
        let storage_error = || UpdateError::new("保存安装包", "INSTALLER_IO", "无法保存安装包，请检查剩余空间或关闭上一次的安装程序。");
        let state = app.state::<UpdateState>();
        let mut downloaded = state.downloaded.try_lock().map_err(|_| UpdateError::new("下载", "UPDATE_BUSY", "已有更新正在处理。"))?;
        if let Some((ready, path)) = downloaded.as_ref() {
            if ready == version && path.is_file() { return Ok(()); }
        }
        let update = latest(app).await?.0.filter(|update| update.details.version == version)
            .ok_or_else(|| UpdateError::new("核对下载版本", "VERSION_CHANGED", "最新版本已变化，请重新检查更新。"))?;
        let url = format!("https://github.com/{REPO}/releases/download/v{}/{}", update.details.version, update.file);
        let response = client(Duration::from_secs(300), true).map_err(|_| UpdateError::new("下载安装包", "CLIENT_INIT", "无法连接 GitHub。"))?.get(url).send().await
            .map_err(|error| transport_error(error, "下载 github.com 安装包", "无法从 GitHub 下载安装包，请重试。"))?;
        if response.status() != reqwest::StatusCode::OK { return Err(UpdateError::new("下载安装包", "HTTP_ERROR", "GitHub 暂时无法提供安装包，请重试。").status(response.status().as_u16())); }
        let directory = app.path().app_cache_dir().map_err(|_| storage_error())?.join("updates");
        tokio::fs::create_dir_all(&directory).await.map_err(|_| storage_error())?;
        let path = directory.join(&update.file);
        let partial = directory.join(format!("{}.part", update.file));
        // Only the native downloader controls these exact filenames.
        let _ = tokio::fs::remove_file(&partial).await;
        if let Err(error) = write_installer(response, &partial, update.size).await {
            let _ = tokio::fs::remove_file(&partial).await;
            return Err(error);
        }
        if tokio::fs::rename(&partial, &path).await.is_err() {
            let _ = tokio::fs::remove_file(&partial).await;
            return Err(storage_error());
        }
        if let Some((_, old_path)) = downloaded.replace((update.details.version, path)) { let _ = tokio::fs::remove_file(old_path).await; }
        Ok(())
    }

    pub(super) async fn install(app: &AppHandle, version: &str) -> Result<String, String> {
        let state = app.state::<UpdateState>();
        let downloaded = state.downloaded.try_lock().map_err(|_| "正在下载安装包。")?;
        let path = downloaded.as_ref().filter(|(ready, path)| ready == version && path.is_file())
            .map(|(_, path)| path).ok_or("安装包已不在缓存中，请重新下载。")?;
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new(path).spawn().map_err(|_| "安装程序未能打开，请重试。")?;
            app.exit(0);
            Ok("opened".into())
        }
        #[cfg(target_os = "android")]
        {
            let installer = app.state::<tauri::plugin::PluginHandle<tauri::Wry>>();
            installer.run_mobile_plugin_async("install", serde_json::json!({ "path": path })).await
                .map_err(|error| error.to_string())
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn update_is_newer_and_has_the_platform_installer() {
            let current = semver::Version::parse("1.0.9").unwrap();
            let release = |tag: &str, name: &str| serde_json::from_value(serde_json::json!({
                "tag_name": tag, "draft": false, "prerelease": false,
                "assets": [{ "name": name, "size": 100, "state": "uploaded", "browser_download_url": "https://untrusted.invalid/" }],
            })).unwrap();
            let target = "android-arm64.apk";
            assert_eq!(available(release("v1.0.10", "TipsyIsle-1.0.10-android-arm64.apk"), &current, target).unwrap().unwrap().details.version, "1.0.10");
            for tag in ["v1.0.9", "v1.0.8", "v1.1.0-beta.1", "bad"] {
                assert!(available(release(tag, "unused"), &current, target).unwrap().is_none());
            }
            assert!(available(release("v1.0.10", "TipsyIsle-1.0.10-windows-x64-setup.exe"), &current, target).is_err());
        }
    }
}
