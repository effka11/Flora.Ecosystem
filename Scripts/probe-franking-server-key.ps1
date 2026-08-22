#Requires -Version 5.1
<#
  Local operational check for FSCP-FRANK stage 1:
    1) ensure Messaging:FrankingSigningSeed in Local/.flora/franking-signing.seed
    2) GET /api/messaging/franking/server-key as an authenticated local user

  Does not print the seed, Jwt secret, or access token.
  Does not write Backend/appsettings.Local.json.

  flora-api picks the seed up from Messaging__FrankingSigningSeed on start
  (Scripts/run-rust-gateway-localhost.ps1). Restart the API after first create.

    pwsh ./Scripts/probe-franking-server-key.ps1
    pwsh ./Scripts/probe-franking-server-key.ps1 -SeedOnly
#>
param(
    [switch] $SeedOnly,
    [string] $Gateway = "http://127.0.0.1:5290"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ensureJwt = Join-Path $PSScriptRoot "ensure-shared-dev-jwt.ps1"
$ensureSeed = Join-Path $PSScriptRoot "ensure-franking-signing-seed.ps1"

function New-FloraAccessToken([string] $secret, [string] $userUuid, [string] $jti) {
    function Encode-B64Url([byte[]] $bytes) {
        return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    }
    $header = '{"alg":"HS256","typ":"JWT"}'
    $exp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + 900
    $payloadObj = [ordered]@{
        sub   = $userUuid
        email = "probe@flora.local"
        jti   = $jti
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier" = $userUuid
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"   = "probe@flora.local"
        exp   = $exp
        iss   = "Flora.Auth"
        aud   = "Flora.Ecosystem"
    }
    $payload = ($payloadObj | ConvertTo-Json -Compress)
    $enc = [System.Text.Encoding]::UTF8
    $signingInput = (Encode-B64Url $enc.GetBytes($header)) + "." + (Encode-B64Url $enc.GetBytes($payload))
    $hmac = [System.Security.Cryptography.HMACSHA256]::new($enc.GetBytes($secret))
    try {
        $sig = $hmac.ComputeHash($enc.GetBytes($signingInput))
    } finally {
        $hmac.Dispose()
    }
    return $signingInput + "." + (Encode-B64Url $sig)
}

function Invoke-JsonGet([string] $url, [string] $bearer) {
    Add-Type -AssemblyName System.Net.Http
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $client = [System.Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(15)
    try {
        $req = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $url)
        if ($bearer) {
            $req.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new("Bearer", $bearer)
        }
        $resp = $client.SendAsync($req).GetAwaiter().GetResult()
        $body = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        return @{ Status = [int]$resp.StatusCode; Body = $body }
    } finally {
        $client.Dispose()
    }
}

$seedJson = & $ensureSeed -Status
if ($LASTEXITCODE -ne 0) { throw "failed to ensure Local/.flora/franking-signing.seed." }
$seedResult = $seedJson | ConvertFrom-Json
Write-Output ("FrankingSigningSeed: {0} ({1}) in Local/.flora/franking-signing.seed" -f $seedResult.action, $seedResult.format)

if ($SeedOnly) { exit 0 }

$anon = Invoke-JsonGet "$Gateway/api/messaging/franking/server-key" $null
Write-Output ("GET unauthenticated: HTTP {0}" -f $anon.Status)

$secret = & $ensureJwt
if ([string]::IsNullOrWhiteSpace($secret)) { throw "Jwt secret is empty." }

$userUuid = $null
$container = [string](docker inspect -f "{{.State.Health.Status}}" flora-local-postgres 2>$null)
$container = $container.Trim()
if ($container -eq "healthy") {
    $userUuid = ([string](& docker exec flora-local-postgres psql -U flora -d flora_social -t -A -c "SELECT user_uuid::text FROM flora_core.user_accounts LIMIT 1;")).Trim()
    if ([string]::IsNullOrWhiteSpace($userUuid)) { $userUuid = $null }
}

if (-not $userUuid) {
    Write-Output "GET authenticated: skipped (no flora_core.user_accounts row). Unauthenticated status above is the route check."
    exit 0
}

$jti = [guid]::NewGuid().ToString()
$sessionId = [guid]::NewGuid().ToString()
$sql = @"
INSERT INTO flora_core.user_sessions (
    session_id, user_uuid, agent_hash, ip_address,
    created_at, expires_at, last_activity,
    jwt_id, refresh_token, rotation_id, status,
    csrf_token, hmac_key
) VALUES (
    '$sessionId', '$userUuid', 'franking-probe', '127.0.0.1',
    now(), now() + interval '1 day', now(),
    '$jti', 'probe-refresh-$sessionId', 0, 0,
    'probe-csrf', 'probe-hmac'
);
"@
$tmpSql = Join-Path ([System.IO.Path]::GetTempPath()) ("flora-franking-probe-" + [guid]::NewGuid().ToString("n") + ".sql")
try {
    [System.IO.File]::WriteAllText($tmpSql, $sql)
    $remote = "/tmp/" + [System.IO.Path]::GetFileName($tmpSql)
    & docker cp $tmpSql "flora-local-postgres:$remote"
    if ($LASTEXITCODE -ne 0) { throw "docker cp of probe session SQL failed." }
    & docker exec flora-local-postgres psql -U flora -d flora_social -v ON_ERROR_STOP=1 -f $remote | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "insert probe session failed." }
    & docker exec flora-local-postgres rm -f $remote | Out-Null
} finally {
    if (Test-Path $tmpSql) { Remove-Item -LiteralPath $tmpSql -Force }
}

$token = New-FloraAccessToken -secret $secret -userUuid $userUuid -jti $jti
$auth = Invoke-JsonGet "$Gateway/api/messaging/franking/server-key" $token
Write-Output ("GET authenticated: HTTP {0}" -f $auth.Status)

if ($auth.Status -ne 200) {
    $snippet = $auth.Body
    if ($snippet.Length -gt 240) { $snippet = $snippet.Substring(0, 240) + "..." }
    Write-Output "body: $snippet"
    exit 1
}

$parsed = $auth.Body | ConvertFrom-Json
$keyId = [string]$parsed.serverFrankingKeyId
$pub = [string]$parsed.publicKeyBase64Url
$ready = [bool]$parsed.reviewerRosterReady
$hasKey = -not [string]::IsNullOrWhiteSpace($keyId)
$pubLen = 0
if ($pub) {
    $pad = $pub.Replace('-', '+').Replace('_', '/')
    switch ($pad.Length % 4) { 2 { $pad += "==" }; 3 { $pad += "=" } }
    try { $pubLen = ([Convert]::FromBase64String($pad)).Length } catch { $pubLen = -1 }
}

Write-Output ("serverFrankingKeyId: {0}" -f $(if ($hasKey) { $keyId } else { "<null>" }))
Write-Output ("publicKey: {0}" -f $(if ($pubLen -gt 0) { "$pubLen bytes" } else { "<null>" }))
Write-Output ("reviewerRosterReady: {0}" -f $ready)

if (-not $hasKey -or $pubLen -ne 32) {
    Write-Output "FAIL: signer is not live (seed missing or invalid at process start). Restart flora-api after creating Local/.flora/franking-signing.seed."
    exit 1
}
Write-Output "PASS: server-key returns a live franking signer."
