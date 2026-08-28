# Flora Gov — Next standalone to VPS (:3001). Does not deploy Social or flora-api.
# nginx gov vhost is created by Apps/Web remote-bootstrap (already on the VPS).
# Usage:
#   .\Scripts\deploy-flora-gov.ps1
#   .\Scripts\deploy-flora-gov.ps1 -SkipBuild
param(
    [string] $Server = "",
    [string] $User = "root",
    [string] $IdentityFile = "",
    [string] $Domain = "flora-s.net",
    [string] $ApiUpstreamUrl = "http://127.0.0.1:5290",
    [switch] $SkipBuild
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$govScript = Join-Path $RepoRoot "Apps\Gov\scripts\deploy.ps1"
if (-not (Test-Path -LiteralPath $govScript)) { throw "Missing $govScript" }

$params = @{
    Server         = $Server
    User           = $User
    IdentityFile   = $IdentityFile
    Domain         = $Domain
    ApiUpstreamUrl = $ApiUpstreamUrl
}
if ($SkipBuild) { $params.SkipBuild = $true }

Write-Host "================================================================"
Write-Host "  Flora Gov -> VPS  Next :3001"
Write-Host "================================================================"

& $govScript @params
if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) {
    throw "Apps/Gov/scripts/deploy.ps1 failed (exit $LASTEXITCODE)."
}
