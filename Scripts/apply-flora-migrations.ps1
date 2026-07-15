#Requires -Version 5.1
<#
  Retired (Phase 5): EF migrations and Flora.Migrations were removed with the C# host.
  Use flora-migrate (Backend/crates/flora-migrate) for schema evolution.
#>
Write-Error "apply-flora-migrations.ps1 retired — C# / EF removed. Use: cargo run -p flora-migrate -- --help"
exit 1
