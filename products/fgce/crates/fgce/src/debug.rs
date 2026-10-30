//! Tree debug layer: outlines, hover labels and pin arrows (`fgce.md` §5.3).
//!
//! The layer runs at the end of `End`, after the tree and every immediate
//! command. It writes through the existing raster primitives and owns no frame
//! bytes of its own. Debug state itself is not part of a frame and survives
//! `Begin`; names and hover are cleared only by their own requests.

use std::collections::HashMap;

use crate::contract::{Blend, Color, DebugGridStyle, DebugPoint, NodeId, Pin, Rect};
use crate::debug_font;
use crate::fill;
use crate::frame::{FrameBuffer, frame_rect};
use crate::tree::{Class, Tree};

#[derive(Default)]
pub(crate) struct DebugState {
    pub(crate) style: Option<DebugGridStyle>,
    pub(crate) hover: Option<DebugPoint>,
    pub(crate) labels: HashMap<NodeId, Box<str>>,
}

impl DebugState {
    pub(crate) fn set_label(&mut self, id: NodeId, text: Option<&str>) {
        match text {
            Some(text) => {
                self.labels.insert(id, Box::from(text));
            }
            None => {
                self.labels.remove(&id);
            }
        }
    }

    pub(crate) fn forget(&mut self, id: NodeId) {
        self.labels.remove(&id);
    }
}

struct Visible<'a> {
    id: NodeId,
    rect: Rect,
    depth: i32,
    order: usize,
    class: Option<&'a Class>,
    parent: Option<NodeId>,
}

/// Paints the debug layer; `style: None` performs no pass at all.
#[allow(clippy::too_many_arguments)]
pub(crate) fn draw(
    buf: &mut FrameBuffer,
    tree: &Tree,
    style: DebugGridStyle,
    hover: Option<DebugPoint>,
    labels: &HashMap<NodeId, Box<str>>,
    window_pin: Pin,
) {
    let frame = frame_rect(buf);
    let visible = collect(tree, frame);
    let max_depth = visible.iter().map(|node| node.depth).max().unwrap_or(0);
    draw_outlines(buf, tree, &visible, max_depth, style);
    if style.label_alpha == 0 {
        return;
    }
    let Some(point) = hover else {
        return;
    };
    let Some(hovered) = hovered(&visible, point) else {
        return;
    };
    draw_labels(buf, &visible, hovered, max_depth, style, labels, window_pin);
}

fn collect(tree: &Tree, frame: Rect) -> Vec<Visible<'_>> {
    let mut visible = Vec::with_capacity(tree.nodes.len() + 1);
    visible.push(Visible {
        id: NodeId(0),
        rect: frame,
        depth: 0,
        order: 0,
        class: None,
        parent: None,
    });
    let mut order = 1;
    let mut stack: Vec<(NodeId, i32)> = tree.roots.iter().rev().map(|&id| (id, 1)).collect();
    while let Some((id, depth)) = stack.pop() {
        let Some(node) = tree.nodes.get(&id) else {
            continue;
        };
        let own = Rect {
            x1: node.live.x1,
            y1: node.live.y1,
            x2: node.live.x1.saturating_add(node.live.size_x - 1),
            y2: node.live.y1.saturating_add(node.live.size_y - 1),
        };
        let rect = own.intersect(node.live.clip);
        if rect.is_empty() {
            continue;
        }
        visible.push(Visible {
            id,
            rect,
            depth,
            order,
            class: Some(&node.class),
            parent: node.parent,
        });
        order += 1;
        for &child in node.children.iter().rev() {
            stack.push((child, depth + 1));
        }
    }
    visible
}

fn level_color(style: DebugGridStyle, depth: i32, max_depth: i32) -> Color {
    interpolate(style.base, style.tip, depth, max_depth)
}

/// Labels keep their own `label_base → label_tip` scale; unset ends inherit the
/// outline ends, so a style without label colors renders exactly as before.
fn label_color(style: DebugGridStyle, depth: i32, max_depth: i32) -> Color {
    let base = style.label_base.unwrap_or(style.base);
    let tip = style.label_tip.unwrap_or(style.tip);
    Color {
        a: style.label_alpha,
        ..interpolate(base, tip, depth, max_depth)
    }
}

fn interpolate(base: Color, tip: Color, depth: i32, max_depth: i32) -> Color {
    if max_depth <= 0 {
        return tip;
    }
    let mix = |base: u8, tip: u8| -> u8 {
        let denominator = max_depth as i64;
        let value = base as i64 * denominator + (tip as i64 - base as i64) * depth as i64;
        ((value + denominator / 2) / denominator).clamp(0, 255) as u8
    };
    Color {
        r: mix(base.r, tip.r),
        g: mix(base.g, tip.g),
        b: mix(base.b, tip.b),
        a: mix(base.a, tip.a),
    }
}

