#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
  Start local PostgreSQL Windows service (needed for flora-api ServeNative PgPool).
  Run elevated once after reboot if postgresql-x64-17 is Stopped.
#>
$ErrorActionPreference = "Stop"
$svc = "postgresql-x64-17"
$s = Get-Service -Name $svc -ErrorAction Stop
if ($s.Status -eq "Running") {
    Write-Host "$svc already Running"
    exit 0
}
Start-Service -Name $svc
Write-Host "$svc started"
Get-Service -Name $svc | Format-Table Name, Status -AutoSize
