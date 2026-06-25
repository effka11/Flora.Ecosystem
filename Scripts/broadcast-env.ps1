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
        $ApiBaseUrl = "http://localhost:5284"
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
