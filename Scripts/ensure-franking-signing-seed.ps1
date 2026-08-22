#Requires -Version 5.1
<#
  Shared Messaging:FrankingSigningSeed for local flora-api.
  File: <repo>/Local/.flora/franking-signing.seed (gitignored via /Local/).
  Created once, reused. Does not write Backend/appsettings.Local.json.

  Capture for the API process (do not print this in logs):
    $seed = & .\Scripts\ensure-franking-signing-seed.ps1
    $env:Messaging__FrankingSigningSeed = $seed

  Status without the secret:
    & .\Scripts\ensure-franking-signing-seed.ps1 -Status
#>
param(
    [switch] $PrintPath,
    [switch] $Status
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = (Split-Path $PSScriptRoot -Parent | Resolve-Path).Path
$dir = Join-Path $root "Local\.flora"
$path = Join-Path $dir "franking-signing.seed"
$legacyJson = Join-Path $root "Backend\appsettings.Local.json"

function Test-FrankingSeed([string] $raw) {
    if ([string]::IsNullOrWhiteSpace($raw)) { return $false }
    $s = $raw.Trim()
    if ($s.Length -eq 64 -and $s -match '^[0-9A-Fa-f]+$') { return $true }
    try {
        $pad = $s.Replace('-', '+').Replace('_', '/')
        switch ($pad.Length % 4) {
            2 { $pad += "==" }
            3 { $pad += "=" }
        }
        $bytes = [Convert]::FromBase64String($pad)
        return $bytes.Length -eq 32
    } catch {
        return $false
    }
}

function Get-FrankingSeedFormat([string] $raw) {
    $s = $raw.Trim()
    if ($s.Length -eq 64 -and $s -match '^[0-9A-Fa-f]+$') { return "hex64" }
    return "b64url32"
}

if (-not (Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

$action = "kept"
$seed = $null
if ((Test-Path $path) -and ((Get-Item $path).Length -gt 0)) {
    $seed = (Get-Content -Path $path -Raw).Trim()
    if (-not (Test-FrankingSeed $seed)) { $seed = $null }
}

if (-not $seed -and (Test-Path $legacyJson)) {
    try {
        $cfg = Get-Content -LiteralPath $legacyJson -Raw | ConvertFrom-Json
        $legacyProp = $null
        if ($null -ne $cfg.Messaging) {
            $legacyProp = $cfg.Messaging.PSObject.Properties["FrankingSigningSeed"]
        }
        if ($null -ne $legacyProp -and (Test-FrankingSeed ([string]$legacyProp.Value))) {
            $seed = ([string]$legacyProp.Value).Trim()
            Set-Content -Path $path -Value $seed -Encoding ascii -NoNewline
            $action = "migrated"
            Write-Host "Migrated FrankingSigningSeed -> $path"
        }
    } catch {
        # overlay unreadable — generate a fresh Local/.flora seed
    }
}

if (-not $seed) {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    } finally {
        $rng.Dispose()
    }
    $seed = [BitConverter]::ToString($bytes).Replace("-", "").ToLowerInvariant()
    Set-Content -Path $path -Value $seed -Encoding ascii -NoNewline
    $action = "created"
    Write-Host "Created local FrankingSigningSeed: $path"
}

$format = Get-FrankingSeedFormat $seed

if ($Status) {
    Write-Output (@{ action = $action; format = $format } | ConvertTo-Json -Compress)
    return
}

if ($PrintPath) {
    Write-Output $path
    return
}

Write-Output $seed
