//! Binary wire protocol of the FGCE host adapter (`docs/wasm-abi.md`, v1).
//!
//! Little-endian. Variable payloads (`verbs`, `children`, `Upload` bytes) are
//! addressed by offsets **relative to the request buffer**, so the adapter never
//! casts host pointers: only the request slice itself crosses the FFI boundary.

use fgce::{
    Align, AlphaMode, Blend, Cap, Color, Edge, Edges, Entity, EntityKind, Error, Fill, FillRule,
    ImageId, Inset, Join, NodeId, Pin, PixelFormat, Radius, Rect, ReferenceId, Request, Response,
    Sample, Stroke, StrokeAlign, Verb,
};

pub(crate) const OP_INFO: u8 = 1;
pub(crate) const OP_GRID: u8 = 2;
pub(crate) const OP_LENGTH: u8 = 3;
pub(crate) const OP_LATTICE: u8 = 4;
pub(crate) const OP_EDGE_PX: u8 = 5;
pub(crate) const OP_MEASURE: u8 = 6;
pub(crate) const OP_BEGIN: u8 = 7;
pub(crate) const OP_END: u8 = 8;
pub(crate) const OP_READ_PIXELS: u8 = 9;
pub(crate) const OP_UPLOAD: u8 = 10;
pub(crate) const OP_DROP: u8 = 11;
pub(crate) const OP_FILL_RECT: u8 = 12;
pub(crate) const OP_ENTITY: u8 = 13;
pub(crate) const OP_GROUP: u8 = 14;
pub(crate) const OP_ARBITRARY: u8 = 15;
pub(crate) const OP_SHOW: u8 = 16;
pub(crate) const OP_PLACE: u8 = 17;
pub(crate) const OP_REMOVE: u8 = 18;
pub(crate) const OP_SNAPSHOT: u8 = 19;
pub(crate) const OP_DEFINE_REFERENCE: u8 = 20;
pub(crate) const OP_USE_REFERENCE: u8 = 21;
pub(crate) const OP_CLIP_PUSH: u8 = 22;
pub(crate) const OP_CLIP_POP: u8 = 23;
pub(crate) const OP_BLIT: u8 = 24;
pub(crate) const OP_FILL_PATH: u8 = 25;
pub(crate) const OP_STROKE_PATH: u8 = 26;

pub(crate) const KIND_NONE: u8 = 0;
pub(crate) const KIND_INFO: u8 = 1;
pub(crate) const KIND_GRID: u8 = 2;
pub(crate) const KIND_LENGTH: u8 = 3;
pub(crate) const KIND_LATTICE: u8 = 4;
pub(crate) const KIND_EDGE_PX: u8 = 5;
pub(crate) const KIND_MEASURE: u8 = 6;
pub(crate) const KIND_FRAME: u8 = 7;
pub(crate) const KIND_PIXELS: u8 = 8;
pub(crate) const KIND_SNAPSHOT: u8 = 9;
pub(crate) const KIND_ERROR: u8 = 10;

/// Owned request payload. Owns `verbs`, `children` and `bytes` so the borrow into
/// `fgce::Request` can be built inside `submit`.
pub(crate) enum Decoded {
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
        verbs: Vec<Verb>,
        fill: Option<Fill>,
        stroke: Option<Stroke>,
    },
    Begin {
        width: u32,
        height: u32,
    },
    End,
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
        bytes: Vec<u8>,
    },
    Drop {
        id: ImageId,
    },
    FillRect {
        rect: Rect,
        color: Color,
        blend: Option<Blend>,
    },
    Entity(EntityOwned),
    Group(BoxOwned),
    Arbitrary(BoxOwned),
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
    ClipPush {
        rect: Rect,
    },
    ClipPop,
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
        verbs: Vec<Verb>,
        rule: FillRule,
        color: Color,
        blend: Option<Blend>,
    },
    StrokePath {
        verbs: Vec<Verb>,
        stroke: Stroke,
        color: Color,
        blend: Option<Blend>,
    },
}

