function Get-FloraSocialVersion([string]$Root) {
    $versionPath = Join-Path $Root "VERSION"
    if (-not (Test-Path -LiteralPath $versionPath)) {
        throw "Missing VERSION at repo root: $versionPath"
    }
    $manifest = Get-Content -LiteralPath $versionPath -Raw | ConvertFrom-Json
    $version = $manifest.products.social
    if ([string]::IsNullOrWhiteSpace($version)) {
        throw "VERSION.products.social must be a non-empty semver string"
    }
    return $version.Trim()
}

function Get-FloraMobileVersion([string]$Root) {
    $versionPath = Join-Path $Root "VERSION"
    if (-not (Test-Path -LiteralPath $versionPath)) {
        throw "Missing VERSION at repo root: $versionPath"
    }
    $manifest = Get-Content -LiteralPath $versionPath -Raw | ConvertFrom-Json
    $version = $manifest.products.mobile
    if ([string]::IsNullOrWhiteSpace($version)) {
        throw "VERSION.products.mobile must be a non-empty semver string"
    }
    return $version.Trim()
}

function Get-FloraAndroidDistApkPath([string]$MobileDir, [string]$Root) {
    # Sideload channel still names APKs after products.social; cut over in a follow-up.
    $version = Get-FloraSocialVersion $Root
    Join-Path $MobileDir "dist\flora.social-v$version-android.apk"
}
