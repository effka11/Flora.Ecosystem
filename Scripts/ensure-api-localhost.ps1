#Requires -Version 5.1
<#
Проверяет, что Flora.API уже слушает localhost:5284.
Не останавливает и не перезапускает API — только предупреждение, если недоступен.
#>
param(
    [int] $Port = 5284,
    [string] $ApiHost = "127.0.0.1"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

$url = "http://${ApiHost}:$Port/health"
try {
    $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
    if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
        Write-Host "Flora.API reachable at $url"
        exit 0
    }
    Write-Warning "Flora.API returned HTTP $($response.StatusCode) at $url"
    exit 0
}
catch {
    Write-Warning @"
Flora.API is not reachable at $url.
Start task ""Flora API: dev localhost"" (or keep it running from Mobile debug), then reload Web.
Web will still start; API proxy routes will fail until API is up.
"@
    exit 0
}
