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

function Get-FloraAndroidDistApkPath([string]$MobileDir, [string]$Root) {
    $version = Get-FloraSocialVersion $Root
    Join-Path $MobileDir "dist\flora.social-v$version-android.apk"
}
