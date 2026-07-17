# Flora Social — full VPS publish (Rust flora-api + Next web).
# Usage:
#   .\Scripts\deploy-flora-social.ps1
#   .\Scripts\deploy-flora-social.ps1 -SkipBuild
#   .\Scripts\deploy-flora-social.ps1 -SkipApi
#   .\Scripts\deploy-flora-social.ps1 -SkipWeb
#   .\Scripts\deploy-flora-social.ps1 -ApiBuildMode Wsl
#
# Prompts once for host/SSH key (or FLORA_DEPLOY_HOST / FLORA_SSH_KEY), then:
#   1) Scripts/deploy-flora-api.ps1
#   2) Apps/Web/scripts/deploy.ps1
param(
    [string] $Server = "",
    [string] $User = "root",
    [string] $IdentityFile = "",
    [string] $Domain = "flora-s.net",
    [string] $PublicSubdomain = "social",
    [string] $ApiUpstreamUrl = "http://127.0.0.1:5290",
    [string] $PublicApiBaseUrl = "",
    [string] $CertbotEmail = "",
    [string] $AllowedClientIps = "",
    [ValidateSet("Auto", "Wsl", "Remote", "Local", "Binary")]
    [string] $ApiBuildMode = "Auto",
    [string] $ApiBinaryPath = "",
    [switch] $SkipBuild,
    [switch] $SkipApi,
    [switch] $SkipWeb
)

$ErrorActionPreference = "Stop"

function Resolve-FloraSshKeyPath {
    param([string] $RawPath)
    $path = $RawPath.Trim().Trim('"')
    if ([string]::IsNullOrWhiteSpace($path)) { return "" }
    if ($path.StartsWith("~")) {
        $path = Join-Path $env:USERPROFILE $path.Substring(1).TrimStart("\", "/")
    }
    return $path
}

if ([string]::IsNullOrWhiteSpace($Server)) {
    $Server = $env:FLORA_DEPLOY_HOST
}
if ([string]::IsNullOrWhiteSpace($Server)) {
    $Server = (Read-Host "VPS IP or hostname").Trim()
}
if ([string]::IsNullOrWhiteSpace($Server)) {
    throw "Server host required: pass -Server <host>, set FLORA_DEPLOY_HOST, or enter at prompt."
}

if ([string]::IsNullOrWhiteSpace($IdentityFile)) {
    $IdentityFile = $env:FLORA_SSH_KEY
}
if ([string]::IsNullOrWhiteSpace($IdentityFile)) {
    $defaultKey = Join-Path $env:USERPROFILE ".ssh\id_ed25519_flora"
    $hint = if (Test-Path -LiteralPath $defaultKey) { " [Enter = $defaultKey]" } else { "" }
    $IdentityFile = Resolve-FloraSshKeyPath (Read-Host "Path to SSH private key$hint")
    if ([string]::IsNullOrWhiteSpace($IdentityFile) -and (Test-Path -LiteralPath $defaultKey)) {
        $IdentityFile = $defaultKey
    }
} else {
    $IdentityFile = Resolve-FloraSshKeyPath $IdentityFile
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$apiScript = Join-Path $RepoRoot "Scripts\deploy-flora-api.ps1"
$webScript = Join-Path $RepoRoot "Apps\Web\scripts\deploy.ps1"

if (-not (Test-Path -LiteralPath $apiScript)) { throw "Missing $apiScript" }
if (-not (Test-Path -LiteralPath $webScript)) { throw "Missing $webScript" }

Write-Host "================================================================"
Write-Host "  Flora Social -> VPS  ${User}@${Server}"
Write-Host "  API :5290 + Web (Next standalone)"
Write-Host "================================================================"

$shared = @{
    Server       = $Server
    User         = $User
    IdentityFile = $IdentityFile
}
if ($SkipBuild) {
    $shared.SkipBuild = $true
}

if (-not $SkipApi) {
    Write-Host ""
    Write-Host "--- [1/2] flora-api ---"
    $apiParams = @{
        Server       = $shared.Server
        User         = $shared.User
        IdentityFile = $shared.IdentityFile
        BuildMode    = $ApiBuildMode
    }
    if ($SkipBuild) { $apiParams.SkipBuild = $true }
    if (-not [string]::IsNullOrWhiteSpace($ApiBinaryPath)) {
        $apiParams.BinaryPath = $ApiBinaryPath
        $apiParams.BuildMode = "Binary"
    }
    & $apiScript @apiParams
    if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) {
        throw "deploy-flora-api.ps1 failed (exit $LASTEXITCODE)."
    }
} else {
    Write-Host "Skipping API (-SkipApi)."
}

if (-not $SkipWeb) {
    Write-Host ""
    Write-Host "--- [2/2] Flora web (Next) ---"
    $webParams = @{
        Server          = $shared.Server
        User            = $shared.User
        IdentityFile    = $shared.IdentityFile
        Domain          = $Domain
        PublicSubdomain = $PublicSubdomain
        ApiUpstreamUrl  = $ApiUpstreamUrl
    }
    if ($SkipBuild) { $webParams.SkipBuild = $true }
    if (-not [string]::IsNullOrWhiteSpace($PublicApiBaseUrl)) {
        $webParams.PublicApiBaseUrl = $PublicApiBaseUrl
    }
    if (-not [string]::IsNullOrWhiteSpace($CertbotEmail)) {
        $webParams.CertbotEmail = $CertbotEmail
    }
    if (-not [string]::IsNullOrWhiteSpace($AllowedClientIps)) {
        $webParams.AllowedClientIps = $AllowedClientIps
    }
    & $webScript @webParams
    if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) {
        throw "Apps/Web/scripts/deploy.ps1 failed (exit $LASTEXITCODE)."
    }
} else {
    Write-Host "Skipping web (-SkipWeb)."
}

Write-Host ""
Write-Host "Flora Social publish complete."
Write-Host "  API health:  curl -s http://127.0.0.1:5290/health"
Write-Host "  Web local:   curl -sI http://127.0.0.1:3000/"
Write-Host ('  Public:      https://{0}.{1}/' -f $PublicSubdomain, $Domain)
