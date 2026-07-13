#Requires -Version 5.1
<#
  Regenerates docs/test-vectors/backend-parity/*.json from the C# reference implementation
  (next-architecture.md §7.1). The cross-language vector jwt-hs256-rust-v1.json is generated
  from Backend/ instead: cargo run -p flora-parity --bin gen-cross-vectors.
  Usage: ./Scripts/generate-golden-vectors.ps1
#>
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

Push-Location $root
try {
    $env:UPDATE_GOLDEN_VECTORS = "1"
    dotnet test tests/Flora.GoldenVectors/Flora.GoldenVectors.csproj --filter "Generator"
    if ($LASTEXITCODE -ne 0) { throw "Golden vector generation failed." }
    Write-Host "Golden vectors written to docs/test-vectors/backend-parity/"
}
finally {
    Pop-Location
    Remove-Item Env:UPDATE_GOLDEN_VECTORS -ErrorAction SilentlyContinue
}
