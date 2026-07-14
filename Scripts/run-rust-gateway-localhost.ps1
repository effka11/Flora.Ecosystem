#Requires -Version 5.1
<#
  Rust flora-api gateway on :5290 — local parity with prod strangler.
  Upstream: Gateway:DotnetUpstream → http://127.0.0.1:5284 (Backend/appsettings.json).
  Music:ServeNative=true → native /api/music/* + workers.
  Auth:ServeNative=true → native sessions/logout/security/refresh/login (Фаза 2b срез).

  Requires: cargo on PATH, shared Jwt from ensure-shared-dev-jwt.ps1,
  .NET upstream already listening (or start soon after).
#>
$ErrorActionPreference = "Stop"
$root = (Split-Path $PSScriptRoot -Parent | Resolve-Path).Path
$configDir = Join-Path $root "Backend"

$secret = & (Join-Path $PSScriptRoot "ensure-shared-dev-jwt.ps1")
$env:ASPNETCORE_ENVIRONMENT = "Development"
$env:FLORA_ENVIRONMENT = "Development"
$env:FLORA_CONFIG_DIR = $configDir
$env:Jwt__Secret = $secret
$env:Music__ServeNative = "true"
$env:Auth__ServeNative = "true"
$env:Verification__ServeNative = "true"
$env:Verification__GrpcListen = "127.0.0.1:50051"
# Local listen/upstream already in Backend/appsettings.json; env can override:
if (-not $env:Gateway__Listen) { $env:Gateway__Listen = "127.0.0.1:5290" }
if (-not $env:Gateway__DotnetUpstream) { $env:Gateway__DotnetUpstream = "http://127.0.0.1:5284" }

Write-Host @"
Flora gateway (Rust) -> http://127.0.0.1:5290
  config: $configDir
  upstream: $($env:Gateway__DotnetUpstream)
  Music + Auth (sessions/logout/security/refresh/login) + Verification ServeNative (gRPC :50051), shared Jwt
"@

Set-Location $root
cargo run -p flora-api