pub(crate) struct EntityOwned {
    pub(crate) id: NodeId,
    pub(crate) kind: KindOwned,
    pub(crate) on_grid: Option<bool>,
    pub(crate) edges: Edges,
    pub(crate) align: Option<Align>,
    pub(crate) blend: Option<Blend>,
    pub(crate) radius: Option<Radius>,
}

pub(crate) enum KindOwned {
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
        verbs: Vec<Verb>,
        fill: Option<Fill>,
        stroke: Option<Stroke>,
        color: Color,
    },
    Flat {
        color: Color,
    },
    Box {
        fill: Option<Fill>,
        stroke: Option<Stroke>,
        color: Color,
    },
}

pub(crate) struct BoxOwned {
    pub(crate) id: NodeId,
    pub(crate) parent: NodeId,
    pub(crate) children: Vec<NodeId>,
    pub(crate) pin: Pin,
    pub(crate) snap: bool,
    pub(crate) inset: Option<Inset>,
    pub(crate) on_grid: Option<bool>,
    pub(crate) edges: Edges,
}

/// Reads a `[offset, offset + len)` slice of the request buffer.
pub(crate) fn sub_slice(data: &[u8], offset: u32, len: u32) -> Result<&[u8], Error> {
    let start = offset as usize;
    let end = start.checked_add(len as usize).ok_or(Error::BufferLayout)?;
    data.get(start..end).ok_or(Error::BufferLayout)
}

pub(crate) struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub(crate) fn new(data: &'a [u8]) -> Self {
        Reader { data, pos: 0 }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.pos >= self.data.len()
    }

    fn take(&mut self, len: usize) -> Result<&'a [u8], Error> {
        let end = self.pos.checked_add(len).ok_or(Error::BufferLayout)?;
        if end > self.data.len() {
            return Err(Error::BufferLayout);
        }
        let slice = &self.data[self.pos..end];
        self.pos = end;
        Ok(slice)
    }

    pub(crate) fn u8(&mut self) -> Result<u8, Error> {
        Ok(self.take(1)?[0])
    }

    pub(crate) fn i8(&mut self) -> Result<i8, Error> {
        Ok(self.u8()? as i8)
    }

    pub(crate) fn bool(&mut self) -> Result<bool, Error> {
        Ok(self.u8()? != 0)
    }

    pub(crate) fn u32(&mut self) -> Result<u32, Error> {
        let bytes = self.take(4)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    pub(crate) fn i32(&mut self) -> Result<i32, Error> {
        Ok(self.u32()? as i32)
    }

    #[cfg(test)]
    pub(crate) fn u64(&mut self) -> Result<u64, Error> {
        let bytes = self.take(8)?;
        Ok(u64::from_le_bytes([
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        ]))
    }

    #[cfg(test)]
    pub(crate) fn bytes(&mut self, len: usize) -> Result<&'a [u8], Error> {
        self.take(len)
    }
}

pub(crate) struct Writer {
    pub(crate) out: Vec<u8>,
}

impl Writer {
    pub(crate) fn new() -> Self {
        Writer { out: Vec::new() }
    }

    pub(crate) fn u8(&mut self, value: u8) {
        self.out.push(value);
    }

    pub(crate) fn bool(&mut self, value: bool) {
        self.out.push(u8::from(value));
    }

    #[cfg(test)]
    pub(crate) fn i8(&mut self, value: i8) {
        self.out.push(value as u8);
    }

    pub(crate) fn u32(&mut self, value: u32) {
        self.out.extend_from_slice(&value.to_le_bytes());
    }

    pub(crate) fn i32(&mut self, value: i32) {
        self.out.extend_from_slice(&value.to_le_bytes());
    }

    pub(crate) fn u64(&mut self, value: u64) {
        self.out.extend_from_slice(&value.to_le_bytes());
    }

