#Requires -Version 5.1
<#
  Shared Android SDK/JDK + adb helpers for Flora Mobile scripts.
  Dot-source: . (Join-Path $PSScriptRoot "mobile-android-env.ps1")
#>
Set-StrictMode -Version Latest

function Test-AndroidSdkPath([string]$path) {
    if ([string]::IsNullOrWhiteSpace($path)) { return $false }
    if ($path.Length -lt 4) { return $false }
    return Test-Path (Join-Path $path "platform-tools")
}

function Resolve-AndroidSdk {
    $raw = @(
        $env:ANDROID_HOME,
        $env:ANDROID_SDK_ROOT,
        (Join-Path $env:LOCALAPPDATA "Android\Sdk"),
        "$env:USERPROFILE\AppData\Local\Android\Sdk"
    ) | Where-Object { Test-AndroidSdkPath $_ } | Select-Object -Unique
    $candidates = @($raw)
    if ($candidates.Count -eq 0) {
        throw @"
Android SDK not found.
Install Android Studio, open SDK Manager, then set:
  `$env:ANDROID_HOME = `"$env:LOCALAPPDATA\Android\Sdk`"
"@
    }
    return $candidates[0]
}

function Resolve-AndroidJdk {
    $studioJbr = @(
        "$env:ProgramFiles\Android\Android Studio\jbr",
        "${env:ProgramFiles(x86)}\Android\Android Studio\jbr"
    ) | Where-Object { $_ -and (Test-Path (Join-Path $_ "bin\java.exe")) } | Select-Object -First 1
    if ($studioJbr) { return $studioJbr }
    if ($env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME "bin\java.exe"))) {
        return $env:JAVA_HOME
    }
    throw "JDK not found. Install Android Studio (includes JBR 21)."
}

function Write-LocalPropertiesSdk([string]$sdkPath, [string]$filePath) {
    $gradleSdk = ($sdkPath -replace '\\', '/').Trim()
    $line = 'sdk.dir=' + $gradleSdk
    [System.IO.File]::WriteAllText($filePath, $line + [Environment]::NewLine, [System.Text.Encoding]::ASCII)
}

function Initialize-FloraAndroidBuildEnv {
    param(
        [string] $MobileDir,
        [string] $RepoRoot
    )

    $sdk = Resolve-AndroidSdk
    $jdk = Resolve-AndroidJdk
    $localProps = Join-Path $MobileDir "android\local.properties"
    if (Test-Path (Split-Path $localProps -Parent)) {
        Write-LocalPropertiesSdk $sdk $localProps
    }

    $env:ANDROID_HOME = $sdk
    $env:ANDROID_SDK_ROOT = $sdk
    $env:JAVA_HOME = $jdk
    $env:Path = "$jdk\bin;" + $env:Path
    $env:CI = "1"

    Write-Host "ANDROID_HOME=$sdk"
    Write-Host "JAVA_HOME=$jdk"
    if (Test-Path $localProps) {
        Write-Host "local.properties -> $localProps"
    }

    return @{ Sdk = $sdk; Jdk = $jdk }
}

function Invoke-Adb {
    param(
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]] $ArgumentList
    )

    # adb writes informational lines (e.g. daemon startup) to stderr; with
    # $ErrorActionPreference = Stop that becomes a terminating NativeCommandError.
    $prevErrorAction = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $raw = & adb @ArgumentList 2>&1
        $exitCode = $LASTEXITCODE
        $lines = @(
            foreach ($item in @($raw)) {
                if ($item -is [System.Management.Automation.ErrorRecord]) {
                    [string]$item.ToString()
                } else {
                    [string]$item
                }
            }
        )
        return [PSCustomObject]@{
            Output   = $lines
            ExitCode = $exitCode
        }
    }
    finally {
        $ErrorActionPreference = $prevErrorAction
    }
}

function Ensure-AdbReady {
    Invoke-Adb start-server | Out-Null
}

