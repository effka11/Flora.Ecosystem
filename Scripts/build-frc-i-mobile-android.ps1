$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$output = Join-Path $repo "Apps/Mobile/modules/flora-frc-i/android/src/main/jniLibs"

cargo ndk --version | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "cargo-ndk is required: cargo install cargo-ndk"
}

cargo ndk `
    -t arm64-v8a `
    -t armeabi-v7a `
    -t x86_64 `
    -o $output `
    build -p frc-i-mobile-ffi --release
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
