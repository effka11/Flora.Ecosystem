# Ensures Android SDK path for Gradle (local.properties).

$ErrorActionPreference = "Stop"

function Test-AndroidSdkPath([string]$path) {
    if ([string]::IsNullOrWhiteSpace($path)) { return $false }
    if ($path.Length -lt 4) { return $false }
    return Test-Path (Join-Path $path "platform-tools")
}

$candidates = @(
    $env:ANDROID_HOME,
    $env:ANDROID_SDK_ROOT,
    (Join-Path $env:LOCALAPPDATA "Android\Sdk"),
    "$env:USERPROFILE\AppData\Local\Android\Sdk"
) | Where-Object { Test-AndroidSdkPath $_ } | Select-Object -Unique

if ($candidates.Count -eq 0) {
    throw "Android SDK not found. Install Android Studio SDK to $env:LOCALAPPDATA\Android\Sdk"
}

$sdk = $candidates[0]
$gradleSdk = $sdk -replace '\\', '/'
$localProps = Join-Path $PSScriptRoot "..\Apps\Mobile\android\local.properties"
Set-Content -Path $localProps -Value "sdk.dir=$gradleSdk" -Encoding ascii
Write-Host "Android SDK: $sdk"
Write-Host "Wrote $localProps"
