//! Canonical pass of `fgce.md` §4.6.
//!
//! Input boxes are already parsed by `tree`: groups are unions of their children,
//! entities and arbitrary boxes carry their own coordinates. The pass rewrites
//! group `near`/size bottom-up and every child's relative `a` top-down.

use std::collections::HashMap;

use crate::contract::{Error, Node as SnapshotNode, NodeId, Rect, Snapshot};
use crate::tree::{
    Class, Context, EntityData, LiveBox, LiveParams, Node as TreeNode, Tree, zero_point,
};
use crate::{MAX_COORD, lattice};

pub(crate) fn canonical_pass(tree: &mut Tree, context: &Context) {
    let mut order = Vec::with_capacity(tree.nodes.len());
    let mut stack: Vec<(NodeId, bool)> = tree.roots.iter().rev().map(|&id| (id, false)).collect();
    while let Some((id, visited)) = stack.pop() {
        if visited {
            order.push(id);
            continue;
        }
        stack.push((id, true));
        if let Some(node) = tree.nodes.get(&id) {
            for &child in node.children.iter().rev() {
                stack.push((child, false));
            }
        }
    }

    let mut absolute: HashMap<NodeId, (i32, i32)> = HashMap::with_capacity(tree.nodes.len());
    for &id in &order {
        let Some(node) = tree.nodes.get(&id) else {
            continue;
        };
        if node.is_group() {
            let mut min_x = i32::MAX;
            let mut min_y = i32::MAX;
            let mut max_x = i32::MIN;
            let mut max_y = i32::MIN;
            let mut found = false;
            for &child in &node.children {
                let (Some(&(child_x, child_y)), Some(child_node)) =
                    (absolute.get(&child), tree.nodes.get(&child))
                else {
                    continue;
                };
                found = true;
                min_x = min_x.min(child_x);
                min_y = min_y.min(child_y);
                max_x = max_x.max(child_x.saturating_add(child_node.size_x - 1));
                max_y = max_y.max(child_y.saturating_add(child_node.size_y - 1));
            }
            if found {
                let size_x = max_x - min_x + 1;
                let size_y = max_y - min_y + 1;
                absolute.insert(id, (min_x, min_y));
                if let Some(node) = tree.nodes.get_mut(&id) {
                    node.size_x = size_x;
                    node.size_y = size_y;
                }
            } else {
                absolute.insert(id, (node.near_x, node.near_y));
            }
        } else {
            let (parent_near_x, parent_near_y) = match node.parent {
                Some(parent) => tree
                    .nodes
                    .get(&parent)
                    .map(|parent| (parent.near_x, parent.near_y))
                    .unwrap_or((0, 0)),
                None => (0, 0),
            };
            absolute.insert(
                id,
                (
                    parent_near_x.saturating_add(node.a_x),
                    parent_near_y.saturating_add(node.a_y),
                ),
            );
        }
    }

    // Top-down with a rigid-shift delta. Children of a group keep their absolute
    // pixels (`fgce.md` §4.6, Q32); children of an arbitrary box or the window keep
    // their `a`, so the whole subtree moves with the box.
    let mut stack: Vec<(NodeId, i32, i32, i32, i32)> =
        tree.roots.iter().map(|&id| (id, 0, 0, 0, 0)).collect();
    while let Some((id, parent_near_x, parent_near_y, delta_x, delta_y)) = stack.pop() {
        let Some(&(absolute_x, absolute_y)) = absolute.get(&id) else {
            continue;
        };
        let Some(node) = tree.nodes.get_mut(&id) else {
            continue;
        };
        let near_x = absolute_x.saturating_add(delta_x);
        let near_y = absolute_y.saturating_add(delta_y);
        let (old_near_x, old_near_y) = (node.near_x, node.near_y);
        node.near_x = near_x;
        node.near_y = near_y;
        node.a_x = near_x - parent_near_x;
        node.a_y = near_y - parent_near_y;
        node.zero_x = zero_point(near_x, context.origin_x, context.step);
        node.zero_y = zero_point(near_y, context.origin_y, context.step);
        node.zero_offset_x = node.zero_x - near_x;
        node.zero_offset_y = node.zero_y - near_y;
        let (child_delta_x, child_delta_y) = if node.is_group() {
            (delta_x, delta_y)
        } else {
            (near_x - old_near_x, near_y - old_near_y)
        };
        let children = node.children.clone();
        for child in children {
            stack.push((child, near_x, near_y, child_delta_x, child_delta_y));
        }
    }
}

