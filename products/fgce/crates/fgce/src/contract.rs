//! Public request/response contract of FGCE (`fgce.md` §1, §5).
//!
//! This module contains data shapes only. It never imports composition modules.

/// Node identity. `0` is the window of the active reference.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct NodeId(pub u32);

/// Image store identity. `0` is forbidden.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct ImageId(pub u32);

/// Reference identity. `0` in `UseReference` means "return to threshold choice".
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct ReferenceId(pub u32);

/// Inclusive rectangle in sPx: `(x1, y1)` is the near corner, `(x2, y2)` the far one.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Rect {
    pub x1: i32,
    pub y1: i32,
    pub x2: i32,
    pub y2: i32,
}

impl Rect {
    pub(crate) fn is_empty(self) -> bool {
        self.x2 < self.x1 || self.y2 < self.y1
    }

    pub(crate) fn intersect(self, other: Rect) -> Rect {
        Rect {
            x1: self.x1.max(other.x1),
            y1: self.y1.max(other.y1),
            x2: self.x2.min(other.x2),
            y2: self.y2.min(other.y2),
        }
    }

    pub(crate) fn width(self) -> i64 {
        self.x2 as i64 - self.x1 as i64 + 1
    }

    pub(crate) fn height(self) -> i64 {
        self.y2 as i64 - self.y1 as i64 + 1
    }
}

/// Straight sRGB color as accepted by requests.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Color {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

/// Entity alignment inside its coordinate box (`fgce.md` §4.5).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Align {
    pub x: i8,
    pub y: i8,
}

/// Attachment of a group, arbitrary box, reference or lattice (`fgce.md` §3.4, §4.6).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Pin {
    pub x: i8,
    pub y: i8,
}

/// One edge of the 5/15 grid drawing grammar (`fgce.md` §3.2, §4.3).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Edge {
    Grid {
        primary: i32,
        fine: Option<u8>,
        spx: Option<i32>,
    },
    Pixel(i32),
}

/// Four inclusive edges of a coordinate or arbitrary box.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Edges {
    pub x1: Edge,
    pub y1: Edge,
    pub x2: Edge,
    pub y2: Edge,
}

/// Corner rounding of a painted box (`fgce.md` §8.5).
///
/// A radius is a form, not an edge: it is parsed with the same length grammar as
/// `Edge` but never obeys `on_grid`. The resolved value is clamped to half of the
/// smaller box side, so `Percent(50)` is always a circle or a capsule.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Radius {
    /// `Grid` — cells of the 5/15 lattice plus an in-cell sPx nudge; `Pixel` — plain sPx.
    Edge(Edge),
    /// Share of the smaller box side in percents, `0..=50`; `50` is the maximum.
    Percent(u8),
}

/// Minimum gaps between a top-level box and the window (`fgce.md` §4.8).
/// `None` means zero.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Inset {
    pub left: Option<Edge>,
    pub top: Option<Edge>,
    pub right: Option<Edge>,
    pub bottom: Option<Edge>,
}

/// Image texel layout accepted by `Upload`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PixelFormat {
    Rgb8,
    Rgba8,
    Alpha8,
}

/// Alpha convention of uploaded bytes and of `ReadPixels` output.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AlphaMode {
    Premul,
    Straight,
}

/// Blending of one drawing command.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Blend {
    SrcOver,
    Src,
    Clear,
    /// Destination-out with coverage: `dst *= 1 - coverage` in premultiplied channels.
    DstOut,
}

/// Fill rule of a path.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FillRule {
    NonZero,
    EvenOdd,
}

/// Fill branch of a vector entity or of `Measure`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Fill {
    pub rule: FillRule,
}

/// Side of the path that the stroke occupies (`fgce.md` §8.4).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StrokeAlign {
    Inside,
    Outside,
    /// Half of `width` on each side of the contour (`fgce.md` §8.4).
    Center,
}

/// Stroke join.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Join {
    /// `limit_q8` is the miter limit in 8.8; default value is `1024`.
    Miter {
        limit_q8: u32,
    },
    Bevel,
    Round,
}

/// Stroke cap.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Cap {
    Butt,
    Square,
    Round,
}

/// Peak normalization of a stroke (`fgce.md` §8.4).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Peak {
    /// The exact light of the geometry; the current behaviour.
    #[default]
    Light,
    /// Scale the whole stroke so its global coverage peak becomes full coverage
    /// (`256`); for `width_q8 = 256` that is the nominal 1 sPx.
    Nominal,
}

/// One whole sPx in the 1/256 units of `Stroke::width_q8`.
pub const SPX_Q8: u32 = 256;

