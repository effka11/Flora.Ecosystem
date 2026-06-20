# Flora Web — local dev against already-running Flora.API on :5284.
# Does NOT stop/restart API or Metro (only frees Next.js ports 3000/3001).

$ErrorActionPreference = "Stop"

$repoRoot = (Join-Path $PSScriptRoot "..") | Resolve-Path
$webRoot = (Join-Path $repoRoot "Apps\Web") | Resolve-Path

& (Join-Path $repoRoot "Scripts\ensure-api-localhost.ps1")
& (Join-Path $repoRoot "Scripts\stop-dev-localhost.ps1") -Web

$env:FLORA_API_UPSTREAM = "http://127.0.0.1:5284"

Write-Host @"

================================================================
  Flora Web -> http://localhost:3000
  API proxy -> $env:FLORA_API_UPSTREAM (keep API terminal running)
================================================================

"@

Set-Location $webRoot
npm run dev
