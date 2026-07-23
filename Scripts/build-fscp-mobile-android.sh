#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
out="$repo/Apps/Mobile/modules/flora-secure-push/android/src/main/jniLibs"

if ! command -v cargo >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  source "$HOME/.cargo/env"
fi
if ! cargo ndk --version >/dev/null 2>&1; then
  cargo install cargo-ndk --locked
fi
rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
cargo ndk \
  -t arm64-v8a \
  -t armeabi-v7a \
  -t x86_64 \
  -o "$out" \
  build -p fscp-mobile-ffi --release

test -f "$out/arm64-v8a/libfscp_mobile_ffi.so"
