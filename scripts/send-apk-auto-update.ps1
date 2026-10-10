# Inbox notice that a new Android version is published (same app_update row + button).
# Does not start an automatic download — the user taps «Обновить».
# Release APK must already be on the Flora channel.
#
#   .\scripts\send-apk-auto-update.ps1
#   .\scripts\send-apk-auto-update.ps1 -Production -Confirm
#
# Task: "Flora Social: notify new Android version"
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
