# Flora — local web against Rust flora-api :5290 (prod parity).
# Does NOT stop/restart API or Metro (only frees Next.js ports 3000/3001).

$ErrorActionPreference = "Stop"

$repoRoot = (Join-Path $PSScriptRoot "..") | Resolve-Path
$webRoot = (Join-Path $repoRoot "Apps\Web") | Resolve-Path

& (Join-Path $repoRoot "Scripts\ensure-api-localhost.ps1")
& (Join-Path $repoRoot "Scripts\stop-dev-localhost.ps1") -Web

$env:FLORA_API_UPSTREAM = "http://127.0.0.1:5290"

Write-Host @"

================================================================
  Flora -> http://localhost:3000
  API proxy -> $env:FLORA_API_UPSTREAM (Rust flora-api)
================================================================

"@

Set-Location $webRoot
npm run dev
