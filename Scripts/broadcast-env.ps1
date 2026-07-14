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
