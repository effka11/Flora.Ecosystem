# Changelog

All notable changes to FGCE are recorded here. The product version is the
kernel version from `crates/fgce/Cargo.toml`; the wasm ABI has its own number.

## 0.1.0-alpha — 2026-10-25

First alpha of the portable composition engine.

### Added

- **`fgce` kernel** — dependency-free, `unsafe` forbidden, one public door:
  `Engine::new` and `Engine::submit`.
- **Composition law** — sPx coordinates, 5/15 lattice, references, box tree,
  canonical and live placement, `Show`/`Place`, clip, frame lifetime.
- **Raster and vector** — `Crisp`/`Area` blit, exact fill coverage, stroke with
  joins and caps, rounded boxes, `Measure`.
- **Frame ownership** — premultiplied RGBA8, `stride = align_up(width * 4, 64)`,
  reused buffer for the same size, one `End` once per frame.
- **`fgce-wasm` adapter** — C ABI 2 and binary wire protocol; the only crate
  with raw pointers.
- **TypeScript binding** — typed engine facade, protocol codec and ABI vectors.
- **`fgce-conformance`** — 159-row §12 map, fuzz, benchmark and frozen fixtures.
- **Documentation** — normative `docs/fgce.md`, `docs/wasm-abi.md` and 64
  resolved decisions in `docs/questions.md`.

### Verification

- `cargo test --workspace --locked`: 352 passed, 0 failed, 1 ignored
  (fixture regeneration) on `x86_64-pc-windows-gnu`, rustc 1.97.0.
- `cargo fmt --all --check` and
  `cargo clippy --workspace --all-targets -- -D warnings` are clean.
- `scripts/check-standalone.ps1` passes a host and a `wasm32-unknown-unknown`
  check outside the product workspace.
- `scripts/check-release.ps1` passed; TypeScript typecheck is clean and 13 tests
  pass (1 fixture-regeneration test skipped). The binding has no runtime npm
  dependencies; `npm audit --omit=dev` reports 0 vulnerabilities.

### Known limitations

- Distribution is source by copying `crates/fgce`; `publish = false`, so the
  crate is not on crates.io.
- Window, pointer/keyboard input, text shaping, page layout and presentation
  belong to the host and are not part of this release.
- Vector coverage uses an analytic `f64` accumulator (decision 61). Do not
  enable `-C target-cpu=native` when byte-identical frames are required.
- Public request/response/error enums are exhaustive. Under `0.y`, a new
  variant is a breaking change and follows Cargo's minor-version rule.
