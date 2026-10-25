# Release gate for FGCE 0.1.0-alpha.
# Checks version sources and license files, then runs the full product gates.

param(
    [string]$ProductRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")),
    [string]$Version = "0.1.0-alpha"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$manifestVersion = '(?m)^version = "' + [regex]::Escape($Version) + '"\r?$'
$manifests = @(
    "crates/fgce/Cargo.toml",
    "crates/fgce-wasm/Cargo.toml",
    "tests/conformance/Cargo.toml"
)

Push-Location $ProductRoot
try {
    foreach ($manifest in $manifests) {
        if (-not (Test-Path $manifest)) {
            throw "Не найден $manifest"
        }
        if ((Get-Content $manifest -Raw) -notmatch $manifestVersion) {
            throw "$manifest does not declare version $Version"
        }
    }

    $package = Get-Content "package.json" -Raw | ConvertFrom-Json
    if ($package.version -ne $Version) {
        throw "package.json: version = $($package.version), ожидалось $Version"
    }

    foreach ($file in @("LICENSE", "NOTICE.md", "crates/fgce/LICENSE", "crates/fgce/NOTICE.md", "crates/fgce-wasm/LICENSE", "crates/fgce-wasm/NOTICE.md")) {
        if (-not (Test-Path $file)) {
            throw "Не найден обязательный файл поставки: $file"
        }
    }

    Write-Host "FGCE release: version $Version and delivery notices are present."

    cargo fmt --all --check
    if ($LASTEXITCODE -ne 0) { throw "cargo fmt failed" }

    cargo clippy --workspace --all-targets --locked -- -D warnings
    if ($LASTEXITCODE -ne 0) { throw "cargo clippy failed" }

    cargo test --workspace --locked
    if ($LASTEXITCODE -ne 0) { throw "cargo test failed" }

    cargo build -p fgce-wasm --target wasm32-unknown-unknown --release --locked
    if ($LASTEXITCODE -ne 0) { throw "wasm32 adapter build failed" }

    & pwsh -NoProfile -File (Join-Path $PSScriptRoot "check-standalone.ps1") -ProductRoot $ProductRoot
    if ($LASTEXITCODE -ne 0) { throw "standalone check failed" }

    npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }

    npm run typecheck
    if ($LASTEXITCODE -ne 0) { throw "TypeScript typecheck failed" }

    $env:FGCE_WASM_PATH = Join-Path $ProductRoot "target/wasm32-unknown-unknown/release/fgce_wasm.wasm"
    npm test
    if ($LASTEXITCODE -ne 0) { throw "TypeScript tests failed" }

    Write-Host "FGCE release checks passed."
}
finally {
    Pop-Location
}
