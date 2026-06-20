# Flora Android — USB Metro dev-client (adb reverse 8081 + 5284).
# PowerShell 5.1 safe: no && in strings.
# USB: app loads JS from http://127.0.0.1:8081 via adb reverse (not Wi-Fi LAN IP).
# Full stack (DB + API + install + Metro): mobile-debug-android.ps1

param(
    [switch] $ReplaceExistingDev
)

$ErrorActionPreference = "Stop"

function Require-Node {
    $versionText = (node -v 2>$null) -replace '^v', ''
    if (-not $versionText) {
        throw "Node.js not found. Expo SDK 56 requires Node >= 20.19.4. Run: nodist global 20.19.4"
    }
    $required = [Version]"20.19.4"
    try {
        $current = [Version]$versionText
    } catch {
        throw "Cannot parse Node version: $versionText"
    }
    if ($current -lt $required) {
        throw @"
Node.js $versionText is too old for Expo SDK 56 (need >= 20.19.4).
Fix: nodist global 20.19.4
Then: npm run debug:android:usb
"@
    }
}

function Require-Adb {
    if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
        throw "adb not found. Install Android SDK platform-tools and add to PATH."
    }
}

function Start-OpenFloraWhenMetroReady {
    Start-Job -ScriptBlock {
        for ($i = 0; $i -lt 90; $i++) {
            try {
                $response = Invoke-WebRequest -Uri "http://127.0.0.1:8081/status" -UseBasicParsing -TimeoutSec 2
                if ($response.Content -match "running") { break }
            } catch {
                Start-Sleep -Seconds 1
                continue
            }
            Start-Sleep -Seconds 1
        }
        $metroUrl = [uri]::EscapeDataString("http://127.0.0.1:8081")
        $deepLink = "exp+flora-mobile://expo-development-client/?url=$metroUrl"
        adb shell am start -a android.intent.action.VIEW -d $deepLink | Out-Null
    } | Out-Null
}

Require-Node
Require-Adb

. (Join-Path $PSScriptRoot "mobile-android-env.ps1")

if (-not (Test-FloraDevClientInstalled) -or $ReplaceExistingDev) {
    if ($ReplaceExistingDev) {
        Write-Host "Reinstalling Flora Dev (-ReplaceExistingDev) ..."
    } else {
        Write-Host "Dev-client not on device - building and installing debug APK (first run can take several minutes) ..."
    }
    $installArgs = @()
    if ($ReplaceExistingDev) { $installArgs += "-ReplaceExisting" }
    & (Join-Path $PSScriptRoot "mobile-install-debug-android.ps1") @installArgs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

& (Join-Path $PSScriptRoot "mobile-adb-reverse.ps1")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$mobileRoot = Join-Path $PSScriptRoot "..\Apps\Mobile" | Resolve-Path
$envFile = Join-Path $mobileRoot ".env"
$envExample = Join-Path $mobileRoot ".env.example"
if (-not (Test-Path $envFile) -and (Test-Path $envExample)) {
    Copy-Item $envExample $envFile
    Write-Host "Created Apps/Mobile/.env"
}

# Metro must listen on IPv4. --localhost on Windows binds [::1] only and breaks adb reverse.
$env:REACT_NATIVE_PACKAGER_HOSTNAME = "127.0.0.1"
$env:EXPO_DEV_SERVER_LISTEN_ADDRESS = "127.0.0.1"
# Avoid hanging manifest requests on expo.dev schema fetch (shows as infinite Connecting...).
$env:EXPO_OFFLINE = "1"

Start-OpenFloraWhenMetroReady

Write-Host ""
Write-Host "================================================================"
Write-Host "  PHONE ERRORS (RedBox / JS) -> THIS TERMINAL (Metro), not API"
Write-Host "================================================================"
Write-Host "Metro: 127.0.0.1:8081 (USB / adb reverse). API logs are in dotnet terminal."
Write-Host "Flora Dev opens on the phone when Metro is ready. If stuck: shake -> Reload."
Write-Host ""

Set-Location $mobileRoot
npx expo start --dev-client --port 8081
