function Get-FloraSocialVersion([string]$Root) {
    $versionPath = Join-Path $Root "version"
    if (-not (Test-Path -LiteralPath $versionPath)) {
        throw "Missing version at repo root: $versionPath"
    }
    $manifest = Get-Content -LiteralPath $versionPath -Raw | ConvertFrom-Json
    $version = $manifest.products.social
    if ([string]::IsNullOrWhiteSpace($version)) {
        throw "version.products.social must be a non-empty semver string"
    }
    return $version.Trim()
}

function Get-FloraMobileVersion([string]$Root) {
    $versionPath = Join-Path $Root "version"
    if (-not (Test-Path -LiteralPath $versionPath)) {
        throw "Missing version at repo root: $versionPath"
    }
    $manifest = Get-Content -LiteralPath $versionPath -Raw | ConvertFrom-Json
    $version = $manifest.products.mobile
    if ([string]::IsNullOrWhiteSpace($version)) {
        throw "version.products.mobile must be a non-empty semver string"
    }
    return $version.Trim()
}

function Get-FloraAndroidApkFileName([string]$Root) {
    $version = Get-FloraMobileVersion $Root
    return "flora-v$version.apk"
}

function Get-FloraAndroidLegacyApkFileName([string]$Root, [string]$Sha8 = "") {
    $version = Get-FloraMobileVersion $Root
    if ($Sha8) {
        return "flora.social-v$version-android-$Sha8.apk"
    }
    return "flora.social-v$version-android.apk"
}

function Get-FloraAndroidDistApkPath([string]$MobileDir, [string]$Root) {
    Join-Path $MobileDir "dist\$(Get-FloraAndroidApkFileName $Root)"
}
