# Generates gitignored prod files with random secrets (run once per machine / after clone).
# Does not print secrets to the console.
param(
    [Parameter(Mandatory = $true)][string] $ServerHost,
    [string] $SmtpHost = "",
    [string] $SmtpUser = "",
    [string[]] $CorsOrigins = @()
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($SmtpHost)) { $SmtpHost = $ServerHost }
if ([string]::IsNullOrWhiteSpace($SmtpUser)) { $SmtpUser = "no-reply@$ServerHost" }
if (-not $CorsOrigins -or $CorsOrigins.Count -eq 0) { $CorsOrigins = @("https://$ServerHost") }
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

function New-HexSecret([int]$byteCount) {
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $buf = New-Object byte[] $byteCount
  $rng.GetBytes($buf)
  return (-join ($buf | ForEach-Object { $_.ToString("x2") }))
}

$dbPass = New-HexSecret 20
$jwtSecret = New-HexSecret 32
$smtpPass = New-HexSecret 16
$broadcastToken = New-HexSecret 32

$dbConn = "Host=$ServerHost;Port=5432;Database=flora_social;Username=flora;Password=$dbPass;Include Error Detail=false;Search Path=flora_core;SSL Mode=Require"

$apiPath = Join-Path $repo "Flora.API\appsettings.Production.json"
$doc = [ordered]@{
  Logging          = @{
    LogLevel = @{
      Default                 = "Information"
      "Microsoft.AspNetCore" = "Warning"
    }
  }
  AllowedHosts     = "*"
  ConnectionStrings = @{
    FloraDatabase = $dbConn
  }
  Jwt              = @{
    Issuer             = "Flora.Auth"
    Audience           = "Flora.Ecosystem"
    Secret             = $jwtSecret
    AccessTokenMinutes = 15
    RefreshTokenDays   = 7
  }
  FeedRecommendation = @{
    EnableCache   = $true
    CacheSeconds  = 120
  }
  Smtp             = @{
    Host       = $SmtpHost
    Port       = 587
    Username   = $SmtpUser
    Password   = $smtpPass
    FromEmail  = $SmtpUser
    FromName   = "Flora"
    EnableSsl  = $true
  }
  FloraWeb         = @{
    CorsOrigins = $CorsOrigins
  }
  Flora            = @{
    AdminBroadcastToken = $broadcastToken
  }
}

$json = ($doc | ConvertTo-Json -Depth 12)
[System.IO.File]::WriteAllText($apiPath, $json)

$broadcastEnvPath = Join-Path $repo "Scripts\broadcast.env"
$broadcastEnv = @(
  "# Generated with appsettings.Production.json — same AdminBroadcastToken"
  "FLORA_API_URL=https://origin.$ServerHost"
  "FLORA_ADMIN_BROADCAST_TOKEN=$broadcastToken"
) -join "`r`n"
[System.IO.File]::WriteAllText($broadcastEnvPath, $broadcastEnv + "`r`n")

$webPath = Join-Path $repo "Apps\Web\.env.production.local"
$web = @(
  "FLORA_API_UPSTREAM=http://${ServerHost}:5284"
  "NODE_ENV=production"
) -join "`r`n"
[System.IO.File]::WriteAllText($webPath, $web + "`r`n")

Write-Host "OK: wrote Flora.API/appsettings.Production.json, Scripts/broadcast.env, and Apps/Web/.env.production.local (secrets not printed)."
Write-Host "On VPS add to /etc/flora-ecosystem/flora-api.env:"
Write-Host "  Flora__AdminBroadcastToken=<same as Scripts/broadcast.env>"
