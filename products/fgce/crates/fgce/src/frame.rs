//! Frame state, clip stack and frame lifecycle (`fgce.md` §5.2, §7).
//!
//! `frame` owns the buffer and calls raster modules; it never walks pixels itself.

use crate::State;
use crate::blit::{self, BlitOp, ImageView};
use crate::contract::{
    AlphaMode, Blend, Color, Error, FillRule, Frame, ImageId, NodeId, Pixels, Radius, Rect, Sample,
    Stroke, Verb,
};
use crate::fill;
use crate::round::{self, CornerCache};
use crate::span;
use crate::store::Store;
use crate::tree::{Class, EntityData, Node, Tree};
use crate::vector;
use crate::{MAX_SIDE, align_up};

pub(crate) const FRAME_ALIGN: usize = 64;

pub(crate) struct FrameBuffer {
    data: Vec<u8>,
    offset: usize,
    width: u32,
    height: u32,
    stride: u32,
    #[cfg(test)]
    allocations: usize,
    #[cfg(test)]
    tree_passes: usize,
}

impl FrameBuffer {
    pub(crate) const fn new() -> Self {
        FrameBuffer {
            data: Vec::new(),
            offset: 0,
            width: 0,
            height: 0,
            stride: 0,
            #[cfg(test)]
            allocations: 0,
            #[cfg(test)]
            tree_passes: 0,
        }
    }

    fn ensure(&mut self, width: u32, height: u32) -> bool {
        let stride = align_up(width as usize * 4, FRAME_ALIGN);
        let need = stride * height as usize;
        let reused = !self.data.is_empty() && self.width == width && self.height == height;
        if !reused {
            self.data = vec![0_u8; need + FRAME_ALIGN];
            self.offset = 0;
            #[cfg(test)]
            {
                self.allocations += 1;
            }
        }
        // Without `unsafe` the first pixel is aligned by an offset inside the allocation.
        let base = self.data.as_ptr() as usize;
        self.offset = (FRAME_ALIGN - base % FRAME_ALIGN) % FRAME_ALIGN;
        self.width = width;
        self.height = height;
        self.stride = stride as u32;
        reused
    }

    pub(crate) fn stride(&self) -> u32 {
        self.stride
    }

    pub(crate) fn bytes(&self) -> &[u8] {
        let need = self.stride as usize * self.height as usize;
        &self.data[self.offset..self.offset + need]
    }

    pub(crate) fn bytes_mut(&mut self) -> &mut [u8] {
        let need = self.stride as usize * self.height as usize;
        let offset = self.offset;
        &mut self.data[offset..offset + need]
    }

    #[cfg(test)]
    pub(crate) fn first_pixel_addr(&self) -> usize {
        self.data.as_ptr() as usize + self.offset
    }

    #[cfg(test)]
    pub(crate) fn allocations(&self) -> usize {
        self.allocations
    }

    #[cfg(test)]
    pub(crate) fn tree_passes(&self) -> usize {
        self.tree_passes
    }

    #[cfg(test)]
    pub(crate) fn pixel(&self, x: i32, y: i32) -> [u8; 4] {
        let stride = self.stride as usize;
        let offset = self.offset + y as usize * stride + x as usize * 4;
        self.data[offset..offset + 4].try_into().unwrap()
    }
}

pub(crate) fn frame_rect(buf: &FrameBuffer) -> Rect {
    Rect {
        x1: 0,
        y1: 0,
        x2: buf.width as i32 - 1,
        y2: buf.height as i32 - 1,
    }
}

pub(crate) fn current_clip(clip: &[Rect], frame: Rect) -> Rect {
    clip.last().copied().unwrap_or(frame)
}

pub(crate) fn begin(
    buf: &mut FrameBuffer,
    state: &mut State,
    clip: &mut Vec<Rect>,
    builtin_canon: &mut Option<(u32, u32)>,
    width: u32,
    height: u32,
) -> Result<(), Error> {
    if !(1..=MAX_SIDE).contains(&width) || !(1..=MAX_SIDE).contains(&height) {
        return Err(Error::SurfaceOutOfRange);
    }
    buf.ensure(width, height);
    span::clear(buf.bytes_mut());
    clip.clear();
    if builtin_canon.is_none() {
        *builtin_canon = Some((width, height));
    }
    *state = State::Begun;
    Ok(())
}

