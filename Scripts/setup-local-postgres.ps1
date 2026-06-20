#Requires -Version 5.1
<#
Поднимает локальный PostgreSQL (Docker) и применяет EF-миграции Flora.

  ./Scripts/setup-local-postgres.ps1
  ./Scripts/setup-local-postgres.ps1 -Reset   # пересоздать volume с нуля

Требования: Docker Desktop (Linux containers), .NET SDK.
#>
param([switch] $Reset)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$conn = "Host=localhost;Port=5432;Database=flora_social;Username=flora;Password=change-me;Include Error Detail=true;Search Path=flora_core"

function Ensure-Docker {
    $docker = Get-Command docker -CommandType Application -ErrorAction SilentlyContinue
    if (-not $docker) { throw "Docker not found. Install Docker Desktop." }
    docker info *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "Docker daemon is not running. Start Docker Desktop and retry."
    }
}

function Wait-PostgresHealthy {
    param([string] $ContainerName, [int] $TimeoutSec = 90)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $status = docker inspect -f "{{.State.Health.Status}}" $ContainerName 2>$null
        if ($status -eq "healthy") { return }
        if ($status -eq "unhealthy") { throw "Container $ContainerName is unhealthy." }
        Start-Sleep -Seconds 2
    }
    throw "PostgreSQL did not become healthy within ${TimeoutSec}s."
}

Push-Location $repoRoot
try {
    Ensure-Docker

    if ($Reset) {
        Write-Host "Resetting volume flora_pg_data..."
        docker compose down -v
    }

    Write-Host "Starting PostgreSQL (docker compose up -d)..."
    docker compose up -d
    if ($LASTEXITCODE -ne 0) { throw "docker compose up failed." }

    Wait-PostgresHealthy -ContainerName "flora-local-postgres"

    $env:ConnectionStrings__FloraDatabase = $conn
    Write-Host "Applying migrations..."
    & (Join-Path $PSScriptRoot "apply-flora-migrations.ps1")
    if ($LASTEXITCODE -ne 0) { throw "Migrations failed." }

    Write-Host ""
    Write-Host "Local PostgreSQL is ready." -ForegroundColor Green
    Write-Host "  Connection: $conn"
    Write-Host "  API:        dotnet run --project Flora.API (http://localhost:5284)"
    Write-Host "  Web:        cd Apps/Web; npm run dev"
    Write-Host "  Stop DB:    docker compose down"
}
finally {
    Pop-Location
}
