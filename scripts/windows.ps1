param([ValidateSet('build','dev','package')][string]$Action = 'build')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
# Reuse the Rust toolchain already installed for the mobile build on this machine.
$tools = Join-Path $projectRoot '.runtime/android-tools'
if (Test-Path -LiteralPath "$tools/cargo/bin/cargo.exe") {
    $env:CARGO_HOME = "$tools/cargo"
    $env:RUSTUP_HOME = "$tools/rustup"
    $env:PATH = "$tools/cargo/bin;$env:PATH"
}
$env:TEMP = Join-Path $projectRoot '.runtime/build-temp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
# The current Windows builder uses a non-default MSVC installation.
# Standard Visual Studio installations are discovered by the Rust toolchain.
$vc = 'D:/vs/VC/Tools/MSVC/14.33.31629'
$sdk = 'D:/Windows Kits/10'
if (Test-Path -LiteralPath "$vc/bin/Hostx64/x64/link.exe") {
    $env:PATH = "$vc/bin/Hostx64/x64;$sdk/bin/10.0.19041.0/x64;$env:PATH"
    $env:INCLUDE = "$vc/include;$sdk/Include/10.0.19041.0/ucrt;$sdk/Include/10.0.19041.0/shared;$sdk/Include/10.0.19041.0/um"
    $env:LIB = "$vc/lib/x64;$sdk/Lib/10.0.19041.0/ucrt/x64;$sdk/Lib/10.0.19041.0/um/x64"
}
if ($Action -eq 'dev') {
    & node node_modules/@tauri-apps/cli/tauri.js dev
    exit $LASTEXITCODE
}
if ($Action -eq 'package') {
    & node node_modules/@tauri-apps/cli/tauri.js bundle --target x86_64-pc-windows-msvc --bundles nsis --ci
} else {
    & npm.cmd run typecheck
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & node node_modules/@tauri-apps/cli/tauri.js build --target x86_64-pc-windows-msvc --bundles nsis --ci -- --locked
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$version = (Get-Content -Raw -LiteralPath "$projectRoot/package.json" | ConvertFrom-Json).version
$installer = "$projectRoot/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/TipsyIsle_${version}_x64-setup.exe"
$release = "$projectRoot/releases/TipsyIsle-${version}-windows-x64-setup.exe"
New-Item -ItemType Directory -Force -Path "$projectRoot/releases" | Out-Null
Copy-Item -LiteralPath $installer -Destination $release -Force
Write-Output "Installer: $release"
