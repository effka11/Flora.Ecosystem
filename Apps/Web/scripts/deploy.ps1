# Full deploy: Next.js standalone + self-contained Flora.API to VPS (one SSH tarball).
# Usage:
#   .\scripts\deploy.ps1
#   .\scripts\deploy.ps1 -SkipBuild
#   .\scripts\deploy.ps1 -ApiUpstreamUrl "http://127.0.0.1:5000"
#   .\scripts\deploy.ps1 -PublicApiBaseUrl "https://origin.flora-s.net"
#   .\scripts\deploy.ps1 -CertbotEmail "you@mail.com"   # optional: LE on VPS (origin.* + apex redirect TLS)
#   .\scripts\deploy.ps1 -AllowedClientIps "1.2.3.4"   # optional: lock apex/www redirect only (CDN stays public)
#
# Public site: https://social.<Domain> (Selectel CDN). Apex A → VPS → 301 to social.* (see remote-bootstrap-flora-web.sh).
# Browsers call /api/* same-origin on https://<PublicSubdomain>.<Domain> (Next proxy). Override with -PublicApiBaseUrl for cross-origin API.
# Windows: scp tarball then ssh (avoids broken cmd pipe to ssh). Non-Windows: tar | ssh in one shot.
param(
    [string] $Server = "",
    [string] $User = "deploy",
    [string] $IdentityFile = "",
    [string] $RemotePath = "/opt/flora-ecosystem/runtime/web",
    [string] $Domain = "flora-s.net",
    [string] $PublicSubdomain = "social",
    [string] $ApiUpstreamUrl = "http://127.0.0.1:5000",
    [string] $PublicApiBaseUrl = "",
    [string] $CertbotEmail = "",
    [string] $AllowedClientIps = "",
    [switch] $SkipBuild,
    [switch] $SkipApi
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($IdentityFile)) {
    $IdentityFile = Join-Path $env:USERPROFILE ".ssh\flora_cursor_temp"
    if (-not (Test-Path -LiteralPath $IdentityFile)) {
        $IdentityFile = Join-Path $env:USERPROFILE ".ssh\id_ed25519_flora"
    }
}
if ([string]::IsNullOrWhiteSpace($Server)) {
    $Server = $env:FLORA_DEPLOY_HOST
}
if ([string]::IsNullOrWhiteSpace($Server)) {
    throw "Server host required: pass -Server <host> or set FLORA_DEPLOY_HOST."
}
if (-not [string]::IsNullOrWhiteSpace($IdentityFile) -and (-not (Test-Path -LiteralPath $IdentityFile))) {
    Write-Warning "SSH key file not found: $IdentityFile (password fallback will apply)."
}

$WebRoot = Split-Path $PSScriptRoot -Parent
$RepoRoot = (Resolve-Path (Join-Path $WebRoot "..\..")).Path
& node (Join-Path $RepoRoot "Scripts\sync-version.mjs")
Set-Location $WebRoot

$resolvedPublic = $PublicApiBaseUrl.Trim().TrimEnd("/")
if ([string]::IsNullOrWhiteSpace($resolvedPublic)) {
    Remove-Item Env:NEXT_PUBLIC_API_BASE_URL -ErrorAction SilentlyContinue
    Write-Host ('NEXT_PUBLIC_API_BASE_URL=(same-origin); browser calls /api/* on https://' + $PublicSubdomain + '.' + $Domain)
} else {
    $env:NEXT_PUBLIC_API_BASE_URL = $resolvedPublic
    Write-Host "NEXT_PUBLIC_API_BASE_URL=$resolvedPublic (embedded at build)."
}

$env:NEXT_PUBLIC_REALTIME_API_BASE_URL = "https://origin.$Domain"
Write-Host "NEXT_PUBLIC_REALTIME_API_BASE_URL=$($env:NEXT_PUBLIC_REALTIME_API_BASE_URL) (SSE bypass CDN)"

$resolvedAllowIps = $AllowedClientIps.Trim()
if ($resolvedAllowIps -eq "-") {
    $resolvedAllowIps = ""
    Write-Host 'nginx allow-list disabled (dash).'
} elseif ([string]::IsNullOrWhiteSpace($resolvedAllowIps)) {
    Write-Host 'nginx allow-list: off (pass -AllowedClientIps with IP to lock apex redirect only).'
} else {
    Write-Host ('nginx allow-list on apex/www only: ' + $resolvedAllowIps + ' (+ 127.0.0.1). CDN ' + $PublicSubdomain + '.* stays public.')
}

