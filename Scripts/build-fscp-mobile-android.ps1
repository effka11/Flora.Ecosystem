$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$output = Join-Path $repo "Apps/Mobile/modules/flora-secure-push/android/src/main/jniLibs"

cargo ndk --version | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "cargo-ndk is required: cargo install cargo-ndk"
}

$targets = @(
    "aarch64-linux-android",
    "armv7-linux-androideabi",
    "x86_64-linux-android"
)
foreach ($target in $targets) {
    rustup target add $target | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "rustup target add $target failed"
    }
}

cargo ndk `
    -t arm64-v8a `
    -t armeabi-v7a `
    -t x86_64 `
    -o $output `
    build -p fscp-mobile-ffi --release
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

$so = Join-Path $output "arm64-v8a\libfscp_mobile_ffi.so"
if (-not (Test-Path $so)) {
    throw "Expected $so after cargo-ndk build"
}
# cargo-ndk copies from target/ and preserves mtimes. Stamp jniLibs so
# Ensure-FscpSecurePushAndroidNative freshness checks see a current artifact
# even when cargo was a cache hit (e.g. Cargo.lock touched without rebuild).
Get-ChildItem $output -Recurse -Filter "libfscp_mobile_ffi.so" -File | ForEach-Object {
    $_.LastWriteTimeUtc = [DateTime]::UtcNow
}
Write-Host "FSCP secure-push native libs ready under $output"
