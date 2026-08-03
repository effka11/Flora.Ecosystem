#Requires -Version 5.1
<#
  Local checks for prod edge layers that next-dev never sees:

    1) ServeNative — ChatOrganizer (and friends) actually mounted on flora-api
    2) CDN PUT block — edge returns nginx 405 for PUT (Selectel parity)
    3) ?b= build-id gate — /login redirects until b matches (VPS nginx parity)

  Prerequisites:
    - flora-api on :5290 (Scripts/run-rust-gateway-localhost.ps1)
    - optional: Next on :3000 for full browser path through edge

  Usage:
    pwsh -File Scripts/check-local-edge-layers.ps1
    pwsh -File Scripts/check-local-edge-layers.ps1 -StartProxy   # keep edge on :8080 after checks
    pwsh -File Scripts/check-local-edge-layers.ps1 -SkipBuildBust
#>
param(
    [switch] $StartProxy,
    [switch] $SkipServeNative,
    [switch] $SkipCdnPut,
    [switch] $SkipBuildBust,
    [int] $EdgePort = 8080,
    [string] $ApiBase = "http://127.0.0.1:5290",
    [string] $WebUpstream = "http://127.0.0.1:3000",
    [string] $BuildId = "local-edge-1"
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$edgeScript = Join-Path $PSScriptRoot "local-edge-layers.mjs"
if (-not (Test-Path -LiteralPath $edgeScript)) {
    throw "Missing $edgeScript"
}

$failures = New-Object System.Collections.Generic.List[string]
$edgeProc = $null

function Write-Step([string] $Message) {
    Write-Host ""
    Write-Host "=== $Message ===" -ForegroundColor Cyan
}

function Invoke-Http {
    param(
        [Parameter(Mandatory = $true)][string] $Method,
        [Parameter(Mandatory = $true)][string] $Uri,
        [string] $Body = "{}",
        [int] $MaxRedirs = 0
    )
    $args = @(
        "-sS", "-o", "$env:TEMP\flora-edge-body.txt", "-w", "%{http_code}",
        "-X", $Method, $Uri,
        "-H", "Content-Type: application/json",
        "--max-redirs", "$MaxRedirs"
    )
    if ($Method -in @("POST", "PUT", "PATCH")) {
        $args += @("-d", $Body)
    }
    if ($MaxRedirs -eq 0) {
        $args = @("-sS", "-D", "$env:TEMP\flora-edge-headers.txt", "-o", "$env:TEMP\flora-edge-body.txt", "-w", "%{http_code}", `
            "-X", $Method, $Uri, "-H", "Content-Type: application/json", "--max-redirs", "0")
        if ($Method -in @("POST", "PUT", "PATCH")) { $args += @("-d", $Body) }
    }
    $code = & curl.exe @args
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 47) {
        # 47 = too many redirects when following; for MaxRedirs 0 curl still exits 0 on 302
        throw "curl failed ($LASTEXITCODE) $Method $Uri"
    }
    $body = ""
    if (Test-Path "$env:TEMP\flora-edge-body.txt") {
        $body = Get-Content -LiteralPath "$env:TEMP\flora-edge-body.txt" -Raw -ErrorAction SilentlyContinue
        if ($null -eq $body) { $body = "" }
    }
    $headers = ""
    if (Test-Path "$env:TEMP\flora-edge-headers.txt") {
        $headers = Get-Content -LiteralPath "$env:TEMP\flora-edge-headers.txt" -Raw -ErrorAction SilentlyContinue
        if ($null -eq $headers) { $headers = "" }
    }
    return [pscustomobject]@{ Code = [int]$code; Body = $body; Headers = $headers }
}

function Assert-True([bool] $Ok, [string] $Pass, [string] $Fail) {
    if ($Ok) {
        Write-Host "  OK  $Pass" -ForegroundColor Green
    } else {
        Write-Host "  FAIL  $Fail" -ForegroundColor Red
        $failures.Add($Fail) | Out-Null
    }
}

function Get-LocationHeader([string] $Headers) {
    if ($Headers -match '(?im)^Location:\s*(.+)$') { return $Matches[1].Trim() }
    return ""
}

function Stop-ListenersOnPort([int] $Port) {
    try {
        $pids = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique)
        foreach ($procId in $pids) {
            if ($procId -and $procId -ne 0) {
                Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue | Out-Null
            }
        }
    } catch { }
    Start-Sleep -Milliseconds 250
}

function Start-EdgeProxy {
    param(
        [string] $Upstream,
        [string] $EdgeBuildId,
        [string] $BlockPut = "1"
    )
    Stop-ListenersOnPort -Port $EdgePort
    $stdout = Join-Path $env:TEMP "flora-edge-stdout-$EdgePort.txt"
    $stderr = Join-Path $env:TEMP "flora-edge-stderr-$EdgePort.txt"
    Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue

    # Inherit ambient env via the current process; override edge knobs for the child.
    $prev = @{
        PORT     = $env:FLORA_EDGE_PORT
        UPSTREAM = $env:FLORA_EDGE_UPSTREAM
        BUILD    = $env:FLORA_EDGE_BUILD_ID
        PUT      = $env:FLORA_EDGE_BLOCK_PUT
    }
    $env:FLORA_EDGE_PORT = "$EdgePort"
    $env:FLORA_EDGE_UPSTREAM = $Upstream
    $env:FLORA_EDGE_BUILD_ID = $EdgeBuildId
    $env:FLORA_EDGE_BLOCK_PUT = $BlockPut
    try {
        $proc = Start-Process -FilePath "node" -ArgumentList @($edgeScript) `
            -WorkingDirectory $repoRoot -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    } finally {
        if ($null -eq $prev.PORT) { Remove-Item Env:FLORA_EDGE_PORT -ErrorAction SilentlyContinue } else { $env:FLORA_EDGE_PORT = $prev.PORT }
        if ($null -eq $prev.UPSTREAM) { Remove-Item Env:FLORA_EDGE_UPSTREAM -ErrorAction SilentlyContinue } else { $env:FLORA_EDGE_UPSTREAM = $prev.UPSTREAM }
        if ($null -eq $prev.BUILD) { Remove-Item Env:FLORA_EDGE_BUILD_ID -ErrorAction SilentlyContinue } else { $env:FLORA_EDGE_BUILD_ID = $prev.BUILD }
        if ($null -eq $prev.PUT) { Remove-Item Env:FLORA_EDGE_BLOCK_PUT -ErrorAction SilentlyContinue } else { $env:FLORA_EDGE_BLOCK_PUT = $prev.PUT }
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    $listening = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($proc.HasExited) { break }
        try {
            $tcp = [System.Net.Sockets.TcpClient]::new()
            $tcp.ReceiveTimeout = 200
            $tcp.SendTimeout = 200
            $tcp.Connect("127.0.0.1", $EdgePort)
            $tcp.Close()
            $listening = $true
            break
        } catch {
            Start-Sleep -Milliseconds 100
        }
    }

    $banner = ""
    if (Test-Path -LiteralPath $stdout) {
        $banner = Get-Content -LiteralPath $stdout -Raw -ErrorAction SilentlyContinue
        if ($null -eq $banner) { $banner = "" }
    }
    $errText = ""
    if (Test-Path -LiteralPath $stderr) {
        $errText = Get-Content -LiteralPath $stderr -Raw -ErrorAction SilentlyContinue
        if ($null -eq $errText) { $errText = "" }
    }

    # Stdout banner is authoritative if TCP race fails under restricted net cmdlets.
    if (-not $listening -and $banner -match "local-edge") {
        $listening = $true
    }

    if (-not $listening) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        throw "Edge proxy did not bind :$EdgePort.`n$banner`n$errText"
    }
    if ($EdgeBuildId -and ($banner -notmatch [regex]::Escape($EdgeBuildId))) {
        Start-Sleep -Milliseconds 200
        $banner = Get-Content -LiteralPath $stdout -Raw -ErrorAction SilentlyContinue
        if ($null -eq $banner) { $banner = "" }
    }
    if ($EdgeBuildId -and ($banner -notmatch [regex]::Escape($EdgeBuildId))) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        throw "Edge started without expected BUILD_ID=$EdgeBuildId. Banner:`n$banner"
    }
    return $proc
}

