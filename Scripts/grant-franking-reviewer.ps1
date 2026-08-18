#Requires -Version 5.1
<#
  Grant or revoke Messaging franking reviewer (Gov moderation queue).
  SoT is flora_core.franking_reviewers, not an Auth user_accounts flag.
  Direct SQL is live immediately; flora-api does not need a restart.

  pwsh ./Scripts/grant-franking-reviewer.ps1 -Username egor
  pwsh ./Scripts/grant-franking-reviewer.ps1 -UserUuid 019f178d-0a7f-75d0-a00a-2dab78cf8fa8
  pwsh ./Scripts/grant-franking-reviewer.ps1 -Username egor -Revoke
  pwsh ./Scripts/grant-franking-reviewer.ps1 -List
#>
param(
    [string] $Username = "",
    [string] $UserUuid = "",
    [switch] $Revoke,
    [switch] $List,
    [string] $Connection = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$sqlDir = Join-Path $PSScriptRoot "sql"

function Get-DefaultConnection {
    if (-not [string]::IsNullOrWhiteSpace($env:ConnectionStrings__FloraDatabase)) {
        return $env:ConnectionStrings__FloraDatabase
    }
    if (-not [string]::IsNullOrWhiteSpace($env:FLORA_DATABASE_CONNECTION)) {
        return $env:FLORA_DATABASE_CONNECTION
    }
    $appsettings = Join-Path $repoRoot "Backend\appsettings.json"
    if (Test-Path $appsettings) {
        $json = Get-Content -LiteralPath $appsettings -Raw | ConvertFrom-Json
        $fromFile = [string]$json.ConnectionStrings.FloraDatabase
        if (-not [string]::IsNullOrWhiteSpace($fromFile)) {
            return $fromFile
        }
    }
    return "Host=localhost;Port=5432;Database=flora_social;Username=flora;Password=change-me;Search Path=flora_core"
}

function Convert-NpgsqlToPsqlArgs([string] $Npgsql) {
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
    if (-not $database) { throw "Connection string missing Database=" }
    $user = $map['username']
    if (-not $user) { $user = $map['user id'] }
    if (-not $user) { $user = "flora" }
    $password = $map['password']
    return @{
        Host     = $hostName
        Port     = $port
        Database = $database
        User     = $user
        Password = $password
    }
}

function Invoke-FloraPsql {
    param(
        [string[]] $ExtraArgs = @(),
        [string] $Sql = ""
    )
    # psql -c does not interpolate :'variables'; always use -f.
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("flora-franking-" + [guid]::NewGuid().ToString("n") + ".sql")
    $containerTmp = "/tmp/" + [System.IO.Path]::GetFileName($tmp)
    $container = [string](docker inspect -f "{{.State.Health.Status}}" flora-local-postgres 2>$null)
    $container = $container.Trim()
    try {
        if ($Sql) {
            [System.IO.File]::WriteAllText($tmp, $Sql, [System.Text.UTF8Encoding]::new($false))
        }
        if ($container -eq "healthy") {
            $argList = @("exec", "flora-local-postgres", "psql", "-U", "flora", "-d", "flora_social", "-v", "ON_ERROR_STOP=1") + $ExtraArgs
            if ($Sql) {
                & docker cp $tmp "flora-local-postgres:$containerTmp"
                if ($LASTEXITCODE -ne 0) { throw "docker cp failed." }
                $argList += @("-f", $containerTmp)
            }
            $output = & docker @argList
            if ($LASTEXITCODE -ne 0) { throw "psql failed." }
            return $output
        }

        $psql = Get-Command psql -ErrorAction SilentlyContinue
        if (-not $psql) {
            throw "PostgreSQL is not reachable as flora-local-postgres and psql is not on PATH."
        }
        $conn = if ($Connection) { $Connection } else { Get-DefaultConnection }
        $parsed = Convert-NpgsqlToPsqlArgs $conn
        $env:PGPASSWORD = $parsed.Password
        $argList = @(
            "-h", $parsed.Host,
            "-p", $parsed.Port,
            "-U", $parsed.User,
            "-d", $parsed.Database,
            "-v", "ON_ERROR_STOP=1"
        ) + $ExtraArgs
        if ($Sql) {
            $argList += @("-f", $tmp)
        }
        $output = & $psql.Source @argList
        if ($LASTEXITCODE -ne 0) { throw "psql failed." }
        $output
    }
    finally {
        Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
        if (Test-Path $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
        if ($container -eq "healthy" -and $Sql) {
            & docker exec flora-local-postgres rm -f $containerTmp 2>$null | Out-Null
        }
    }
}

if ($List) {
    Invoke-FloraPsql -Sql @"
SELECT a.username,
       r.user_uuid,
       r.added_at,
       r.revoked_at,
       (r.revoked_at IS NULL) AS is_active
FROM flora_core.franking_reviewers r
JOIN flora_core.user_accounts a ON a.user_uuid = r.user_uuid
ORDER BY a.username;
"@
    exit 0
}

if ([string]::IsNullOrWhiteSpace($Username) -and [string]::IsNullOrWhiteSpace($UserUuid)) {
    throw "Pass -Username, -UserUuid, or -List."
}
if (-not [string]::IsNullOrWhiteSpace($Username) -and -not [string]::IsNullOrWhiteSpace($UserUuid)) {
    throw "Pass only one of -Username or -UserUuid."
}
if (-not [string]::IsNullOrWhiteSpace($UserUuid)) {
    try { [void][guid]::Parse($UserUuid) }
    catch { throw "UserUuid is not a UUID." }
}

if ($Username) {
    $lookup = Invoke-FloraPsql -ExtraArgs @("-t", "-A", "-v", "username=$Username") -Sql @"
SELECT a.user_uuid::text
FROM flora_core.user_accounts a
WHERE lower(a.username) = lower(:'username');
"@
    $found = ([string]$lookup).Trim()
    if ([string]::IsNullOrWhiteSpace($found)) {
        throw "No flora_core.user_accounts row for username '$Username'."
    }
    $sqlName = if ($Revoke) { "revoke-franking-reviewer-by-username.sql" } else { "grant-franking-reviewer-by-username.sql" }
    $sql = Get-Content -LiteralPath (Join-Path $sqlDir $sqlName) -Raw
    Invoke-FloraPsql -ExtraArgs @("-v", "username=$Username") -Sql $sql
    exit 0
}

$sqlName = if ($Revoke) { "revoke-franking-reviewer-by-uuid.sql" } else { "grant-franking-reviewer-by-uuid.sql" }
$sql = Get-Content -LiteralPath (Join-Path $sqlDir $sqlName) -Raw
Invoke-FloraPsql -ExtraArgs @("-v", "user_uuid=$UserUuid") -Sql $sql