function Get-AdbDeviceSerial {
    $result = Invoke-Adb devices
    if ($result.ExitCode -ne 0) {
        throw "adb devices failed with exit code $($result.ExitCode)."
    }
    $lines = @($result.Output | Select-Object -Skip 1 | Where-Object { $_.Trim() -ne "" })
    $authorized = @($lines | Where-Object { $_ -match "\tdevice$" })
    if ($authorized.Count -eq 0) {
        throw "No authorized Android device. Connect USB debugging and run 'Flora Android: debug (USB)'."
    }
    if ($authorized.Count -gt 1) {
        Write-Warning "Multiple devices; using first: $($authorized[0])"
    }
    return ($authorized[0] -split "`t")[0]
}

$script:FloraAndroidPackageProduction = "social.flora.mobile"
$script:FloraAndroidPackageDevelopment = "social.flora.mobile.dev"

function Get-FloraAndroidPackageId {
    param(
        [ValidateSet("development", "production")]
        [string] $Variant = "production"
    )
    if ($Variant -eq "development") { return $script:FloraAndroidPackageDevelopment }
    return $script:FloraAndroidPackageProduction
}

function Test-FloraPackageInstalled {
    param(
        [ValidateSet("development", "production")]
        [string] $Variant = "production"
    )
    $packageId = Get-FloraAndroidPackageId $Variant
    $result = Invoke-Adb shell pm path $packageId
    $path = $result.Output -join "`n"
    return ($result.ExitCode -eq 0) -and ($path -match "package:")
}

function Test-FloraDevClientInstalled {
    if (-not (Test-FloraPackageInstalled -Variant development)) { return $false }
    $packageId = Get-FloraAndroidPackageId development
    $result = Invoke-Adb shell dumpsys package $packageId
    if ($result.ExitCode -ne 0) { return $false }
    $dump = $result.Output -join "`n"
    return ($dump -match "expo\.modules\.devlauncher|expo\.modules\.devmenu")
}

function Ensure-MobileEnvFile([string]$mobileDir) {
    $envFile = Join-Path $mobileDir ".env"
    $envExample = Join-Path $mobileDir ".env.example"
    if (-not (Test-Path $envFile) -and (Test-Path $envExample)) {
        Copy-Item $envExample $envFile
        Write-Host "Created Apps/Mobile/.env from .env.example"
    }
    if (-not (Test-Path $envFile)) {
        throw "Missing Apps/Mobile/.env (copy from .env.example and set EXPO_PUBLIC_API_URL)."
    }
}

function Ensure-FfmpegAndroid([string]$repoRoot, [string]$mobileDir) {
    Push-Location $repoRoot
    try {
        Write-Host "patch ffmpeg-kit-react-native ..."
        node (Join-Path $repoRoot "Scripts\patch-ffmpeg-kit.mjs")
        if ($LASTEXITCODE -ne 0) { throw "patch-ffmpeg-kit.mjs failed" }
        Write-Host "ensure ffmpeg-kit AAR ..."
        node (Join-Path $repoRoot "Scripts\ensure-ffmpeg-android-aar.mjs")
        if ($LASTEXITCODE -ne 0) { throw "ensure-ffmpeg-android-aar.mjs failed" }
    }
    finally {
        Pop-Location
    }
}

function Get-FreeSubstDrive {
    foreach ($letter in @('Z', 'Y', 'X', 'W', 'V', 'U', 'T', 'S', 'R', 'Q', 'P', 'O', 'N', 'M', 'L', 'K', 'J', 'I', 'H', 'G', 'F', 'E', 'D')) {
        $drive = "${letter}:"
        if (-not (Test-Path $drive)) { return $drive }
    }
    return $null
}

function Invoke-FromShortRoot([string]$longRoot, [scriptblock]$Action) {
    $drive = Get-FreeSubstDrive
    if (-not $drive) {
        Write-Warning "No free drive letter for subst; building from long path (may hit MAX_PATH on Windows)."
        Push-Location $longRoot
        try { & $Action } finally { Pop-Location }
        return
    }

    $mapped = $false
    try {
        subst $drive $longRoot | Out-Null
        $mapped = $true
        $shortRoot = Join-Path $drive "\"
        Write-Host "Using subst $drive -> $longRoot"
        Push-Location $shortRoot
        & $Action
    }
    finally {
        Pop-Location
        if ($mapped) { subst $drive /d | Out-Null }
    }
}

