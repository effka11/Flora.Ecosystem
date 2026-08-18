# Flora Gov - local Next on :3001 against Rust flora-api :5290.
# Does NOT stop Social (:3000) or restart a healthy API. Only frees :3001.

$ErrorActionPreference = "Stop"

$repoRoot = (Join-Path $PSScriptRoot "..") | Resolve-Path
$govRoot = Join-Path $repoRoot "Apps\Gov"

function Test-ApiHealthy {
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:5290/health" -UseBasicParsing -TimeoutSec 2
        return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500)
    }
    catch {
        return $false
    }
}

if (-not (Test-ApiHealthy)) {
    Write-Host "flora-api is not on :5290 - starting DB + API (Social :3000 is left running)."
    Push-Location $repoRoot
    try {
        docker compose up -d
        if ($LASTEXITCODE -ne 0) {
            throw "docker compose up failed (is Docker Desktop running?)"
        }
        $deadline = (Get-Date).AddSeconds(90)
        do {
            $status = docker inspect -f '{{.State.Health.Status}}' flora-local-postgres 2>$null
            if ($status -eq "healthy") { break }
            if ($status -eq "unhealthy") { throw "flora-local-postgres is unhealthy." }
            Start-Sleep -Seconds 2
        } while ((Get-Date) -lt $deadline)
        if ($status -ne "healthy") {
            throw "PostgreSQL did not become healthy in time."
        }
    }
    finally {
        Pop-Location
    }

    $null = & (Join-Path $PSScriptRoot "ensure-shared-dev-jwt.ps1")
    Start-Process -FilePath "powershell.exe" `
        -ArgumentList @(
            "-NoProfile", "-ExecutionPolicy", "Bypass",
            "-File", (Join-Path $PSScriptRoot "run-rust-gateway-localhost.ps1")
        ) `
        -WorkingDirectory $repoRoot `
        -WindowStyle Normal

    $apiDeadline = (Get-Date).AddSeconds(300)
    do {
        if (Test-ApiHealthy) { break }
        Start-Sleep -Seconds 3
    } while ((Get-Date) -lt $apiDeadline)
    if (-not (Test-ApiHealthy)) {
        throw "flora-api did not become ready on :5290 within 300s. Check the cargo window."
    }
}

& (Join-Path $PSScriptRoot "ensure-api-localhost.ps1")
& (Join-Path $PSScriptRoot "stop-dev-localhost.ps1") -Gov

$env:FLORA_API_UPSTREAM = "http://127.0.0.1:5290"

$envExample = Join-Path $govRoot ".env.example"
$envLocal = Join-Path $govRoot ".env.local"
if (-not (Test-Path $envLocal) -and (Test-Path $envExample)) {
    Copy-Item $envExample $envLocal
    Write-Host "Created Apps/Gov/.env.local from .env.example"
}

if (-not (Test-Path (Join-Path $govRoot "node_modules"))) {
    Write-Host "Installing Apps/Gov dependencies (not a root workspace)..."
    npm install --prefix $govRoot
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host @"

================================================================
  Flora Gov -> http://localhost:3001
  API proxy -> $env:FLORA_API_UPSTREAM (Rust flora-api)
  Registration stays on Social http://localhost:3000/login
================================================================

"@

Set-Location $govRoot
npm run dev
