#Requires -Version 5.1
<#
  adb reverse for Flora Mobile USB debug (Metro 8081, API 5284).
  Used from .vscode/tasks.json and mobile-debug-usb.ps1.
#>
$ErrorActionPreference = "Stop"

if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
    throw "adb not found. Install Android SDK platform-tools and add to PATH."
}

$lines = @(adb devices | Select-Object -Skip 1 | Where-Object { $_.Trim() -ne "" })
$authorized = @($lines | Where-Object { $_ -match "\tdevice$" })
$unauthorized = @($lines | Where-Object { $_ -match "\tunauthorized$" })

if ($authorized.Count -eq 0 -and $unauthorized.Count -gt 0) {
    throw @"
Phone is connected but NOT authorized for USB debugging.

On the phone:
1. Unlock the screen
2. Look for "Allow USB debugging?" / RSA fingerprint dialog
3. Tap Allow (optionally "Always allow from this computer")

If no dialog appears:
- Developer options -> Revoke USB debugging authorizations
- Unplug USB, plug back in
- Or run: adb kill-server
  then: adb devices

Expected: adb devices  ->  <serial>    device
"@
}

if ($authorized.Count -eq 0) {
    throw @"
Phone not visible in adb.
1. USB cable with data (not charge-only)
2. Developer options -> USB debugging ON
3. Accept RSA prompt on phone
4. Check: adb devices  ->  <serial>    device
"@
}

Write-Host "Devices: $($authorized.Count)"
adb reverse tcp:8081 tcp:8081
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
adb reverse tcp:5284 tcp:5284
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "USB reverse OK: Metro 8081, API 5284"
