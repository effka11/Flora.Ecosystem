# Changelog

All notable changes to FGCE are recorded here. The product version is the
kernel version from `crates/fgce/Cargo.toml`; the wasm ABI has its own number.

## 0.2.0 — 2026-10-30

Second release: closes FGCE-REQ-1…10. Product version `0.2.0`, wasm ABI `3`.

### Added

- **`DrawTree` and `EntityKind::Empty`** — an explicit tree pass inside the
  frame and a layout-only node that paints nothing.
- **`StrokeAlign::Center`** — a symmetric band around the contour, including
  odd widths, joins and caps; open contours are supported only by `Center`.
- **Immediate rounding** — `FillRect { radius }` and `StrokeRoundRect` through
  the same rounded-form path as `Box`.
- **`FillLattice`** — one-sPx lattice lines with an optional primary step.
- **Debug tree layer** — `DebugGrid`, `DebugHover`, `DebugLabel`, the normative
  5×7 font (appendix A) and a stateful name map.
- **`Peak`** — `Stroke.peak` with `Light` (default) and opt-in `Nominal`
  normalization of the whole stroke by its global coverage peak.
- **Fractional stroke width** — `Stroke::width_q8` counts 1/256 sPx, so a frame
  weighs 0.8 (`205`) and a cross 0.7 (`179`). Coverage is the exact band area
  `width_q8 / 256`, not a pixel-rounded one; `Stroke::px`/`Stroke::q8` are the
  short constructors. Works in `StrokePath`, `StrokeRoundRect`, `Vector`,
  `Box { stroke }`, `Measure`, `Inside`/`Outside`/`Center` and both peaks.
  `width_q8 = 0` is `BadStroke`.
- **Debug label color scale** — `DebugGridStyle.label_base` and `label_tip`
  interpolate labels (and their arrows) over `depth / max_depth` independently
  of the outline colors, then apply `label_alpha`. Unset ends inherit `base`
  and `tip`, so an existing style keeps its bytes.

### Changed

- **Linear light** — partial coverage and `SrcOver` with `src.a < 255` mix in
  linear light; opaque pixels stay byte-identical. `DstOut` remains
  premultiplied bytes.
- **Rounded `DstOut`** — `FillRect`/`Flat`/`Box` with a radius erase the shape;
  `Blit`/`Photo`/`Glyph` keep the corner mask.
- **Icons** — the three Luna icons have new golden numbers; see
  `docs/migration-0.2.0.md`. The fractional widths give a 13×13 frame at
  channel 164 / ink 39.043 (`width_q8 = 205`, `Inside`, `Peak::Light`) and an
  edge-to-edge 11×11 cross at channel 171 / ink 25.663 (`width_q8 = 179`,
  `Center`, `Peak::Nominal`).
- **Debug labels** — `label_base = #F2`, `label_tip = #8E`, `label_alpha = 200`
  over `#0E` render the window label at 217 and the leaf at 127.

### Breaking

- Public `Request`, `EntityKind`, `Stroke` and `Error` enums changed: new
  variants and fields. Under `0.y` this is a minor release, hence `0.2.0`.
- `StrokePath` now takes `stroke: Stroke` instead of separate fields;
  `FillRect` carries `radius`; `stroke?` carries `peak` in the wire format.
- `Stroke.width` became `Stroke.width_q8` in 1/256 sPx. A host multiplies whole
  pixels by 256; the core no longer rounds a width to a whole pixel.
- `DebugGridStyle` grew `label_base` and `label_tip` (optional on the wire).
- `Inside`/`Outside` on an open contour are `BadPath`; use `Center`.
- Wasm ABI bumped `2 → 3`: opcodes 27–32, `StrokeAlign` code 2, `Peak` codes
  0/1, `EntityKind` tag 5, `FillRect.radius`, `stroke?` in q8 units and the two
  optional label colors. `0.2.0` is not released yet, so these changes stay in
  ABI `3`.

### Verification

- `cargo test --workspace`: 450 passed, 0 failed, 3 ignored (fixture
  regeneration) on `x86_64-pc-windows-gnu`, rustc 1.97.0.
- `cargo fmt --all --check` and
  `cargo clippy --workspace --all-targets -- -D warnings` are clean.
- `cargo deny check` passes; `tools/validate-architecture-rust.ps1` passes
  (53 crates).
- `scripts/check-standalone.ps1` passes host and `wasm32-unknown-unknown`.
- TypeScript: `tsc` clean; 12 tests pass without the wasm artifact (2 skipped:
  wasm smoke and vector regeneration). ABI vectors pin `abi = 3`, the fractional
  `widthQ8` and the label colors.

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
