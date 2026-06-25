# Production Android release (AAB/APK) via Gradle after expo prebuild.
param(
    [switch] $BroadcastUpdate
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

function Test-AndroidSdkPath([string]$path) {
    if ([string]::IsNullOrWhiteSpace($path)) { return $false }
    return (Test-Path (Join-Path $path "platform-tools"))
}

$sdk = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, (Join-Path $env:LOCALAPPDATA "Android\Sdk")) |
    Where-Object { Test-AndroidSdkPath $_ } | Select-Object -First 1
if (-not $sdk) { throw "Android SDK not found. Install Android Studio." }

$jdk = @(
    "$env:ProgramFiles\Android\Android Studio\jbr",
    "${env:ProgramFiles(x86)}\Android\Android Studio\jbr"
) | Where-Object { Test-Path (Join-Path $_ "bin\java.exe") } | Select-Object -First 1
if (-not $jdk) { throw "Android Studio JBR (JDK 21) not found." }

$mobile = Join-Path $root "Apps\Mobile"
$envFile = Join-Path $mobile ".env"
if (-not (Test-Path $envFile)) {
    throw "Missing Apps/Mobile/.env with EXPO_PUBLIC_API_URL (see .env.production.example)."
}

$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:JAVA_HOME = $jdk
$env:Path = "$jdk\bin;" + $env:Path

. (Join-Path $PSScriptRoot "mobile-flora-version.ps1")

function Stop-AndroidGradleDaemons([string]$androidDir) {
    $gradlew = Join-Path $androidDir "gradlew.bat"
    if (-not (Test-Path $gradlew)) { return }
    Write-Host "stopping Gradle daemons (unlock android/ for prebuild) ..."
    Push-Location $androidDir
    try {
        & .\gradlew.bat --stop 2>$null | Out-Null
    }
    finally {
        Pop-Location
    }
    Start-Sleep -Seconds 2
}

function Remove-LockedDirectory([string]$path) {
    if (-not (Test-Path $path)) { return }
    for ($i = 0; $i -lt 8; $i++) {
        try {
            Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop
            return
        }
        catch {
            if ($i -ge 7) { throw "Cannot remove locked folder: $path`nClose Android Studio / file explorers and retry.`n$($_.Exception.Message)" }
            Write-Host "retry remove $path ($($i + 1)/8) ..."
            Start-Sleep -Seconds 2
        }
    }
}

function Assert-GoogleServicesInAndroid([string]$androidDir) {
    $googleServices = Join-Path $androidDir "app\google-services.json"
    if (-not (Test-Path $googleServices)) {
        throw "Missing $googleServices - FCM push will not work. Re-run release after google-services.json is present."
    }
    $gradle = Join-Path $androidDir "app\build.gradle"
    $content = Get-Content $gradle -Raw
    if ($content -notmatch "com\.google\.gms\.google-services") {
        throw "android/app/build.gradle missing google-services plugin - FCM push will not work."
    }
    Write-Host "google-services.json + Gradle plugin: OK"
}

function Assert-FloraNativeSplash([string]$mobileDir, [string]$androidDir) {
    $splash = Join-Path $androidDir "app\src\main\res\drawable-xxhdpi\splashscreen_logo.png"
    if (-not (Test-Path $splash)) {
        throw "prebuild did not generate splashscreen_logo.png"
    }
    $source = Join-Path $mobileDir "assets\images\splash-icon.png"
    if (-not (Test-Path $source)) {
        throw "Missing source splash asset: $source"
    }
    $sourceTime = (Get-Item $source).LastWriteTimeUtc
    $nativeTime = (Get-Item $splash).LastWriteTimeUtc
    if ($nativeTime -lt $sourceTime.AddSeconds(-5)) {
        throw "Native splash is stale (older than assets/images/splash-icon.png). prebuild likely failed; aborting."
    }
    $bytes = [System.IO.File]::ReadAllBytes($splash)
    if ($bytes.Length -lt 4096) {
        throw "splashscreen_logo.png looks too small ($($bytes.Length) bytes)."
    }
    Write-Host "native splash OK: $splash"
}

