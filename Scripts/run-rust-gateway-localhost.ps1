#Requires -Version 5.1
<#
  Rust flora-api on :5290 — sole local API host (Phase 5: .NET removed).

  Requires: cargo on PATH, shared Jwt from ensure-shared-dev-jwt.ps1,
  franking seed from ensure-franking-signing-seed.ps1 (Local/.flora),
  PostgreSQL (docker compose), Backend/appsettings.json.
#>
$ErrorActionPreference = "Stop"
$root = (Split-Path $PSScriptRoot -Parent | Resolve-Path).Path
$configDir = Join-Path $root "Backend"

$secret = & (Join-Path $PSScriptRoot "ensure-shared-dev-jwt.ps1")
$frankingSeed = & (Join-Path $PSScriptRoot "ensure-franking-signing-seed.ps1")
$env:ASPNETCORE_ENVIRONMENT = "Development"
$env:FLORA_ENVIRONMENT = "Development"
$env:FLORA_CONFIG_DIR = $configDir
$env:Jwt__Secret = $secret
$env:Messaging__FrankingSigningSeed = $frankingSeed
$env:Music__ServeNative = "true"
$env:Auth__ServeNative = "true"
$env:Users__ServeNative = "true"
$env:Content__ServeNative = "true"
$env:Messaging__ServeNative = "true"
$env:ChatOrganizer__ServeNative = "true"
$env:Notifications__ServeNative = "true"
$env:Verification__ServeNative = "true"
$env:Verification__GrpcListen = "127.0.0.1:50051"
if (-not $env:Gateway__Listen) { $env:Gateway__Listen = "127.0.0.1:5290" }
# Phase 5: no .NET fallback
$env:Gateway__DotnetUpstream = ""

Write-Host @"
Flora API (Rust) -> http://127.0.0.1:5290
  config: $configDir
  Music + Auth + Users + Content + Messaging + ChatOrganizer + Notifications + Verification ServeNative (gRPC :50051)
"@

Set-Location $root
cargo run -p flora-api
