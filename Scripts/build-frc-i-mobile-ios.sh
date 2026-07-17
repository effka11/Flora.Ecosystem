#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"

rustup target add aarch64-apple-ios
cargo build -p frc-i-mobile-ffi --target aarch64-apple-ios --release

target_dir="$(cargo metadata --no-deps --format-version 1 | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')"
output="$repo/Apps/Mobile/modules/flora-frc-i/ios/lib"
mkdir -p "$output"
cp "$target_dir/aarch64-apple-ios/release/libfrc_i_mobile_ffi.a" "$output/"
