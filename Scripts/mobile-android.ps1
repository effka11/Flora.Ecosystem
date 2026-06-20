# Android dev client: build + install + start Metro (interactive dev loop).
# For VS Code / CI use mobile-debug-android.ps1 (one-shot) instead.

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "mobile-android-env.ps1")

$root = Split-Path $PSScriptRoot -Parent
$mobile = Join-Path $root "Apps\Mobile"

Ensure-MobileEnvFile $mobile
Initialize-FloraAndroidBuildEnv -MobileDir $mobile -RepoRoot $root | Out-Null
Ensure-FfmpegAndroid $root $mobile

Push-Location $mobile
try {
    $env:CI = "1"
    npm run android
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
    Pop-Location
}
