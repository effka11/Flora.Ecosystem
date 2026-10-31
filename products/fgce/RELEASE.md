# FGCE 0.2.1 — release preparation

**Status:** release candidate for `0.2.1`.
**Date:** 2026-10-31.
**Product root:** `products/fgce`.

This release covers only the FGCE product: the portable kernel, the C ABI
adapter, the TypeScript binding and the conformance suite. The release diff
touches only `products/fgce`; other repository products and apps are outside
this release.

`0.2.1` is a debug-layer behaviour fix. Public request and type names are
unchanged, the wasm ABI stays `3`, and the label and arrow pixels change on
purpose; the frozen debug fixtures are regenerated.

## Version sources

The product version is `0.2.1` and is recorded literally in four places:

| File | Field |
|------|-------|
| `crates/fgce/Cargo.toml` | `package.version` |
| `crates/fgce-wasm/Cargo.toml` | `package.version` |
| `tests/conformance/Cargo.toml` | `package.version` |
| `package.json` | `version` |

The wasm ABI has its own version (`ABI_VERSION = 3` in
`crates/fgce-wasm/src/lib.rs`); it is independent from the product version and
does not change in this release.

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

Verified on `x86_64-pc-windows-msvc` with `rustc 1.97.0` / `cargo 1.97.0`
and the `wasm32-unknown-unknown` target installed:

- `pwsh ./scripts/check-release.ps1`: passed end to end. The script ran
  `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`,
  `cargo test --workspace --locked`, the wasm release build, the standalone
  host + wasm32 checks, `npm ci`, `npm run typecheck` and `npm test`.
- `cargo fmt --all -- --check`: clean.
- `cargo clippy --workspace --all-targets --locked -- -D warnings`: clean.
- `cargo test --workspace --locked`: all kernel, adapter and conformance tests
  pass; only the fixture-regeneration tests remain `#[ignore]`.
- `cargo build -p fgce-wasm --target wasm32-unknown-unknown --release --locked`:
  the `0.2.1` artifact builds, so the TS smoke test sees the new
  `Info.version`.
- `pwsh ./scripts/check-standalone.ps1`: host and `wasm32-unknown-unknown`
  checks pass outside the product workspace.
- `npm run typecheck`: clean. `npm test` with `FGCE_WASM_PATH`: 13 passed,
  1 skipped (ABI-vector regeneration).
- `npm audit --omit=dev`: 0 runtime vulnerabilities. The dev-tooling audit
  reports 3 advisories; they are build-time only and are not shipped.
- `cargo run -p fgce --example debug_grid`: builds and prints a 64×40 frame
  with the hover label chain and 7×7 arrows.
- `cargo tree -p fgce`: the kernel has no dependencies.
- `cargo deny check`: passed (advisory and license warnings only).

## Distribution

- Kernel: copy `crates/fgce` as a directory; depend on it with
  `fgce = { path = "...", version = "=0.2.1" }`.
- Full product source: copy `products/fgce` (kernel, adapter, TS binding,
  conformance, docs, `LICENSE`, `NOTICE.md`).
- `publish = false` on every crate: this release is not on crates.io.
- `LICENSE` and `NOTICE.md` must travel with the kernel directory; the same two
  files are in `crates/fgce-wasm`.

## Tag

The release tag is `fgce/v0.2.1`. It is not created by this preparation;
create and push it only after the gates and the release diff are reviewed:

```sh
git tag -a fgce/v0.2.1 -m "FGCE 0.2.1"
git push origin release/fgce-0.2.1 fgce/v0.2.1
```

## Known limitations

- The product has no window, input, text shaping, page layout or presentation;
  those belong to the host.
- Vector coverage uses the analytic `f64` accumulator fixed by decision 61.
  Avoid `-C target-cpu=native` when byte-identical frames are required.
- Public request/response/error enums are exhaustive. Under `0.y`, adding a
  variant is a breaking change and follows Cargo's minor-version rule.
- GPU rasterization, partial redraw, rotation, gradients, path clips and scaled
  `Photo`/`Glyph` are outside `0.2.1`. Fractional stroke width is inside it as
  `Stroke::width_q8`.
