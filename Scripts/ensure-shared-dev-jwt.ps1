#Requires -Version 5.1
<#
  Shared Jwt:Secret for local flora-api.
  File: <repo>/Local/.flora/dev-jwt.secret (gitignored via /Local/). Created once, reused.

  Dot-source or capture:
    $secret = & .\Scripts\ensure-shared-dev-jwt.ps1
#>
param(
    [switch] $PrintPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = (Split-Path $PSScriptRoot -Parent | Resolve-Path).Path
$dir = Join-Path $root "Local\.flora"
$path = Join-Path $dir "dev-jwt.secret"

# One-time migrate from legacy <repo>/.flora/
$legacyDir = Join-Path $root ".flora"
$legacyPath = Join-Path $legacyDir "dev-jwt.secret"
if ((-not (Test-Path $path)) -and (Test-Path $legacyPath)) {
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    Move-Item -LiteralPath $legacyPath -Destination $path -Force
    Write-Host "Migrated Jwt secret: $legacyPath -> $path"
}

if (-not (Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

if (-not (Test-Path $path) -or ((Get-Item $path).Length -lt 32)) {
    $bytes = New-Object byte[] 48
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    }
    finally {
        $rng.Dispose()
    }
    $secret = [Convert]::ToBase64String($bytes)
    Set-Content -Path $path -Value $secret -Encoding ascii -NoNewline
    Write-Host "Created shared local Jwt secret: $path"
}
else {
    $secret = (Get-Content -Path $path -Raw).Trim()
}

if ($PrintPath) {
    Write-Output $path
}
else {
    Write-Output $secret
}
