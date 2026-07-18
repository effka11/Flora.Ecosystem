# Deploy Rust flora-api to VPS (Phase 5: sole HTTP host on :5290, no .NET).
# Usage:
#   .\Scripts\deploy-flora-api.ps1
#   .\Scripts\deploy-flora-api.ps1 -SkipBuild
#   .\Scripts\deploy-flora-api.ps1 -BuildMode Wsl
#   .\Scripts\deploy-flora-api.ps1 -BuildMode Remote
#   .\Scripts\deploy-flora-api.ps1 -BinaryPath path\to\flora-api
#
# BuildMode Auto: Linux host -> Local; Windows + WSL (bash+cargo) -> Wsl; else Remote.
param(
    [string] $Server = "",
    [string] $User = "root",
    [string] $IdentityFile = "",
    [string] $RemotePath = "/opt/flora-ecosystem/runtime/gateway",
    [ValidateSet("Auto", "Wsl", "Remote", "Local", "Binary")]
    [string] $BuildMode = "Auto",
    [string] $BinaryPath = "",
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

function ConvertTo-WslPath {
    param([string] $WinPath)
    $full = (Resolve-Path -LiteralPath $WinPath).Path
    if ($full -match '^([A-Za-z]):\\(.*)$') {
        $drive = $Matches[1].ToLowerInvariant()
        $rest = $Matches[2] -replace '\\', '/'
        return "/mnt/$drive/$rest"
    }
    throw "Cannot convert path to WSL: $WinPath"
}

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
    }
    $text = [System.Text.Encoding]::UTF8.GetString($bytes, $offset, $bytes.Length - $offset)
    $text = $text -replace "`r`n", "`n" -replace "`r", "`n"
    [System.IO.File]::WriteAllText($StagingPath, $text, [System.Text.UTF8Encoding]::new($false))
}