#[derive(Clone, Copy)]
struct LiveFrame {
    id: NodeId,
    parent_x: i32,
    parent_y: i32,
    canon_x: i32,
    canon_y: i32,
    live_w: i32,
    live_h: i32,
}

/// One live pass (`fgce.md` §4.6): pin, snap and inset top-down, then `Show`
/// on the second descent.
///
/// Returns `true` when any live rectangle changed, so `generation` grows only
/// for a pass that actually wrote new rectangles.
pub(crate) fn live_pass(
    tree: &mut Tree,
    window: &LiveParams,
    shows: &HashMap<NodeId, Rect>,
) -> Result<bool, Error> {
    let lattice = lattice::compute(
        window.live_w,
        window.live_h,
        window.step,
        window.pin.x,
        window.pin.y,
    )?;
    let origin_x = lattice.lattice.origin_x as i32;
    let origin_y = lattice.lattice.origin_y as i32;
    let live_w = window.live_w as i32;
    let live_h = window.live_h as i32;
    let frame = Rect {
        x1: 0,
        y1: 0,
        x2: live_w - 1,
        y2: live_h - 1,
    };

    let mut pin: HashMap<NodeId, (i32, i32)> = HashMap::with_capacity(tree.nodes.len());
    let mut stack: Vec<LiveFrame> = Vec::with_capacity(tree.nodes.len());
    for &id in tree.roots.iter().rev() {
        stack.push(LiveFrame {
            id,
            parent_x: 0,
            parent_y: 0,
            canon_x: window.canon_w as i32,
            canon_y: window.canon_h as i32,
            live_w,
            live_h,
        });
    }
    while let Some(frame) = stack.pop() {
        let id = frame.id;
        let Some(node) = tree.nodes.get(&id) else {
            continue;
        };
        let (rel_x, rel_y) = resolve(
            node,
            frame.parent_x,
            frame.parent_y,
            frame.canon_x,
            frame.canon_y,
            frame.live_w,
            frame.live_h,
            window,
            origin_x,
            origin_y,
        )?;
        let live_x = frame.parent_x.saturating_add(rel_x);
        let live_y = frame.parent_y.saturating_add(rel_y);
        pin.insert(id, (live_x, live_y));
        let (size_x, size_y) = (node.size_x, node.size_y);
        for &child in tree.nodes[&id].children.iter().rev() {
            stack.push(LiveFrame {
                id: child,
                parent_x: live_x,
                parent_y: live_y,
                canon_x: size_x,
                canon_y: size_y,
                live_w: size_x,
                live_h: size_y,
            });
        }
    }

    let mut changed = false;
    let mut stack: Vec<(NodeId, i32, i32, Rect)> = tree
        .roots
        .iter()
        .rev()
        .map(|&id| (id, 0, 0, frame))
        .collect();
    while let Some((id, delta_x, delta_y, clip)) = stack.pop() {
        let Some(node) = tree.nodes.get(&id) else {
            continue;
        };
        let Some(&(pin_x, pin_y)) = pin.get(&id) else {
            continue;
        };
        let (live_x, live_y, size_x, size_y, next_dx, next_dy) = match shows.get(&id) {
            Some(rect) => {
                let (width, height) = rect_sides(*rect)?;
                (
                    rect.x1,
                    rect.y1,
                    width,
                    height,
                    rect.x1 - pin_x,
                    rect.y1 - pin_y,
                )
            }
            None => (
                pin_x + delta_x,
                pin_y + delta_y,
                node.size_x,
                node.size_y,
                delta_x,
                delta_y,
            ),
        };
        let (paint_x, paint_y) = paint_origin(node, live_x, live_y, size_x, size_y);
        let next = LiveBox {
            x1: live_x,
            y1: live_y,
            size_x,
            size_y,
            clip,
            paint_x,
            paint_y,
        };
        let rect = Rect {
            x1: live_x,
            y1: live_y,
            x2: live_x.saturating_add(size_x - 1),
            y2: live_y.saturating_add(size_y - 1),
        };
        let child_clip = clip.intersect(rect);
        if node.live != next {
            changed = true;
        }
        if let Some(node) = tree.nodes.get_mut(&id) {
            node.live = next;
        }
        for &child in tree.nodes[&id].children.iter().rev() {
            stack.push((child, next_dx, next_dy, child_clip));
        }
    }
    Ok(changed)
}