function Stop-AndroidGradleDaemons {
    param([string]$MobileDir)
    $androidDir = Join-Path $MobileDir "android"
    $gradlew = Join-Path $androidDir "gradlew.bat"
    if (-not (Test-Path $gradlew)) { return }
    Write-Host "Stopping Gradle daemons (unlock android/) ..."
    Push-Location $androidDir
    try {
        & .\gradlew.bat --stop 2>$null | Out-Null
    }
    finally {
        Pop-Location
    }
    Start-Sleep -Seconds 2
}

function Remove-LockedDirectory {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return }
    for ($i = 0; $i -lt 8; $i++) {
        try {
            Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
            return
        }
        catch {
            if ($i -ge 7) {
                throw @"
Cannot remove locked folder: $Path
Close Android Studio, Gradle builds, and file explorers on Apps/Mobile/android, then retry.
$($_.Exception.Message)
"@
            }
            Write-Host "Retry remove $Path ($($i + 1)/8) ..."
            Start-Sleep -Seconds 2
        }
    }
}

function Sync-AndroidFromStaging {
    param(
        [string]$SourceAndroidDir,
        [string]$TargetAndroidDir
    )
    New-Item -ItemType Directory -Path $TargetAndroidDir -Force | Out-Null
    Write-Host "Sync $SourceAndroidDir -> $TargetAndroidDir ..."
    & robocopy $SourceAndroidDir $TargetAndroidDir /MIR /E /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
    $robocopyExit = $LASTEXITCODE
    if ($robocopyExit -ge 8) {
        throw "robocopy android sync failed with exit code $robocopyExit"
    }
}

function Assert-FloraAndroidDevPackage([string]$AndroidDir) {
    $gradle = Join-Path $AndroidDir "app\build.gradle"
    if (-not (Test-Path $gradle)) {
        throw "Missing $gradle after prebuild."
    }
    $content = Get-Content $gradle -Raw
    if ($content -notmatch "social\.flora\.mobile\.dev") {
        throw "android/ is not Flora Dev (expected applicationId social.flora.mobile.dev). Set APP_VARIANT=development."
    }
}

function Invoke-ExpoAndroidPrebuildClean {
    param([string]$MobileDir)
    $androidDir = Join-Path $MobileDir "android"
    $stage = Join-Path $MobileDir (".prebuild-stage-dev-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
    $skipNames = @(
        "android", "android_gen", "node_modules", ".expo", "dist",
        ".prebuild-stage", ".prebuild-stage-dev", ".git", ".kotlin"
    )

    Stop-AndroidGradleDaemons $MobileDir

    Remove-LockedDirectory $stage
    New-Item -ItemType Directory -Path $stage -Force | Out-Null

    Get-ChildItem $MobileDir -Force |
        Where-Object {
            $skipNames -notcontains $_.Name -and
            $_.Name -notlike ".prebuild-stage*" -and
            $_.Name -notlike ".prebuild-stage-dev*"
        } |
        ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $stage $_.Name) -Recurse -Force
        }

    $nmLink = Join-Path $stage "node_modules"
    if (-not (Test-Path $nmLink)) {
        cmd /c mklink /J "$nmLink" (Join-Path $MobileDir "node_modules") | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Failed to junction node_modules into prebuild stage." }
    }

    Write-Host "expo prebuild in staging folder (avoids locked Apps/Mobile/android) ..."
    Push-Location $stage
    try {
        npx expo prebuild --platform android --no-install
        if ($LASTEXITCODE -ne 0) {
            throw "expo prebuild failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }

    $generatedAndroid = Join-Path $stage "android"
    if (-not (Test-Path $generatedAndroid)) {
        throw "expo prebuild did not create android/ in staging folder."
    }

    Stop-AndroidGradleDaemons $MobileDir
    Sync-AndroidFromStaging $generatedAndroid $androidDir
    Assert-FloraAndroidDevPackage $androidDir

    try {
        Remove-LockedDirectory $stage
    }
    catch {
        Write-Host "warning: could not remove staging folder (safe to ignore): $($_.Exception.Message)"
    }
}
