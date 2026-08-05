function Read-DotEnvValue {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][string] $Key
    )
    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }
    foreach ($line in Get-Content -LiteralPath $Path) {
        $trimmed = $line.Trim()
        if ($trimmed.Length -eq 0 -or $trimmed.StartsWith("#")) {
            continue
        }
        if ($trimmed -match "^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$") {
            if ($matches[1] -ne $Key) {
                continue
            }
            $value = $matches[2].Trim()
            if (
                ($value.StartsWith('"') -and $value.EndsWith('"')) -or
                ($value.StartsWith("'") -and $value.EndsWith("'"))
            ) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            return $value
        }
    }
    return $null
}

function Test-IsLocalBroadcastApiUrl {
    param([string] $Url)
    if ([string]::IsNullOrWhiteSpace($Url)) {
        return $true
    }
    return $Url.Trim() -match '^https?://(localhost|127\.0\.0\.1)(:\d+)?(/|$)'
}

function Import-BroadcastEnvFile {
    param([string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    foreach ($line in Get-Content -LiteralPath $Path) {
        $trimmed = $line.Trim()
        if ($trimmed.Length -eq 0 -or $trimmed.StartsWith("#")) {
            continue
        }
        if ($trimmed -match "^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$") {
            $name = $matches[1]
            $value = $matches[2].Trim()
            if (
                ($value.StartsWith('"') -and $value.EndsWith('"')) -or
                ($value.StartsWith("'") -and $value.EndsWith("'"))
            ) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
                Set-Item -Path "Env:$name" -Value $value
            }
        }
    }
}

function Resolve-BroadcastConfig {
    param(
        [Parameter(Mandatory = $true)][string] $Root,
        [string] $ApiBaseUrl = "",
        [string] $Token = "",
        [switch] $Production
    )

    $localhostDefaultToken = "dev-local-broadcast-token-change-me"
    $broadcastEnvPath = Join-Path $Root "Scripts\broadcast.env"
    Import-BroadcastEnvFile $broadcastEnvPath

    if ($Production -and [string]::IsNullOrWhiteSpace($ApiBaseUrl)) {
        $mobileEnv = Join-Path $Root "Apps\Mobile\.env"
        $fromMobile = Read-DotEnvValue $mobileEnv "EXPO_PUBLIC_API_URL"
        if (-not [string]::IsNullOrWhiteSpace($fromMobile)) {
            $ApiBaseUrl = $fromMobile
        }
    }

    if ([string]::IsNullOrWhiteSpace($ApiBaseUrl)) {
        $ApiBaseUrl = $env:FLORA_API_URL
    }
    if ([string]::IsNullOrWhiteSpace($ApiBaseUrl)) {
        $ApiBaseUrl = "http://localhost:5290"
    }
    $ApiBaseUrl = $ApiBaseUrl.Trim().TrimEnd("/")

    if ([string]::IsNullOrWhiteSpace($Token)) {
        $Token = $env:FLORA_ADMIN_BROADCAST_TOKEN
    }
    if ([string]::IsNullOrWhiteSpace($Token) -and (Test-IsLocalBroadcastApiUrl $ApiBaseUrl)) {
        $Token = $localhostDefaultToken
    }

    return @{
        ApiBaseUrl = $ApiBaseUrl
        Token      = $Token
    }
}

function Get-AppUpdateBroadcastText {
    param([Parameter(Mandatory = $true)][string] $Version)
    # PS 5.1 may load Cyrillic from .ps1 with wrong encoding; build prefix from UTF-8 bytes.
    $prefixBytes = [byte[]](
        0xD0, 0x9D, 0xD0, 0xBE, 0xD0, 0xB2, 0xD0, 0xB0, 0xD1, 0x8F, 0x20,
        0xD0, 0xB2, 0xD0, 0xB5, 0xD1, 0x80, 0xD1, 0x81, 0xD0, 0xB8, 0xD1, 0x8F, 0x20,
        0x41, 0x6E, 0x64, 0x72, 0x6F, 0x69, 0x64, 0x20, 0x2D, 0x20
    )
    $prefix = [System.Text.Encoding]::UTF8.GetString($prefixBytes)
    return $prefix + $Version.Trim()
}

function Test-AppUpdateManifestObject {
    param($Raw)
    if ($null -eq $Raw) { return $false }
    if (-not $Raw.version -or -not $Raw.versionCode -or -not $Raw.apkUrl -or -not $Raw.sha256) {
        return $false
    }
    $sha = ([string]$Raw.sha256).Trim().ToLowerInvariant()
    if ($sha.Length -ne 64) { return $false }
    if ([int64]$Raw.versionCode -lt 1) { return $false }
    return $true
}

<#
.SYNOPSIS
  Load flora.social-android-update.json for broadcast FCM metadata.
  Prefers Flora APK channel (social.flora-s.net/apk); local dist is fallback when version matches.
#>
function Get-AppUpdateManifestForBroadcast {
    param(
        [Parameter(Mandatory = $true)][string] $Root,
        [Parameter(Mandatory = $true)][string] $Version,
        # Deprecated name: when set, prefer remote channel before local dist.
        [switch] $PreferGitHub,
        [switch] $PreferChannel
    )
    $v = $Version.Trim()
    $preferRemote = $PreferChannel -or $PreferGitHub
    $channelLatestUrl = "https://social.flora-s.net/apk/flora.social-android-update.json"

    function Read-ManifestFile([string] $Path) {
        if (-not (Test-Path -LiteralPath $Path)) { return $null }
        try {
            $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
            if (Test-AppUpdateManifestObject $raw) { return $raw }
        }
        catch {
            Write-Host "Ignoring invalid update manifest at $Path : $($_.Exception.Message)" -ForegroundColor DarkYellow
        }
        return $null
    }

    function Get-ManifestFromChannel {
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("flora-update-manifest-" + [guid]::NewGuid().ToString("n") + ".json")
        try {
            Invoke-WebRequest -Uri $channelLatestUrl -OutFile $tmp -UseBasicParsing -TimeoutSec 30
            $raw = Read-ManifestFile $tmp
            if ($null -ne $raw) {
                Write-Host "Update manifest: $channelLatestUrl" -ForegroundColor DarkGray
                return $raw
            }
        }
        catch {
            Write-Host "APK channel download failed: $($_.Exception.Message)" -ForegroundColor DarkYellow
        }
        finally {
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        }
        return $null
    }

    if ($preferRemote) {
        $fromChannel = Get-ManifestFromChannel
        if ($null -ne $fromChannel) {
            if (([string]$fromChannel.version).Trim() -eq $v) { return $fromChannel }
            Write-Host "Channel latest version=$($fromChannel.version), want $v — trying local dist" -ForegroundColor DarkYellow
        }
    }

    $candidates = @(
        (Join-Path $Root "Apps\Mobile\dist\flora.social-android-update.json"),
        (Join-Path $Root "Apps\Mobile\android_gen\dist\flora.social-android-update.json"),
        (Join-Path $Root "Artifacts\mobile\flora.social-android-update.json")
    )
    foreach ($path in $candidates) {
        $raw = Read-ManifestFile $path
        if ($null -eq $raw) { continue }
        if (([string]$raw.version).Trim() -ne $v) {
            Write-Host "Skipping $path (version=$($raw.version), want $v)" -ForegroundColor DarkYellow
            continue
        }
        Write-Host "Update manifest: $path" -ForegroundColor DarkGray
        return $raw
    }

    if (-not $preferRemote) {
        $fromChannel = Get-ManifestFromChannel
        if ($null -ne $fromChannel -and ([string]$fromChannel.version).Trim() -eq $v) {
            return $fromChannel
        }
    }

    Write-Host "No update.json found for version $v." -ForegroundColor DarkYellow
    return $null
}
