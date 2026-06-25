# Preflight for production "app update" broadcast (Android release).
# Usage: .\Scripts\setup-app-update-broadcast.ps1
#        .\Scripts\setup-app-update-broadcast.ps1 -ApiBaseUrl "https://origin.flora-s.net"
#Requires -Version 5.1
param(
    [string] $ApiBaseUrl = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

. (Join-Path $PSScriptRoot "broadcast-env.ps1")

$resolved = Resolve-BroadcastConfig -Root $root -ApiBaseUrl $ApiBaseUrl -Production:$false
$apiUrl = $resolved.ApiBaseUrl
$token = $resolved.Token

Write-Host ""
Write-Host "Flora app-update broadcast (production)" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""

$ok = $true

if (Test-IsLocalBroadcastApiUrl $apiUrl) {
    Write-Host 'WARN: API URL is local' -ForegroundColor Yellow
    Write-Host "       $apiUrl — for prod use Scripts/broadcast.env or -ApiBaseUrl." -ForegroundColor Yellow
    $ok = $false
} else {
    Write-Host "[OK] API URL: $apiUrl" -ForegroundColor Green
}

if ([string]::IsNullOrWhiteSpace($token)) {
    $ok = $false
    Write-Host 'WARN: Missing FLORA_ADMIN_BROADCAST_TOKEN (Scripts/broadcast.env or env var)' -ForegroundColor Yellow
} else {
    Write-Host "[OK] Admin broadcast token configured locally" -ForegroundColor Green
}

$broadcastEnv = Join-Path $PSScriptRoot "broadcast.env"
if (Test-Path $broadcastEnv) {
    Write-Host "[OK] Scripts/broadcast.env" -ForegroundColor Green
} else {
    Write-Host "[--] Scripts/broadcast.env not found (optional if env vars are set)" -ForegroundColor DarkGray
}

$mobileEnv = Join-Path $root "Apps\Mobile\.env"
if (Test-Path $mobileEnv) {
    $mobileApi = Read-DotEnvValue $mobileEnv "EXPO_PUBLIC_API_URL"
    if ($mobileApi -and $mobileApi.TrimEnd("/") -ne $apiUrl.TrimEnd("/")) {
        Write-Host "WARN: Apps/Mobile/.env EXPO_PUBLIC_API_URL ($mobileApi) differs from broadcast API ($apiUrl)" -ForegroundColor Yellow
        $ok = $false
    } elseif ($mobileApi) {
        Write-Host "[OK] Apps/Mobile/.env API matches broadcast target" -ForegroundColor Green
    }
} else {
    Write-Host "[--] Apps/Mobile/.env missing (needed for release APK)" -ForegroundColor DarkGray
}

if (-not (Test-IsLocalBroadcastApiUrl $apiUrl)) {
    $probeUri = "$($apiUrl.TrimEnd('/'))/api/admin/notifications/broadcast"
    Write-Host ""
    Write-Host "Probing $probeUri ..."
    try {
        $null = Invoke-WebRequest -Method Post -Uri $probeUri `
            -Headers @{ "X-Flora-Admin-Token" = "flora-broadcast-probe" } `
            -Body "{}" -ContentType "application/json; charset=utf-8" `
            -UseBasicParsing -TimeoutSec 20 -ErrorAction Stop
        Write-Host 'WARN: Unexpected 2xx on probe (check API)' -ForegroundColor Yellow
    }
    catch {
        $status = $null
        if ($_.Exception.Response) {
            $status = [int]$_.Exception.Response.StatusCode
        }
        if ($status -eq 404) {
            $ok = $false
            Write-Host 'WARN: Broadcast disabled on API (404). Set Flora__AdminBroadcastToken on server and restart flora-api.' -ForegroundColor Yellow
        }
        elseif ($status -eq 401) {
            Write-Host "[OK] Broadcast endpoint enabled (401 on probe token)" -ForegroundColor Green
        }
        elseif ($status -eq 400) {
            Write-Host "[OK] Broadcast endpoint enabled (400 without text)" -ForegroundColor Green
        }
        else {
            $ok = $false
            Write-Host "WARN: Probe failed: HTTP $status - $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
}

Write-Host ""
Write-Host "Release order (recommended):" -ForegroundColor Cyan
Write-Host "  1. Bump VERSION, build APK (mobile-release-android.ps1)"
Write-Host "  2. Publish GitHub release with APK"
Write-Host "  3. Deploy API if backend changed"
Write-Host "  4. .\Scripts\broadcast-app-update.ps1 -Production -Confirm"
Write-Host ""

if ($ok) {
    Write-Host "Ready to broadcast after release is published." -ForegroundColor Green
}
else {
    Write-Host "Complete the items above before broadcasting to production users." -ForegroundColor Yellow
    exit 1
}
