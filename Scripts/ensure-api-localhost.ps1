#Requires -Version 5.1
<#
Проверяет Rust gateway (локальный паритет с продом) на :5290.
Опционально предупреждает, если .NET upstream :5284 недоступен.
#>
param(
    [int] $GatewayPort = 5290,
    [int] $UpstreamPort = 5284,
    [string] $ApiHost = "127.0.0.1"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

$gatewayUrl = "http://${ApiHost}:$GatewayPort/health"
$upstreamUrl = "http://${ApiHost}:$UpstreamPort/health"

try {
    $response = Invoke-WebRequest -Uri $gatewayUrl -UseBasicParsing -TimeoutSec 3
    if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
        Write-Host "Flora gateway reachable at $gatewayUrl"
    }
    else {
        Write-Warning "Flora gateway returned HTTP $($response.StatusCode) at $gatewayUrl"
    }
}
catch {
    Write-Warning @"
Flora gateway is not reachable at $gatewayUrl.
Start tasks: ""Flora API: .NET upstream"" then ""Flora Gateway: Rust"",
or ""Flora: API + Web"" / Scripts/zed-dev-api-web.ps1.
Web will still start; API proxy routes will fail until the gateway is up.
"@
}

try {
    $null = Invoke-WebRequest -Uri $upstreamUrl -UseBasicParsing -TimeoutSec 2
    Write-Host "Flora.API upstream reachable at $upstreamUrl"
}
catch {
    Write-Warning "Flora.API upstream not reachable at $upstreamUrl (gateway will 502 non-native routes)."
}

exit 0