pub(crate) fn end<'a>(buf: &'a mut FrameBuffer, state: &mut State) -> Result<Frame<'a>, Error> {
    if *state != State::Begun {
        return Err(Error::NotBegun);
    }
    *state = State::Ended;
    let width = buf.width;
    let height = buf.height;
    let stride = buf.stride;
    Ok(Frame {
        width,
        height,
        stride,
        pixels: buf.bytes(),
    })
}

pub(crate) fn read_pixels(
    buf: &FrameBuffer,
    state: State,
    clip: &[Rect],
    rect: Rect,
    alpha: AlphaMode,
) -> Result<Pixels, Error> {
    if state == State::Empty {
        return Err(Error::NotBegun);
    }
    let view = rect
        .intersect(current_clip(clip, frame_rect(buf)))
        .intersect(frame_rect(buf));
    if view.is_empty() {
        return Ok(Pixels {
            x: view.x1,
            y: view.y1,
            width: 0,
            height: 0,
            stride: 0,
            bytes: Vec::new(),
        });
    }
    let width = (view.x2 - view.x1 + 1) as u32;
    let height = (view.y2 - view.y1 + 1) as u32;
    let stride = width * 4;
    let mut bytes = Vec::with_capacity(stride as usize * height as usize);
    let src = buf.bytes();
    let src_stride = buf.stride() as usize;
    for y in view.y1..=view.y2 {
        let row_start = y as usize * src_stride + view.x1 as usize * 4;
        let row = &src[row_start..row_start + stride as usize];
        if alpha == AlphaMode::Straight {
            span::straight_row(row, &mut bytes);
        } else {
            bytes.extend_from_slice(row);
        }
    }
    Ok(Pixels {
        x: view.x1,
        y: view.y1,
        width,
        height,
        stride,
        bytes,
    })
}

pub(crate) fn clip_push(
    state: State,
    clip: &mut Vec<Rect>,
    frame: Rect,
    rect: Rect,
) -> Result<(), Error> {
    if state != State::Begun {
        return Err(Error::NotBegun);
    }
    if clip.len() >= crate::MAX_CLIP as usize {
        return Err(Error::ClipOverflow);
    }
    clip.push(rect.intersect(current_clip(clip, frame)));
    Ok(())
}

pub(crate) fn clip_pop(state: State, clip: &mut Vec<Rect>) -> Result<(), Error> {
    if state != State::Begun {
        return Err(Error::NotBegun);
    }
    if clip.pop().is_none() {
        return Err(Error::ClipUnderflow);
    }
    Ok(())
}