function Stop-EdgeProxy([System.Diagnostics.Process] $Proc) {
    if ($null -ne $Proc -and -not $Proc.HasExited) {
        try { $Proc.Kill() } catch { }
        try { $null = $Proc.WaitForExit(3000) } catch { }
    }
    Stop-ListenersOnPort -Port $EdgePort
}

Write-Host "Flora local edge-layer checks"
Write-Host "  API  $ApiBase"
Write-Host "  Web  $WebUpstream (browser path)"
Write-Host "  Edge http://127.0.0.1:$EdgePort"

# --- 1) ServeNative ---------------------------------------------------------
if (-not $SkipServeNative) {
    Write-Step "ServeNative (flora-api direct)"
    try {
        $health = Invoke-Http -Method GET -Uri "$ApiBase/health"
        Assert-True ($health.Code -eq 200) "flora-api /health -> 200" "flora-api not up on $ApiBase (start Scripts/run-rust-gateway-localhost.ps1)"
    } catch {
        Assert-True $false "" "flora-api not reachable at $ApiBase - $($_.Exception.Message)"
    }

    $organizer = Invoke-Http -Method GET -Uri "$ApiBase/api/chat-organizer"
    Assert-True ($organizer.Code -eq 401) `
        "GET /api/chat-organizer -> 401 (module mounted)" `
        "GET /api/chat-organizer -> $($organizer.Code) (want 401). If 404: set ChatOrganizer__ServeNative=true"

    $watchPost = Invoke-Http -Method POST -Uri "$ApiBase/api/auth/presence/watch" `
        -Body '{"connectionId":"00000000-0000-4000-8000-000000000001","userUuids":[]}'
    Assert-True ($watchPost.Code -eq 401) `
        "POST /api/auth/presence/watch -> 401 (handler present)" `
        "POST /api/auth/presence/watch -> $($watchPost.Code) (want 401; deploy API with POST+PUT route)"

    $watchPut = Invoke-Http -Method PUT -Uri "$ApiBase/api/auth/presence/watch" `
        -Body '{"connectionId":"00000000-0000-4000-8000-000000000001","userUuids":[]}'
    Assert-True ($watchPut.Code -eq 401) `
        "PUT /api/auth/presence/watch -> 401 on API (CDN is what blocks PUT)" `
        "PUT /api/auth/presence/watch -> $($watchPut.Code) on API"
}

