#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
crate="fscp-mobile-ffi"
out="$repo/Apps/Mobile/modules/flora-secure-push/ios/FSCPMobileFFI.xcframework"
headers="$repo/Apps/Mobile/modules/flora-secure-push/ios/include"
target_dir="${CARGO_TARGET_DIR:-$repo/Target}"

if ! command -v cargo >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  source "$HOME/.cargo/env"
fi
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
cargo build -p "$crate" --target aarch64-apple-ios --release
cargo build -p "$crate" --target aarch64-apple-ios-sim --release
cargo build -p "$crate" --target x86_64-apple-ios --release

mkdir -p "$headers" "$target_dir/ios-simulator-universal/release"
cp "$repo/Apps/Mobile/modules/flora-secure-push/ios/FloraSecurePushBridge.h" "$headers/"
lipo -create \
  "$target_dir/aarch64-apple-ios-sim/release/libfscp_mobile_ffi.a" \
  "$target_dir/x86_64-apple-ios/release/libfscp_mobile_ffi.a" \
  -output "$target_dir/ios-simulator-universal/release/libfscp_mobile_ffi.a"

rm -rf "$out"
xcodebuild -create-xcframework \
  -library "$target_dir/aarch64-apple-ios/release/libfscp_mobile_ffi.a" -headers "$headers" \
  -library "$target_dir/ios-simulator-universal/release/libfscp_mobile_ffi.a" -headers "$headers" \
  -output "$out"
