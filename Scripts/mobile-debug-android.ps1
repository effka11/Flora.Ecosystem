#Requires -Version 5.1
<#
  One-shot Android USB debug: PostgreSQL + Flora.API + Flora Dev + Metro.

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

function Test-FloraApiHealthy {
    param(
        [string] $Url = "http://127.0.0.1:5284/health"
    )
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
        return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500)
    }
    catch {
        return $false
    }
}

function Ensure-FloraApiDev {
    if (Test-FloraApiHealthy) {
        Write-Host "Flora.API already listening on http://localhost:5284"
        return
    }

    Write-Host "Flora.API not reachable - starting dotnet watch in a new window ..."
    & (Join-Path $PSScriptRoot "stop-dev-localhost.ps1") -Api

    $proj = Join-Path $root "Flora.API\Flora.API.csproj"
    $env:ASPNETCORE_ENVIRONMENT = "Development"
    Start-Process -FilePath "dotnet" `
        -ArgumentList @(
            "watch", "run",
            "--project", $proj,
            "--urls", "http://localhost:5284"
        ) `
        -WorkingDirectory $root `
        -WindowStyle Normal

    $deadline = (Get-Date).AddSeconds(120)
    do {
        if (Test-FloraApiHealthy) {
            Write-Host "Flora.API ready at http://localhost:5284"
            return
        }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)

    throw "Flora.API did not become ready on :5284 within 120s. Check the dotnet window."
}

Write-Host @"

================================================================
  Flora Android debug (USB)
  DB + API + Flora Dev + Metro
================================================================

"@

& (Join-Path $PSScriptRoot "stop-dev-localhost.ps1") -Mobile

Start-FloraDb

if (-not $SkipApi) {
    Ensure-FloraApiDev
}

$metroScript = Join-Path $PSScriptRoot "mobile-debug-usb.ps1"
if ($ReplaceExistingDev) {
    & $metroScript -ReplaceExistingDev
} else {
    & $metroScript
}
exit $LASTEXITCODE