    pub(crate) fn bytes(&mut self, value: &[u8]) {
        self.out.extend_from_slice(value);
    }
}

fn format_code(format: PixelFormat) -> u8 {
    match format {
        PixelFormat::Rgb8 => 0,
        PixelFormat::Rgba8 => 1,
        PixelFormat::Alpha8 => 2,
    }
}

fn read_opt<T>(
    reader: &mut Reader<'_>,
    read: impl FnOnce(&mut Reader<'_>) -> Result<T, Error>,
) -> Result<Option<T>, Error> {
    if reader.bool()? {
        Ok(Some(read(reader)?))
    } else {
        Ok(None)
    }
}

fn read_edge(reader: &mut Reader<'_>) -> Result<Edge, Error> {
    match reader.u8()? {
        0 => {
            let primary = reader.i32()?;
            let fine = read_opt(reader, |r| r.u8())?;
            let spx = read_opt(reader, |r| r.i32())?;
            Ok(Edge::Grid { primary, fine, spx })
        }
        1 => Ok(Edge::Pixel(reader.i32()?)),
        _ => Err(Error::BufferLayout),
    }
}

fn read_edges(reader: &mut Reader<'_>) -> Result<Edges, Error> {
    Ok(Edges {
        x1: read_edge(reader)?,
        y1: read_edge(reader)?,
        x2: read_edge(reader)?,
        y2: read_edge(reader)?,
    })
}

fn read_inset(reader: &mut Reader<'_>) -> Result<Option<Inset>, Error> {
    if !reader.bool()? {
        return Ok(None);
    }
    Ok(Some(Inset {
        left: read_opt(reader, read_edge)?,
        top: read_opt(reader, read_edge)?,
        right: read_opt(reader, read_edge)?,
        bottom: read_opt(reader, read_edge)?,
    }))
}

fn read_rect(reader: &mut Reader<'_>) -> Result<Rect, Error> {
    Ok(Rect {
        x1: reader.i32()?,
        y1: reader.i32()?,
        x2: reader.i32()?,
        y2: reader.i32()?,
    })
}

fn read_color(reader: &mut Reader<'_>) -> Result<Color, Error> {
    Ok(Color {
        r: reader.u8()?,
        g: reader.u8()?,
        b: reader.u8()?,
        a: reader.u8()?,
    })
}

fn read_verb(reader: &mut Reader<'_>) -> Result<Verb, Error> {
    match reader.u8()? {
        0 => Ok(Verb::Move(reader.i32()?, reader.i32()?)),
        1 => Ok(Verb::Line(reader.i32()?, reader.i32()?)),
        2 => Ok(Verb::Quad(
            reader.i32()?,
            reader.i32()?,
            reader.i32()?,
            reader.i32()?,
        )),
        3 => Ok(Verb::Cubic(
            reader.i32()?,
            reader.i32()?,
            reader.i32()?,
            reader.i32()?,
            reader.i32()?,
            reader.i32()?,
        )),
        4 => Ok(Verb::Close),
        _ => Err(Error::BufferLayout),
    }
}

fn read_stroke(reader: &mut Reader<'_>) -> Result<Stroke, Error> {
    let width = reader.u32()?;
    let align = match reader.u8()? {
        0 => StrokeAlign::Inside,
        1 => StrokeAlign::Outside,
        _ => return Err(Error::BufferLayout),
    };
    let join = match reader.u8()? {
        0 => Join::Miter {
            limit_q8: reader.u32()?,
        },
        1 => Join::Bevel,
        2 => Join::Round,
        _ => return Err(Error::BufferLayout),
    };
    let cap = match reader.u8()? {
        0 => Cap::Butt,
        1 => Cap::Square,
        2 => Cap::Round,
        _ => return Err(Error::BufferLayout),
    };
    Ok(Stroke {
        width,
        align,
        join,
        cap,
    })
}

fn read_fill(reader: &mut Reader<'_>) -> Result<Fill, Error> {
    Ok(Fill {
        rule: match reader.u8()? {
            0 => FillRule::NonZero,
            1 => FillRule::EvenOdd,
            _ => return Err(Error::BufferLayout),
        },
    })
}

/// Reads `offset/len` and decodes the pointed buffer into verbs.
fn read_verbs(data: &[u8], reader: &mut Reader<'_>) -> Result<Vec<Verb>, Error> {
    let offset = reader.u32()?;
    let len = reader.u32()?;
    let bytes = sub_slice(data, offset, len)?;
    let mut verbs = Vec::new();
    let mut vr = Reader::new(bytes);
    while !vr.is_empty() {
        verbs.push(read_verb(&mut vr)?);
    }
    Ok(verbs)
}

/// Reads `offset/count` (count is a node count) into children ids.
fn read_children(data: &[u8], reader: &mut Reader<'_>) -> Result<Vec<NodeId>, Error> {
    let offset = reader.u32()?;
    let count = reader.u32()?;
    let bytes = sub_slice(data, offset, count.saturating_mul(4))?;
    let mut children = Vec::with_capacity(count as usize);
    let mut cr = Reader::new(bytes);
    for _ in 0..count {
        children.push(NodeId(cr.u32()?));
    }
    Ok(children)
}

fn read_kind(data: &[u8], reader: &mut Reader<'_>) -> Result<KindOwned, Error> {
    match reader.u8()? {
        0 => Ok(KindOwned::Photo {
            format: read_format(reader)?,
            image: ImageId(reader.u32()?),
            tint: read_opt(reader, read_color)?,
        }),
        1 => Ok(KindOwned::Glyph {
            format: read_format(reader)?,
            image: ImageId(reader.u32()?),
            tint: read_opt(reader, read_color)?,
        }),
        2 => Ok(KindOwned::Vector {
            verbs: read_verbs(data, reader)?,
            fill: read_opt(reader, read_fill)?,
            stroke: read_opt(reader, read_stroke)?,
            color: read_color(reader)?,
        }),
        3 => Ok(KindOwned::Flat {
            color: read_color(reader)?,
        }),
        4 => Ok(KindOwned::Box {
            fill: read_opt(reader, read_fill)?,
            stroke: read_opt(reader, read_stroke)?,
            color: read_color(reader)?,
        }),
        _ => Err(Error::BufferLayout),
    }
}

fn read_format(reader: &mut Reader<'_>) -> Result<PixelFormat, Error> {
    match reader.u8()? {
        0 => Ok(PixelFormat::Rgb8),
        1 => Ok(PixelFormat::Rgba8),
        2 => Ok(PixelFormat::Alpha8),
        _ => Err(Error::BufferLayout),
    }
}

pub(crate) fn decode_request(data: &[u8]) -> Result<Decoded, Error> {
    let mut reader = Reader::new(data);
    let op = reader.u8()?;
    let decoded = match op {
        OP_INFO => Decoded::Info,
        OP_GRID => Decoded::Grid { k: reader.u32()? },
        OP_LENGTH => Decoded::Length {
            n: reader.u32()?,
            k: reader.u32()?,
        },
        OP_LATTICE => Decoded::Lattice {
            span_x: reader.u32()?,
            span_y: reader.u32()?,
            step: reader.u32()?,
            pin_x: reader.i8()?,
            pin_y: reader.i8()?,
        },
        OP_EDGE_PX => Decoded::EdgePx {
            edge: read_edge(&mut reader)?,
            k: reader.u32()?,
        },
        OP_MEASURE => Decoded::Measure {
            verbs: read_verbs(data, &mut reader)?,
            fill: read_opt(&mut reader, read_fill)?,
            stroke: read_opt(&mut reader, read_stroke)?,
        },
        OP_BEGIN => Decoded::Begin {
            width: reader.u32()?,
            height: reader.u32()?,
        },
        OP_END => Decoded::End,
        OP_READ_PIXELS => Decoded::ReadPixels {
            rect: read_rect(&mut reader)?,
            alpha: match reader.u8()? {
                0 => AlphaMode::Premul,
                1 => AlphaMode::Straight,
                _ => return Err(Error::BufferLayout),
            },
        },
        OP_UPLOAD => {
            let id = ImageId(reader.u32()?);
            let width = reader.u32()?;
            let height = reader.u32()?;
            let stride = reader.u32()?;
            let format = read_format(&mut reader)?;
            let alpha = match reader.u8()? {
                0 => AlphaMode::Premul,
                1 => AlphaMode::Straight,
                _ => return Err(Error::BufferLayout),
            };
            let ptr = reader.u32()?;
            let len = reader.u32()?;
            let bytes = sub_slice(data, ptr, len)?.to_vec();
            Decoded::Upload {
                id,
                width,
                height,
                stride,
                format,
                alpha,
                bytes,
            }
        }
        OP_DROP => Decoded::Drop {
            id: ImageId(reader.u32()?),
        },
        OP_FILL_RECT => Decoded::FillRect {
            rect: read_rect(&mut reader)?,
            color: read_color(&mut reader)?,
            blend: read_opt(&mut reader, read_blend)?,
        },
        OP_ENTITY => Decoded::Entity(EntityOwned {
            id: NodeId(reader.u32()?),
            kind: read_kind(data, &mut reader)?,
            on_grid: read_opt(&mut reader, |r| r.bool())?,
            edges: read_edges(&mut reader)?,
            align: read_opt(&mut reader, read_align)?,
            blend: read_opt(&mut reader, read_blend)?,
            radius: read_opt(&mut reader, read_radius)?,
        }),
        OP_GROUP => Decoded::Group(read_box(data, &mut reader, false)?),
        OP_ARBITRARY => Decoded::Arbitrary(read_box(data, &mut reader, true)?),
        OP_SHOW => Decoded::Show {
            id: NodeId(reader.u32()?),
            rect: read_rect(&mut reader)?,
        },
        OP_PLACE => Decoded::Place {
            id: NodeId(reader.u32()?),
            rect: read_rect(&mut reader)?,
        },
        OP_REMOVE => Decoded::Remove {
            id: NodeId(reader.u32()?),
        },
        OP_SNAPSHOT => Decoded::Snapshot,
        OP_DEFINE_REFERENCE => Decoded::DefineReference {
            id: ReferenceId(reader.u32()?),
            canon_w: reader.u32()?,
            canon_h: reader.u32()?,
            k: reader.u32()?,
            d: reader.u32()?,
            pin: Pin {
                x: reader.i8()?,
                y: reader.i8()?,
            },
            enter_cols: reader.u32()?,
            enter_rows: reader.u32()?,
        },
        OP_USE_REFERENCE => Decoded::UseReference {
            id: ReferenceId(reader.u32()?),
        },
        OP_CLIP_PUSH => Decoded::ClipPush {
            rect: read_rect(&mut reader)?,
        },
        OP_CLIP_POP => Decoded::ClipPop,
        OP_BLIT => Decoded::Blit {
            id: ImageId(reader.u32()?),
            dest: read_rect(&mut reader)?,
            src: read_rect(&mut reader)?,
            sample: match reader.u8()? {
                0 => Sample::Crisp,
                1 => Sample::Area,
                _ => return Err(Error::BufferLayout),
            },
            tint: read_opt(&mut reader, read_color)?,
            blend: read_opt(&mut reader, read_blend)?,
            radius: read_opt(&mut reader, read_radius)?,
        },
        OP_FILL_PATH => Decoded::FillPath {
            verbs: read_verbs(data, &mut reader)?,
            rule: read_fill(&mut reader)?.rule,
            color: read_color(&mut reader)?,
            blend: read_opt(&mut reader, read_blend)?,
        },
        OP_STROKE_PATH => Decoded::StrokePath {
            verbs: read_verbs(data, &mut reader)?,
            stroke: read_stroke(&mut reader)?,
            color: read_color(&mut reader)?,
            blend: read_opt(&mut reader, read_blend)?,
        },
        _ => return Err(Error::BufferLayout),
    };
    Ok(decoded)
}

fn read_align(reader: &mut Reader<'_>) -> Result<Align, Error> {
    Ok(Align {
        x: reader.i8()?,
        y: reader.i8()?,
    })
}

fn read_blend(reader: &mut Reader<'_>) -> Result<Blend, Error> {
    match reader.u8()? {
        0 => Ok(Blend::SrcOver),
        1 => Ok(Blend::Src),
        2 => Ok(Blend::Clear),
        3 => Ok(Blend::DstOut),
        _ => Err(Error::BufferLayout),
    }
}

fn read_radius(reader: &mut Reader<'_>) -> Result<Radius, Error> {
    match reader.u8()? {
        0 => Ok(Radius::Edge(read_edge(reader)?)),
        1 => Ok(Radius::Percent(reader.u8()?)),
        _ => Err(Error::BufferLayout),
    }
}

fn read_box(data: &[u8], reader: &mut Reader<'_>, arbitrary: bool) -> Result<BoxOwned, Error> {
    let id = NodeId(reader.u32()?);
    let parent = NodeId(reader.u32()?);
    let on_grid = if arbitrary {
        read_opt(reader, |r| r.bool())?
    } else {
        None
    };
    let edges = if arbitrary {
        read_edges(reader)?
    } else {
        Edges {
            x1: Edge::Pixel(0),
            y1: Edge::Pixel(0),
            x2: Edge::Pixel(0),
            y2: Edge::Pixel(0),
        }
    };
    let children = read_children(data, reader)?;
    let pin = Pin {
        x: reader.i8()?,
        y: reader.i8()?,
    };
    let snap = reader.bool()?;
    let inset = read_inset(reader)?;
    Ok(BoxOwned {
        id,
        parent,
        children,
        pin,
        snap,
        inset,
        on_grid,
        edges,
    })
}

/// Builds a `fgce::Request` from an owned payload. The borrows live for the call.
pub(crate) fn to_request(decoded: &Decoded) -> Request<'_> {
    match decoded {
        Decoded::Info => Request::Info,
        Decoded::Grid { k } => Request::Grid { k: *k },
        Decoded::Length { n, k } => Request::Length { n: *n, k: *k },
        Decoded::Lattice {
            span_x,
            span_y,
            step,
            pin_x,
            pin_y,
        } => Request::Lattice {
            span_x: *span_x,
            span_y: *span_y,
            step: *step,
            pin_x: *pin_x,
            pin_y: *pin_y,
        },
        Decoded::EdgePx { edge, k } => Request::EdgePx { edge: *edge, k: *k },
        Decoded::Measure {
            verbs,
            fill,
            stroke,
        } => Request::Measure {
            verbs,
            fill: *fill,
            stroke: *stroke,
        },
        Decoded::Begin { width, height } => Request::Begin {
            width: *width,
            height: *height,
        },
        Decoded::End => Request::End,
        Decoded::ReadPixels { rect, alpha } => Request::ReadPixels {
            rect: *rect,
            alpha: *alpha,
        },
        Decoded::Upload {
            id,
            width,
            height,
            stride,
            format,
            alpha,
            bytes,
        } => Request::Upload {
            id: *id,
            width: *width,
            height: *height,
            stride: *stride,
            format: *format,
            alpha: *alpha,
            bytes,
        },
        Decoded::Drop { id } => Request::Drop { id: *id },
        Decoded::FillRect { rect, color, blend } => Request::FillRect {
            rect: *rect,
            color: *color,
            blend: *blend,
        },
        Decoded::Entity(entity) => Request::Entity(Entity {
            id: entity.id,
            kind: to_kind(&entity.kind),
            on_grid: entity.on_grid,
            edges: entity.edges,
            align: entity.align,
            blend: entity.blend,
            radius: entity.radius,
        }),
        Decoded::Group(box_owned) => Request::Group {
            id: box_owned.id,
            parent: box_owned.parent,
            children: &box_owned.children,
            pin: box_owned.pin,
            snap: box_owned.snap,
            inset: box_owned.inset,
        },
        Decoded::Arbitrary(box_owned) => Request::Arbitrary {
            id: box_owned.id,
            parent: box_owned.parent,
            on_grid: box_owned.on_grid,
            edges: box_owned.edges,
            children: &box_owned.children,
            pin: box_owned.pin,
            snap: box_owned.snap,
            inset: box_owned.inset,
        },
        Decoded::Show { id, rect } => Request::Show {
            id: *id,
            rect: *rect,
        },
        Decoded::Place { id, rect } => Request::Place {
            id: *id,
            rect: *rect,
        },
        Decoded::Remove { id } => Request::Remove { id: *id },
        Decoded::Snapshot => Request::Snapshot,
        Decoded::DefineReference {
            id,
            canon_w,
            canon_h,
            k,
            d,
            pin,
            enter_cols,
            enter_rows,
        } => Request::DefineReference {
            id: *id,
            canon_w: *canon_w,
            canon_h: *canon_h,
            k: *k,
            d: *d,
            pin: *pin,
            enter_cols: *enter_cols,
            enter_rows: *enter_rows,
        },
        Decoded::UseReference { id } => Request::UseReference { id: *id },
        Decoded::ClipPush { rect } => Request::ClipPush { rect: *rect },
        Decoded::ClipPop => Request::ClipPop,
        Decoded::Blit {
            id,
            dest,
            src,
            sample,
            tint,
            blend,
            radius,
        } => Request::Blit {
            id: *id,
            dest: *dest,
            src: *src,
            sample: *sample,
            tint: *tint,
            blend: *blend,
            radius: *radius,
        },
        Decoded::FillPath {
            verbs,
            rule,
            color,
            blend,
        } => Request::FillPath {
            verbs,
            rule: *rule,
            color: *color,
            blend: *blend,
        },
        Decoded::StrokePath {
            verbs,
            stroke,
            color,
            blend,
        } => Request::StrokePath {
            verbs,
            width: stroke.width,
            align: stroke.align,
            join: stroke.join,
            cap: stroke.cap,
            color: *color,
            blend: *blend,
        },
    }
}

