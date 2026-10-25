# Standalone portability gate for the FGCE kernel (§1, §7).
# Copies the crate directory outside the product workspace, rejects inherited
# workspace fields, then checks a host build and wasm32-unknown-unknown.

param(
    [string]$ProductRoot = (Resolve-Path (Join-Path $PSScriptRoot ".."))
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$crateDir = Join-Path $ProductRoot "crates/fgce"
$manifest = Join-Path $crateDir "Cargo.toml"
if (-not (Test-Path $manifest)) {
    Write-Error "Не найден $manifest"
    exit 1
}

$content = Get-Content $manifest -Raw
if ($content -match 'workspace\s*=\s*true') {
    Write-Error "Крейт fgce не должен использовать *.workspace = true: копия каталога обязана собираться отдельно."
    exit 1
}

$toolchainFile = Join-Path $ProductRoot "rust-toolchain.toml"
$channel = "stable"
if (Test-Path $toolchainFile) {
    $toolchainContent = Get-Content $toolchainFile -Raw
    if ($toolchainContent -match 'channel\s*=\s*"([^"]+)"') {
        $channel = $Matches[1]
    }
}

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("fgce-standalone-" + [guid]::NewGuid().ToString("N"))
$targetDir = Join-Path $ProductRoot "target"

try {
    New-Item -ItemType Directory -Path $temp | Out-Null
    Copy-Item -Path (Join-Path $crateDir "*") -Destination $temp -Recurse -Force

    $copiedManifest = Join-Path $temp "Cargo.toml"
    Push-Location $temp
    try {
        Write-Host "fgce standalone: host check ($channel)"
        & rustup run $channel cargo check --manifest-path $copiedManifest --target-dir $targetDir
        if ($LASTEXITCODE -ne 0) { throw "host check failed" }

        Write-Host "fgce standalone: wasm32-unknown-unknown check ($channel)"
        & rustup run $channel cargo check --manifest-path $copiedManifest --target wasm32-unknown-unknown --target-dir $targetDir
        if ($LASTEXITCODE -ne 0) { throw "wasm32 check failed" }
    }
    finally {
        Pop-Location
    }
}
finally {
    if (Test-Path $temp) {
        Remove-Item -Recurse -Force $temp
    }
}

Write-Host "fgce standalone check passed."