function Join-UnixLines {
    param([Parameter(Mandatory = $true)][string[]] $Lines)
    return (($Lines | ForEach-Object { $_ }) -join "`n") + "`n"
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
if ([string]::IsNullOrWhiteSpace($IdentityFile)) {
    $defaultKey = Join-Path $env:USERPROFILE ".ssh\id_ed25519_flora"
    $hint = if (Test-Path -LiteralPath $defaultKey) { " [Enter = $defaultKey]" } else { "" }
    $IdentityFile = Resolve-FloraSshKeyPath (Read-Host "Path to SSH private key$hint")
    if ([string]::IsNullOrWhiteSpace($IdentityFile) -and (Test-Path -LiteralPath $defaultKey)) {
        $IdentityFile = $defaultKey
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

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $RepoRoot
& node (Join-Path $RepoRoot "Scripts\sync-version.mjs")

$onWindowsHost = $env:OS -eq "Windows_NT"
$onLinuxHost = -not $onWindowsHost -and ($PSVersionTable.Platform -eq "Unix")
# WSL relay may exist without a distro/bash (Docker Desktop stub) - require bash + cargo.
$wslOk = $false
if ($onWindowsHost) {
    try {
        $null = & wsl -e bash -lc "command -v cargo >/dev/null" 2>$null
        $wslOk = ($LASTEXITCODE -eq 0)
    } catch {
        $wslOk = $false
    }
}

if ($BuildMode -eq "Auto") {
    if (-not [string]::IsNullOrWhiteSpace($BinaryPath) -or $SkipBuild) {
        $BuildMode = "Binary"
    } elseif ($onLinuxHost) {
        $BuildMode = "Local"
    } elseif ($wslOk) {
        $BuildMode = "Wsl"
    } else {
        $BuildMode = "Remote"
        if ($onWindowsHost) {
            Write-Host "WSL bash/cargo unavailable - using remote cargo build on VPS."
        }
    }
}

Write-Host "BuildMode=$BuildMode"

$releaseBinCandidates = @(
    (Join-Path $RepoRoot "Target\release\flora-api"),
    (Join-Path $RepoRoot "Target\x86_64-unknown-linux-gnu\release\flora-api")
)

$builtBinary = $null
if ($BuildMode -eq "Binary" -or $SkipBuild) {
    if (-not [string]::IsNullOrWhiteSpace($BinaryPath)) {
        $builtBinary = (Resolve-Path -LiteralPath $BinaryPath).Path
    } else {
        foreach ($c in $releaseBinCandidates) {
            if (Test-Path -LiteralPath $c) {
                $builtBinary = $c
                break
            }
        }
    }
    if (-not $builtBinary) {
        throw "No Linux flora-api binary. Build first or pass -BinaryPath / use -BuildMode Wsl|Remote|Local."
    }
    Write-Host "Using binary: $builtBinary"
} elseif ($BuildMode -eq "Local") {
    Write-Host "cargo build -p flora-api --release ..."
    cargo build -p flora-api --release
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed (exit $LASTEXITCODE)." }
    $builtBinary = Join-Path $RepoRoot "Target\release\flora-api"
    if (-not (Test-Path -LiteralPath $builtBinary)) {
        throw "Missing $builtBinary after local build."
    }
} elseif ($BuildMode -eq "Wsl") {
    if (-not $wslOk) {
        throw "WSL bash/cargo unavailable. Use -BuildMode Remote or install a WSL distro with Rust."
    }
    $wslRoot = ConvertTo-WslPath $RepoRoot
    Write-Host "WSL cargo build -p flora-api --release (cwd $wslRoot) ..."
    & wsl -e bash -lc "set -euo pipefail; cd '$wslRoot'; cargo build -p flora-api --release"
    if ($LASTEXITCODE -ne 0) { throw "WSL cargo build failed (exit $LASTEXITCODE)." }
    $builtBinary = Join-Path $RepoRoot "Target\release\flora-api"
    if (-not (Test-Path -LiteralPath $builtBinary)) {
        throw "Missing $builtBinary after WSL build."
    }
}

$ts = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$stageDir = Join-Path $env:TEMP "flora-api-deploy-stage-$ts"
$tarballPath = Join-Path $env:TEMP "flora-api-deploy-$ts.tgz"
New-Item -ItemType Directory -Path $stageDir -Force | Out-Null

try {
    $installSrc = Join-Path $PSScriptRoot "remote-install-flora-api.sh"
    Expand-ToUnixLfFile -SourcePath $installSrc -StagingPath (Join-Path $stageDir "remote-install-flora-api.sh")

    $versionsSrc = Join-Path $RepoRoot "Backend\flora-versions.json"
    if (-not (Test-Path -LiteralPath $versionsSrc)) {
        $versionsSrc = Join-Path $RepoRoot "flora-versions.json"
    }
    Copy-Item -LiteralPath $versionsSrc -Destination (Join-Path $stageDir "flora-versions.json") -Force

    $appsettingsSrc = Join-Path $RepoRoot "Backend\appsettings.json"
    if (Test-Path -LiteralPath $appsettingsSrc) {
        Copy-Item -LiteralPath $appsettingsSrc -Destination (Join-Path $stageDir "appsettings.json") -Force
    }

    $sshExe = @(New-SshTransportOpts -IdentityKey $IdentityFile) + @("${User}@${Server}")
    $tarPath = (Get-Command -Name tar -CommandType Application -ErrorAction Stop).Path

    if ($BuildMode -eq "Remote") {
        Write-Host "Packing source for remote cargo build..."
        $srcTar = Join-Path $env:TEMP "flora-api-src-$ts.tgz"
        $excludeFile = Join-Path $env:TEMP "flora-api-tar-exclude-$ts.txt"
        @(
            "Target"
            "target"
            "node_modules"
            "Apps/Web/.next"
            "Apps/Mobile/android"
            "Apps/Mobile/ios"
            ".git"
            "*.apk"
        ) | Set-Content -LiteralPath $excludeFile -Encoding ascii

        Push-Location $RepoRoot
        try {
            # .cargo/config.toml sets target-dir=Target; include it so remote matches.
            & $tarPath -czf $srcTar --exclude-from=$excludeFile `
                Cargo.toml Cargo.lock rust-toolchain.toml .cargo `
                Backend Products Packages Tools Scripts Infrastructure `
                VERSION flora-versions.json 2>$null
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $srcTar)) {
                throw "source tar failed."
            }
        } finally {
            Pop-Location
        }

        $remoteSrcTgz = "/tmp/flora-api-src-$ts.tgz"
        Write-Host "Uploading sources (scp)..."
        $scpSrc = @(New-SshTransportOpts -IdentityKey $IdentityFile) + @($srcTar, "${User}@${Server}:${remoteSrcTgz}")
        & scp @scpSrc
        if ($LASTEXITCODE -ne 0) { throw "scp sources failed (exit $LASTEXITCODE)." }

        # Write remote build script to a file and run via bash — avoids ssh -c quote/paren breakage.
        $remoteBuildShLocal = Join-Path $env:TEMP "flora-api-remote-build-$ts.sh"
        $remoteBuildShRemote = "/tmp/flora-api-remote-build-$ts.sh"
        $remoteBuildBody = @"
set -euo pipefail
shopt -s nullglob
export DEBIAN_FRONTEND=noninteractive
BUILD_ROOT=/opt/flora-ecosystem/build
SRC="`$BUILD_ROOT/src"
OUT=/tmp/flora-api-bin-$ts
REMOTE_SRC_TGZ=$remoteSrcTgz
mkdir -p "`$SRC"
# Keep cargo incremental cache; never reuse a previous release binary (would skip new code).
if [ ! -d "`$SRC/target" ] && [ ! -d "`$SRC/Target" ]; then
  for old in /tmp/flora-api-src-*/Target /tmp/flora-api-src-*/target; do
    if [ -d "`$old" ]; then
      echo "Adopting cargo cache from `$old"
      base=`$(basename "`$old")
      mv "`$old" "`$SRC/`$base"
      break
    fi
  done
fi
if [ -d "`$SRC/target" ] && [ ! -e "`$SRC/Target" ]; then
  mv "`$SRC/target" "`$SRC/Target"
fi
# Drop stale /tmp release binaries so we cannot accidentally ship an old flora-api.
rm -f /tmp/flora-api-src-*/target/release/flora-api /tmp/flora-api-src-*/Target/release/flora-api 2>/dev/null || true
tar -xzf "`$REMOTE_SRC_TGZ" -C "`$SRC"
rm -f "`$REMOTE_SRC_TGZ"
if [ -f "`$HOME/.cargo/env" ]; then
  . "`$HOME/.cargo/env"
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "Installing rustup on VPS first run..."
  curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain 1.97.0 --profile minimal
  . "`$HOME/.cargo/env"
fi
if ! command -v cc >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq build-essential pkg-config libssl-dev protobuf-compiler
fi
if ! command -v protoc >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq protobuf-compiler
fi
cd "`$SRC"
cargo build -p flora-api --release
BIN=
for cand in Target/release/flora-api target/release/flora-api; do
  if [ -x "`$cand" ]; then
    BIN=`$cand
    break
  fi
done
if [ -z "`$BIN" ]; then
  echo "flora-api binary not found under Target/ or target/"
  ls -la Target/release target/release 2>/dev/null || true
  exit 1
fi
install -m 755 "`$BIN" "`$OUT"
echo "Built `$BIN -> `$OUT"
"@
        $remoteBuildBody = $remoteBuildBody -replace "`r`n", "`n" -replace "`r", "`n"
        [System.IO.File]::WriteAllText($remoteBuildShLocal, $remoteBuildBody, [System.Text.UTF8Encoding]::new($false))

        $scpBuildSh = @(New-SshTransportOpts -IdentityKey $IdentityFile) + @($remoteBuildShLocal, "${User}@${Server}:${remoteBuildShRemote}")
        & scp @scpBuildSh
        if ($LASTEXITCODE -ne 0) { throw "scp remote-build script failed (exit $LASTEXITCODE)." }

        Write-Host "Building on VPS (salvages last /tmp binary if present; else persistent incremental cargo)..."
        & ssh @sshExe "bash $remoteBuildShRemote"
        $buildEc = $LASTEXITCODE
        & ssh @sshExe "rm -f $remoteBuildShRemote" 2>$null
        Remove-Item -LiteralPath $remoteBuildShLocal -Force -ErrorAction SilentlyContinue
        if ($buildEc -ne 0) { throw "remote cargo build failed (exit $buildEc)." }

        $remoteBin = "/tmp/flora-api-bin-$ts"
        $localBin = Join-Path $stageDir "flora-api"
        Write-Host "Downloading built binary..."
        $scpDown = @(New-SshTransportOpts -IdentityKey $IdentityFile) + @("${User}@${Server}:${remoteBin}", $localBin)
        & scp @scpDown
        if ($LASTEXITCODE -ne 0) { throw "scp binary download failed (exit $LASTEXITCODE)." }
        & ssh @sshExe "rm -f $remoteBin"
    } else {
        Copy-Item -LiteralPath $builtBinary -Destination (Join-Path $stageDir "flora-api") -Force
    }

    if (-not (Test-Path -LiteralPath (Join-Path $stageDir "flora-api"))) {
        throw "Staging payload missing flora-api binary."
    }

    Remove-Item -LiteralPath $tarballPath -Force -ErrorAction SilentlyContinue
    Write-Host "Packing install payload..."
    & $tarPath -czf $tarballPath -C $stageDir .
    if ($LASTEXITCODE -ne 0) { throw "tar pack failed (exit $LASTEXITCODE)." }

    $remoteTgz = "/tmp/flora-api-deploy-$ts.tgz"
    Write-Host "Uploading payload (scp)..."
    $scpPayload = @(New-SshTransportOpts -IdentityKey $IdentityFile) + @($tarballPath, "${User}@${Server}:${remoteTgz}")
    & scp @scpPayload
    if ($LASTEXITCODE -ne 0) { throw "scp payload failed (exit $LASTEXITCODE)." }

    $remoteInstall = Join-UnixLines @(
        "set -euo pipefail"
        "export DEBIAN_FRONTEND=noninteractive"
        "yes N | dpkg --configure -a 2>/dev/null || true"
        "mkdir -p /tmp/flora-api-d-$ts"
        "tar -xzf $remoteTgz -C /tmp/flora-api-d-$ts"
        "bash /tmp/flora-api-d-$ts/remote-install-flora-api.sh /tmp/flora-api-d-$ts"
        "rm -rf /tmp/flora-api-d-$ts $remoteTgz"
    )
    Write-Host "Installing Flora API on VPS..."
    & ssh @sshExe $remoteInstall
    if ($LASTEXITCODE -ne 0) { throw "ssh install failed (exit $LASTEXITCODE)." }

    Write-Host "Done."
    Write-Host "  Remote path: $RemotePath"
    Write-Host "  Health: curl -s http://127.0.0.1:5290/health"
    Write-Host "  Version: curl -s http://127.0.0.1:5290/version"
} finally {
    Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $tarballPath -Force -ErrorAction SilentlyContinue
}