/// Sets the canonical box of `id` from a window rectangle (`fgce.md` §4.7).
///
/// The caller runs the canonical pass and `validate_tree` over the patched tree.
pub(crate) fn place_node(
    tree: &mut Tree,
    id: NodeId,
    rect: Rect,
    window: &LiveParams,
) -> Result<(), Error> {
    if rect.is_empty() {
        return Err(Error::BadCell);
    }
    if id.0 == 0 {
        return Err(Error::BadParent);
    }
    let Some(node) = tree.nodes.get(&id) else {
        return Err(Error::UnknownNode);
    };
    if node.is_group() {
        return Err(Error::BadParent);
    }
    let (size_x, size_y) = rect_sides(rect)?;
    let (parent_live_x, parent_live_y, parent_canon_x, parent_canon_y, parent_w, parent_h) =
        match node.parent {
            Some(parent) => {
                let Some(parent) = tree.nodes.get(&parent) else {
                    return Err(Error::BadParent);
                };
                (
                    parent.live.x1,
                    parent.live.y1,
                    parent.size_x,
                    parent.size_y,
                    parent.size_x,
                    parent.size_y,
                )
            }
            None => (
                0,
                0,
                window.canon_w as i32,
                window.canon_h as i32,
                window.live_w as i32,
                window.live_h as i32,
            ),
        };
    let p_x = rect.x1 - parent_live_x;
    let p_y = rect.y1 - parent_live_y;
    let (a_x, a_y) = match &node.class {
        Class::Arbitrary { pin, .. } => (
            inverse_pin(pin.x, p_x, parent_canon_x, parent_w, -1)?,
            inverse_pin(pin.y, p_y, parent_canon_y, parent_h, 1)?,
        ),
        Class::Entity(_) => (p_x, p_y),
        Class::Group { .. } => return Err(Error::BadParent),
    };
    check_coord(a_x as i64)?;
    check_coord(a_y as i64)?;
    let Some(node) = tree.nodes.get_mut(&id) else {
        return Err(Error::UnknownNode);
    };
    node.a_x = a_x;
    node.a_y = a_y;
    node.size_x = size_x;
    node.size_y = size_y;
    if matches!(
        node.class,
        Class::Entity(EntityData::Flat { .. } | EntityData::Empty)
    ) {
        node.entity_size_x = size_x;
        node.entity_size_y = size_y;
    }
    Ok(())
}

fn inverse_pin(pin: i8, p: i32, canon: i32, live: i32, near: i8) -> Result<i32, Error> {
    if pin == 0 {
        if live == 0 {
            return Err(Error::Overflow);
        }
        return check_coord((p as i64 * canon as i64).div_euclid(live as i64));
    }
    if pin == near {
        return Ok(p);
    }
    check_coord(p as i64 - live as i64 + canon as i64)
}

pub(crate) fn rect_sides(rect: Rect) -> Result<(i32, i32), Error> {
    check_coord(rect.x1 as i64)?;
    check_coord(rect.y1 as i64)?;
    check_coord(rect.x2 as i64)?;
    check_coord(rect.y2 as i64)?;
    let width = (rect.x2 as i64 - rect.x1 as i64 + 1) as i32;
    let height = (rect.y2 as i64 - rect.y1 as i64 + 1) as i32;
    Ok((width, height))
}