/// Stroke branch of a vector entity or of `Measure` (`fgce.md` §8.4).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Stroke {
    /// Perpendicular width in 1/256 sPx; `0` is `BadStroke`.
    pub width_q8: u32,
    pub align: StrokeAlign,
    pub join: Join,
    pub cap: Cap,
    pub peak: Peak,
}

impl Stroke {
    /// Whole-sPx width with the common defaults: `Miter { limit_q8: 1024 }`,
    /// `Cap::Butt` and `Peak::Light`.
    pub const fn px(width: u32, align: StrokeAlign) -> Self {
        Stroke {
            width_q8: width.saturating_mul(SPX_Q8),
            align,
            join: Join::Miter { limit_q8: 1024 },
            cap: Cap::Butt,
            peak: Peak::Light,
        }
    }

    /// Width already in 1/256 sPx, same defaults as `px`.
    pub const fn q8(width_q8: u32, align: StrokeAlign) -> Self {
        Stroke {
            width_q8,
            align,
            join: Join::Miter { limit_q8: 1024 },
            cap: Cap::Butt,
            peak: Peak::Light,
        }
    }
}

/// Colors and text scale of the debug tree layer (`fgce.md` §5.3).
///
/// Labels interpolate `label_base → label_tip` over the same depth fraction as
/// the outlines; `None` inherits `base` and `tip`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct DebugGridStyle {
    pub base: Color,
    pub tip: Color,
    pub label_base: Option<Color>,
    pub label_tip: Option<Color>,
    pub label_alpha: u8,
    pub label_scale: u8,
}

impl DebugGridStyle {
    /// Outlines and labels share one `base → tip` scale; `label_alpha` and
    /// `label_scale` keep the label pass on or off.
    pub const fn new(base: Color, tip: Color, label_alpha: u8, label_scale: u8) -> Self {
        DebugGridStyle {
            base,
            tip,
            label_base: None,
            label_tip: None,
            label_alpha,
            label_scale,
        }
    }

    /// A separate brightness scale for labels; arrows follow it as well.
    pub const fn with_label_colors(self, label_base: Color, label_tip: Color) -> Self {
        DebugGridStyle {
            label_base: Some(label_base),
            label_tip: Some(label_tip),
            ..self
        }
    }
}

/// Window-space point used by `DebugHover`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct DebugPoint {
    pub x: i32,
    pub y: i32,
}

/// Raster sampling of `Blit`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Sample {
    Crisp,
    Area,
}

/// Path verb. Coordinates are sPx (`fgce.md` §8.3).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Verb {
    Move(i32, i32),
    Line(i32, i32),
    Quad(i32, i32, i32, i32),
    Cubic(i32, i32, i32, i32, i32, i32),
    Close,
}

/// Paint of an entity (`fgce.md` §4.2).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EntityKind<'a> {
    Photo {
        format: PixelFormat,
        image: ImageId,
        tint: Option<Color>,
    },
    Glyph {
        format: PixelFormat,
        image: ImageId,
        tint: Option<Color>,
    },
    Vector {
        verbs: &'a [Verb],
        fill: Option<Fill>,
        stroke: Option<Stroke>,
        color: Color,
    },
    Flat {
        color: Color,
    },
    /// Rounded box: fill and/or stroke of the entity rectangle with `radius`.
    Box {
        fill: Option<Fill>,
        stroke: Option<Stroke>,
        color: Color,
    },
    /// Layout-only box: occupies its coordinate box and paints nothing.
    Empty,
}

/// Entity request body (`fgce.md` §5.0).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Entity<'a> {
    pub id: NodeId,
    pub kind: EntityKind<'a>,
    pub on_grid: Option<bool>,
    pub edges: Edges,
    pub align: Option<Align>,
    pub blend: Option<Blend>,
    pub radius: Option<Radius>,
}

