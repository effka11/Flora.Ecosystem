#Requires -Version 5.1
<#
  Regenerates artifacts/contract-fixtures/*.json from ContractFixtureGenerator.
  Usage: ./Scripts/generate-contract-fixtures.ps1
#>
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

Push-Location $root
try {
    $env:UPDATE_CONTRACT_FIXTURES = "1"
    dotnet test tests/Flora.ContractFixtures/Flora.ContractFixtures.csproj --filter "Generator"
    if ($LASTEXITCODE -ne 0) { throw "Contract fixture generation failed." }
    Write-Host "Contract fixtures written to artifacts/contract-fixtures/"
}
finally {
    Pop-Location
    Remove-Item Env:UPDATE_CONTRACT_FIXTURES -ErrorAction SilentlyContinue
}