function Test-AndroidGenFresh([string]$mobileDir) {
    $splash = Join-Path $mobileDir "android_gen\app\src\main\res\drawable-xxhdpi\splashscreen_logo.png"
    $source = Join-Path $mobileDir "assets\images\splash-icon.png"
    if (-not ((Test-Path $splash) -and (Test-Path $source))) { return $false }
    $sourceTime = (Get-Item $source).LastWriteTimeUtc
    $nativeTime = (Get-Item $splash).LastWriteTimeUtc
    if ($nativeTime -lt $sourceTime.AddSeconds(-5)) { return $false }
    return Test-AndroidGenProductionPackage $mobileDir
}

function Test-AndroidGenProductionPackage([string]$mobileDir) {
    $gradle = Join-Path $mobileDir "android_gen\app\build.gradle"
    if (-not (Test-Path $gradle)) { return $false }
    $content = Get-Content $gradle -Raw
    if ($content -match "social\.flora\.mobile\.dev") { return $false }
    if ($content -notmatch "social\.flora\.mobile") { return $false }
    if ($content -notmatch "com\.google\.gms\.google-services") { return $false }

    $googleServices = Join-Path $mobileDir "android_gen\app\google-services.json"
    if (-not (Test-Path $googleServices)) { return $false }

    $devKotlin = Join-Path $mobileDir "android_gen\app\src\main\java\social\flora\mobile\dev"
    if (Test-Path $devKotlin) { return $false }

    return $true
}

function Invoke-ExpoAndroidPrebuild([string]$mobileDir) {
    $androidOut = Join-Path $mobileDir "android_gen"
    if (Test-AndroidGenFresh $mobileDir) {
        Write-Host "android_gen already has Flora splash/icons; skipping expo prebuild."
        return $androidOut
    }

    $stage = Join-Path $mobileDir (".prebuild-stage-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
    $skipNames = @(
        "android", "android_gen", "node_modules", ".expo", "dist",
        ".prebuild-stage", ".git", ".kotlin"
    )

    Remove-LockedDirectory $stage
    New-Item -ItemType Directory -Path $stage -Force | Out-Null

    Get-ChildItem $mobileDir -Force |
        Where-Object {
            $skipNames -notcontains $_.Name -and $_.Name -notlike ".prebuild-stage*"
        } |
        ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $stage $_.Name) -Recurse -Force
        }

    $nmLink = Join-Path $stage "node_modules"
    if (-not (Test-Path $nmLink)) {
        cmd /c mklink /J "$nmLink" (Join-Path $mobileDir "node_modules") | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Failed to junction node_modules into prebuild stage." }
    }

    Write-Host "expo prebuild in staging folder (avoids locked android/) ..."
    Push-Location $stage
    try {
        npx expo prebuild --platform android --no-install
        if ($LASTEXITCODE -ne 0) { throw "expo prebuild failed with exit code $LASTEXITCODE" }
    }
    finally {
        Pop-Location
    }

    $generatedAndroid = Join-Path $stage "android"
    if (-not (Test-Path $generatedAndroid)) {
        throw "expo prebuild did not create android/ in staging folder."
    }

    Remove-LockedDirectory $androidOut
    Move-Item -LiteralPath $generatedAndroid -Destination $androidOut

    $splashCheck = Join-Path $androidOut "app\src\main\res\drawable-xxhdpi\splashscreen_logo.png"
    if (-not (Test-Path $splashCheck)) {
        throw "prebuild did not generate splashscreen_logo.png at $splashCheck"
    }

    try {
        Remove-LockedDirectory $stage
    }
    catch {
        Write-Host "warning: could not remove .prebuild-stage (safe to ignore): $($_.Exception.Message)"
    }

    return $androidOut
}

function Sync-AndroidProjectFromGen([string]$mobileDir) {
    $androidGen = Join-Path $mobileDir "android_gen"
    $androidDir = Join-Path $mobileDir "android"
    if (-not (Test-Path $androidGen)) {
        throw "Missing android_gen. Run expo prebuild first."
    }
    Write-Host "sync android_gen -> android (mirror; removes stale Flora Dev sources) ..."
  # /MIR deletes files in android/ that are not in android_gen (e.g. social.flora.mobile.dev from USB debug prebuild).
    & robocopy $androidGen $androidDir /MIR /E /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
    if ($LASTEXITCODE -gt 7) {
        throw "robocopy android_gen -> android failed with exit code $LASTEXITCODE"
    }

    $devKotlin = Join-Path $androidDir "app\src\main\java\social\flora\mobile\dev"
    if (Test-Path $devKotlin) {
        throw "android/ still contains social.flora.mobile.dev after sync. Delete Apps/Mobile/android_gen and re-run release."
    }

    return $androidDir
}