# --- 2) CDN PUT block -------------------------------------------------------
if (-not $SkipCdnPut) {
    Write-Step "CDN PUT block (edge → API)"
    # Point upstream at API so this check does not require Next.
    Stop-EdgeProxy $edgeProc
    $edgeProc = Start-EdgeProxy -Upstream $ApiBase -EdgeBuildId "" -BlockPut "1"
    $edge = "http://127.0.0.1:$EdgePort"

    $put = Invoke-Http -Method PUT -Uri "$edge/api/auth/presence/watch" `
        -Body '{"connectionId":"00000000-0000-4000-8000-000000000001","userUuids":[]}'
    $putLooksNginx = $put.Code -eq 405 -and ($put.Body -match "405 Not Allowed" -or $put.Body -match "nginx")
    Assert-True $putLooksNginx `
        "edge PUT /api/auth/presence/watch -> 405 nginx" `
        "edge PUT -> $($put.Code) (want nginx 405 HTML)"

    $post = Invoke-Http -Method POST -Uri "$edge/api/auth/presence/watch" `
        -Body '{"connectionId":"00000000-0000-4000-8000-000000000001","userUuids":[]}'
    Assert-True ($post.Code -ne 405) `
        "edge POST /api/auth/presence/watch -> $($post.Code) (passes edge)" `
        "edge POST was blocked with 405 - PUT filter too aggressive"

    $orgPut = Invoke-Http -Method PUT -Uri "$edge/api/chat-organizer" -Body '{"wire":"x"}'
    Assert-True ($orgPut.Code -eq 405) `
        "edge PUT /api/chat-organizer -> 405" `
        "edge PUT /api/chat-organizer -> $($orgPut.Code)"
}