#[allow(clippy::too_many_arguments)]
fn resolve(
    node: &TreeNode,
    parent_x: i32,
    parent_y: i32,
    parent_canon_x: i32,
    parent_canon_y: i32,
    parent_w: i32,
    parent_h: i32,
    window: &LiveParams,
    origin_x: i32,
    origin_y: i32,
) -> Result<(i32, i32), Error> {
    let (pin, snap, inset) = match &node.class {
        Class::Group { pin, snap, inset }
        | Class::Arbitrary {
            pin, snap, inset, ..
        } => (*pin, *snap, *inset),
        Class::Entity(_) => return Ok((node.a_x, node.a_y)),
    };
    let mut rel_x = pin_axis(pin.x, node.a_x, parent_canon_x, parent_w, -1)?;
    let mut rel_y = pin_axis(pin.y, node.a_y, parent_canon_y, parent_h, 1)?;
    if snap {
        rel_x = snap_edge(parent_x, rel_x, origin_x, window.step, snap_mode(pin.x, -1))?;
        rel_y = snap_edge(parent_y, rel_y, origin_y, window.step, snap_mode(pin.y, 1))?;
    }
    if let Some([left, top, right, bottom]) = inset {
        let abs_x = parent_x + rel_x;
        let abs_y = parent_y + rel_y;
        rel_x = inset_axis(abs_x, node.size_x, window.live_w as i32, left, right) - parent_x;
        rel_y = inset_axis(abs_y, node.size_y, window.live_h as i32, top, bottom) - parent_y;
    }
    Ok((rel_x, rel_y))
}

fn pin_axis(pin: i8, a: i32, canon: i32, live: i32, near: i8) -> Result<i32, Error> {
    if pin == 0 {
        if canon == 0 {
            return Err(Error::Overflow);
        }
        return check_coord((a as i64 * live as i64).div_euclid(canon as i64));
    }
    if pin == near {
        return Ok(a);
    }
    check_coord(a as i64 + live as i64 - canon as i64)
}

#[derive(Clone, Copy)]
enum SnapMode {
    Lower,
    Upper,
    Nearest,
}

fn snap_mode(pin: i8, near: i8) -> SnapMode {
    if pin == near {
        SnapMode::Lower
    } else if pin == -near {
        SnapMode::Upper
    } else {
        SnapMode::Nearest
    }
}

fn snap_edge(parent: i32, rel: i32, origin: i32, step: u32, mode: SnapMode) -> Result<i32, Error> {
    let absolute = parent as i64 + rel as i64;
    let step = step as i64;
    let origin = origin as i64;
    let rem = (absolute - origin).rem_euclid(step);
    let lower = absolute - rem;
    let upper = if rem == 0 { lower } else { lower + step };
    let line = match mode {
        SnapMode::Lower => lower,
        SnapMode::Upper => upper,
        SnapMode::Nearest => {
            if absolute - lower < upper - absolute {
                lower
            } else {
                upper
            }
        }
    };
    check_coord(line - parent as i64)
}

fn inset_axis(value: i32, size: i32, live: i32, gap0: i32, gap1: i32) -> i32 {
    let lo = gap0;
    let hi = live - size - gap1;
    if lo <= hi {
        value.clamp(lo, hi)
    } else {
        gap0 - (lo - hi).div_euclid(2)
    }
}

fn paint_origin(node: &TreeNode, live_x: i32, live_y: i32, size_x: i32, size_y: i32) -> (i32, i32) {
    if !matches!(node.class, Class::Entity(_)) {
        return (live_x, live_y);
    }
    let free_x = size_x - node.entity_size_x;
    let free_y = size_y - node.entity_size_y;
    (
        live_x + align_offset(node.align.x, free_x, -1),
        live_y + align_offset(node.align.y, free_y, 1),
    )
}

fn align_offset(align: i8, free: i32, near: i8) -> i32 {
    if align == near {
        0
    } else if align == -near {
        free
    } else {
        free.div_euclid(2)
    }
}

fn check_coord(value: i64) -> Result<i32, Error> {
    if value.unsigned_abs() > MAX_COORD as u64 {
        Err(Error::Overflow)
    } else {
        Ok(value as i32)
    }
}

