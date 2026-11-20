param([ValidateSet('init','build','dev','native','package')][string]$Action = 'build')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$tools = Join-Path $projectRoot '.runtime\android-tools'
if (Test-Path -LiteralPath "$tools\cargo\bin\cargo.exe") {
    $env:CARGO_HOME = "$tools\cargo"
    $env:RUSTUP_HOME = "$tools\rustup"
    $env:PATH = "$tools\cargo\bin;$env:PATH"
}
if (Test-Path -LiteralPath "$tools\sdk") { $env:ANDROID_HOME = "$tools\sdk" }
if (!$env:ANDROID_HOME) { throw '请先安装 Android SDK 并配置 ANDROID_HOME' }
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:NDK_HOME = "$env:ANDROID_HOME\ndk\28.2.13676358"
if (!(Test-Path -LiteralPath $env:NDK_HOME)) { throw '请安装 Android NDK 28.2.13676358' }
if (Test-Path -LiteralPath 'D:\jdk-21.0.6+7\bin\java.exe') { $env:JAVA_HOME = 'D:\jdk-21.0.6+7' }
$env:PATH = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:PATH"
$env:TEMP = Join-Path $projectRoot '.runtime\build-temp'
$env:TMP = $env:TEMP
$env:GRADLE_USER_HOME = Join-Path $tools 'gradle'
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
$javaTemporary = $env:TEMP.Replace('\','/')
$env:JAVA_TOOL_OPTIONS = "-Djava.net.preferIPv4Stack=true -Djdk.net.unixdomain.tmpdir=$javaTemporary -Djava.io.tmpdir=$javaTemporary"
# The current machine has an existing MSVC/Windows SDK installation outside the default directory.
$vc = 'D:\vs\VC\Tools\MSVC\14.33.31629'
$sdk = 'D:\Windows Kits\10'
if (Test-Path -LiteralPath "$vc\bin\Hostx64\x64\link.exe") {
    $env:PATH = "$vc\bin\Hostx64\x64;$sdk\bin\10.0.19041.0\x64;$env:PATH"
    $env:INCLUDE = "$vc\include;$sdk\Include\10.0.19041.0\ucrt;$sdk\Include\10.0.19041.0\shared;$sdk\Include\10.0.19041.0\um"
    $env:LIB = "$vc\lib\x64;$sdk\Lib\10.0.19041.0\ucrt\x64;$sdk\Lib\10.0.19041.0\um\x64"
}
if ($Action -eq 'init') {
    & node node_modules/@tauri-apps/cli/tauri.js android init --ci --skip-targets-install
    exit $LASTEXITCODE
}
if ($Action -eq 'dev') {
    & node node_modules/@tauri-apps/cli/tauri.js android dev --target aarch64
    exit $LASTEXITCODE
}
if ($Action -in @('build', 'package') -and !(Test-Path -LiteralPath 'src-tauri/gen/android/keystore.properties' -PathType Leaf)) {
    throw '发布 APK 需要在 src-tauri/gen/android/keystore.properties 配置签名。仅开发时请使用 npm run android:dev。'
}
if ($Action -eq 'build') {
    & npm.cmd run typecheck
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
if ($Action -ne 'package') {
    $llvm = "$env:NDK_HOME\toolchains\llvm\prebuilt\windows-x86_64\bin"
    $env:CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER = "$llvm\aarch64-linux-android26-clang.cmd"
    $env:CC_aarch64_linux_android = "$llvm\aarch64-linux-android26-clang.cmd"
    $env:AR_aarch64_linux_android = "$llvm\llvm-ar.exe"
    $env:WRY_ANDROID_PACKAGE = 'com.xiaoleng.tipsyisle'
    $env:WRY_ANDROID_LIBRARY = 'tipsy_isle_lib'
    $env:TAURI_ANDROID_PACKAGE_UNESCAPED = 'com.xiaoleng.tipsyisle'
    $env:TAURI_ANDROID_PROJECT_PATH = "$projectRoot\src-tauri\gen\android"
    $env:WRY_ANDROID_KOTLIN_FILES_OUT_DIR = "$env:TAURI_ANDROID_PROJECT_PATH\app\src\main\java\com\xiaoleng\tipsyisle\generated"
    & cargo build --manifest-path src-tauri/Cargo.toml --target aarch64-linux-android --release --lib --features custom-protocol --locked
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
if ($Action -eq 'native') { exit 0 }
# Ordinary file copy supports Windows without symbolic-link privileges.
$destination = "$projectRoot\src-tauri\gen\android\app\src\main\jniLibs\arm64-v8a"
New-Item -ItemType Directory -Force -Path $destination | Out-Null
Copy-Item -LiteralPath "$projectRoot\src-tauri\target\aarch64-linux-android\release\libtipsy_isle_lib.so" -Destination "$destination\libtipsy_isle_lib.so" -Force
& "$projectRoot\src-tauri\gen\android\gradlew.bat" -p "$projectRoot\src-tauri\gen\android" :app:assembleArm64Release -x :app:rustBuildArm64Release -PtargetList=aarch64 -ParchList=arm64 -PabiList=arm64-v8a --console=plain --no-daemon
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$apk = "$projectRoot\src-tauri\gen\android\app\build\outputs\apk\arm64\release\app-arm64-release.apk"
New-Item -ItemType Directory -Force -Path "$projectRoot\releases" | Out-Null
Copy-Item -LiteralPath $apk -Destination "$projectRoot\releases\TipsyIsle-1.0.0-android-arm64.apk" -Force
Write-Output 'APK: releases\TipsyIsle-1.0.0-android-arm64.apk'