# --- 3) ?b= build-id gate ---------------------------------------------------
if (-not $SkipBuildBust) {
    Write-Step "?b= build-id gate (edge → web or self)"
    Stop-EdgeProxy $edgeProc
    # Prefer real Next if up; otherwise still validate redirect math against any upstream.
    $upstreamForBust = $ApiBase
    try {
        $webProbe = Invoke-Http -Method GET -Uri "$WebUpstream/login"
        if ($webProbe.Code -ge 200 -and $webProbe.Code -lt 500) {
            $upstreamForBust = $WebUpstream
            Write-Host "  using web upstream $WebUpstream"
        }
    } catch {
        Write-Host "  web not up — redirect checks only (upstream $ApiBase)"
    }

    $edgeProc = Start-EdgeProxy -Upstream $upstreamForBust -EdgeBuildId $BuildId -BlockPut "1"
    $edge = "http://127.0.0.1:$EdgePort"

    $root = Invoke-Http -Method GET -Uri "$edge/"
    $locRoot = Get-LocationHeader $root.Headers
    Assert-True ($root.Code -eq 302 -and $locRoot -match [regex]::Escape("b=$BuildId")) `
        "GET / -> 302 login?b=$BuildId" `
        "GET / -> $($root.Code) Location=$locRoot"

    $badB = Invoke-Http -Method GET -Uri "$edge/login?b=wrong-id"
    $locBad = Get-LocationHeader $badB.Headers
    Assert-True ($badB.Code -eq 302 -and $locBad -match [regex]::Escape("b=$BuildId")) `
        "GET /login?b=wrong-id -> 302 to matching b" `
        "GET /login?b=wrong-id -> $($badB.Code) Location=$locBad"

    $goodB = Invoke-Http -Method GET -Uri "$edge/login?b=$BuildId"
    Assert-True ($goodB.Code -ne 302) `
        "GET /login?b=$BuildId -> $($goodB.Code) (passes gate)" `
        "GET /login?b=$BuildId still 302 - gate mismatch (prod loop mode)"

    Write-Host ""
    Write-Host "  Loop repro tip: edge FLORA_EDGE_BUILD_ID=A while Next NEXT_PUBLIC_BUILD_ID=B." -ForegroundColor DarkYellow
    Write-Host "  Browser bounces forever - same bug as VPS SkipBuild deploy." -ForegroundColor DarkYellow
}

Write-Host ""
if ($failures.Count -gt 0) {
    Write-Host "FAILED ($($failures.Count)):" -ForegroundColor Red
    foreach ($f in $failures) { Write-Host "  - $f" -ForegroundColor Red }
    if (-not $StartProxy) { Stop-EdgeProxy $edgeProc }
    exit 1
}

Write-Host "All edge-layer checks passed." -ForegroundColor Green

if ($StartProxy) {
    Write-Host ""
    Write-Host "Edge left running for manual browsing:" -ForegroundColor Cyan
    Write-Host "  http://127.0.0.1:$EdgePort  →  $WebUpstream"
    Write-Host "  PUT blocked; ?b=$BuildId on / and /login"
    Write-Host "  Stop: Stop-Process -Id $($edgeProc.Id)"
    # Restart pointed at web for interactive use
    Stop-EdgeProxy $edgeProc
    $env:FLORA_EDGE_PORT = "$EdgePort"
    $env:FLORA_EDGE_UPSTREAM = $WebUpstream
    $env:FLORA_EDGE_BUILD_ID = $BuildId
    $env:FLORA_EDGE_BLOCK_PUT = "1"
    Write-Host "Starting interactive edge (Ctrl+C to stop)..."
    Set-Location $repoRoot
    & node $edgeScript
} else {
    Stop-EdgeProxy $edgeProc
}
