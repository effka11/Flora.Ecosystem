#Requires -Version 5.1
<#
  .NET Flora.API as Phase-0+ upstream on :5284 (Music HTTP still registered;
  Music workers off when Music__ServeNative=true — workers run on Rust gateway).

  Shared Jwt with Scripts/run-rust-gateway-localhost.ps1 via .flora/dev-jwt.secret.
#>
$ErrorActionPreference = "Stop"
$root = (Split-Path $PSScriptRoot -Parent | Resolve-Path).Path

$secret = & (Join-Path $PSScriptRoot "ensure-shared-dev-jwt.ps1")
$env:ASPNETCORE_ENVIRONMENT = "Development"
$env:Jwt__Secret = $secret
$env:Music__ServeNative = "true"
$env:Verification__UseGrpc = "true"
$env:Verification__GrpcAddress = "http://127.0.0.1:50051"

$proj = Join-Path $root "Flora.API\Flora.API.csproj"
Write-Host "Flora.API (.NET upstream) -> http://127.0.0.1:5284 (Music/Verification via Rust where flagged)"
Set-Location $root
dotnet watch run --project $proj --urls http://localhost:5284