/// Active tree in draw order: node first, then its children; the window is
/// omitted and each rectangle is intersected with the frame and its ancestors
/// (`fgce.md` §5.5).
pub(crate) fn snapshot(tree: &Tree, generation: u64) -> Snapshot {
    let mut nodes = Vec::with_capacity(tree.nodes.len());
    let mut stack: Vec<NodeId> = tree.roots.iter().rev().copied().collect();
    while let Some(id) = stack.pop() {
        let Some(node) = tree.nodes.get(&id) else {
            continue;
        };
        let rect = Rect {
            x1: node.live.x1,
            y1: node.live.y1,
            x2: node.live.x1.saturating_add(node.live.size_x - 1),
            y2: node.live.y1.saturating_add(node.live.size_y - 1),
        }
        .intersect(node.live.clip);
        nodes.push(SnapshotNode {
            id,
            parent: node.parent.unwrap_or(NodeId(0)),
            rect,
        });
        for &child in node.children.iter().rev() {
            stack.push(child);
        }
    }
    Snapshot { generation, nodes }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::{Align, Blend, Color, Pin};
    use crate::tree::{Class, EntityData, Node};

    fn context() -> Context {
        Context {
            k: 5,
            step: 15,
            origin_x: 0,
            origin_y: 0,
        }
    }

    fn flat(parent: Option<NodeId>, a_x: i32, near_x: i32, size_x: i32) -> Node {
        Node {
            parent,
            class: Class::Entity(EntityData::Flat {
                color: Color {
                    r: 255,
                    g: 255,
                    b: 255,
                    a: 255,
                },
            }),
            align: Align { x: 0, y: 0 },
            a_x,
            a_y: 0,
            near_x,
            near_y: 0,
            size_x,
            size_y: 5,
            zero_x: 0,
            zero_y: 0,
            zero_offset_x: 0,
            zero_offset_y: 0,
            entity_size_x: size_x,
            entity_size_y: 5,
            blend: Blend::SrcOver,
            radius: None,
            children: Vec::new(),
            live: LiveBox::default(),
        }
    }

    fn group(children: Vec<NodeId>, near_x: i32, size_x: i32) -> Node {
        Node {
            parent: None,
            class: Class::Group {
                pin: crate::contract::Pin { x: -1, y: 1 },
                snap: false,
                inset: None,
            },
            align: Align { x: 0, y: 0 },
            a_x: 0,
            a_y: 0,
            near_x,
            near_y: 0,
            size_x,
            size_y: 5,
            zero_x: 0,
            zero_y: 0,
            zero_offset_x: 0,
            zero_offset_y: 0,
            entity_size_x: 0,
            entity_size_y: 0,
            blend: Blend::SrcOver,
            radius: None,
            children,
            live: LiveBox::default(),
        }
    }

    #[test]
    fn new_child_moves_union_but_not_the_first_child() {
        let mut tree = Tree::default();
        tree.nodes
            .insert(NodeId(1), flat(Some(NodeId(10)), 0, 10, 5));
        tree.nodes
            .insert(NodeId(2), flat(Some(NodeId(10)), 10, 20, 5));
        tree.nodes
            .insert(NodeId(10), group(vec![NodeId(1), NodeId(2)], 10, 15));
        tree.roots.push(NodeId(10));
        canonical_pass(&mut tree, &context());
        assert_eq!(tree.nodes[&NodeId(1)].near_x, 10);
        assert_eq!(tree.nodes[&NodeId(2)].near_x, 20);
        assert_eq!(tree.nodes[&NodeId(10)].near_x, 10);
        assert_eq!(tree.nodes[&NodeId(10)].size_x, 15);

        tree.nodes
            .insert(NodeId(3), flat(Some(NodeId(10)), -10, 0, 5));
        tree.nodes
            .get_mut(&NodeId(10))
            .unwrap()
            .children
            .push(NodeId(3));
        canonical_pass(&mut tree, &context());
        assert_eq!(tree.nodes[&NodeId(1)].near_x, 10);
        assert_eq!(tree.nodes[&NodeId(3)].near_x, 0);
        assert_eq!(tree.nodes[&NodeId(10)].near_x, 0);
        assert_eq!(tree.nodes[&NodeId(1)].a_x, 10);
        assert_eq!(tree.nodes[&NodeId(3)].a_x, 0);
    }

    #[test]
    fn moving_one_child_keeps_the_sibling_and_the_union() {
        let mut tree = Tree::default();
        tree.nodes
            .insert(NodeId(1), flat(Some(NodeId(10)), 0, 10, 5));
        tree.nodes
            .insert(NodeId(2), flat(Some(NodeId(10)), 10, 20, 5));
        tree.nodes
            .insert(NodeId(10), group(vec![NodeId(1), NodeId(2)], 10, 15));
        tree.roots.push(NodeId(10));
        canonical_pass(&mut tree, &context());

        tree.nodes.get_mut(&NodeId(1)).unwrap().a_x = -10;
        canonical_pass(&mut tree, &context());
        assert_eq!(tree.nodes[&NodeId(1)].near_x, 0);
        assert_eq!(tree.nodes[&NodeId(2)].near_x, 20);
        assert_eq!(tree.nodes[&NodeId(10)].near_x, 0);
        assert_eq!(tree.nodes[&NodeId(2)].a_x, 20);

        let before = tree.nodes[&NodeId(2)].near_x;
        canonical_pass(&mut tree, &context());
        assert_eq!(tree.nodes[&NodeId(2)].near_x, before);
    }

    #[test]
    fn nested_group_does_not_move_neighbours() {
        let mut tree = Tree::default();
        tree.nodes
            .insert(NodeId(1), flat(Some(NodeId(10)), 0, 10, 5));
        tree.nodes
            .insert(NodeId(2), flat(Some(NodeId(10)), 10, 20, 5));
        let mut inner = group(vec![NodeId(1), NodeId(2)], 10, 15);
        inner.parent = Some(NodeId(20));
        tree.nodes.insert(NodeId(10), inner);
        tree.nodes
            .insert(NodeId(3), flat(Some(NodeId(20)), 20, 30, 5));
        tree.nodes
            .insert(NodeId(20), group(vec![NodeId(10), NodeId(3)], 10, 25));
        tree.roots.push(NodeId(20));
        canonical_pass(&mut tree, &context());
        assert_eq!(tree.nodes[&NodeId(10)].near_x, 10);
        assert_eq!(tree.nodes[&NodeId(20)].near_x, 10);

        tree.nodes.get_mut(&NodeId(1)).unwrap().a_x = -10;
        canonical_pass(&mut tree, &context());
        assert_eq!(tree.nodes[&NodeId(10)].near_x, 0);
        assert_eq!(tree.nodes[&NodeId(20)].near_x, 0);
        assert_eq!(tree.nodes[&NodeId(3)].near_x, 30);
        assert_eq!(tree.nodes[&NodeId(2)].near_x, 20);
    }

    #[allow(clippy::too_many_arguments)]
    fn pinned(
        pin: Pin,
        snap: bool,
        inset: Option<[i32; 4]>,
        a_x: i32,
        a_y: i32,
        size_x: i32,
        size_y: i32,
        children: Vec<NodeId>,
    ) -> Node {
        Node {
            parent: None,
            class: Class::Group { pin, snap, inset },
            align: Align { x: 0, y: 0 },
            a_x,
            a_y,
            near_x: a_x,
            near_y: a_y,
            size_x,
            size_y,
            zero_x: 0,
            zero_y: 0,
            zero_offset_x: 0,
            zero_offset_y: 0,
            entity_size_x: 0,
            entity_size_y: 0,
            blend: Blend::SrcOver,
            radius: None,
            children,
            live: LiveBox::default(),
        }
    }

    fn entity_box(
        align: Align,
        a_x: i32,
        a_y: i32,
        size_x: i32,
        size_y: i32,
        entity_x: i32,
        entity_y: i32,
    ) -> Node {
        Node {
            parent: None,
            class: Class::Entity(EntityData::Flat {
                color: Color {
                    r: 255,
                    g: 255,
                    b: 255,
                    a: 255,
                },
            }),
            align,
            a_x,
            a_y,
            near_x: a_x,
            near_y: a_y,
            size_x,
            size_y,
            zero_x: 0,
            zero_y: 0,
            zero_offset_x: 0,
            zero_offset_y: 0,
            entity_size_x: entity_x,
            entity_size_y: entity_y,
            blend: Blend::SrcOver,
            radius: None,
            children: Vec::new(),
            live: LiveBox::default(),
        }
    }

    fn window(canon: u32, live: u32, step: u32, pin: Pin) -> LiveParams {
        LiveParams {
            canon_w: canon,
            canon_h: canon,
            live_w: live,
            live_h: live,
            step,
            pin,
        }
    }

    fn pass(tree: &mut Tree, window: &LiveParams) -> bool {
        live_pass(tree, window, &HashMap::new()).unwrap()
    }

    #[test]
    fn pin_follows_fraction_and_far_gap() {
        let mut tree = Tree::default();
        tree.nodes.insert(
            NodeId(1),
            pinned(Pin { x: 0, y: 0 }, false, None, 400, 400, 50, 50, vec![]),
        );
        tree.nodes.insert(
            NodeId(2),
            pinned(Pin { x: 1, y: 1 }, false, None, 400, 400, 50, 50, vec![]),
        );
        tree.roots = vec![NodeId(1), NodeId(2)];
        let window = LiveParams {
            canon_w: 1000,
            canon_h: 1000,
            live_w: 1100,
            live_h: 1000,
            step: 15,
            pin: Pin { x: -1, y: 1 },
        };
        pass(&mut tree, &window);
        assert_eq!(tree.nodes[&NodeId(1)].live.x1, 440);
        assert_eq!(tree.nodes[&NodeId(1)].live.y1, 400);
        assert_eq!(tree.nodes[&NodeId(2)].live.x1, 500);
        assert_eq!(tree.nodes[&NodeId(2)].live.y1, 400);
    }

    #[test]
    fn pin_zero_growth_is_pixelwise() {
        let mut previous: Option<i32> = None;
        for live in 1000..=1005 {
            let mut tree = Tree::default();
            tree.nodes.insert(
                NodeId(1),
                pinned(Pin { x: 0, y: 0 }, false, None, 400, 0, 50, 50, vec![]),
            );
            tree.roots = vec![NodeId(1)];
            pass(&mut tree, &window(1000, live, 15, Pin { x: -1, y: 1 }));
            let x = tree.nodes[&NodeId(1)].live.x1;
            assert_eq!(x, (400 * live as i32).div_euclid(1000));
            if let Some(previous) = previous {
                assert!((x - previous).abs() <= 1, "L = {live}");
            }
            previous = Some(x);
        }
    }

    #[test]
    fn snap_quantizes_after_pin() {
        let window = window(60, 60, 6, Pin { x: -1, y: 1 });
        let mut tree = Tree::default();
        tree.nodes.insert(
            NodeId(1),
            pinned(Pin { x: -1, y: 1 }, true, None, 3, 3, 2, 2, vec![]),
        );
        tree.nodes.insert(
            NodeId(2),
            pinned(Pin { x: 1, y: -1 }, true, None, 3, 3, 2, 2, vec![]),
        );
        tree.nodes.insert(
            NodeId(3),
            pinned(Pin { x: 0, y: 0 }, true, None, 3, 3, 2, 2, vec![]),
        );
        tree.roots = vec![NodeId(1), NodeId(2), NodeId(3)];
        pass(&mut tree, &window);
        assert_eq!(tree.nodes[&NodeId(1)].live.x1, 0);
        assert_eq!(tree.nodes[&NodeId(1)].live.y1, 0);
        assert_eq!(tree.nodes[&NodeId(2)].live.x1, 6);
        assert_eq!(tree.nodes[&NodeId(2)].live.y1, 6);
        assert_eq!(tree.nodes[&NodeId(3)].live.x1, 6);
        assert_eq!(tree.nodes[&NodeId(3)].live.y1, 6);

        let mut tree = Tree::default();
        tree.nodes.insert(
            NodeId(10),
            pinned(
                Pin { x: -1, y: 1 },
                false,
                None,
                10,
                0,
                20,
                20,
                vec![NodeId(1)],
            ),
        );
        let mut child = pinned(Pin { x: -1, y: 1 }, true, None, 3, 0, 2, 2, vec![]);
        child.parent = Some(NodeId(10));
        tree.nodes.insert(NodeId(1), child);
        tree.roots = vec![NodeId(10)];
        pass(&mut tree, &window);
        assert_eq!(tree.nodes[&NodeId(10)].live.x1, 10);
        assert_eq!(tree.nodes[&NodeId(1)].live.x1, 12);
    }

    #[test]
    fn inset_clamps_and_shortens() {
        let cases = [
            (160, 0, 15),
            (160, 30, 30),
            (160, 50, 45),
            (120, 0, 10),
            (119, 0, 10),
        ];
        for (live, a, expected) in cases {
            let mut tree = Tree::default();
            tree.nodes.insert(
                NodeId(1),
                pinned(
                    Pin { x: -1, y: 1 },
                    false,
                    Some([15, 0, 15, 0]),
                    a,
                    0,
                    100,
                    100,
                    vec![],
                ),
            );
            tree.roots = vec![NodeId(1)];
            pass(&mut tree, &window(500, live, 15, Pin { x: -1, y: 1 }));
            assert_eq!(
                tree.nodes[&NodeId(1)].live.x1,
                expected,
                "L = {live}, a = {a}"
            );
        }

        let mut tree = Tree::default();
        tree.nodes.insert(
            NodeId(1),
            pinned(
                Pin { x: -1, y: 1 },
                true,
                Some([15, 0, 15, 0]),
                0,
                0,
                100,
                100,
                vec![],
            ),
        );
        tree.roots = vec![NodeId(1)];
        pass(&mut tree, &window(500, 120, 15, Pin { x: -1, y: 1 }));
        assert_eq!(tree.nodes[&NodeId(1)].live.x1, 10);
    }

    #[test]
    fn align_places_the_entity_box() {
        let window = window(100, 100, 15, Pin { x: -1, y: 1 });
        let mut tree = Tree::default();
        tree.nodes.insert(
            NodeId(1),
            entity_box(Align { x: 1, y: 0 }, 0, 0, 10, 10, 4, 4),
        );
        tree.nodes.insert(
            NodeId(2),
            entity_box(Align { x: -1, y: -1 }, 20, 20, 10, 10, 4, 4),
        );
        tree.nodes.insert(
            NodeId(3),
            entity_box(Align { x: 0, y: 0 }, 40, 40, 10, 10, 4, 4),
        );
        tree.roots = vec![NodeId(1), NodeId(2), NodeId(3)];
        pass(&mut tree, &window);
        assert_eq!(tree.nodes[&NodeId(1)].live.paint_x, 6);
        assert_eq!(tree.nodes[&NodeId(1)].live.paint_y, 3);
        assert_eq!(tree.nodes[&NodeId(2)].live.paint_x, 20);
        assert_eq!(tree.nodes[&NodeId(2)].live.paint_y, 26);
        assert_eq!(tree.nodes[&NodeId(3)].live.paint_x, 43);
        assert_eq!(tree.nodes[&NodeId(3)].live.paint_y, 43);
    }

    #[test]
    fn snapshot_is_draw_order_and_clips_to_frame() {
        let window = window(100, 100, 15, Pin { x: -1, y: 1 });
        let mut tree = Tree::default();
        tree.nodes
            .insert(NodeId(1), flat(Some(NodeId(10)), 0, 0, 5));
        tree.nodes
            .insert(NodeId(2), flat(Some(NodeId(10)), 10, 10, 5));
        tree.nodes
            .insert(NodeId(10), group(vec![NodeId(1), NodeId(2)], 0, 15));
        tree.nodes.insert(NodeId(3), flat(None, -20, -20, 5));
        tree.roots = vec![NodeId(10), NodeId(3)];
        pass(&mut tree, &window);
        let list = snapshot(&tree, 7);
        assert_eq!(list.generation, 7);
        let ids: Vec<u32> = list.nodes.iter().map(|node| node.id.0).collect();
        assert_eq!(ids, [10, 1, 2, 3]);
        assert_eq!(list.nodes[0].parent, NodeId(0));
        assert_eq!(list.nodes[1].parent, NodeId(10));
        assert_eq!(
            list.nodes[0].rect,
            Rect {
                x1: 0,
                y1: 0,
                x2: 14,
                y2: 4
            }
        );
        assert!(list.nodes[3].rect.is_empty());
    }
}