fn draw_outlines(
    buf: &mut FrameBuffer,
    tree: &Tree,
    visible: &[Visible<'_>],
    max_depth: i32,
    style: DebugGridStyle,
) {
    let by_id: HashMap<NodeId, &Visible<'_>> = visible.iter().map(|node| (node.id, node)).collect();
    let frame = frame_rect(buf);
    let mut stack: Vec<(NodeId, bool)> = vec![(NodeId(0), false)];
    while let Some((id, visited)) = stack.pop() {
        if !visited {
            stack.push((id, true));
            if id.0 == 0 {
                for &root in tree.roots.iter().rev() {
                    if by_id.contains_key(&root) {
                        stack.push((root, false));
                    }
                }
            } else if let Some(node) = tree.nodes.get(&id) {
                for &child in node.children.iter().rev() {
                    if by_id.contains_key(&child) {
                        stack.push((child, false));
                    }
                }
            }
            continue;
        }
        let Some(node) = by_id.get(&id) else {
            continue;
        };
        let color = level_color(style, node.depth, max_depth);
        draw_outline(buf, node.rect, color, frame);
    }
}

fn draw_outline(buf: &mut FrameBuffer, rect: Rect, color: Color, frame: Rect) {
    if rect.is_empty() || color.a == 0 {
        return;
    }
    let stride = buf.stride() as usize;
    let right = rect.x2.saturating_add(1).min(frame.x2);
    let bottom = rect.y2.saturating_add(1).min(frame.y2);
    let lines = [
        Rect {
            x1: rect.x1,
            y1: rect.y1,
            x2: rect.x1,
            y2: rect.y2,
        },
        Rect {
            x1: right,
            y1: rect.y1,
            x2: right,
            y2: rect.y2,
        },
        Rect {
            x1: rect.x1,
            y1: rect.y1,
            x2: right,
            y2: rect.y1,
        },
        Rect {
            x1: rect.x1,
            y1: bottom,
            x2: right,
            y2: bottom,
        },
    ];
    for line in lines {
        let view = line.intersect(frame);
        if !view.is_empty() {
            fill::fill_rect(buf.bytes_mut(), stride, view, color, Blend::SrcOver);
        }
    }
}

fn hovered(visible: &[Visible<'_>], point: DebugPoint) -> Option<usize> {
    let mut best: Option<(i32, usize)> = None;
    for node in visible.iter().skip(1) {
        if point.x < node.rect.x1
            || point.x > node.rect.x2
            || point.y < node.rect.y1
            || point.y > node.rect.y2
        {
            continue;
        }
        let rank = (node.depth, node.order);
        if best.is_none_or(|(depth, order)| rank > (depth, order)) {
            best = Some(rank);
        }
    }
    best.map(|(_, order)| {
        visible
            .iter()
            .position(|node| node.order == order)
            .expect("hovered order belongs to a visible node")
    })
}

#[allow(clippy::too_many_arguments)]
fn draw_labels(
    buf: &mut FrameBuffer,
    visible: &[Visible<'_>],
    hovered: usize,
    max_depth: i32,
    style: DebugGridStyle,
    labels: &HashMap<NodeId, Box<str>>,
    window_pin: Pin,
) {
    let frame = frame_rect(buf);
    let by_id: HashMap<NodeId, usize> = visible
        .iter()
        .enumerate()
        .map(|(index, node)| (node.id, index))
        .collect();
    let mut chain = Vec::new();
    let mut current = Some(hovered);
    while let Some(index) = current {
        chain.push(index);
        current = visible[index]
            .parent
            .and_then(|parent| by_id.get(&parent).copied());
    }
    // The window is the implicit root of every top-level node.
    chain.push(0);
    chain.reverse();

    let mut placed: Vec<Rect> = Vec::new();
    for index in chain {
        let node = &visible[index];
        let text = labels
            .get(&node.id)
            .map(|text| text.to_string())
            .unwrap_or_else(|| format!("#{}", node.id.0));
        let width = debug_font::text_width(&text, style.label_scale as i32);
        let height = debug_font::text_height(style.label_scale as i32);
        if width <= 0 || height <= 0 {
            continue;
        }
        let (mut x, mut y) = label_origin(buf, node, width, height);
        x = x.clamp(frame.x1, (frame.x2 + 1 - width).max(frame.x1));
        y = y.clamp(frame.y1, (frame.y2 + 1 - height).max(frame.y1));
        loop {
            let overlap = placed.iter().find(|placed| {
                x < placed.x2 + 1
                    && placed.x1 < x + width
                    && y < placed.y2 + 1
                    && placed.y1 < y + height
            });
            let Some(placed) = overlap else {
                break;
            };
            y = placed.y2 + 1;
            if y + height > frame.y2 + 1 {
                y = (frame.y2 + 1 - height).max(frame.y1);
                break;
            }
        }
        let rect = Rect {
            x1: x,
            y1: y,
            x2: x + width - 1,
            y2: y + height - 1,
        };
        let color = label_color(style, node.depth, max_depth);
        draw_text(buf, &text, x, y, style.label_scale as i32, color, frame);
        draw_arrow(buf, node, window_pin, color, frame);
        placed.push(rect);
    }
}

fn label_origin(buf: &FrameBuffer, node: &Visible<'_>, width: i32, height: i32) -> (i32, i32) {
    let rect = node.rect;
    let frame = frame_rect(buf);
    match node.class {
        None => (rect.x1 + 1, rect.y2 + 1 - height),
        Some(Class::Entity(_)) => {
            let above = rect.y1 - height - 1;
            if above >= frame.y1 {
                (rect.x1, above)
            } else {
                (rect.x1, rect.y2 + 2)
            }
        }
        Some(Class::Group { pin, .. }) | Some(Class::Arbitrary { pin, .. }) => {
            let x = if pin.x == 1 {
                rect.x2 + 1 - width
            } else {
                rect.x1
            };
            let y = if pin.y == -1 {
                rect.y2 + 1 - height
            } else {
                rect.y1
            };
            (x, y)
        }
    }
}

fn draw_text(
    buf: &mut FrameBuffer,
    text: &str,
    x: i32,
    y: i32,
    scale: i32,
    color: Color,
    frame: Rect,
) {
    if color.a == 0 {
        return;
    }
    let stride = buf.stride() as usize;
    let mut cursor = x;
    for character in text.chars() {
        let glyph = debug_font::glyph(character);
        for (row, bits) in glyph.iter().enumerate() {
            for column in 0..debug_font::GLYPH_WIDTH {
                if bits & (1 << (debug_font::GLYPH_WIDTH - 1 - column)) == 0 {
                    continue;
                }
                let pixel = Rect {
                    x1: cursor + column * scale,
                    y1: y + row as i32 * scale,
                    x2: cursor + column * scale + scale - 1,
                    y2: y + row as i32 * scale + scale - 1,
                }
                .intersect(frame);
                if !pixel.is_empty() {
                    fill::fill_rect(buf.bytes_mut(), stride, pixel, color, Blend::SrcOver);
                }
            }
        }
        cursor += debug_font::ADVANCE * scale;
    }
}

fn draw_arrow(
    buf: &mut FrameBuffer,
    node: &Visible<'_>,
    window_pin: Pin,
    color: Color,
    frame: Rect,
) {
    if color.a == 0 {
        return;
    }
    let pin = match node.class {
        None => window_pin,
        Some(Class::Group { pin, .. }) | Some(Class::Arbitrary { pin, .. }) => *pin,
        Some(Class::Entity(_)) => return,
    };
    let Some(mask) = arrow_mask(pin.x, pin.y) else {
        return;
    };
    let rect = node.rect;
    let x = if pin.x == 1 {
        rect.x2 - 4
    } else if pin.x == -1 {
        rect.x1
    } else {
        (rect.x1 + rect.x2) / 2 - 2
    };
    let y = if pin.y == 1 {
        rect.y1
    } else if pin.y == -1 {
        rect.y2 - 4
    } else {
        (rect.y1 + rect.y2) / 2 - 2
    };
    let stride = buf.stride() as usize;
    for (row, bits) in mask.iter().enumerate() {
        for column in 0..5 {
            if bits & (1 << (4 - column)) == 0 {
                continue;
            }
            let pixel = Rect {
                x1: x + column,
                y1: y + row as i32,
                x2: x + column,
                y2: y + row as i32,
            }
            .intersect(frame);
            if !pixel.is_empty() {
                fill::fill_rect(buf.bytes_mut(), stride, pixel, color, Blend::SrcOver);
            }
        }
    }
}

const ARROW_UP: [u8; 5] = [0x04, 0x0E, 0x15, 0x04, 0x04];
const ARROW_DOWN: [u8; 5] = [0x04, 0x04, 0x15, 0x0E, 0x04];
const ARROW_LEFT: [u8; 5] = [0x04, 0x08, 0x1F, 0x08, 0x04];
const ARROW_RIGHT: [u8; 5] = [0x04, 0x02, 0x1F, 0x02, 0x04];
const ARROW_UP_LEFT: [u8; 5] = [0x10, 0x18, 0x1C, 0x1E, 0x1F];
const ARROW_UP_RIGHT: [u8; 5] = [0x01, 0x03, 0x07, 0x0F, 0x1F];
const ARROW_DOWN_LEFT: [u8; 5] = [0x1F, 0x1E, 0x1C, 0x18, 0x10];
const ARROW_DOWN_RIGHT: [u8; 5] = [0x1F, 0x0F, 0x07, 0x03, 0x01];
const ARROW_CIRCLE: [u8; 5] = [0x0E, 0x11, 0x11, 0x11, 0x0E];

fn arrow_mask(x: i8, y: i8) -> Option<&'static [u8; 5]> {
    match (x.signum(), y.signum()) {
        (0, 1) => Some(&ARROW_UP),
        (0, -1) => Some(&ARROW_DOWN),
        (-1, 0) => Some(&ARROW_LEFT),
        (1, 0) => Some(&ARROW_RIGHT),
        (-1, 1) => Some(&ARROW_UP_LEFT),
        (1, 1) => Some(&ARROW_UP_RIGHT),
        (-1, -1) => Some(&ARROW_DOWN_LEFT),
        (1, -1) => Some(&ARROW_DOWN_RIGHT),
        _ => Some(&ARROW_CIRCLE),
    }
}