$nm = Join-Path $WebRoot "node_modules"
$haveNext = Test-Path (Join-Path $nm "next\package.json")
$haveTsx = Test-Path (Join-Path $nm "tsx\package.json")
if (-not $haveNext -or -not $haveTsx) {
    Write-Host "node_modules missing or incomplete - running npm install..."
    if (Test-Path (Join-Path $WebRoot "package-lock.json")) {
        npm ci
    } else {
        npm install
    }
}

$versionManifestPath = Join-Path $RepoRoot "VERSION"
if (-not (Test-Path -LiteralPath $versionManifestPath)) {
    throw "Missing VERSION at repo root. Run: npm run version:sync"
}
$floraVersions = Get-Content -LiteralPath $versionManifestPath -Raw | ConvertFrom-Json
$env:NEXT_PUBLIC_APP_VERSION = [string]$floraVersions.products.social
$env:NEXT_PUBLIC_ECOSYSTEM_VERSION = [string]$floraVersions.ecosystem
Write-Host "NEXT_PUBLIC_APP_VERSION=$($env:NEXT_PUBLIC_APP_VERSION)"
Write-Host "NEXT_PUBLIC_ECOSYSTEM_VERSION=$($env:NEXT_PUBLIC_ECOSYSTEM_VERSION)"

$webBuildId = (Get-Date -Format "yyyyMMddHHmmss")
try {
    Push-Location $RepoRoot
    $gitHead = (& git rev-parse --short HEAD 2>$null)
    if ($LASTEXITCODE -eq 0 -and $gitHead) {
        $webBuildId = "$($gitHead.Trim())-$((Get-Date -Format 'yyyyMMddHHmmss'))"
    }
    Pop-Location
} catch {
    if ((Get-Location).Path -eq $RepoRoot) { Pop-Location }
}
$env:NEXT_PUBLIC_BUILD_ID = $webBuildId
Write-Host "WEB_BUILD_ID=$webBuildId"
Write-Host ('CDN without purge: open https://' + $PublicSubdomain + '.' + $Domain + '/login?b=' + $webBuildId)

if (-not $SkipBuild) {
    Write-Host "npm run build..."
    npm run build
} else {
    Write-Host "Skipping build (-SkipBuild)."
}

npm run prepare:standalone

function Resolve-StandaloneDir {
    param([string] $WebRoot)
    $candidates = @(
        (Join-Path $WebRoot ".next\standalone"),
        (Join-Path $WebRoot ".next\standalone\Apps\Web")
    )
    foreach ($dir in $candidates) {
        if (Test-Path (Join-Path $dir "server.js")) { return $dir }
    }
    return $candidates[0]
}

$Standalone = Resolve-StandaloneDir -WebRoot (Get-Location)
if (-not (Test-Path "$Standalone\server.js")) { throw "Missing $Standalone\server.js" }

$ts = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

function New-SshTransportOpts {
    param([string] $IdentityKey)
    $parts = @(
        "-o", "BatchMode=no",
        "-o", "PreferredAuthentications=publickey,password,keyboard-interactive"
    )
    if ($IdentityKey -and (Test-Path -LiteralPath $IdentityKey)) {
        $parts += @("-i", $IdentityKey)
    }
    return $parts
}

function Expand-ToUnixLfFile {
    param([string] $SourcePath, [string] $StagingPath)
    $bytes = [System.IO.File]::ReadAllBytes($SourcePath)
    $offset = 0
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        $offset = 3
    } elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) {
        $offset = 2
    }
    if ($offset -ge $bytes.Length) { throw "File is empty after BOM strip: $SourcePath" }

    $text = [System.Text.Encoding]::UTF8.GetString($bytes, $offset, $bytes.Length - $offset)
    $text = ($text -replace "`r`n", "`n") -replace "`r", "`n"

    $enc = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($StagingPath, $text, $enc)

    return $StagingPath
}

