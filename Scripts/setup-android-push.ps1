#Requires -Version 5.1
<#
  Push credentials for flora-api (Phase 5: no Flora.API/ tree).
  Puts service-account JSON under Backend/secrets/ and prints env hints.
#>
$ErrorActionPreference = "Stop"
$root = (Split-Path $PSScriptRoot -Parent | Resolve-Path).Path
$secretsDir = Join-Path $root "Backend\secrets"
New-Item -ItemType Directory -Force -Path $secretsDir | Out-Null

Write-Host @"
Android / FCM setup (Rust host):
  1. Place Firebase service-account JSON in: $secretsDir
  2. Set on flora-api:
       Push__Firebase__CredentialsPath=<path-to-json>
     or Push__Firebase__CredentialsJson=<inline-json>
  3. Restart flora-api (local: Scripts/run-rust-gateway-localhost.ps1; prod: systemd flora-api).
"@
