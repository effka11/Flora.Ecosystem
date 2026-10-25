# fgce

Portable 2D composition engine: sPx coordinates, 5/15 lattice, box tree,
reference frames, raster, vector, clip and one frame buffer.

- No dependencies, no `unsafe`, no OS or GPU calls.
- One public entry point: `Engine::new` and `Engine::submit`.
- Frame output: premultiplied RGBA8, rows top-down,
  `stride = align_up(width * 4, 64)`.

This directory is the delivery unit: copy it into another project and build it
there. The manifest uses literal fields and never inherits from a workspace.

## Dependency

```toml
[dependencies]
fgce = { path = "third_party/fgce", version = "=0.1.0-alpha" }
```

The exact `=` is required: replacing the directory without updating the version
must fail to build.

## Minimal frame

```rust
use fgce::{Color, Engine, Rect, Request, Response};

let mut engine = Engine::new();
engine.submit(Request::Begin { width: 320, height: 200 })?;
engine.submit(Request::FillRect {
    rect: Rect { x1: 0, y1: 0, x2: 319, y2: 199 },
    color: Color { r: 12, g: 12, b: 12, a: 255 },
    blend: None,
})?;

let Response::Frame(frame) = engine.submit(Request::End)? else {
    unreachable!("End returns a frame");
};
assert_eq!((frame.width, frame.height), (320, 200));
assert!(frame.stride >= frame.width * 4);
```

`End` borrows the engine buffer: the host presents or copies it before the next
`submit`. `ReadPixels` returns an owning copy in straight or premultiplied alpha.

## Limits

| Limit | Value |
|-------|-------|
| Frame and image side | `1..=8192` |
| Lattice scale `k` | `1..=40` |
| Clip depth | `32` |
| Vertices per path | `65_536` |
| Absolute coordinate | `1_048_576` |

## Host boundaries

The kernel does not open a window, read files, decode images, shape text or
sample input. A host owns those layers and talks to the engine only through
`submit`. The full normative law is `docs/fgce.md` in the FGCE product
repository; this crate carries the public contract and its tests.

## License

AGPL-3.0-only; see [`LICENSE`](LICENSE) and [`NOTICE.md`](NOTICE.md).