/// One request accepted by `submit`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Request<'a> {
    Info,
    Grid {
        k: u32,
    },
    Length {
        n: u32,
        k: u32,
    },
    Lattice {
        span_x: u32,
        span_y: u32,
        step: u32,
        pin_x: i8,
        pin_y: i8,
    },
    EdgePx {
        edge: Edge,
        k: u32,
    },
    Measure {
        verbs: &'a [Verb],
        fill: Option<Fill>,
        stroke: Option<Stroke>,
    },
    Begin {
        width: u32,
        height: u32,
    },
    End,
    /// Paints the active tree once inside the current frame; idempotent.
    DrawTree,
    ReadPixels {
        rect: Rect,
        alpha: AlphaMode,
    },
    Upload {
        id: ImageId,
        width: u32,
        height: u32,
        stride: u32,
        format: PixelFormat,
        alpha: AlphaMode,
        bytes: &'a [u8],
    },
    Drop {
        id: ImageId,
    },
    FillRect {
        rect: Rect,
        color: Color,
        blend: Option<Blend>,
        radius: Option<Radius>,
    },
    Blit {
        id: ImageId,
        dest: Rect,
        src: Rect,
        sample: Sample,
        tint: Option<Color>,
        blend: Option<Blend>,
        radius: Option<Radius>,
    },
    FillPath {
        verbs: &'a [Verb],
        rule: FillRule,
        color: Color,
        blend: Option<Blend>,
    },
    StrokePath {
        verbs: &'a [Verb],
        stroke: Stroke,
        color: Color,
        blend: Option<Blend>,
    },
    /// Stroke of a rounded rectangle; `radius: None` is a plain rectangle.
    StrokeRoundRect {
        rect: Rect,
        radius: Option<Radius>,
        stroke: Stroke,
        color: Color,
        blend: Option<Blend>,
    },
    /// One-sPx lattice lines inside `rect`; verticals first, then horizontals.
    FillLattice {
        rect: Rect,
        step: u32,
        primary_step: Option<u32>,
        fine_color: Color,
        primary_color: Color,
        blend: Option<Blend>,
    },
    /// Enables or disables the debug tree layer; `None` keeps the names.
    DebugGrid {
        style: Option<DebugGridStyle>,
    },
    /// Hover point of the debug layer; `None` removes the labels.
    DebugHover(Option<DebugPoint>),
    /// Name of a node in the debug layer; `None` removes it.
    DebugLabel {
        id: NodeId,
        text: Option<&'a str>,
    },
    ClipPush {
        rect: Rect,
    },
    ClipPop,
    DefineReference {
        id: ReferenceId,
        canon_w: u32,
        canon_h: u32,
        k: u32,
        d: u32,
        pin: Pin,
        enter_cols: u32,
        enter_rows: u32,
    },
    UseReference {
        id: ReferenceId,
    },
    Entity(Entity<'a>),
    Group {
        id: NodeId,
        parent: NodeId,
        children: &'a [NodeId],
        pin: Pin,
        snap: bool,
        inset: Option<Inset>,
    },
    Arbitrary {
        id: NodeId,
        parent: NodeId,
        on_grid: Option<bool>,
        edges: Edges,
        children: &'a [NodeId],
        pin: Pin,
        snap: bool,
        inset: Option<Inset>,
    },
    Show {
        id: NodeId,
        rect: Rect,
    },
    Place {
        id: NodeId,
        rect: Rect,
    },
    Remove {
        id: NodeId,
    },
    Snapshot,
}

/// Grid step pair of scale `k` (`fgce.md` §3.1).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Grid {
    pub fine: u32,
    pub primary: u32,
}

/// Live window lattice (`fgce.md` §3.4).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Lattice {
    pub count_x: u32,
    pub count_y: u32,
    pub origin_x: i64,
    pub origin_y: i64,
}

/// Engine limits (`fgce.md` §5.1, decision 52).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Info {
    pub version: &'static str,
    pub max_side: u32,
    pub max_k: u32,
    pub max_clip: u32,
    pub max_vertices: u32,
    pub max_coord: u32,
    pub pixel_format: PixelFormat,
    pub premultiplied: bool,
}

/// Borrowed frame returned by `End` without a copy.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Frame<'a> {
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub pixels: &'a [u8],
}

/// Owning copy returned by `ReadPixels`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Pixels {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub bytes: Vec<u8>,
}

/// One node of a snapshot.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Node {
    pub id: NodeId,
    pub parent: NodeId,
    pub rect: Rect,
}

/// Snapshot of the active tree in draw order (`fgce.md` §5.5).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Snapshot {
    pub generation: u64,
    pub nodes: Vec<Node>,
}

/// Response of `submit`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Response<'a> {
    Info(Info),
    Grid(Grid),
    Length(u32),
    Lattice(Lattice),
    EdgePx(i32),
    Measure(Rect),
    Frame(Frame<'a>),
    Snapshot(Snapshot),
    Pixels(Pixels),
    None,
}

/// Error codes of `fgce.md` §5.4. Carries no text.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Error {
    ScaleOutOfRange,
    SurfaceOutOfRange,
    NotBegun,
    UnknownImage,
    UnknownNode,
    ImageTooLarge,
    BufferLayout,
    ClipUnderflow,
    ClipOverflow,
    BadCell,
    Overflow,
    BadStroke,
    BadPath,
    BadNudge,
    BadAnchor,
    BadGroup,
    BadArbitrary,
    BadInset,
    BoxOverflow,
    OffGrid,
    BadParent,
    ReferenceMissing,
    ReferenceBusy,
    BadRadius,
}
