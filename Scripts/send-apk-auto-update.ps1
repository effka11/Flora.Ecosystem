# Prod/local sideload auto-update push for ALL Android clients.
# Same wire as one-user smoke: inbox app_update + data-only HIGH FCM with update{}.
# No APK build / no GitHub publish — release must already exist.
#
#   .\Scripts\send-apk-auto-update.ps1
#   .\Scripts\send-apk-auto-update.ps1 -Production -Confirm
#
# Task: "Flora Social: Send auto-update & notifications to side-APK"
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
