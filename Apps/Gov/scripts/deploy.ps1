# Flora Gov — Next.js standalone to VPS (:3001). Does not rewrite nginx or deploy Social/API.
# Usage:
#   .\scripts\deploy.ps1
#   .\scripts\deploy.ps1 -SkipBuild
#   .\scripts\deploy.ps1 -ApiUpstreamUrl "http://127.0.0.1:5290"
param(
    [string] $Server = "",
    [string] $User = "root",
    [string] $IdentityFile = "",
    [string] $RemotePath = "/opt/flora-ecosystem/runtime/gov",
    [string] $Domain = "flora-s.net",
    [string] $ApiUpstreamUrl = "http://127.0.0.1:5290",
    [switch] $SkipBuild
)

$ErrorActionPreference = "Stop"

function Resolve-FloraSshKeyPath {
    param([string] $RawPath)
    $path = $RawPath.Trim().Trim('"')
    if ([string]::IsNullOrWhiteSpace($path)) { return "" }
    if ($path.StartsWith("~")) {
        $path = Join-Path $env:USERPROFILE $path.Substring(1).TrimStart("\", "/")
    }
    return $path
}

if ([string]::IsNullOrWhiteSpace($Server)) {
    $Server = $env:FLORA_DEPLOY_HOST
}
if ([string]::IsNullOrWhiteSpace($Server)) {
    $Server = (Read-Host "VPS IP or hostname").Trim()
}
if ([string]::IsNullOrWhiteSpace($Server)) {
    throw "Server host required: pass -Server <host>, set FLORA_DEPLOY_HOST, or enter at prompt."
}

if ([string]::IsNullOrWhiteSpace($IdentityFile)) {
    $IdentityFile = $env:FLORA_SSH_KEY
}
$defaultKey = Join-Path $env:USERPROFILE ".ssh\id_ed25519_flora"
if ([string]::IsNullOrWhiteSpace($IdentityFile)) {
    if (Test-Path -LiteralPath $defaultKey) {
        $IdentityFile = $defaultKey
    } else {
        $IdentityFile = Resolve-FloraSshKeyPath (Read-Host "Path to SSH private key")
    }
} else {
    $IdentityFile = Resolve-FloraSshKeyPath $IdentityFile
}

Write-Host "Deploy target: ${User}@${Server}"
if (-not [string]::IsNullOrWhiteSpace($IdentityFile) -and (-not (Test-Path -LiteralPath $IdentityFile))) {
    Write-Warning "SSH key file not found: $IdentityFile (password fallback will apply)."
} elseif (-not [string]::IsNullOrWhiteSpace($IdentityFile)) {
    Write-Host "SSH key: $IdentityFile"
}

$GovRoot = Split-Path $PSScriptRoot -Parent
$RepoRoot = (Resolve-Path (Join-Path $GovRoot "..\..")).Path
& node (Join-Path $RepoRoot "Scripts\sync-version.mjs")
Set-Location $GovRoot

$nm = Join-Path $GovRoot "node_modules"
$haveNext = Test-Path (Join-Path $nm "next\package.json")
$haveTsx = Test-Path (Join-Path $nm "tsx\package.json")
if (-not $haveNext -or -not $haveTsx) {
    Write-Host "node_modules missing or incomplete - running npm ci..."
    if (Test-Path (Join-Path $GovRoot "package-lock.json")) {
        npm ci
    } else {
        npm install
    }
}

if (-not $SkipBuild) {
    Write-Host "npm run build..."
    npm run build
} else {
    Write-Host "Skipping build (-SkipBuild)."
}

npm run prepare:standalone

$StandaloneRoot = Join-Path (Get-Location) ".next\standalone"
$serverJsCandidates = @(
    (Join-Path $StandaloneRoot "server.js"),
    (Join-Path $StandaloneRoot "Apps\Gov\server.js")
)
$serverJs = $serverJsCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $serverJs) { throw "Missing $StandaloneRoot\server.js (or Apps\Gov\server.js). Run npm run build." }
Write-Host "Standalone server.js: $serverJs"

$ts = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

function New-SshTransportOpts {
    param([string] $IdentityKey)
    $parts = @(
        "-o", "BatchMode=yes",
        "-o", "IdentitiesOnly=yes",
        "-o", "ConnectTimeout=20"
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

$stageDir = Join-Path $env:TEMP "flora-gov-deploy-stage-$ts"
$tarballPath = Join-Path $env:TEMP "flora-gov-deploy-$ts.tgz"
$deployOnWindows = ($true -eq $IsWindows) -or (($null -eq $IsWindows) -and ($env:OS -eq "Windows_NT"))
try {
    New-Item -ItemType Directory -Path $stageDir -Force | Out-Null

    foreach ($deployArg in @( $RemotePath, $Domain, $ApiUpstreamUrl )) {
        if ($deployArg -match '[\x00-\x08\x0B\x0C\x0E-\x1F]') {
            throw "Bootstrap args must not contain control characters."
        }
    }

    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    $argsPath = Join-Path $stageDir "args.txt"
    [System.IO.File]::WriteAllText(
        $argsPath,
        ($RemotePath, $Domain, $ApiUpstreamUrl) -join "`n",
        $utf8NoBom
    )

    $bootstrapSrc = Join-Path $PSScriptRoot "remote-bootstrap-flora-gov.sh"
    if (-not (Test-Path -LiteralPath $bootstrapSrc)) { throw "Missing $bootstrapSrc" }
    $null = Expand-ToUnixLfFile -SourcePath $bootstrapSrc -StagingPath (Join-Path $stageDir "bootstrap.sh")

    $payloadInstallSrc = Join-Path $PSScriptRoot "remote-deploy-payload-install.sh"
    if (-not (Test-Path -LiteralPath $payloadInstallSrc)) { throw "Missing $payloadInstallSrc" }
    $null = Expand-ToUnixLfFile -SourcePath $payloadInstallSrc -StagingPath (Join-Path $stageDir "remote-deploy-payload-install.sh")

    $govDest = Join-Path $stageDir "gov"
    New-Item -ItemType Directory -Path $govDest -Force | Out-Null
    Get-ChildItem -LiteralPath $StandaloneRoot -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $govDest -Recurse -Force
    }

    $sshExe = @(New-SshTransportOpts -IdentityKey $IdentityFile) + @("-l", $User, $Server)
    $remoteCmd = ('set -euo pipefail; export TS={0}; mkdir -p /tmp/flora-d-$TS; tar -xzf - -C /tmp/flora-d-$TS; bash /tmp/flora-d-$TS/remote-deploy-payload-install.sh' -f $ts)

    $tarPath = (Get-Command -Name tar -CommandType Application -ErrorAction Stop).Path

    Write-Host "Deploying Gov payload to server..."
    if ($deployOnWindows) {
        Remove-Item -LiteralPath $tarballPath -Force -ErrorAction SilentlyContinue
        Write-Host "Packing gzip tarball..."
        & $tarPath -czf $tarballPath -C $stageDir .
        if ($LASTEXITCODE -ne 0) { throw "tar pack failed (exit $LASTEXITCODE)." }

        $remoteTgz = "/tmp/flora-gov-deploy-$ts.tgz"
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
    Write-Host "  Next: curl -sI http://127.0.0.1:3001/"
    Write-Host ('  Open https://gov.' + $Domain + '/')
}
finally {
    if ($deployOnWindows -and (Test-Path -LiteralPath $tarballPath)) {
        Remove-Item -LiteralPath $tarballPath -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $stageDir) {
        Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
