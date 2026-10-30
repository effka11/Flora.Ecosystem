//! Shared helpers for the FGCE §12 conformance suite.
//!
//! Every check here goes through `Engine::submit`; the harness never reaches
//! into crate internals, so `fgce-conformance` stays a test package and not a
//! second API door (implementation plan D2).

use fgce::{
    AlphaMode, Blend, Color, Edge, Edges, Engine, Entity, EntityKind, Error, ImageId, Info, NodeId,
    PixelFormat, Pixels, Rect, Request, Response, Snapshot,
};

pub const WHITE: Color = Color {
    r: 255,
    g: 255,
    b: 255,
    a: 255,
};
pub const RED: Color = Color {
    r: 255,
    g: 0,
    b: 0,
    a: 255,
};

/// Inclusive rectangle in sPx.
pub fn rect(x1: i32, y1: i32, x2: i32, y2: i32) -> Rect {
    Rect { x1, y1, x2, y2 }
}

/// Pixel edges of an entity or arbitrary box (`on_grid = false`).
pub fn pixels(x1: i32, y1: i32, x2: i32, y2: i32) -> Edges {
    Edges {
        x1: Edge::Pixel(x1),
        y1: Edge::Pixel(y1),
        x2: Edge::Pixel(x2),
        y2: Edge::Pixel(y2),
    }
}

/// Grid edge in primary cells.
pub fn grid(primary: i32) -> Edge {
    Edge::Grid {
        primary,
        fine: None,
        spx: None,
    }
}

pub fn bpp(format: PixelFormat) -> u32 {
    match format {
        PixelFormat::Rgb8 => 3,
        PixelFormat::Rgba8 => 4,
        PixelFormat::Alpha8 => 1,
    }
}

/// A frame copied out of the engine (tests own the bytes).
pub struct FrameBytes {
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub bytes: Vec<u8>,
}

impl FrameBytes {
    /// Premultiplied RGBA of one pixel.
    pub fn pixel(&self, x: i32, y: i32) -> [u8; 4] {
        let at = y as usize * self.stride as usize + x as usize * 4;
        [
            self.bytes[at],
            self.bytes[at + 1],
            self.bytes[at + 2],
            self.bytes[at + 3],
        ]
    }
}

/// One engine plus helpers that never bypass `submit`.
pub struct Harness {
    engine: Engine,
    size: Option<(u32, u32)>,
}

impl Default for Harness {
    fn default() -> Self {
        Harness::new()
    }
}

impl Harness {
    pub fn new() -> Self {
        Harness {
            engine: Engine::new(),
            size: None,
        }
    }

    pub fn ok(&mut self, request: Request<'_>) {
        self.engine
            .submit(request)
            .map(|_| ())
            .expect("request must pass");
    }

