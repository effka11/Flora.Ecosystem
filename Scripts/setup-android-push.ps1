#Requires -Version 5.1
<#
  FCM push setup check for release APK (social.flora.mobile). Flora Dev does not use push.

  Usage:
    .\Scripts\setup-android-push.ps1
#>
$ErrorActionPreference = "Stop"
$root = (Split-Path $PSScriptRoot -Parent | Resolve-Path).Path
$mobile = Join-Path $root "Apps\Mobile"
$prodGoogle = Join-Path $mobile "google-services.json"
$localSettings = Join-Path $root "Flora.API\appsettings.Local.json"
$secretsDir = Join-Path $root "Flora.API\secrets"

$ok = $true

Write-Host ""
Write-Host "Flora Android push (release APK only)" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host 'Flora Dev (USB): no FCM - use SSE + polling while app is open.' -ForegroundColor DarkGray
Write-Host ""

if (Test-Path $prodGoogle) {
    $pkgs = @()
    try {
        $j = Get-Content $prodGoogle -Raw | ConvertFrom-Json
        foreach ($c in @($j.client)) {
            $p = $c.client_info.android_client_info.package_name
            if ($p) { $pkgs += [string]$p }
        }
    } catch { }
    if ($pkgs -contains "social.flora.mobile") {
        Write-Host "[OK] google-services.json (social.flora.mobile)" -ForegroundColor Green
    } else {
        $ok = $false
        Write-Host 'WARN: google-services.json missing client social.flora.mobile' -ForegroundColor Yellow
    }
} else {
    $ok = $false
    Write-Host 'WARN: Missing Apps\Mobile\google-services.json' -ForegroundColor Yellow
}

$hasServiceAccount = $false
if (Test-Path (Join-Path $secretsDir "firebase-service-account.json")) {
    $hasServiceAccount = $true
    Write-Host "[OK] secrets\firebase-service-account.json" -ForegroundColor Green
} else {
    $jsonFiles = @()
    if (Test-Path $secretsDir) {
        $jsonFiles = Get-ChildItem $secretsDir -Filter "*.json" | Where-Object { $_.Name -notlike "*.example.json" }
    }
    if ($jsonFiles.Count -eq 1) {
        $hasServiceAccount = $true
        Write-Host "[OK] secrets\$($jsonFiles[0].Name)" -ForegroundColor Green
    }
}

if (-not $hasServiceAccount -and (Test-Path $localSettings)) {
    $json = Get-Content $localSettings -Raw | ConvertFrom-Json
    $credJson = $json.Push.Firebase.CredentialsJson
    $credPath = $json.Push.Firebase.CredentialsPath
    if ($credJson -and $credJson.Trim().Length -gt 10) {
        $hasServiceAccount = $true
        Write-Host "[OK] Push:Firebase:CredentialsJson in appsettings.Local.json" -ForegroundColor Green
    } elseif ($credPath -and (Test-Path (Join-Path $root "Flora.API\$credPath"))) {
        $hasServiceAccount = $true
        Write-Host "[OK] Push:Firebase:CredentialsPath -> $credPath" -ForegroundColor Green
    }
}

if (-not $hasServiceAccount) {
    $ok = $false
    Write-Host 'WARN: Firebase Admin SDK not configured on API' -ForegroundColor Yellow
}

Write-Host ""
Write-Host "1. Mobile (release)" -ForegroundColor Cyan
Write-Host "   Firebase -> Android app social.flora.mobile -> google-services.json"
Write-Host "   Build: .\Scripts\mobile-release-android.ps1"
Write-Host ""
Write-Host "2. API" -ForegroundColor Cyan
Write-Host "   Service account JSON in Flora.API\secrets\"
Write-Host "   appsettings.Local.json with Push:Firebase:CredentialsPath"
Write-Host "   API log: FCM push enabled for message notifications."
Write-Host ""
Write-Host "3. Test on release APK" -ForegroundColor Cyan
Write-Host "   Install Flora (not Flora Dev), login, allow notifications, send DM."
Write-Host ""
Write-Host '4. App-update broadcast (optional, after GitHub release)' -ForegroundColor Cyan
Write-Host "   VPS: Flora__AdminBroadcastToken in /etc/flora-ecosystem/flora-api.env"
Write-Host "   Local: Scripts/broadcast.env (see broadcast.env.example)"
Write-Host "   Check: .\Scripts\setup-app-update-broadcast.ps1"
Write-Host "   Send:  .\Scripts\broadcast-app-update.ps1 -Production -Confirm"
Write-Host ""

if ($ok) {
    Write-Host "Release push config looks ready." -ForegroundColor Green
} else {
    Write-Host "Complete steps above for release builds." -ForegroundColor Yellow
}
