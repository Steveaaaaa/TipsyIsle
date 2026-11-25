# 构建 iOS 版

iOS 包内版本目前由 `src-tauri/tauri.ios.conf.json` 单独固定为 `1.1.6`。Windows、Android 和网页版继续使用各自现有的版本配置。

## 在 Mac 上构建

需要 Node.js 22（至少 22.19.0）、Rust、Xcode 26 或更新版本与已安装的 iOS 模拟器运行时，以及 XcodeGen（`brew install xcodegen`）。在项目根目录执行：

```sh
npm ci
rustup target add aarch64-apple-ios
npm run tauri -- ios init --ci --skip-targets-install
cp src-tauri/icons/ios/*.png src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/
npm run tauri -- ios build --ci --target aarch64 --no-sign
```

生成的 IPA 位于 `src-tauri/gen/apple/build/arm64/`。`--no-sign` 只验证能否打包；未签名 IPA 不能直接安装到普通 iPhone，也不能上传 App Store Connect。

## 用 GitHub Actions 构建发布包

推送到 `codex/ios-1.1.6` 后，GitHub Actions 会自动运行 **Build iOS**。配置签名密钥后，再设置 `APPLE_DEVELOPMENT_TEAM` 并重新运行该工作流，即可导出供 App Store Connect 上传的 IPA。工作流进入 GitHub 默认分支后，也可以手动运行并勾选 `signed`。

- 变量 `APPLE_DEVELOPMENT_TEAM`：Apple 开发团队 ID。
- 密钥 `IOS_CERTIFICATE`、`IOS_CERTIFICATE_PASSWORD`：以 Base64 编码的 Apple Distribution `.p12`（含私钥）以及证书的密码。
- 密钥 `IOS_MOBILE_PROVISION`：以 Base64 编码的 App Store 分发描述文件，必须与证书和应用标识 `com.xiaoleng.tipsyisle` 匹配。

下载 Actions 构建产物，用 Apple Transporter 上传到 App Store Connect，再用于 TestFlight 或 App Store 审核。工作流不会提交审核、发布 App，也不会覆盖已发布的 Windows 或 Android 包。签名密钥只放入 GitHub Secrets 或本地钥匙串，不要提交到仓库。
