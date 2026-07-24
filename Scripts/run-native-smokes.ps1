#Requires -Version 5.1
<#
  After Postgres is Running: restart flora-api and run all ServeNative smoke tests.

  1) Admin once:  pwsh -File Scripts/start-postgres-admin.ps1
  2) Then:         pwsh -File Scripts/run-native-smokes.ps1

  Expects flora-api on :5290 with ServeNative flags (see run-rust-gateway-localhost.ps1).
  Optional: FLORA_AUTH_SMOKE_USER / FLORA_USERS_SMOKE_TARGET_USERNAME
#>
$ErrorActionPreference = "Stop"
$root = (Split-Path $PSScriptRoot -Parent | Resolve-Path).Path
Set-Location $root

$pg = Get-Service postgresql-x64-17 -ErrorAction SilentlyContinue
if (-not $pg -or $pg.Status -ne "Running") {
    Write-Error "PostgreSQL not Running. Elevate and run: pwsh -File Scripts/start-postgres-admin.ps1"
}

$secret = & (Join-Path $PSScriptRoot "ensure-shared-dev-jwt.ps1")
$env:Jwt__Secret = $secret
$env:FLORA_ENVIRONMENT = "Development"
$env:ASPNETCORE_ENVIRONMENT = "Development"
$env:FLORA_CONFIG_DIR = (Join-Path $root "Backend")

$env:FLORA_AUTH_SESSIONS_SMOKE = "1"
$env:FLORA_USERS_SMOKE = "1"
$env:FLORA_CONTENT_SMOKE = "1"
$env:FLORA_MESSAGING_SMOKE = "1"
$env:FLORA_NOTIFICATIONS_SMOKE = "1"

function Invoke-NativeSmoke {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Package,

        [Parameter(Mandatory = $true)]
        [string] $Test
    )

    Write-Host "Running $Package/$Test ..."
    & cargo test -p $Package --test $Test -- --nocapture --test-threads=1
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "Native smoke $Package/$Test failed (exit $exitCode)."
    }
}

Write-Host "Running ServeNative smokes against http://127.0.0.1:5290 ..."
Invoke-NativeSmoke -Package "flora-auth" -Test "sessions_smoke"
Invoke-NativeSmoke -Package "flora-users" -Test "users_smoke"
Invoke-NativeSmoke -Package "flora-content" -Test "feed_smoke"
Invoke-NativeSmoke -Package "flora-messaging" -Test "messaging_smoke"
Invoke-NativeSmoke -Package "flora-notifications" -Test "notifications_smoke"
Write-Host "All smokes finished."