function Invoke-GradleRelease([string]$androidDir) {
    $targets = @("assembleRelease")
    if ($env:FLORA_ANDROID_BUILD_AAB -eq "1") {
        $targets += "bundleRelease"
    }

    $maxAttempts = 3
    for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
        Write-Host "gradle $($targets -join ' ') (attempt $attempt/$maxAttempts) ..."
        Push-Location $androidDir
        try {
            & .\gradlew.bat @targets --no-daemon
            if ($LASTEXITCODE -eq 0) { return }
        }
        finally {
            Pop-Location
        }

        if ($attempt -lt $maxAttempts) {
            Write-Host "Gradle failed; retrying in 8s (often Windows locks APK during packageRelease) ..."
            Stop-AndroidGradleDaemons $androidDir
            Start-Sleep -Seconds 8
        }
    }

    throw "Gradle release build failed after $maxAttempts attempts (last task often :app:packageRelease on Windows)."
}

Push-Location $mobile
try {
    Remove-Item Env:APP_VARIANT -ErrorAction SilentlyContinue

    Write-Host "sync VERSION -> app manifests (products.social) ..."
    node ../../Scripts/sync-version.mjs
    $socialVersion = Get-FloraSocialVersion $root
    Write-Host "release version: $socialVersion (VERSION.products.social)"

    Write-Host "render Flora icons (replace Metro grid splash) ..."
    node ../../Scripts/render-flora-mobile-assets.mjs

    Write-Host "patch ffmpeg-kit-react-native ..."
    node ../../Scripts/patch-ffmpeg-kit.mjs

    Write-Host "ensure ffmpeg-kit AAR ..."
    node ../../Scripts/ensure-ffmpeg-android-aar.mjs

    $legacyAndroid = Join-Path $mobile "android"
    Stop-AndroidGradleDaemons $legacyAndroid

    $androidGenDir = Invoke-ExpoAndroidPrebuild $mobile
    $androidDir = Sync-AndroidProjectFromGen $mobile
    Assert-FloraNativeSplash $mobile $androidDir
    Assert-GoogleServicesInAndroid $androidDir

    Write-Host "ensure ffmpeg-kit AAR (after android sync) ..."
    node ../../Scripts/ensure-ffmpeg-android-aar.mjs

    $localProps = Join-Path $androidDir "local.properties"
    $gradleSdk = ($sdk -replace '\\', '/').Trim()
    [System.IO.File]::WriteAllText($localProps, "sdk.dir=$gradleSdk`n", [System.Text.Encoding]::ASCII)

    Invoke-GradleRelease $androidDir

    $apk = Get-ChildItem -Recurse -Filter "app-release.apk" (Join-Path $androidDir "app\build\outputs\apk\release") -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($apk) {
        $distDir = Join-Path $mobile "dist"
        New-Item -ItemType Directory -Force -Path $distDir | Out-Null
        $distApk = Get-FloraAndroidDistApkPath $mobile $root
        Copy-Item -LiteralPath $apk.FullName -Destination $distApk -Force
        Write-Host "APK (build): $($apk.FullName)"
        Write-Host "APK (copy for install): $distApk"

        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zip = [System.IO.Compression.ZipFile]::OpenRead($apk.FullName)
        try {
            $bundled = $zip.Entries | Where-Object { $_.FullName -match 'index\.android\.bundle|\.hbc$|_expo/static/js' }
            if (-not $bundled) {
                throw "Release APK has no embedded JS bundle; it would require Metro. Rebuild failed validation."
            }
            Write-Host "Embedded JS bundle: OK ($($bundled.Count) file(s))"
        }
        finally {
            $zip.Dispose()
        }
    }
    $aab = Get-ChildItem -Recurse -Filter "app-release.aab" (Join-Path $androidDir "app\build\outputs\bundle\release") -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($aab) {
        Write-Host "AAB: $($aab.FullName)"
    }
    if (-not $apk -and -not $aab) {
        Write-Host "Release outputs under android_gen\app\build\outputs\"
    }
}
finally {
    Pop-Location
}

if ($BroadcastUpdate) {
    Write-Host ""
    Write-Host "Broadcast app-update notification (production) ..."
    & (Join-Path $PSScriptRoot "broadcast-app-update.ps1") -Production -Confirm
}
