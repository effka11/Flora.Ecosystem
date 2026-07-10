# Send in-app "app_update" notification only (no APK build / no GitHub publish).
# Use after the APK is already on GitHub Releases.
#
#   .\Scripts\send-apk-auto-update.ps1
#   .\Scripts\send-apk-auto-update.ps1 -Production -Confirm
param(
    [string] $ApiBaseUrl = "",
    [string] $Token = "",
    [string] $Text = "",
    [switch] $Production,
    [switch] $Confirm,
    [switch] $Force
)

$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "broadcast-app-update.ps1") @PSBoundParameters
exit $LASTEXITCODE
