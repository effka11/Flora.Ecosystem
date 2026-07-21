# Broadcast sideload "app_update" to all Android clients (inbox + data-only HIGH FCM).
# Same payload as the one-user smoke: update{version,versionCode,apkUrl,sha256,sizeBytes}.
#
# Requires Flora:AdminBroadcastToken on API (flora-api.env on VPS).
#
# Local:
#   .\Scripts\broadcast-app-update.ps1
#
# Production (after APK is on GitHub releases + flora-api with send_app_update_push):
#   .\Scripts\setup-app-update-broadcast.ps1
#   .\Scripts\broadcast-app-update.ps1 -Production -Confirm
#
# Env (or Scripts/broadcast.env):
#   FLORA_API_URL               - API base
#   FLORA_ADMIN_BROADCAST_TOKEN - must match Flora__AdminBroadcastToken
param(
    [string] $ApiBaseUrl = "",
    [string] $Token = "",
    [string] $Text = "",
    [switch] $Production,
    [switch] $Confirm,
    [switch] $Force
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

. (Join-Path $PSScriptRoot "broadcast-env.ps1")
. (Join-Path $PSScriptRoot "mobile-flora-version.ps1")

$config = Resolve-BroadcastConfig -Root $root -ApiBaseUrl $ApiBaseUrl -Token $Token -Production:$Production
$ApiBaseUrl = $config.ApiBaseUrl
$Token = $config.Token

if ([string]::IsNullOrWhiteSpace($Token)) {
    throw @"
Admin token required.
  Prod: copy Scripts/broadcast.env.example -> Scripts/broadcast.env and set FLORA_ADMIN_BROADCAST_TOKEN
        (same value as Flora__AdminBroadcastToken in /etc/flora-ecosystem/flora-api.env on VPS).
  Local: pass -Token or use dev token in appsettings.Development.json.
"@
}

$isLocal = Test-IsLocalBroadcastApiUrl $ApiBaseUrl
if ($isLocal -and $Token -eq "dev-local-broadcast-token-change-me") {
    Write-Host "Using localhost default admin broadcast token (see Flora.API/appsettings.Development.json)." -ForegroundColor DarkGray
}

$version = Get-FloraSocialVersion $root
if ([string]::IsNullOrWhiteSpace($Text)) {
    $Text = Get-AppUpdateBroadcastText $version
}

# Production (and any non-local API): require GitHub/dist manifest - same wire as one-user FCM.
$requireUpdate = $Production -or (-not $isLocal)
$manifest = Get-AppUpdateManifestForBroadcast -Root $root -Version $version -PreferGitHub:$requireUpdate
if ($null -eq $manifest) {
    if ($requireUpdate) {
        throw @"
No flora.social-android-update.json for VERSION.products.social=$version.
Publish GitHub release social/v$version (APK), keep matching
Apps/Mobile/dist/flora.social-android-update.json for this broadcast, then retry.
"@
    }
}
elseif (([string]$manifest.version).Trim() -ne $version) {
    throw "Update manifest version='$($manifest.version)' does not match VERSION.products.social='$version'."
}

$update = $null
if ($null -ne $manifest) {
    $update = @{
        version     = [string]$manifest.version
        versionCode = [int64]$manifest.versionCode
        apkUrl      = [string]$manifest.apkUrl
        sha256      = ([string]$manifest.sha256).ToLowerInvariant()
    }
    if ($null -ne $manifest.sizeBytes -and [int64]$manifest.sizeBytes -gt 0) {
        $update.sizeBytes = [int64]$manifest.sizeBytes
    }
}

if (-not $Force -and ($Confirm -or -not $isLocal)) {
    Write-Host ""
    if ($isLocal) {
        Write-Host "Local broadcast (sideload Android)" -ForegroundColor Cyan
    } else {
        Write-Host "Production broadcast (sideload Android)" -ForegroundColor Yellow
    }
    Write-Host "  API:         $ApiBaseUrl"
    Write-Host "  Audience:    active users with Android client/push token"
    Write-Host "  Type:        app_update (inbox + data-only HIGH FCM, no system tray)"
    Write-Host "  Text:        $Text"
    if ($null -ne $update) {
        Write-Host "  version:     $($update.version)"
        Write-Host "  versionCode: $($update.versionCode)"
        Write-Host "  apkUrl:      $($update.apkUrl)"
        Write-Host "  sha256:      $($update.sha256.Substring(0, 12))..."
        if ($update.ContainsKey("sizeBytes")) {
            Write-Host "  sizeBytes:   $($update.sizeBytes)"
        }
    } else {
        Write-Host "  update:      (none - local only)" -ForegroundColor DarkYellow
    }
    Write-Host ""
    $answer = (Read-Host "Send to all Android sideload clients? [y/N]").Trim().ToLowerInvariant()
    if ($answer -ne "y" -and $answer -ne "yes") {
        Write-Host "Cancelled."
        exit 0
    }
}

$uri = "$ApiBaseUrl/api/admin/notifications/broadcast"
$body = @{
    text     = $Text
    type     = "app_update"
    category = "developer"
    platform = "android"
}
if ($null -ne $update) {
    $body.update = $update
}

$bodyJson = $body | ConvertTo-Json -Compress -Depth 5

Write-Host "POST $uri"
Write-Host "Text: $Text"
if ($null -ne $update) {
    Write-Host "Including update metadata versionCode=$($update.versionCode)" -ForegroundColor DarkGray
}

# Windows PowerShell 5.1: send UTF-8 bytes (not a .NET string body).
$bodyUtf8 = [System.Text.Encoding]::UTF8.GetBytes($bodyJson)

$headers = @{
    "X-Flora-Admin-Token" = $Token.Trim()
}

try {
    $response = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Body $bodyUtf8 -ContentType "application/json; charset=utf-8"
    $recipients = $response.recipients
    if ($null -eq $recipients) { $recipients = $response.Recipients }
    Write-Host "Broadcast sent to $recipients recipient(s)."
    Write-Host "Each recipient: inbox app_update + data-only FCM (native download/install)." -ForegroundColor DarkGray
}
catch {
    $detail = $_.Exception.Message
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
        $detail = $_.ErrorDetails.Message
    }
    throw "Broadcast failed: $detail"
}
