#Requires -Version 5.1
<#
  One-shot Android USB debug: PostgreSQL + .NET :5284 + Rust gateway :5290 + Flora Dev + Metro.

  VS Code: Flora Android: debug (USB)
  CLI:     .\Scripts\mobile-debug-android.ps1
           .\Scripts\mobile-debug-android.ps1 -ReplaceExistingDev
#>
param(
    [switch] $ReplaceExistingDev,
    [switch] $SkipApi
)

$ErrorActionPreference = "Stop"
$root = (Split-Path $PSScriptRoot -Parent | Resolve-Path).Path

function Start-FloraDb {
    Push-Location $root
    try {
        Write-Host "Flora DB: docker compose up -d ..."
        docker compose up -d
        if ($LASTEXITCODE -ne 0) {
            throw "docker compose up failed (is Docker Desktop running?)"
        }

        $deadline = (Get-Date).AddSeconds(90)
        do {
            $status = docker inspect -f '{{.State.Health.Status}}' flora-local-postgres 2>$null
            if ($status -eq "healthy") {
                Write-Host "PostgreSQL ready (flora-local-postgres)."
                return
            }
            if ($status -eq "unhealthy") {
                throw "flora-local-postgres is unhealthy."
            }
            Start-Sleep -Seconds 2
        } while ((Get-Date) -lt $deadline)

        throw "PostgreSQL did not become healthy in time."
    }
    finally {
        Pop-Location
    }
}

function Test-Healthy {
    param([string] $Url)
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
        return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500)
    }
    catch {
        return $false
    }
}

function Ensure-DotnetUpstream {
    if (Test-Healthy "http://127.0.0.1:5284/health") {
        Write-Host "Flora.API upstream already on http://localhost:5284"
        return
    }

    Write-Host "Flora.API not reachable - starting .NET upstream in a new window ..."
    Start-Process -FilePath "powershell.exe" `
        -ArgumentList @(
            "-NoProfile", "-ExecutionPolicy", "Bypass",
            "-File", (Join-Path $PSScriptRoot "run-dotnet-upstream-localhost.ps1")
        ) `
        -WorkingDirectory $root `
        -WindowStyle Normal

    $deadline = (Get-Date).AddSeconds(120)
    do {
        if (Test-Healthy "http://127.0.0.1:5284/health") {
            Write-Host "Flora.API upstream ready at http://localhost:5284"
            return
        }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)

    throw "Flora.API did not become ready on :5284 within 120s. Check the dotnet window."
}

function Ensure-RustGateway {
    if (Test-Healthy "http://127.0.0.1:5290/health") {
        Write-Host "Flora gateway already on http://localhost:5290"
        return
    }

    Write-Host "Starting Rust gateway in a new window ..."
    Start-Process -FilePath "powershell.exe" `
        -ArgumentList @(
            "-NoProfile", "-ExecutionPolicy", "Bypass",
            "-File", (Join-Path $PSScriptRoot "run-rust-gateway-localhost.ps1")
        ) `
        -WorkingDirectory $root `
        -WindowStyle Normal

    $deadline = (Get-Date).AddSeconds(300)
    do {
        if (Test-Healthy "http://127.0.0.1:5290/health") {
            Write-Host "Flora gateway ready at http://localhost:5290"
            return
        }
        Start-Sleep -Seconds 3
    } while ((Get-Date) -lt $deadline)

    throw "flora-api gateway did not become ready on :5290 within 300s."
}

Write-Host @"

================================================================
  Flora Android debug (USB)
  DB + .NET :5284 + Rust :5290 + Flora Dev + Metro
================================================================

"@

& (Join-Path $PSScriptRoot "stop-dev-localhost.ps1") -Mobile

Start-FloraDb

$null = & (Join-Path $PSScriptRoot "ensure-shared-dev-jwt.ps1")

if (-not $SkipApi) {
    & (Join-Path $PSScriptRoot "stop-dev-localhost.ps1") -Api
    Ensure-DotnetUpstream
    Ensure-RustGateway
}

$metroScript = Join-Path $PSScriptRoot "mobile-debug-usb.ps1"
if ($ReplaceExistingDev) {
    & $metroScript -ReplaceExistingDev
} else {
    & $metroScript
}
exit $LASTEXITCODE
