#Requires -Version 7
<#
.SYNOPSIS
  Apply (optional) + assert social notification groups migration (0002).

.DESCRIPTION
  Does not read Local/ secrets. Pass connection yourself.
  -Migrate uses flora-migrate (Npgsql: Host=...;Database=...;...).
  Verify uses psql; Npgsql strings are converted to a postgresql:// URL when needed.

.EXAMPLE
  # Assert only (migrations already applied):
  pwsh ./Tools/verify-social-notification-groups.ps1 -Connection "Host=localhost;Port=5432;Database=flora_social;Username=flora;Password=..."

.EXAMPLE
  # Apply all module migrations then assert:
  pwsh ./Tools/verify-social-notification-groups.ps1 -Migrate -Connection "Host=localhost;Port=5432;Database=flora_social;Username=flora;Password=..."
#>
param(
    [Parameter(Mandatory = $false)]
    [string] $Connection = $(
        if ($env:DATABASE_URL) { $env:DATABASE_URL }
        elseif ($env:FLORA_DATABASE_CONNECTION) { $env:FLORA_DATABASE_CONNECTION }
        else { "" }
    ),

    [switch] $Migrate
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$sqlFile = Join-Path $repoRoot "Tools/sql/verify-social-notification-groups.sql"
$beforeSql = Join-Path $repoRoot "Tools/sql/snapshot-social-notification-groups-before.sql"

function Convert-NpgsqlToPostgresUrl([string] $Npgsql) {
    if ($Npgsql -match '^\s*postgres(ql)?://') {
        return $Npgsql.Trim()
    }
    $map = @{}
    foreach ($segment in ($Npgsql -split ';' | Where-Object { $_.Trim() -ne "" })) {
        $eq = $segment.IndexOf('=')
        if ($eq -lt 1) { continue }
        $k = $segment.Substring(0, $eq).Trim().ToLowerInvariant()
        $v = $segment.Substring($eq + 1).Trim()
        $map[$k] = $v
    }
    $hostName = $map['host']
    if (-not $hostName) { $hostName = "localhost" }
    $port = $map['port']
    if (-not $port) { $port = "5432" }
    $database = $map['database']
    if (-not $database) { throw "Npgsql connection missing Database=" }
    $user = $map['username']
    if (-not $user) { $user = $map['user id'] }
    if (-not $user) { $user = $map['userid'] }
    $password = $map['password']
    $userEnc = [uri]::EscapeDataString($user)
    $passEnc = if ($password) { [uri]::EscapeDataString($password) } else { "" }
    $auth = if ($password) { "${userEnc}:${passEnc}" } else { $userEnc }
    return "postgresql://${auth}@${hostName}:${port}/${database}"
}

if (-not (Test-Path $sqlFile)) {
    throw "Missing $sqlFile"
}

if ([string]::IsNullOrWhiteSpace($Connection)) {
    Write-Host @"
Pass -Connection <Npgsql or postgresql://...> or set DATABASE_URL / FLORA_DATABASE_CONNECTION.

Examples:
  pwsh ./Tools/verify-social-notification-groups.ps1 -Migrate -Connection "Host=localhost;Database=flora_social;Username=flora;Password=..."
  pwsh ./Tools/verify-social-notification-groups.ps1 -Connection "postgresql://flora:...@localhost:5432/flora_social"
"@
    exit 2
}

$psql = Get-Command psql -ErrorAction SilentlyContinue
if (-not $psql) {
    throw "psql not found on PATH. Install PostgreSQL client tools."
}

$psqlUrl = Convert-NpgsqlToPostgresUrl $Connection

if ($Migrate) {
    Write-Host "Applying flora-migrate..."
    Push-Location $repoRoot
    try {
        cargo run -p flora-migrate -- --connection $Connection
        if ($LASTEXITCODE -ne 0) {
            throw "flora-migrate failed (exit $LASTEXITCODE)"
        }
    }
    finally {
        Pop-Location
    }
}
elseif (Test-Path $beforeSql) {
    Write-Host "Optional pre-assert snapshot (informational; does not fail):"
    & psql $psqlUrl -f $beforeSql 2>$null | Out-Host
}

Write-Host "Running $sqlFile"
& psql $psqlUrl -v ON_ERROR_STOP=1 -f $sqlFile
if ($LASTEXITCODE -ne 0) {
    throw "verify SQL failed (exit $LASTEXITCODE)"
}
Write-Host "OK — social notification groups verify passed."
