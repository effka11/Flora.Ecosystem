# Вызывается из VS Code/Cursor tasks. Путь к ключу передаётся через FLORA_SSH_KEY (env),
# чтобы пустое поле ввода не ломало разбор аргументов (-SshKey без значения).
param(
    [string] $SshHost = "",
    [switch] $SkipBuild
)

$ErrorActionPreference = "Stop"
$deploy = Join-Path $PSScriptRoot "deploy.ps1"

if ([string]::IsNullOrWhiteSpace($SshHost)) {
    $SshHost = $env:FLORA_DEPLOY_HOST
}
if ([string]::IsNullOrWhiteSpace($SshHost)) {
    throw "Deploy host required: pass -SshHost <host> or set FLORA_DEPLOY_HOST."
}

$SshKey = $env:FLORA_SSH_KEY
if ($null -eq $SshKey) { $SshKey = "" }
if ([string]::IsNullOrWhiteSpace($SshKey)) {
    $defaultKey = Join-Path $env:USERPROFILE ".ssh\flora_cursor_temp"
    if (Test-Path -LiteralPath $defaultKey) {
        $SshKey = $defaultKey
    }
}

$keyForLog = "<deploy.ps1 default>"
$params = @{ Server = $SshHost }
if (-not [string]::IsNullOrWhiteSpace($SshKey)) {
    $trimmed = $SshKey.Trim()
    $params.IdentityFile = $trimmed
    $keyForLog = $trimmed
}
if ($SkipBuild) {
    $params.SkipBuild = $true
}

Write-Host "Flora deploy (task): Server=$SshHost IdentityFile=$keyForLog SkipBuild=$([bool]$SkipBuild)"
& $deploy @params
