# Production Android release (AAB/APK) via Gradle after expo prebuild.
param(
    [switch] $BroadcastUpdate,
    [switch] $PublishChannel,
    # Deprecated alias for -PublishChannel (GitHub Releases no longer used for APK).
    [switch] $PublishGitHub
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

$FloraApkChannelOrigin = "https://social.flora-s.net"
$FloraApkChannelBase = "$FloraApkChannelOrigin/apk"
$FloraApkChannelRemoteDir = "/var/www/flora-apk"
$FloraApkChannelLatestJson = "flora.social-android-update.json"
$FloraApkChannelReleasesJson = "releases.json"

if ($PublishGitHub -and -not $PublishChannel) {
    Write-Warning "-PublishGitHub is deprecated; publishing to Flora APK channel (-PublishChannel)."
    $PublishChannel = $true
}

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

$buildPlayAab = $env:FLORA_ANDROID_BUILD_AAB -eq "1"
if ($buildPlayAab) {
    # A bundle is a Play artifact: exclude PackageInstaller code and permissions
    # before Expo autolinking/prebuild, exactly like the EAS production profile.
    $env:FLORA_DISABLE_SIDELOAD_UPDATES = "1"
}
$nativeBuildMode = if ($env:FLORA_DISABLE_SIDELOAD_UPDATES -eq "1") { "play" } else { "sideload" }
if ($PublishChannel -and $nativeBuildMode -eq "play") {
    throw "-PublishChannel requires a sideload APK build. Unset FLORA_ANDROID_BUILD_AAB / FLORA_DISABLE_SIDELOAD_UPDATES."
}
Write-Host "Android native mode: $nativeBuildMode"

. (Join-Path $PSScriptRoot "mobile-flora-version.ps1")
. (Join-Path $PSScriptRoot "patch-release-gradle-props.ps1")
. (Join-Path $PSScriptRoot "mobile-android-env.ps1")
Ensure-FscpSecurePushAndroidNative $root

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

function Test-AndroidGenFresh([string]$mobileDir, [string]$buildMode) {
    $splash = Join-Path $mobileDir "android_gen\app\src\main\res\drawable-xxhdpi\splashscreen_logo.png"
    $source = Join-Path $mobileDir "assets\images\splash-icon.png"
    $notifNative = Join-Path $mobileDir "android_gen\app\src\main\res\drawable-xxhdpi\notification_icon.png"
    $notifSource = Join-Path $mobileDir "assets\images\notification-icon.png"
    if (-not ((Test-Path $splash) -and (Test-Path $source))) { return $false }
    if (-not ((Test-Path $notifNative) -and (Test-Path $notifSource))) { return $false }
    $modeMarker = Join-Path $mobileDir "android_gen\.flora-build-mode"
    if (-not (Test-Path -LiteralPath $modeMarker)) { return $false }
    if ((Get-Content -LiteralPath $modeMarker -Raw).Trim() -ne $buildMode) { return $false }
    $sourceTime = (Get-Item $source).LastWriteTimeUtc
    $nativeTime = (Get-Item $splash).LastWriteTimeUtc
    if ($nativeTime -lt $sourceTime.AddSeconds(-5)) { return $false }
    $notifSourceTime = (Get-Item $notifSource).LastWriteTimeUtc
    $notifNativeTime = (Get-Item $notifNative).LastWriteTimeUtc
    if ($notifNativeTime -lt $notifSourceTime.AddSeconds(-5)) { return $false }

    # Invalidate when Expo version / versionCode changed (otherwise stale APK labels).
    $appJsonPath = Join-Path $mobileDir "app.json"
    $gradlePath = Join-Path $mobileDir "android_gen\app\build.gradle"
    if ((Test-Path $appJsonPath) -and (Test-Path $gradlePath)) {
        $appJson = Get-Content -LiteralPath $appJsonPath -Raw | ConvertFrom-Json
        $wantName = [string]$appJson.expo.version
        $wantCode = [string]$appJson.expo.android.versionCode
        $gradle = Get-Content -LiteralPath $gradlePath -Raw
        if ($gradle -notmatch [regex]::Escape("versionName `"$wantName`"")) { return $false }
        if ($gradle -notmatch "(?m)^\s*versionCode\s+$wantCode\b") { return $false }
    }

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

function Invoke-ExpoAndroidPrebuild([string]$mobileDir, [string]$buildMode) {
    $androidOut = Join-Path $mobileDir "android_gen"
    if (Test-AndroidGenFresh $mobileDir $buildMode) {
        Write-Host "android_gen already has Flora splash/icons and mode=$buildMode; skipping expo prebuild."
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

    Write-Host "configure updater autolinking for mode=$buildMode ..."
    & node (Join-Path $root "Scripts\configure-mobile-play-autolinking.mjs") $stage
    if ($LASTEXITCODE -ne 0) { throw "Failed to configure mobile autolinking." }

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
    [System.IO.File]::WriteAllText(
        (Join-Path $androidOut ".flora-build-mode"),
        "$buildMode`n",
        [System.Text.Encoding]::ASCII
    )

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

    Write-Host "sync VERSION -> app manifests ..."
    node ../../Scripts/sync-version.mjs
    $apkVersion = Get-FloraMobileVersion $root
    Write-Host "release version: $apkVersion (VERSION.products.mobile)"

    Write-Host "render Flora icons (replace Metro grid splash) ..."
    node ../../Scripts/render-flora-mobile-assets.mjs

    Write-Host "patch ffmpeg-kit-react-native ..."
    node ../../Scripts/patch-ffmpeg-kit.mjs

    Write-Host "ensure ffmpeg-kit AAR ..."
    node ../../Scripts/ensure-ffmpeg-android-aar.mjs

    $legacyAndroid = Join-Path $mobile "android"
    Stop-AndroidGradleDaemons $legacyAndroid

    $androidGenDir = Invoke-ExpoAndroidPrebuild $mobile $nativeBuildMode
    $androidDir = Sync-AndroidProjectFromGen $mobile
    Assert-FloraNativeSplash $mobile $androidDir
    Assert-GoogleServicesInAndroid $androidDir

    Write-Host "ensure ffmpeg-kit AAR (after android sync) ..."
    node ../../Scripts/ensure-ffmpeg-android-aar.mjs

    $localProps = Join-Path $androidDir "local.properties"
    $gradleSdk = ($sdk -replace '\\', '/').Trim()
    [System.IO.File]::WriteAllText($localProps, "sdk.dir=$gradleSdk`n", [System.Text.Encoding]::ASCII)

    Invoke-ReleaseGradlePropertiesPatch -AndroidDir $androidDir
    $androidGenDir = Join-Path $mobile "android_gen"
    if (Test-Path (Join-Path $androidGenDir "gradle.properties")) {
        Invoke-ReleaseGradlePropertiesPatch -AndroidDir $androidGenDir
    }

    Invoke-GradleRelease $androidDir

    $apk = Get-ChildItem -Recurse -Filter "app-release.apk" (Join-Path $androidDir "app\build\outputs\apk\release") -ErrorAction SilentlyContinue |
        Select-Object -First 1
    $distApk = $null
    $updateManifestPath = $null
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
            # Force array: a single ZipArchiveEntry has no .Count under Set-StrictMode.
            $bundled = @($zip.Entries | Where-Object { $_.FullName -match 'index\.android\.bundle|\.hbc$|_expo/static/js' })
            if ($bundled.Count -eq 0) {
                throw "Release APK has no embedded JS bundle; it would require Metro. Rebuild failed validation."
            }
            Write-Host "Embedded JS bundle: OK ($($bundled.Count) file(s))"
        }
        finally {
            $zip.Dispose()
        }

        if ($nativeBuildMode -eq "sideload") {
            $appJsonPath = Join-Path $mobile "app.json"
            $appJson = Get-Content -LiteralPath $appJsonPath -Raw | ConvertFrom-Json
            $versionCode = [int]$appJson.expo.android.versionCode
            if ($versionCode -lt 1) {
                throw "Apps/Mobile/app.json expo.android.versionCode must be a positive integer"
            }

            $apkItem = Get-Item -LiteralPath $distApk
            $sha256 = (Get-FileHash -LiteralPath $distApk -Algorithm SHA256).Hash.ToLowerInvariant()
            $canonicalFileName = Get-FloraAndroidApkFileName $root
            $publishedApk = Join-Path $distDir $canonicalFileName
            if ($apkItem.FullName -ne $publishedApk) {
                Copy-Item -LiteralPath $apkItem.FullName -Destination $publishedApk -Force
                $distApk = $publishedApk
                $apkItem = Get-Item -LiteralPath $distApk
            }
            # 0.12 clients only trust flora.social-v…-android[-{sha8}].apk in apkUrl.
            # Hashed mirror is the sideload pointer (CDN-safe); plain alias covers 0.12 fallback 2.4.
            $sha8 = $sha256.Substring(0, 8)
            $legacyHashedFileName = Get-FloraAndroidLegacyApkFileName $root $sha8
            $legacyPlainFileName = Get-FloraAndroidLegacyApkFileName $root
            Copy-Item -LiteralPath $distApk -Destination (Join-Path $distDir $legacyHashedFileName) -Force
            Copy-Item -LiteralPath $distApk -Destination (Join-Path $distDir $legacyPlainFileName) -Force
            $legacyApkUrl = "$FloraApkChannelBase/$legacyHashedFileName"
            $updateManifest = [ordered]@{
                version      = $apkVersion
                versionCode  = $versionCode
                apkFileName  = $legacyHashedFileName
                apkUrl       = $legacyApkUrl
                sha256       = $sha256
                sizeBytes    = [int64]$apkItem.Length
            }
            $updateManifestPath = Join-Path $distDir "flora.social-android-update.json"
            $json = ($updateManifest | ConvertTo-Json -Depth 4) + "`n"
            $utf8NoBom = New-Object System.Text.UTF8Encoding $false
            [System.IO.File]::WriteAllText($updateManifestPath, $json, $utf8NoBom)
            Write-Host "Update manifest: $updateManifestPath (versionCode=$versionCode, sizeBytes=$($apkItem.Length))"
            Write-Host "APK canonical: $canonicalFileName"
            Write-Host "APK 0.12 mirror: $legacyHashedFileName"
        }
        else {
            $staleManifest = Join-Path $distDir "flora.social-android-update.json"
            Remove-Item -LiteralPath $staleManifest -Force -ErrorAction SilentlyContinue
            Write-Host "Play-mode APK: update manifest intentionally not generated."
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

if ($PublishChannel) {
    if (-not $distApk -or -not (Test-Path -LiteralPath $distApk)) {
        throw "-PublishChannel requires a built APK at dist/"
    }
    $updateManifestPath = Join-Path (Join-Path $mobile "dist") "flora.social-android-update.json"
    if (-not (Test-Path -LiteralPath $updateManifestPath)) {
        throw "-PublishChannel requires $updateManifestPath (sideload build generates it)."
    }

    function Resolve-FloraSshKeyPath([string]$RawPath) {
        $path = $RawPath.Trim().Trim('"')
        if ([string]::IsNullOrWhiteSpace($path)) { return "" }
        if ($path.StartsWith("~")) {
            $path = Join-Path $env:USERPROFILE $path.Substring(1).TrimStart("\", "/")
        }
        return $path
    }

    function New-FloraSshTransportOpts([string]$IdentityKey) {
        $parts = @(
            "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "ConnectTimeout=30"
        )
        if ($IdentityKey -and (Test-Path -LiteralPath $IdentityKey)) {
            $parts += @("-i", $IdentityKey)
        }
        return $parts
    }

    $server = $env:FLORA_DEPLOY_HOST
    if ([string]::IsNullOrWhiteSpace($server)) {
        $server = (Read-Host "VPS IP or hostname for APK channel").Trim()
    }
    if ([string]::IsNullOrWhiteSpace($server)) {
        throw "Server host required: set FLORA_DEPLOY_HOST or enter at prompt."
    }

    $user = if ($env:FLORA_DEPLOY_USER) { $env:FLORA_DEPLOY_USER.Trim() } else { "root" }
    $sshKeyEnv = if ($null -ne $env:FLORA_SSH_KEY) { $env:FLORA_SSH_KEY } else { "" }
    $identityFile = Resolve-FloraSshKeyPath $sshKeyEnv
    if ([string]::IsNullOrWhiteSpace($identityFile)) {
        $defaultKey = Join-Path $env:USERPROFILE ".ssh\id_ed25519_flora"
        if (Test-Path -LiteralPath $defaultKey) { $identityFile = $defaultKey }
    }

    $sshBase = @(New-FloraSshTransportOpts -IdentityKey $identityFile)
    $remoteTarget = "${user}@${server}"
    $apkItem = Get-Item -LiteralPath $distApk
    $apkFileName = $apkItem.Name
    $manifestObj = Get-Content -LiteralPath $updateManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $publishedAt = [DateTime]::UtcNow.ToString("o")
    $tmpLocal = Join-Path $env:TEMP ("flora-apk-channel-" + [guid]::NewGuid().ToString("n"))
    New-Item -ItemType Directory -Path $tmpLocal | Out-Null

    try {
        Write-Host ""
        Write-Host "Publishing APK channel → ${FloraApkChannelBase}/ (${remoteTarget}:${FloraApkChannelRemoteDir}) ..."

        & ssh @sshBase $remoteTarget "mkdir -p $FloraApkChannelRemoteDir"
        if ($LASTEXITCODE -ne 0) { throw "ssh mkdir failed (exit $LASTEXITCODE)" }

        $distDir = Join-Path $mobile "dist"
        $canonicalFileName = Get-FloraAndroidApkFileName $root
        $legacyHashedFileName = [string]$manifestObj.apkFileName
        if ($legacyHashedFileName -notmatch '^flora\.social-v.+-android') {
            throw "Update manifest apkFileName must be the 0.12 flora.social mirror, got '$legacyHashedFileName'"
        }
        $legacyPlainFileName = Get-FloraAndroidLegacyApkFileName $root
        $uploadNames = @($canonicalFileName, $legacyHashedFileName, $legacyPlainFileName) |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
            Select-Object -Unique
        foreach ($name in $uploadNames) {
            $localApk = Join-Path $distDir $name
            if (-not (Test-Path -LiteralPath $localApk)) {
                throw "Missing channel APK alias $localApk"
            }
            $remoteApk = "${remoteTarget}:${FloraApkChannelRemoteDir}/$name"
            Write-Host "Uploading APK $name ..."
            & scp @sshBase $localApk $remoteApk
            if ($LASTEXITCODE -ne 0) { throw "scp APK $name failed (exit $LASTEXITCODE)" }
        }

        $remoteLatest = "${remoteTarget}:${FloraApkChannelRemoteDir}/$FloraApkChannelLatestJson"
        Write-Host "Uploading $FloraApkChannelLatestJson ..."
        & scp @sshBase $updateManifestPath $remoteLatest
        if ($LASTEXITCODE -ne 0) { throw "scp update.json failed (exit $LASTEXITCODE)" }

        $localReleases = Join-Path $tmpLocal $FloraApkChannelReleasesJson
        $remoteReleasesPath = "${FloraApkChannelRemoteDir}/$FloraApkChannelReleasesJson"
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            & scp @sshBase "${remoteTarget}:${remoteReleasesPath}" $localReleases 2>$null
        }
        finally {
            $ErrorActionPreference = $prevEap
        }

        $existing = @()
        if (Test-Path -LiteralPath $localReleases) {
            try {
                $catalog = Get-Content -LiteralPath $localReleases -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($catalog.releases) { $existing = @($catalog.releases) }
            }
            catch {
                Write-Warning "Existing releases.json unreadable; starting fresh. $($_.Exception.Message)"
                $existing = @()
            }
        }

        $newEntry = [ordered]@{
            version      = [string]$manifestObj.version
            versionCode  = [int]$manifestObj.versionCode
            apkFileName  = $apkFileName
            apkUrl       = "$FloraApkChannelBase/$apkFileName"
            sha256       = ([string]$manifestObj.sha256).ToLowerInvariant()
            sizeBytes    = [int64]$manifestObj.sizeBytes
            publishedAt  = $publishedAt
        }
        $merged = @($newEntry) + @($existing | Where-Object { ([string]$_.version).Trim() -ne [string]$manifestObj.version })
        $outCatalog = [ordered]@{
            updatedAt = $publishedAt
            releases  = @($merged)
        }
        $utf8NoBom = New-Object System.Text.UTF8Encoding $false
        $json = ($outCatalog | ConvertTo-Json -Depth 6) + "`n"
        [System.IO.File]::WriteAllText($localReleases, $json, $utf8NoBom)

        Write-Host "Uploading $FloraApkChannelReleasesJson ($($merged.Count) release(s)) ..."
        & scp @sshBase $localReleases "${remoteTarget}:${remoteReleasesPath}"
        if ($LASTEXITCODE -ne 0) { throw "scp releases.json failed (exit $LASTEXITCODE)" }

        Write-Host "APK channel published: $FloraApkChannelBase/$canonicalFileName"
        Write-Host "0.12 sideload pointer: $FloraApkChannelBase/$legacyHashedFileName"
    }
    finally {
        Remove-Item -LiteralPath $tmpLocal -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if ($BroadcastUpdate) {
    Write-Host ""
    Write-Host "Broadcast app-update notification (production) ..."
    & (Join-Path $PSScriptRoot "broadcast-app-update.ps1") -Production -Confirm
}
