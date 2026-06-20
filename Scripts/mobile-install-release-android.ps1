# Install standalone production APK (replaces dev-client that needs Metro).
param(
    [string] $ApkPath = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$mobile = Join-Path $root "Apps\Mobile"

. (Join-Path $PSScriptRoot "mobile-flora-version.ps1")

$defaultApk = Get-FloraAndroidDistApkPath $mobile $root

if ([string]::IsNullOrWhiteSpace($ApkPath)) {
    $ApkPath = $defaultApk
}
if (-not (Test-Path -LiteralPath $ApkPath)) {
    throw "APK not found: $ApkPath`nRun first: cd Apps\Mobile && npm run build:android:release"
}

if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
    throw "adb not found. Add Android SDK platform-tools to PATH."
}

$devices = adb devices | Select-String "device$"
if (-not $devices) {
    throw "No Android device in adb devices. Enable USB debugging and approve the PC."
}

Write-Host "Removing dev-client build (if any) ..."
adb uninstall social.flora.mobile 2>$null | Out-Null

Write-Host "Installing standalone release APK ..."
adb install -r $ApkPath
if ($LASTEXITCODE -ne 0) { throw "adb install failed with exit code $LASTEXITCODE" }

Write-Host "Done. Open Flora on the phone (no Metro / PC required)."
Write-Host "Launch: adb shell am start -n social.flora.mobile/.MainActivity"