    pub fn submit(&mut self, request: Request<'_>) -> Result<Response<'_>, Error> {
        self.engine.submit(request)
    }

    pub fn err(&mut self, request: Request<'_>) -> Error {
        self.engine
            .submit(request)
            .expect_err("request must be rejected")
    }

    pub fn begin(&mut self, width: u32, height: u32) {
        self.try_begin(width, height).expect("Begin must pass");
    }

    /// `Begin` that records the frame size only after a successful request.
    pub fn try_begin(&mut self, width: u32, height: u32) -> Result<(), Error> {
        match self.engine.submit(Request::Begin { width, height }) {
            Ok(_) => {
                self.size = Some((width, height));
                Ok(())
            }
            Err(error) => Err(error),
        }
    }

    pub fn end(&mut self) -> FrameBytes {
        match self.engine.submit(Request::End).expect("End must pass") {
            Response::Frame(frame) => FrameBytes {
                width: frame.width,
                height: frame.height,
                stride: frame.stride,
                bytes: frame.pixels.to_vec(),
            },
            _ => unreachable!("End returns Frame"),
        }
    }

    pub fn pixels(&mut self, area: Rect) -> Pixels {
        self.read_pixels(area, AlphaMode::Straight)
    }

    /// Premultiplied RGBA as stored in the frame, without the straight conversion.
    pub fn pixels_premul(&mut self, area: Rect) -> Pixels {
        self.read_pixels(area, AlphaMode::Premul)
    }

    fn read_pixels(&mut self, area: Rect, alpha: AlphaMode) -> Pixels {
        match self
            .engine
            .submit(Request::ReadPixels { rect: area, alpha })
            .expect("ReadPixels must pass")
        {
            Response::Pixels(pixels) => pixels,
            _ => unreachable!("ReadPixels returns Pixels"),
        }
    }

    /// Straight RGBA of one pixel.
    pub fn pixel(&mut self, x: i32, y: i32) -> [u8; 4] {
        let pixels = self.pixels(rect(x, y, x, y));
        [
            pixels.bytes[0],
            pixels.bytes[1],
            pixels.bytes[2],
            pixels.bytes[3],
        ]
    }

    /// Premultiplied RGBA of one frame pixel (`fgce.md` §6, §12 rows 121–127, 147).
    pub fn pixel_premul(&mut self, x: i32, y: i32) -> [u8; 4] {
        let pixels = self.pixels_premul(rect(x, y, x, y));
        [
            pixels.bytes[0],
            pixels.bytes[1],
            pixels.bytes[2],
            pixels.bytes[3],
        ]
    }

    pub fn snapshot(&mut self) -> Snapshot {
        match self
            .engine
            .submit(Request::Snapshot)
            .expect("Snapshot must pass")
        {
            Response::Snapshot(snapshot) => snapshot,
            _ => unreachable!("Snapshot returns Snapshot"),
        }
    }

    pub fn info(&mut self) -> Info {
        match self.engine.submit(Request::Info).expect("Info must pass") {
            Response::Info(info) => info,
            _ => unreachable!("Info returns Info"),
        }
    }

    /// `Empty` is the only state where `Snapshot` is rejected with `NotBegun`.
    pub fn is_empty(&mut self) -> bool {
        matches!(self.engine.submit(Request::Snapshot), Err(Error::NotBegun))
    }

    pub fn upload(
        &mut self,
        id: u32,
        width: u32,
        height: u32,
        format: PixelFormat,
        alpha: AlphaMode,
        bytes: &[u8],
    ) {
        self.ok(Request::Upload {
            id: ImageId(id),
            width,
            height,
            stride: width * bpp(format),
            format,
            alpha,
            bytes,
        });
    }

    pub fn try_upload(
        &mut self,
        id: u32,
        width: u32,
        height: u32,
        format: PixelFormat,
        alpha: AlphaMode,
        bytes: &[u8],
    ) -> Error {
        self.err(Request::Upload {
            id: ImageId(id),
            width,
            height,
            stride: width * bpp(format),
            format,
            alpha,
            bytes,
        })
    }

    pub fn upload_rgba(
        &mut self,
        id: u32,
        width: u32,
        height: u32,
        alpha: AlphaMode,
        bytes: &[u8],
    ) {
        self.upload(id, width, height, PixelFormat::Rgba8, alpha, bytes);
    }

    pub fn fill(&mut self, area: Rect, color: Color) {
        self.ok(Request::FillRect {
            rect: area,
            color,
            blend: None,
            radius: None,
        });
    }

    pub fn fill_path(&mut self, verbs: &[fgce::Verb], rule: fgce::FillRule, color: Color) {
        self.ok(Request::FillPath {
            verbs,
            rule,
            color,
            blend: None,
        });
    }

    pub fn try_fill_path(
        &mut self,
        verbs: &[fgce::Verb],
        rule: fgce::FillRule,
        color: Color,
    ) -> Error {
        self.err(Request::FillPath {
            verbs,
            rule,
            color,
            blend: None,
        })
    }

    pub fn stroke_path(
        &mut self,
        verbs: &[fgce::Verb],
        width: u32,
        align: fgce::StrokeAlign,
        join: fgce::Join,
        cap: fgce::Cap,
        color: Color,
    ) {
        self.ok(Request::StrokePath {
            verbs,
            stroke: fgce::Stroke {
                width_q8: width * fgce::SPX_Q8,
                align,
                join,
                cap,
                peak: fgce::Peak::Light,
            },
            color,
            blend: None,
        });
    }

    /// `StrokePath` with a 1/256 sPx width and an explicit peak (§8.4).
    #[allow(clippy::too_many_arguments)]
    pub fn stroke_path_q8(
        &mut self,
        verbs: &[fgce::Verb],
        width_q8: u32,
        align: fgce::StrokeAlign,
        join: fgce::Join,
        cap: fgce::Cap,
        peak: fgce::Peak,
        color: Color,
    ) {
        self.ok(Request::StrokePath {
            verbs,
            stroke: fgce::Stroke {
                width_q8,
                align,
                join,
                cap,
                peak,
            },
            color,
            blend: None,
        });
    }

    #[allow(clippy::too_many_arguments)]
    pub fn try_stroke_path(
        &mut self,
        verbs: &[fgce::Verb],
        width: u32,
        align: fgce::StrokeAlign,
        join: fgce::Join,
        cap: fgce::Cap,
        color: Color,
    ) -> Error {
        self.err(Request::StrokePath {
            verbs,
            stroke: fgce::Stroke {
                width_q8: width * fgce::SPX_Q8,
                align,
                join,
                cap,
                peak: fgce::Peak::Light,
            },
            color,
            blend: None,
        })
    }

    pub fn measure(
        &mut self,
        verbs: &[fgce::Verb],
        fill: Option<fgce::Fill>,
        stroke: Option<fgce::Stroke>,
    ) -> Rect {
        match self
            .engine
            .submit(Request::Measure {
                verbs,
                fill,
                stroke,
            })
            .expect("Measure must pass")
        {
            Response::Measure(area) => area,
            _ => unreachable!("Measure returns Measure"),
        }
    }

    pub fn try_measure(
        &mut self,
        verbs: &[fgce::Verb],
        fill: Option<fgce::Fill>,
        stroke: Option<fgce::Stroke>,
    ) -> Error {
        self.err(Request::Measure {
            verbs,
            fill,
            stroke,
        })
    }

    pub fn clip_push(&mut self, area: Rect) {
        self.ok(Request::ClipPush { rect: area });
    }

    pub fn clip_pop(&mut self) {
        self.ok(Request::ClipPop);
    }

    pub fn define_reference(
        &mut self,
        id: u32,
        canon: (u32, u32),
        k: u32,
        d: u32,
        pin: fgce::Pin,
        enter: (u32, u32),
    ) {
        self.ok(Request::DefineReference {
            id: fgce::ReferenceId(id),
            canon_w: canon.0,
            canon_h: canon.1,
            k,
            d,
            pin,
            enter_cols: enter.0,
            enter_rows: enter.1,
        });
    }

    pub fn use_reference(&mut self, id: u32) {
        self.ok(Request::UseReference {
            id: fgce::ReferenceId(id),
        });
    }

    pub fn try_use_reference(&mut self, id: u32) -> Error {
        self.err(Request::UseReference {
            id: fgce::ReferenceId(id),
        })
    }

    pub fn fill_blend(&mut self, area: Rect, color: Color, blend: Blend) {
        self.ok(Request::FillRect {
            rect: area,
            color,
            blend: Some(blend),
            radius: None,
        });
    }

    pub fn blit(&mut self, id: u32, dest: Rect, src: Rect, sample: fgce::Sample) {
        self.ok(Request::Blit {
            id: ImageId(id),
            dest,
            src,
            sample,
            tint: None,
            blend: None,
            radius: None,
        });
    }

    #[allow(clippy::too_many_arguments)]
    pub fn blit_full(
        &mut self,
        id: u32,
        dest: Rect,
        src: Rect,
        sample: fgce::Sample,
        tint: Option<Color>,
        blend: Option<Blend>,
    ) {
        self.ok(Request::Blit {
            id: ImageId(id),
            dest,
            src,
            sample,
            tint,
            blend,
            radius: None,
        });
    }

    pub fn try_blit(&mut self, id: u32, dest: Rect, src: Rect, sample: fgce::Sample) -> Error {
        self.err(Request::Blit {
            id: ImageId(id),
            dest,
            src,
            sample,
            tint: None,
            blend: None,
            radius: None,
        })
    }

    pub fn show(&mut self, id: u32, area: Rect) {
        self.ok(Request::Show {
            id: NodeId(id),
            rect: area,
        });
    }

    pub fn place(&mut self, id: u32, area: Rect) {
        self.ok(Request::Place {
            id: NodeId(id),
            rect: area,
        });
    }

    pub fn try_place(&mut self, id: u32, area: Rect) -> Error {
        self.err(Request::Place {
            id: NodeId(id),
            rect: area,
        })
    }

    pub fn remove(&mut self, id: u32) {
        self.ok(Request::Remove { id: NodeId(id) });
    }

    pub fn try_remove(&mut self, id: u32) -> Error {
        self.err(Request::Remove { id: NodeId(id) })
    }

    /// A stable fingerprint of everything observable through `submit`:
    /// snapshot list, generation and the whole frame.
    pub fn fingerprint(&mut self) -> u64 {
        let mut hash = 0xcbf2_9ce4_8422_2325_u64;
        if self.is_empty() {
            mix(&mut hash, 0);
            return hash;
        }
        let snapshot = self.snapshot();
        mix(&mut hash, 1);
        mix(&mut hash, snapshot.generation);
        for node in &snapshot.nodes {
            mix(&mut hash, node.id.0 as u64);
            mix(&mut hash, node.parent.0 as u64);
            mix(&mut hash, node.rect.x1 as u64);
            mix(&mut hash, node.rect.y1 as u64);
            mix(&mut hash, node.rect.x2 as u64);
            mix(&mut hash, node.rect.y2 as u64);
        }
        if let Some((width, height)) = self.size {
            let pixels = self.pixels(rect(0, 0, width as i32 - 1, height as i32 - 1));
            for byte in pixels.bytes {
                mix(&mut hash, byte as u64);
            }
        }
        hash
    }
}

fn mix(hash: &mut u64, value: u64) {
    for byte in value.to_le_bytes() {
        *hash ^= byte as u64;
        *hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
}

/// A flat entity request with off-grid pixel edges.
pub fn flat(id: u32, x1: i32, y1: i32, x2: i32, y2: i32, color: Color) -> Request<'static> {
    Request::Entity(Entity {
        id: NodeId(id),
        kind: EntityKind::Flat { color },
        on_grid: Some(false),
        edges: pixels(x1, y1, x2, y2),
        align: None,
        blend: None,
        radius: None,
    })
}

/// A photo entity request with off-grid pixel edges.
pub fn photo(
    id: u32,
    format: PixelFormat,
    image: u32,
    x1: i32,
    y1: i32,
    x2: i32,
    y2: i32,
) -> Request<'static> {
    Request::Entity(Entity {
        id: NodeId(id),
        kind: EntityKind::Photo {
            format,
            image: ImageId(image),
            tint: None,
        },
        on_grid: Some(false),
        edges: pixels(x1, y1, x2, y2),
        align: None,
        blend: None,
        radius: None,
    })
}

/// Deterministic LCG for fuzzing (`xorshift64*`), no external crates.
pub struct Lcg(u64);

impl Lcg {
    pub fn new(seed: u64) -> Self {
        Lcg(seed | 1)
    }

    pub fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        (x.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 32) as u32
    }

    pub fn below(&mut self, limit: u32) -> u32 {
        if limit == 0 {
            0
        } else {
            self.next_u32() % limit
        }
    }

    pub fn range(&mut self, low: i32, high: i32) -> i32 {
        if high <= low {
            low
        } else {
            low + self.below((high - low + 1) as u32) as i32
        }
    }

    pub fn pick(&mut self, options: usize) -> usize {
        self.below(options as u32) as usize
    }
}
