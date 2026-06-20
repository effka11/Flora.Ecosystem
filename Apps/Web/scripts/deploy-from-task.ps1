# Вызывается из VS Code/Cursor tasks. Хост/ключ можно задать через FLORA_DEPLOY_HOST / FLORA_SSH_KEY;
# иначе deploy.ps1 запросит IP и путь к ключу интерактивно (подключение как root).
param(
    [string] $SshHost = "",
    [switch] $SkipBuild
)

$ErrorActionPreference = "Stop"
$deploy = Join-Path $PSScriptRoot "deploy.ps1"

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
if ($SkipBuild) {
    $params.SkipBuild = $true
}

Write-Host "Flora deploy (task): root@VPS; prompts if host/key not in env or -SshHost."
& $deploy @params