$stageDir = Join-Path $env:TEMP "flora-deploy-stage-$ts"
$tarballPath = Join-Path $env:TEMP "flora-deploy-$ts.tgz"
$isWindows = ($true -eq $IsWindows) -or (($null -eq $IsWindows) -and ($env:OS -eq "Windows_NT"))
try {
    New-Item -ItemType Directory -Path $stageDir -Force | Out-Null

    foreach ($deployArg in @( $RemotePath, $Domain, $ApiUpstreamUrl, $CertbotEmail, $resolvedAllowIps, $PublicSubdomain, $webBuildId )) {
        if ($deployArg -match '[\x00-\x08\x0B\x0C\x0E-\x1F]') {
            throw "Bootstrap args must not contain control characters."
        }
    }

    if (-not $SkipApi) {
        $apiProj = Join-Path $RepoRoot "Flora.API\Flora.API.csproj"
        if (-not (Test-Path -LiteralPath $apiProj)) { throw "Missing $apiProj" }
        $apiOut = Join-Path $stageDir "api"
        Write-Host "dotnet publish Flora.API -> $apiOut (linux-x64, self-contained)..."
        dotnet publish $apiProj -c Release -r linux-x64 --self-contained true -o $apiOut
        if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed (exit $LASTEXITCODE)." }
        if (-not (Test-Path (Join-Path $apiOut "Flora.API"))) { throw "Publish output missing Flora.API executable." }
    }

    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    $argsPath = Join-Path $stageDir "args.txt"
    $certLine = $CertbotEmail.Trim()
    [System.IO.File]::WriteAllText(
        $argsPath,
        ($RemotePath, $Domain, $ApiUpstreamUrl, $certLine, $resolvedAllowIps, $PublicSubdomain, $webBuildId) -join "`n",
        $utf8NoBom
    )

    $bootstrapSrc = Join-Path $PSScriptRoot "remote-bootstrap-flora-web.sh"
    if (-not (Test-Path -LiteralPath $bootstrapSrc)) { throw "Missing $bootstrapSrc" }
    $null = Expand-ToUnixLfFile -SourcePath $bootstrapSrc -StagingPath (Join-Path $stageDir "bootstrap.sh")

    $payloadInstallSrc = Join-Path $PSScriptRoot "remote-deploy-payload-install.sh"
    if (-not (Test-Path -LiteralPath $payloadInstallSrc)) { throw "Missing $payloadInstallSrc" }
    $null = Expand-ToUnixLfFile -SourcePath $payloadInstallSrc -StagingPath (Join-Path $stageDir "remote-deploy-payload-install.sh")

    $webDest = Join-Path $stageDir "web"
    New-Item -ItemType Directory -Path $webDest -Force | Out-Null
    Get-ChildItem -LiteralPath $Standalone -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $webDest -Recurse -Force
    }

    $sshExe = @(New-SshTransportOpts -IdentityKey $IdentityFile) + @("-l", $User, $Server)
    $remoteCmd = ('set -euo pipefail; export TS={0}; mkdir -p /tmp/flora-d-$TS; tar -xzf - -C /tmp/flora-d-$TS; bash /tmp/flora-d-$TS/remote-deploy-payload-install.sh' -f $ts)

    $tarPath = (Get-Command -Name tar -CommandType Application -ErrorAction Stop).Path

    Write-Host "Deploying payload to server..."
    if ($isWindows) {
        Remove-Item -LiteralPath $tarballPath -Force -ErrorAction SilentlyContinue
        Write-Host "Packing gzip tarball..."
        & $tarPath -czf $tarballPath -C $stageDir .
        if ($LASTEXITCODE -ne 0) { throw "tar pack failed (exit $LASTEXITCODE)." }

        $remoteTgz = "/tmp/flora-deploy-$ts.tgz"
        $scpExe = @(New-SshTransportOpts -IdentityKey $IdentityFile) + @($tarballPath, "${User}@${Server}:${remoteTgz}")
        Write-Host "Uploading tarball (scp)..."
        & scp @scpExe
        if ($LASTEXITCODE -ne 0) { throw "scp failed (exit $LASTEXITCODE)." }

        $remoteExtract = "set -euo pipefail; export DEBIAN_FRONTEND=noninteractive; yes N | dpkg --configure -a 2>/dev/null || true; export TS=$ts; mkdir -p /tmp/flora-d-$ts; tar -xzf $remoteTgz -C /tmp/flora-d-$ts; bash /tmp/flora-d-$ts/remote-deploy-payload-install.sh; rm -f $remoteTgz"
        Write-Host "Extracting and installing (ssh)..."
        & ssh @sshExe $remoteExtract
        $deployExit = $LASTEXITCODE
    } else {
        & $tarPath -czf - -C $stageDir . | & ssh @sshExe $remoteCmd
        $deployExit = $LASTEXITCODE
    }
    if ($deployExit -ne 0) { throw "ssh deploy failed (exit $deployExit)." }

    Write-Host "Done."
    Write-Host "  Next: curl -sI http://127.0.0.1:3000/ ; curl -s http://127.0.0.1:5000/health"
    Write-Host ('  Open https://' + $PublicSubdomain + '.' + $Domain + '/login?b=' + $webBuildId + ' (or flora-s.net redirect).')
    Write-Host '  Selectel CDN: disable HTML cache or cache only /_next/static/ — then purge is rarely needed.'
}
finally {
    if ($isWindows -and (Test-Path -LiteralPath $tarballPath)) {
        Remove-Item -LiteralPath $tarballPath -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $stageDir) {
        Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