fn to_kind(kind: &KindOwned) -> EntityKind<'_> {
    match kind {
        KindOwned::Photo {
            format,
            image,
            tint,
        } => EntityKind::Photo {
            format: *format,
            image: *image,
            tint: *tint,
        },
        KindOwned::Glyph {
            format,
            image,
            tint,
        } => EntityKind::Glyph {
            format: *format,
            image: *image,
            tint: *tint,
        },
        KindOwned::Vector {
            verbs,
            fill,
            stroke,
            color,
        } => EntityKind::Vector {
            verbs,
            fill: *fill,
            stroke: *stroke,
            color: *color,
        },
        KindOwned::Flat { color } => EntityKind::Flat { color: *color },
        KindOwned::Box {
            fill,
            stroke,
            color,
        } => EntityKind::Box {
            fill: *fill,
            stroke: *stroke,
            color: *color,
        },
    }
}

/// Error code order is the `fgce::Error` declaration order; the TS mirrors it.
pub(crate) fn error_code(error: Error) -> u8 {
    match error {
        Error::ScaleOutOfRange => 0,
        Error::SurfaceOutOfRange => 1,
        Error::NotBegun => 2,
        Error::UnknownImage => 3,
        Error::UnknownNode => 4,
        Error::ImageTooLarge => 5,
        Error::BufferLayout => 6,
        Error::ClipUnderflow => 7,
        Error::ClipOverflow => 8,
        Error::BadCell => 9,
        Error::Overflow => 10,
        Error::BadStroke => 11,
        Error::BadPath => 12,
        Error::BadNudge => 13,
        Error::BadAnchor => 14,
        Error::BadGroup => 15,
        Error::BadArbitrary => 16,
        Error::BadInset => 17,
        Error::BoxOverflow => 18,
        Error::OffGrid => 19,
        Error::BadParent => 20,
        Error::ReferenceMissing => 21,
        Error::ReferenceBusy => 22,
        Error::BadRadius => 23,
    }
}

