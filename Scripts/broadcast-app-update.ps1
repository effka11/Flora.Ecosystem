# Broadcast "app update" developer notification to Android clients only.
# Requires Flora:AdminBroadcastToken on API (see appsettings.Production.example.json / flora-api.env on VPS).
#
# Local:
#   .\Scripts\broadcast-app-update.ps1
#
# Production (after APK is on GitHub releases):
#   copy Scripts\broadcast.env.example -> Scripts\broadcast.env  (gitignored)
#   .\Scripts\setup-app-update-broadcast.ps1
#   .\Scripts\broadcast-app-update.ps1 -Production -Confirm
#
#   .\Scripts\broadcast-app-update.ps1 -ApiBaseUrl "https://origin.flora-s.net" -Token "<secret>"
#
# Env (or Scripts/broadcast.env):
#   FLORA_API_URL               - API base
#   FLORA_ADMIN_BROADCAST_TOKEN - must match Flora:AdminBroadcastToken / Flora__AdminBroadcastToken
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

if (-not $Force -and ($Confirm -or -not $isLocal)) {
    $versionPreview = Get-FloraSocialVersion $root
    Write-Host ""
    if ($isLocal) {
        Write-Host "Local broadcast" -ForegroundColor Cyan
    } else {
        Write-Host "Production broadcast" -ForegroundColor Yellow
    }
    Write-Host "  API:     $ApiBaseUrl"
    Write-Host "  Version: $versionPreview"
    Write-Host "  Text:    $(if ($Text) { $Text } else { "Новая версия Android - $versionPreview" })"
    Write-Host ""
    $answer = (Read-Host "Send to all Android clients? [y/N]").Trim().ToLowerInvariant()
    if ($answer -ne "y" -and $answer -ne "yes") {
        Write-Host "Cancelled."
        exit 0
    }
}

$version = Get-FloraSocialVersion $root
if ([string]::IsNullOrWhiteSpace($Text)) {
    $Text = "Новая версия Android - $version"
}

$uri = "$ApiBaseUrl/api/admin/notifications/broadcast"
$bodyJson = @{
    text     = $Text
    type     = "app_update"
    category = "developer"
    platform = "android"
} | ConvertTo-Json -Compress

Write-Host "POST $uri"
Write-Host "Text: $Text"

# Windows PowerShell 5.1 sends string bodies in the system ANSI code page; API expects UTF-8 JSON.
$bodyUtf8 = [System.Text.Encoding]::UTF8.GetBytes($bodyJson)

$headers = @{
    "X-Flora-Admin-Token" = $Token.Trim()
}

try {
    $response = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Body $bodyUtf8 -ContentType "application/json; charset=utf-8"
    $recipients = $response.recipients
    if ($null -eq $recipients) { $recipients = $response.Recipients }
    Write-Host "Broadcast sent to $recipients recipient(s)."
}
catch {
    $detail = $_.Exception.Message
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
        $detail = $_.ErrorDetails.Message
    }
    throw "Broadcast failed: $detail"
}
