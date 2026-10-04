# Task entry: Flora Social full VPS publish (API + web).
# Host/key: -SshHost / FLORA_DEPLOY_HOST / FLORA_SSH_KEY, else interactive prompts.
param(
    [string] $SshHost = "",
    [switch] $SkipBuild,
    [switch] $SkipApi,
    [switch] $SkipWeb
)

$ErrorActionPreference = "Stop"
$deploy = Join-Path $PSScriptRoot "deploy-flora-social.ps1"

$params = @{}
if (-not [string]::IsNullOrWhiteSpace($SshHost)) {
    $params.Server = $SshHost.Trim()
} elseif (-not [string]::IsNullOrWhiteSpace($env:FLORA_DEPLOY_HOST)) {
    $params.Server = $env:FLORA_DEPLOY_HOST.Trim()
}

$SshKey = $env:FLORA_SSH_KEY
if ($null -eq $SshKey) { $SshKey = "" }
if (-not [string]::IsNullOrWhiteSpace($SshKey)) {
    $params.IdentityFile = $SshKey.Trim()
}
if ($SkipBuild) { $params.SkipBuild = $true }
if ($SkipApi) { $params.SkipApi = $true }
if ($SkipWeb) { $params.SkipWeb = $true }

Write-Host "Flora Social deploy (task): root@VPS; prompts if host/key not in env or -SshHost."
& $deploy @params
if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) {
    throw "deploy-flora-social.ps1 failed (exit $LASTEXITCODE)."
}
