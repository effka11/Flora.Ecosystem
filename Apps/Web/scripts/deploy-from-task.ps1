# Deprecated entry — forwards to Flora Social full deploy.
param(
    [string] $SshHost = "",
    [switch] $SkipBuild
)

$ErrorActionPreference = "Stop"
$forward = (Resolve-Path (Join-Path $PSScriptRoot "..\..\Scripts\deploy-flora-social-from-task.ps1")).Path

$params = @{}
if (-not [string]::IsNullOrWhiteSpace($SshHost)) { $params.SshHost = $SshHost.Trim() }
if ($SkipBuild) { $params.SkipBuild = $true }

Write-Host "Forwarding to Flora Social full deploy..."
& $forward @params
