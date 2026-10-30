# FGCE 0.2.0 — release preparation

**Status:** release candidate for `0.2.0`.
**Date:** 2026-10-30.
**Product root:** `products/fgce`.

This branch contains only the FGCE product: the portable kernel, the C ABI
adapter, the TypeScript binding and the conformance suite. Other repository
products and apps are intentionally absent.

## Version sources

The product version is `0.2.0` and is recorded literally in four places:

| File | Field |
|------|-------|
| `crates/fgce/Cargo.toml` | `package.version` |
| `crates/fgce-wasm/Cargo.toml` | `package.version` |
| `tests/conformance/Cargo.toml` | `package.version` |
| `package.json` | `version` |

The wasm ABI has its own version (`ABI_VERSION = 3` in
`crates/fgce-wasm/src/lib.rs`); it is independent from the product version.

## Release gates

Run from `products/fgce`:

```sh
pwsh ./scripts/check-release.ps1
```

The script checks the four version sources and the license files, then runs:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo build -p fgce-wasm --target wasm32-unknown-unknown --release --locked
pwsh ./scripts/check-standalone.ps1
npm ci
npm run typecheck
FGCE_WASM_PATH=target/wasm32-unknown-unknown/release/fgce_wasm.wasm npm test
```

The conformance suite is the §12 gate; `cargo test -p fgce` covers internal
values that are unreachable through `submit`.

## Verification record

Verified on `x86_64-pc-windows-gnu`, rustc 1.97.0:

- `cargo test --workspace --locked`: 450 passed, 0 failed, 3 ignored
  (fixture regeneration only).
- `cargo fmt --all --check`: clean.
- `cargo clippy --workspace --all-targets --locked -- -D warnings`: clean.
- `cargo deny check`: passed (advisory and license warnings only).
- `tools/validate-architecture-rust.ps1`: passed (53 crates).
- `scripts/check-standalone.ps1`: host and `wasm32-unknown-unknown` checks pass
  outside the product workspace.
- `scripts/check-release.ps1 -Version 0.2.0`: passed end to end.
- TypeScript: `tsc` clean; 12 tests passed without the wasm artifact (2 skipped:
  wasm smoke and vector regeneration), 13 passed with `FGCE_WASM_PATH` set.
- Runtime npm dependencies: none; `npm audit --omit=dev` reports 0
  vulnerabilities. Dev-tooling advisories are build-time only and are not
  shipped with the binding.

## Distribution

- Kernel: copy `crates/fgce` as a directory; depend on it with
  `fgce = { path = "...", version = "=0.2.0" }`.
- Full product source: copy `products/fgce` (kernel, adapter, TS binding,
  conformance, docs, `LICENSE`, `NOTICE.md`).
- `publish = false` on every crate: this release is not on crates.io.
- `LICENSE` and `NOTICE.md` must travel with the kernel directory; the same two
  files are in `crates/fgce-wasm`.

## Tag

The release tag is `fgce/v0.2.0`. It is not created by this preparation;
create and push it only after the gates and the release diff are reviewed:

```sh
git tag -a fgce/v0.2.0 -m "FGCE 0.2.0"
git push origin release/fgce-0.2.0 fgce/v0.2.0
```

## Known limitations

- The product has no window, input, text shaping, page layout or presentation;
  those belong to the host.
- Vector coverage uses the analytic `f64` accumulator fixed by decision 61.
  Avoid `-C target-cpu=native` when byte-identical frames are required.
- Public request/response/error enums are exhaustive. Under `0.y`, adding a
  variant is a breaking change and follows Cargo's minor-version rule.
- GPU rasterization, partial redraw, rotation, gradients, path clips and scaled
  `Photo`/`Glyph` are outside `0.2.0`. Fractional stroke width is inside it as
  `Stroke::width_q8`.
