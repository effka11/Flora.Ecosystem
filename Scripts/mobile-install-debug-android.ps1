#Requires -Version 5.1
<#
  Build + install Flora Dev (expo-dev-client) on USB device.
  Package: social.flora.mobile.dev — coexists with production Flora APK.

  Usage:
    .\Scripts\mobile-install-debug-android.ps1
    .\Scripts\mobile-install-debug-android.ps1 -ReplaceExisting
#>
param(
    [switch] $ReplaceExisting
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "mobile-android-env.ps1")

$root = Split-Path $PSScriptRoot -Parent
$mobile = Join-Path $root "Apps\Mobile"
$devPackage = Get-FloraAndroidPackageId development

if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
    throw "adb not found. Install Android SDK platform-tools and add to PATH."
}

& (Join-Path $PSScriptRoot "mobile-adb-reverse.ps1")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$serial = Get-AdbDeviceSerial
Ensure-MobileEnvFile $mobile
Initialize-FloraAndroidBuildEnv -MobileDir $mobile -RepoRoot $root | Out-Null
Ensure-FfmpegAndroid $root $mobile
$hadFrcINative = Test-FrcIAndroidNativePresent $root
Ensure-FrcIAndroidNative $root
$frcINativeJustBuilt = -not $hadFrcINative

$env:APP_VARIANT = "development"

$hasDevClient = Test-FloraDevClientInstalled

if ($hasDevClient -and -not $ReplaceExisting -and -not $frcINativeJustBuilt) {
    Write-Host "Flora Dev already installed on $serial ($devPackage). Skipping Gradle build."
    Write-Host "Reinstall: .\Scripts\mobile-install-debug-android.ps1 -ReplaceExisting"
    Write-Host "If FRI photos are blank, reinstall so libfrc_i_mobile_ffi.so is packaged into the APK."
    exit 0
}

if ($frcINativeJustBuilt -and $hasDevClient -and -not $ReplaceExisting) {
    Write-Host "FRC-I native was just built - reinstalling Flora Dev so .so is in the APK ..."
}

if (($ReplaceExisting -or $frcINativeJustBuilt) -and (Test-FloraPackageInstalled -Variant development)) {
    Write-Host "Removing existing Flora Dev ($devPackage) ..."
    Invoke-Adb uninstall $devPackage | Out-Null
}

Write-Host ""
Write-Host "================================================================"
Write-Host "  Building Flora Dev (debug dev-client APK)"
Write-Host "================================================================"
Write-Host "Device: $serial"
Write-Host "Package: $devPackage (production Flora APK is not touched)"
Write-Host "Metro: VS Code task Flora Android: debug (USB) or .\Scripts\mobile-debug-android.ps1"
Write-Host ""

$env:FLORA_ADB_SERIAL = $serial
$env:ANDROID_SERIAL = $serial
$env:CI = "1"

Push-Location $mobile
try {
    Write-Host "expo prebuild (android, development variant) ..."
    Invoke-ExpoAndroidPrebuildClean $mobile

    npx expo run:android --no-bundler
    if ($LASTEXITCODE -ne 0) {
        throw "expo run:android failed with exit code $LASTEXITCODE"
    }
}
finally {
    Remove-Item Env:APP_VARIANT -ErrorAction SilentlyContinue
    Pop-Location
}

if (-not (Test-FloraDevClientInstalled)) {
    throw "Install finished but Flora Dev not detected on device. Check Gradle output above."
}

Write-Host "Flora Dev installed. Next: VS Code task Flora Android: debug (USB) or .\Scripts\mobile-debug-android.ps1"
