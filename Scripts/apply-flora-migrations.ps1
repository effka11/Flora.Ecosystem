#Requires -Version 5.1
<#
Applies Flora EF Core migrations in FK order on the database from ConnectionStrings:FloraDatabase.

Examples (PowerShell from repo root):
  $env:ConnectionStrings__FloraDatabase = "Host=localhost;Port=5432;Database=flora_social;Username=flora;Password=***;Search Path=flora_core"
  ./Scripts/apply-flora-migrations.ps1

Override via environment variable (same binding as Flora.API appsettings keys):
  ConnectionStrings__FloraDatabase
  Jwt__Secret (runtime only — not needed for dotnet ef database update)
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$startupProject = Join-Path $repoRoot "Flora.Migrations\Flora.Migrations.csproj"

function Resolve-FloraDatabaseConnectionString {
    if ($env:ConnectionStrings__FloraDatabase) {
        return $env:ConnectionStrings__FloraDatabase.Trim()
    }

    $apiDir = Join-Path $repoRoot "Flora.API"
    $candidates = @(
        (Join-Path $apiDir "appsettings.Local.json"),
        (Join-Path $apiDir "appsettings.Development.json")
    )

    foreach ($path in $candidates) {
        if (-not (Test-Path -LiteralPath $path)) { continue }
        try {
            $json = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
            $conn = $json.ConnectionStrings.FloraDatabase
            if (-not [string]::IsNullOrWhiteSpace($conn)) {
                return $conn.Trim()
            }
        }
        catch {
            Write-Warning "Could not read connection string from $path"
        }
    }

    return "Host=localhost;Port=5432;Database=flora_social;Username=flora;Password=change-me;Include Error Detail=true;Search Path=flora_core"
}

if (-not $env:ConnectionStrings__FloraDatabase) {
    $env:ConnectionStrings__FloraDatabase = Resolve-FloraDatabaseConnectionString
    Write-Host "Using ConnectionStrings:FloraDatabase from appsettings / localhost default." -ForegroundColor DarkGray
}

$steps = @(
    @{ Context = "AuthDbContext"; Project = "Modules\Flora.Auth\Flora.Auth.Infrastructure\Flora.Auth.Infrastructure.csproj" },
    @{ Context = "VerificationDbContext"; Project = "Modules\Flora.Verification\Flora.Verification.Infrastructure\Flora.Verification.Infrastructure.csproj" },
    @{ Context = "UsersDbContext"; Project = "Modules\Flora.Users\Flora.Users.Infrastructure\Flora.Users.Infrastructure.csproj" },
    @{ Context = "ContentDbContext"; Project = "Modules\Flora.Content\Flora.Content.Infrastructure\Flora.Content.Infrastructure.csproj" },
    @{ Context = "MessagingDbContext"; Project = "Modules\Flora.Messaging\Flora.Messaging.Infrastructure\Flora.Messaging.Infrastructure.csproj" },
    @{ Context = "NotificationsDbContext"; Project = "Modules\Flora.Notifications\Flora.Notifications.Infrastructure\Flora.Notifications.Infrastructure.csproj" },
    @{ Context = "MusicDbContext"; Project = "Modules\Flora.Music\Flora.Music.Infrastructure\Flora.Music.Infrastructure.csproj" }
)

Push-Location $repoRoot
try {
    foreach ($s in $steps) {
        $project = Join-Path $repoRoot $s.Project
        Write-Host ("Updating {0} ..." -f $s.Context)
        dotnet ef database update --project $project --startup-project $startupProject --context $s.Context
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    Write-Host "All contexts updated."
}
finally {
    Pop-Location
}
