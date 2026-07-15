# Flora Web — local dev against Rust gateway :5290 (prod strangler parity).
# Does NOT stop/restart API or Metro (only frees Next.js ports 3000/3001).
# Upstream .NET stays on :5284; Music native + workers on the gateway.

$ErrorActionPreference = "Stop"

$repoRoot = (Join-Path $PSScriptRoot "..") | Resolve-Path
$webRoot = (Join-Path $repoRoot "Apps\Web") | Resolve-Path

& (Join-Path $repoRoot "Scripts\ensure-api-localhost.ps1")
& (Join-Path $repoRoot "Scripts\stop-dev-localhost.ps1") -Web

$env:FLORA_API_UPSTREAM = "http://127.0.0.1:5290"

Write-Host @"

================================================================
  Flora Web -> http://localhost:3000
  API proxy -> $env:FLORA_API_UPSTREAM (Rust gateway; .NET upstream :5284)
================================================================

"@

Set-Location $webRoot
npm run dev
