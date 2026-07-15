#Requires -Version 5.1
<#
Проверяет flora-api на :5290 (локальный паритет с продом).
#>
param(
    [int] $GatewayPort = 5290,
    [string] $ApiHost = "127.0.0.1"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

$gatewayUrl = "http://${ApiHost}:$GatewayPort/health"

try {
    $response = Invoke-WebRequest -Uri $gatewayUrl -UseBasicParsing -TimeoutSec 3
    if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
        Write-Host "flora-api reachable at $gatewayUrl"
    }
    else {
        Write-Warning "flora-api returned HTTP $($response.StatusCode) at $gatewayUrl"
    }
}
catch {
    Write-Warning @"
flora-api is not reachable at $gatewayUrl.
Start: ""Flora Gateway: Rust"" / Scripts/run-rust-gateway-localhost.ps1,
or ""Flora: API + Web"" / Scripts/zed-dev-api-web.ps1.
Web will still start; API proxy routes will fail until the API is up.
"@
}