pub(crate) fn error_response(error: Error) -> Vec<u8> {
    vec![KIND_ERROR, error_code(error)]
}

pub(crate) fn encode_response(response: Response<'_>) -> Vec<u8> {
    let mut out = Vec::new();
    match response {
        Response::None => out.push(KIND_NONE),
        Response::Info(info) => {
            out.push(KIND_INFO);
            let mut writer = Writer::new();
            writer.u32(info.version.len() as u32);
            writer.bytes(info.version.as_bytes());
            writer.u32(info.max_side);
            writer.u32(info.max_k);
            writer.u32(info.max_clip);
            writer.u32(info.max_vertices);
            writer.u32(info.max_coord);
            writer.u8(format_code(info.pixel_format));
            writer.bool(info.premultiplied);
            out.extend_from_slice(&writer.out);
        }
        Response::Grid(grid) => {
            out.push(KIND_GRID);
            let mut writer = Writer::new();
            writer.u32(grid.fine);
            writer.u32(grid.primary);
            out.extend_from_slice(&writer.out);
        }
        Response::Length(length) => {
            out.push(KIND_LENGTH);
            let mut writer = Writer::new();
            writer.u32(length);
            out.extend_from_slice(&writer.out);
        }
        Response::Lattice(lattice) => {
            out.push(KIND_LATTICE);
            let mut writer = Writer::new();
            writer.u32(lattice.count_x);
            writer.u32(lattice.count_y);
            writer.u64(lattice.origin_x as u64);
            writer.u64(lattice.origin_y as u64);
            out.extend_from_slice(&writer.out);
        }
        Response::EdgePx(value) => {
            out.push(KIND_EDGE_PX);
            let mut writer = Writer::new();
            writer.i32(value);
            out.extend_from_slice(&writer.out);
        }
        Response::Measure(rect) => {
            out.push(KIND_MEASURE);
            let mut writer = Writer::new();
            writer.i32(rect.x1);
            writer.i32(rect.y1);
            writer.i32(rect.x2);
            writer.i32(rect.y2);
            out.extend_from_slice(&writer.out);
        }
        Response::Frame(frame) => {
            out.push(KIND_FRAME);
            let mut writer = Writer::new();
            writer.u32(frame.width);
            writer.u32(frame.height);
            writer.u32(frame.stride);
            writer.u32(frame.pixels.len() as u32);
            out.extend_from_slice(&writer.out);
            out.extend_from_slice(frame.pixels);
        }
        Response::Pixels(pixels) => {
            out.push(KIND_PIXELS);
            let mut writer = Writer::new();
            writer.i32(pixels.x);
            writer.i32(pixels.y);
            writer.u32(pixels.width);
            writer.u32(pixels.height);
            writer.u32(pixels.stride);
            writer.u32(pixels.bytes.len() as u32);
            out.extend_from_slice(&writer.out);
            out.extend_from_slice(&pixels.bytes);
        }
        Response::Snapshot(snapshot) => {
            out.push(KIND_SNAPSHOT);
            let mut writer = Writer::new();
            writer.u64(snapshot.generation);
            writer.u32(snapshot.nodes.len() as u32);
            for node in &snapshot.nodes {
                writer.u32(node.id.0);
                writer.u32(node.parent.0);
                writer.i32(node.rect.x1);
                writer.i32(node.rect.y1);
                writer.i32(node.rect.x2);
                writer.i32(node.rect.y2);
            }
            out.extend_from_slice(&writer.out);
        }
    }
    out
}