pub(crate) fn fill_rect(
    state: State,
    buf: &mut FrameBuffer,
    clip: &[Rect],
    rect: Rect,
    color: Color,
    blend: Blend,
) -> Result<(), Error> {
    if state != State::Begun {
        return Err(Error::NotBegun);
    }
    let view = rect.intersect(current_clip(clip, frame_rect(buf)));
    if view.is_empty() {
        return Ok(());
    }
    let stride = buf.stride() as usize;
    fill::fill_rect(buf.bytes_mut(), stride, view, color, blend);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn fill_path(
    state: State,
    buf: &mut FrameBuffer,
    clip: &[Rect],
    verbs: &[Verb],
    rule: FillRule,
    color: Color,
    blend: Blend,
    scratch: &mut vector::RasterScratch,
) -> Result<(), Error> {
    if state != State::Begun {
        return Err(Error::NotBegun);
    }
    let stride = buf.stride() as usize;
    let target = current_clip(clip, frame_rect(buf));
    vector::fill_path(
        buf.bytes_mut(),
        stride,
        target,
        verbs,
        rule,
        color,
        blend,
        scratch,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn stroke_path(
    state: State,
    buf: &mut FrameBuffer,
    clip: &[Rect],
    verbs: &[Verb],
    stroke: &Stroke,
    color: Color,
    blend: Blend,
    scratch: &mut vector::RasterScratch,
) -> Result<(), Error> {
    if state != State::Begun {
        return Err(Error::NotBegun);
    }
    let stride = buf.stride() as usize;
    let target = current_clip(clip, frame_rect(buf));
    vector::stroke_path(
        buf.bytes_mut(),
        stride,
        target,
        verbs,
        stroke,
        color,
        blend,
        scratch,
    )
}

pub(crate) struct BlitRequest {
    pub(crate) id: ImageId,
    pub(crate) dest: Rect,
    pub(crate) src: Rect,
    pub(crate) sample: Sample,
    pub(crate) tint: Option<Color>,
    pub(crate) blend: Blend,
    pub(crate) radius: Option<Radius>,
}

pub(crate) fn blit(
    state: State,
    buf: &mut FrameBuffer,
    store: &Store,
    clip: &[Rect],
    request: &BlitRequest,
    corners: &mut CornerCache,
    k: u32,
) -> Result<(), Error> {
    if state != State::Begun {
        return Err(Error::NotBegun);
    }
    let target = current_clip(clip, frame_rect(buf));
    blit_target(buf, store, target, request, corners, k)
}

fn blit_target(
    buf: &mut FrameBuffer,
    store: &Store,
    target: Rect,
    request: &BlitRequest,
    corners: &mut CornerCache,
    k: u32,
) -> Result<(), Error> {
    let stride = buf.stride() as usize;
    let view = request.dest.intersect(target);
    let image = store.get(request.id).ok_or(Error::UnknownImage)?;
    let image_view = ImageView {
        width: image.width,
        height: image.height,
        format: image.format,
        data: image.data(),
    };
    let op = BlitOp {
        dest: request.dest,
        src: request.src,
        sample: request.sample,
        tint: request.tint,
        blend: request.blend,
    };
    blit::blit(buf.bytes_mut(), stride, view, &image_view, &op)?;
    mask_radius(buf, view, request.dest, request.radius, corners, k)
}

/// Cuts the painted box by its rounded outline. The mask paints nothing but
/// coverage, so the color is irrelevant.
fn mask_radius(
    buf: &mut FrameBuffer,
    view: Rect,
    dest: Rect,
    radius: Option<Radius>,
    corners: &mut CornerCache,
    k: u32,
) -> Result<(), Error> {
    let Some(radius) = radius else {
        return Ok(());
    };
    let value = round::resolve(radius, dest, k)?;
    if value <= 0 || view.is_empty() {
        return Ok(());
    }
    let stride = buf.stride() as usize;
    round::fill(
        buf.bytes_mut(),
        stride,
        view,
        dest,
        value,
        Color {
            r: 0,
            g: 0,
            b: 0,
            a: 255,
        },
        Blend::DstOut,
        corners,
    );
    Ok(())
}

/// Paints the active tree in the order `fgce.md` §5.5 fixes: node, then its
/// children. Tree clips come from `live_clip`; the `ClipPush` stack is not read
/// here, and groups or arbitrary boxes put no pixels.
pub(crate) fn draw_tree(
    buf: &mut FrameBuffer,
    store: &Store,
    tree: &Tree,
    scratch: &mut vector::RasterScratch,
    corners: &mut CornerCache,
    k: u32,
) -> Result<(), Error> {
    #[cfg(test)]
    {
        buf.tree_passes += 1;
    }
    let mut stack: Vec<NodeId> = tree.roots.iter().rev().copied().collect();
    let mut shifted: Vec<Verb> = Vec::new();
    while let Some(id) = stack.pop() {
        let Some(node) = tree.nodes.get(&id) else {
            continue;
        };
        draw_node(buf, store, node, &mut shifted, scratch, corners, k)?;
        for &child in node.children.iter().rev() {
            stack.push(child);
        }
    }
    Ok(())
}

fn draw_node(
    buf: &mut FrameBuffer,
    store: &Store,
    node: &Node,
    shifted: &mut Vec<Verb>,
    scratch: &mut vector::RasterScratch,
    corners: &mut CornerCache,
    k: u32,
) -> Result<(), Error> {
    let own = Rect {
        x1: node.live.x1,
        y1: node.live.y1,
        x2: node.live.x1.saturating_add(node.live.size_x - 1),
        y2: node.live.y1.saturating_add(node.live.size_y - 1),
    };
    let clip = node.live.clip.intersect(own);
    if clip.is_empty() {
        return Ok(());
    }
    let width = node.entity_size_x;
    let height = node.entity_size_y;
    let dest = Rect {
        x1: node.live.paint_x,
        y1: node.live.paint_y,
        x2: node.live.paint_x.saturating_add(width - 1),
        y2: node.live.paint_y.saturating_add(height - 1),
    };
    match &node.class {
        Class::Entity(EntityData::Flat { color }) => {
            let view = dest.intersect(clip);
            if !view.is_empty() {
                let stride = buf.stride() as usize;
                let radius = resolved(node.radius, dest, k)?;
                if radius > 0 {
                    round::fill(
                        buf.bytes_mut(),
                        stride,
                        view,
                        dest,
                        radius,
                        *color,
                        node.blend,
                        corners,
                    );
                } else {
                    fill::fill_rect(buf.bytes_mut(), stride, view, *color, node.blend);
                }
            }
        }
        Class::Entity(EntityData::Box {
            fill: box_fill,
            stroke,
            color,
        }) => {
            let view = dest.intersect(clip);
            if view.is_empty() {
                return Ok(());
            }
            let stride = buf.stride() as usize;
            let radius = resolved(node.radius, dest, k)?;
            if box_fill.is_some() {
                if radius > 0 {
                    round::fill(
                        buf.bytes_mut(),
                        stride,
                        view,
                        dest,
                        radius,
                        *color,
                        node.blend,
                        corners,
                    );
                } else {
                    fill::fill_rect(buf.bytes_mut(), stride, view, *color, node.blend);
                }
            }
            if let Some(stroke) = stroke {
                shifted.clear();
                round::path(dest, radius, shifted);
                vector::stroke_path(
                    buf.bytes_mut(),
                    stride,
                    clip,
                    shifted,
                    stroke,
                    *color,
                    node.blend,
                    scratch,
                )?;
            }
        }
        Class::Entity(EntityData::Photo { image, tint, .. })
        | Class::Entity(EntityData::Glyph { image, tint, .. }) => {
            let request = BlitRequest {
                id: *image,
                dest,
                src: Rect {
                    x1: 0,
                    y1: 0,
                    x2: width - 1,
                    y2: height - 1,
                },
                sample: Sample::Crisp,
                tint: Some(*tint),
                blend: node.blend,
                radius: node.radius,
            };
            blit_target(buf, store, clip, &request, corners, k)?;
        }
        Class::Entity(EntityData::Vector {
            verbs,
            fill,
            stroke,
            color,
        }) => {
            let dx = node.live.x1.saturating_add(node.zero_offset_x);
            let dy = node.live.y1.saturating_add(node.zero_offset_y);
            shifted.clear();
            shifted.extend(verbs.iter().map(|verb| shift(*verb, dx, dy)));
            let stride = buf.stride() as usize;
            match (fill, stroke) {
                (Some(fill), None) => vector::fill_path(
                    buf.bytes_mut(),
                    stride,
                    clip,
                    shifted,
                    fill.rule,
                    *color,
                    node.blend,
                    scratch,
                )?,
                (None, Some(stroke)) => vector::stroke_path(
                    buf.bytes_mut(),
                    stride,
                    clip,
                    shifted,
                    stroke,
                    *color,
                    node.blend,
                    scratch,
                )?,
                _ => {}
            }
        }
        Class::Group { .. } | Class::Arbitrary { .. } => {}
    }
    Ok(())
}

fn resolved(radius: Option<Radius>, rect: Rect, k: u32) -> Result<i32, Error> {
    match radius {
        Some(radius) => round::resolve(radius, rect, k),
        None => Ok(0),
    }
}

fn shift(verb: Verb, dx: i32, dy: i32) -> Verb {
    match verb {
        Verb::Move(x, y) => Verb::Move(x + dx, y + dy),
        Verb::Line(x, y) => Verb::Line(x + dx, y + dy),
        Verb::Quad(cx, cy, x, y) => Verb::Quad(cx + dx, cy + dy, x + dx, y + dy),
        Verb::Cubic(c1x, c1y, c2x, c2y, x, y) => {
            Verb::Cubic(c1x + dx, c1y + dy, c2x + dx, c2y + dy, x + dx, y + dy)
        }
        Verb::Close => Verb::Close,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn begin_engine() -> (FrameBuffer, State, Vec<Rect>, Option<(u32, u32)>) {
        let mut buf = FrameBuffer::new();
        let mut state = State::Empty;
        let mut clip = Vec::new();
        let mut canon = None;
        begin(&mut buf, &mut state, &mut clip, &mut canon, 10, 10).unwrap();
        (buf, state, clip, canon)
    }

    #[test]
    fn stride_and_alignment() {
        let (buf, _, _, _) = begin_engine();
        assert_eq!(buf.stride(), 64);
        assert_eq!(buf.bytes().len(), 640);
        assert_eq!(buf.first_pixel_addr() % 64, 0);

        let mut buf = FrameBuffer::new();
        let mut state = State::Empty;
        let mut clip = Vec::new();
        let mut canon = None;
        begin(&mut buf, &mut state, &mut clip, &mut canon, 17, 3).unwrap();
        assert_eq!(buf.stride(), 128);
        assert_eq!(buf.bytes().len(), 384);
        assert_eq!(buf.first_pixel_addr() % 64, 0);
    }

    #[test]
    fn same_size_begin_reuses_buffer() {
        let (mut buf, mut state, mut clip, mut canon) = begin_engine();
        let addr = buf.first_pixel_addr();
        assert_eq!(buf.allocations(), 1);
        begin(&mut buf, &mut state, &mut clip, &mut canon, 10, 10).unwrap();
        assert_eq!(buf.first_pixel_addr(), addr);
        assert_eq!(buf.allocations(), 1, "same-size Begin allocates nothing");
        assert_eq!(state, State::Begun);
        begin(&mut buf, &mut state, &mut clip, &mut canon, 11, 10).unwrap();
        assert_eq!(buf.allocations(), 2, "new size allocates once");
    }

    #[test]
    fn draw_tree_counts_one_pass() {
        let (mut buf, _, _, _) = begin_engine();
        let store = Store::new();
        let tree = Tree::default();
        assert_eq!(buf.tree_passes(), 0);
        draw_tree(
            &mut buf,
            &store,
            &tree,
            &mut vector::RasterScratch::default(),
            &mut round::CornerCache::default(),
            5,
        )
        .unwrap();
        assert_eq!(buf.tree_passes(), 1);
    }

    #[test]
    fn begin_zeroes_previous_frame() {
        let (mut buf, mut state, mut clip, mut canon) = begin_engine();
        let red = Color {
            r: 255,
            g: 0,
            b: 0,
            a: 255,
        };
        fill_rect(
            State::Begun,
            &mut buf,
            &clip,
            Rect {
                x1: 0,
                y1: 0,
                x2: 9,
                y2: 9,
            },
            red,
            Blend::SrcOver,
        )
        .unwrap();
        assert_eq!(buf.pixel(0, 0), [255, 0, 0, 255]);
        begin(&mut buf, &mut state, &mut clip, &mut canon, 10, 10).unwrap();
        assert_eq!(buf.pixel(0, 0), [0, 0, 0, 0]);
    }

    #[test]
    fn end_borrows_buffer_and_state_moves() {
        let (mut buf, mut state, _, _) = begin_engine();
        let addr = buf.first_pixel_addr();
        let frame = end(&mut buf, &mut state).unwrap();
        assert_eq!(frame.width, 10);
        assert_eq!(frame.height, 10);
        assert_eq!(frame.stride, 64);
        assert_eq!(frame.pixels.as_ptr() as usize, addr);
        assert_eq!(state, State::Ended);
        assert_eq!(end(&mut buf, &mut state).unwrap_err(), Error::NotBegun);
    }

    #[test]
    fn clip_stack_limits() {
        let frame = Rect {
            x1: 0,
            y1: 0,
            x2: 9,
            y2: 9,
        };
        let mut clip = Vec::new();
        assert_eq!(
            clip_pop(State::Begun, &mut clip).unwrap_err(),
            Error::ClipUnderflow
        );
        for _ in 0..32 {
            clip_push(State::Begun, &mut clip, frame, frame).unwrap();
        }
        assert_eq!(
            clip_push(State::Begun, &mut clip, frame, frame).unwrap_err(),
            Error::ClipOverflow
        );
    }

    #[test]
    fn clip_is_intersected() {
        let frame = Rect {
            x1: 0,
            y1: 0,
            x2: 9,
            y2: 9,
        };
        let mut clip = Vec::new();
        clip_push(
            State::Begun,
            &mut clip,
            frame,
            Rect {
                x1: 2,
                y1: 2,
                x2: 5,
                y2: 5,
            },
        )
        .unwrap();
        clip_push(
            State::Begun,
            &mut clip,
            frame,
            Rect {
                x1: 4,
                y1: 0,
                x2: 8,
                y2: 3,
            },
        )
        .unwrap();
        assert_eq!(
            *clip.last().unwrap(),
            Rect {
                x1: 4,
                y1: 2,
                x2: 5,
                y2: 3
            }
        );
    }

    #[test]
    fn read_pixels_before_and_after() {
        let (mut buf, mut state, clip, _) = begin_engine();
        assert_eq!(
            read_pixels(
                &buf,
                State::Empty,
                &clip,
                frame_rect(&buf),
                AlphaMode::Premul
            )
            .unwrap_err(),
            Error::NotBegun
        );
        let red = Color {
            r: 100,
            g: 50,
            b: 25,
            a: 255,
        };
        fill_rect(
            State::Begun,
            &mut buf,
            &clip,
            Rect {
                x1: 1,
                y1: 1,
                x2: 2,
                y2: 2,
            },
            red,
            Blend::SrcOver,
        )
        .unwrap();
        end(&mut buf, &mut state).unwrap();
        let pixels = read_pixels(
            &buf,
            state,
            &clip,
            Rect {
                x1: 0,
                y1: 0,
                x2: 9,
                y2: 9,
            },
            AlphaMode::Premul,
        )
        .unwrap();
        assert_eq!(pixels.width, 10);
        assert_eq!(pixels.height, 10);
        assert_eq!(pixels.bytes.len(), 400);
        assert_eq!(&pixels.bytes[0..4], &[0, 0, 0, 0]);
        assert_eq!(
            &pixels.bytes[(10 + 1) * 4..(10 + 1) * 4 + 4],
            &[100, 50, 25, 255]
        );
    }

    #[test]
    fn read_pixels_empty_intersection_is_zero_sized() {
        let (buf, _, clip, _) = begin_engine();
        let pixels = read_pixels(
            &buf,
            State::Begun,
            &clip,
            Rect {
                x1: 100,
                y1: 100,
                x2: 110,
                y2: 110,
            },
            AlphaMode::Premul,
        )
        .unwrap();
        assert_eq!(pixels.width, 0);
        assert_eq!(pixels.height, 0);
        assert!(pixels.bytes.is_empty());
    }

    #[test]
    fn read_pixels_straight() {
        let (mut buf, _, clip, _) = begin_engine();
        let color = Color {
            r: 200,
            g: 100,
            b: 50,
            a: 128,
        };
        fill_rect(
            State::Begun,
            &mut buf,
            &clip,
            Rect {
                x1: 0,
                y1: 0,
                x2: 0,
                y2: 0,
            },
            color,
            Blend::SrcOver,
        )
        .unwrap();
        let premul = read_pixels(
            &buf,
            State::Begun,
            &clip,
            Rect {
                x1: 0,
                y1: 0,
                x2: 0,
                y2: 0,
            },
            AlphaMode::Premul,
        )
        .unwrap();
        assert_eq!(premul.bytes, [100, 50, 25, 128]);
        let straight = read_pixels(
            &buf,
            State::Begun,
            &clip,
            Rect {
                x1: 0,
                y1: 0,
                x2: 0,
                y2: 0,
            },
            AlphaMode::Straight,
        )
        .unwrap();
        assert_eq!(straight.bytes, [199, 100, 50, 128]);
    }

    #[test]
    fn draw_after_end_is_not_begun() {
        let (mut buf, mut state, clip, _) = begin_engine();
        end(&mut buf, &mut state).unwrap();
        let error = fill_rect(
            state,
            &mut buf,
            &clip,
            Rect {
                x1: 0,
                y1: 0,
                x2: 0,
                y2: 0,
            },
            Color {
                r: 0,
                g: 0,
                b: 0,
                a: 0,
            },
            Blend::SrcOver,
        )
        .unwrap_err();
        assert_eq!(error, Error::NotBegun);
        assert_eq!(
            clip_push(state, &mut Vec::new(), frame_rect(&buf), frame_rect(&buf)).unwrap_err(),
            Error::NotBegun
        );
    }

    #[test]
    fn fill_rect_respects_clip_bytes() {
        let (mut buf, state, mut clip, _) = begin_engine();
        let full = frame_rect(&buf);
        clip_push(
            State::Begun,
            &mut clip,
            full,
            Rect {
                x1: 2,
                y1: 2,
                x2: 4,
                y2: 4,
            },
        )
        .unwrap();
        fill_rect(
            State::Begun,
            &mut buf,
            &clip,
            full,
            Color {
                r: 255,
                g: 0,
                b: 0,
                a: 255,
            },
            Blend::SrcOver,
        )
        .unwrap();
        clip_pop(State::Begun, &mut clip).unwrap();

        let pixels = read_pixels(&buf, state, &clip, full, AlphaMode::Premul).unwrap();
        assert_eq!(&pixels.bytes[0..4], &[0, 0, 0, 0]);
        let inside = (2 * 10 + 2) * 4;
        assert_eq!(&pixels.bytes[inside..inside + 4], &[255, 0, 0, 255]);
        let outside = (5 * 10 + 5) * 4;
        assert_eq!(&pixels.bytes[outside..outside + 4], &[0, 0, 0, 0]);
    }
}
