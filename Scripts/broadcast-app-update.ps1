# Broadcast "app update" developer notification to Android clients only.
# Requires Flora:AdminBroadcastToken in API config (see appsettings.Local.example.json).
#
# Usage:
#   .\Scripts\broadcast-app-update.ps1
#   .\Scripts\broadcast-app-update.ps1 -ApiBaseUrl "https://origin.flora-s.net"
#   .\Scripts\broadcast-app-update.ps1 -Text "Novaya versiya Android - 0.2.0-alpha"
#
# Env:
#   FLORA_API_URL               - API base (default http://localhost:5284)
#   FLORA_ADMIN_BROADCAST_TOKEN - admin token (must match Flora:AdminBroadcastToken)
param(
    [string] $ApiBaseUrl = "",
    [string] $Token = "",
    [string] $Text = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

$localhostDefaultToken = "dev-local-broadcast-token-change-me"

. (Join-Path $PSScriptRoot "mobile-flora-version.ps1")

if ([string]::IsNullOrWhiteSpace($ApiBaseUrl)) {
    $ApiBaseUrl = $env:FLORA_API_URL
}
if ([string]::IsNullOrWhiteSpace($ApiBaseUrl)) {
    $ApiBaseUrl = "http://localhost:5284"
}
$ApiBaseUrl = $ApiBaseUrl.Trim().TrimEnd("/")

if ([string]::IsNullOrWhiteSpace($Token)) {
    $Token = $env:FLORA_ADMIN_BROADCAST_TOKEN
}
if ([string]::IsNullOrWhiteSpace($Token) -and $ApiBaseUrl -match '^https?://(localhost|127\.0\.0\.1)(:\d+)?$') {
    $Token = $localhostDefaultToken
    Write-Host "Using localhost default admin broadcast token (see Flora.API/appsettings.Development.json)." -ForegroundColor DarkGray
}
if ([string]::IsNullOrWhiteSpace($Token)) {
    throw "Admin token required: pass -Token or set FLORA_ADMIN_BROADCAST_TOKEN (must match Flora:AdminBroadcastToken on API)."
}

$version = Get-FloraSocialVersion $root
if ([string]::IsNullOrWhiteSpace($Text)) {
    # UTF-8 base64: "Novaya versiya Android"
    $prefix = [System.Text.Encoding]::UTF8.GetString(
        [Convert]::FromBase64String('0J3QvtCy0LDRjyDQstC10YDRgdC40Y8gQW5kcm9pZA=='))
    $Text = "$prefix - $version"
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
