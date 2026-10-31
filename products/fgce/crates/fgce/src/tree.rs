//! References, nodes and tree mutations (`fgce.md` §4, §5.5).
//!
//! This module owns reference trees and stores canonical boxes; it never runs
//! the canonical pass. `place` receives the stored boxes and rewrites `near`/`a`.

use std::collections::{HashMap, HashSet};

use crate::contract::{
    Align, Blend, Color, Edges, Entity, EntityKind, Error, Fill, ImageId, Inset, NodeId, Pin,
    PixelFormat, Radius, Rect, ReferenceId, Stroke, Verb,
};
use crate::store::Store;
use crate::{MAX_COORD, MAX_SIDE, State, lattice, spx, vector};

/// Identity of a tree: the built-in reference or one service reference.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) enum RefKey {
    Builtin,
    Service(ReferenceId),
}

/// Canonical parameters needed to parse edges and compute `zero`.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Context {
    pub(crate) k: u32,
    pub(crate) step: u32,
    pub(crate) origin_x: i32,
    pub(crate) origin_y: i32,
}

/// Inputs of the live pass: the active reference and the current window
/// (`fgce.md` §4.6).
#[derive(Clone, Copy, Debug)]
pub(crate) struct LiveParams {
    pub(crate) canon_w: u32,
    pub(crate) canon_h: u32,
    pub(crate) live_w: u32,
    pub(crate) live_h: u32,
    pub(crate) step: u32,
    pub(crate) pin: Pin,
}

#[derive(Clone, Debug)]
pub(crate) enum EntityData {
    Photo {
        format: PixelFormat,
        image: ImageId,
        tint: Color,
    },
    Glyph {
        format: PixelFormat,
        image: ImageId,
        tint: Color,
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
    /// Layout-only node: carries a coordinate box and paints no pixels.
    Empty,
}

#[derive(Clone, Debug)]
pub(crate) enum Class {
    Entity(EntityData),
    Group {
        pin: Pin,
        snap: bool,
        inset: Option<[i32; 4]>,
    },
    Arbitrary {
        pin: Pin,
        snap: bool,
        inset: Option<[i32; 4]>,
        on_grid: bool,
    },
}

/// Live rectangles written by the `place` pass (`fgce.md` §4.6, §5.5).
///
/// `x1,y1,size_x,size_y` is the coordinate box; `clip` is already intersected
/// with the frame and every ancestor. `paint_x,paint_y` places the entity box
/// inside the coordinate box by `align`; groups and arbitrary boxes keep it equal
/// to `x1,y1`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct LiveBox {
    pub(crate) x1: i32,
    pub(crate) y1: i32,
    pub(crate) size_x: i32,
    pub(crate) size_y: i32,
    pub(crate) clip: Rect,
    pub(crate) paint_x: i32,
    pub(crate) paint_y: i32,
}

impl Default for LiveBox {
    fn default() -> Self {
        LiveBox {
            x1: 0,
            y1: 0,
            size_x: 0,
            size_y: 0,
            clip: Rect {
                x1: 0,
                y1: 0,
                x2: -1,
                y2: -1,
            },
            paint_x: 0,
            paint_y: 0,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Node {
    pub(crate) parent: Option<NodeId>,
    pub(crate) class: Class,
    pub(crate) align: Align,
    pub(crate) a_x: i32,
    pub(crate) a_y: i32,
    pub(crate) near_x: i32,
    pub(crate) near_y: i32,
    pub(crate) size_x: i32,
    pub(crate) size_y: i32,
    pub(crate) zero_x: i32,
    pub(crate) zero_y: i32,
    pub(crate) zero_offset_x: i32,
    pub(crate) zero_offset_y: i32,
    pub(crate) entity_size_x: i32,
    pub(crate) entity_size_y: i32,
    pub(crate) blend: Blend,
    pub(crate) radius: Option<Radius>,
    pub(crate) children: Vec<NodeId>,
    pub(crate) live: LiveBox,
}

impl Node {
    pub(crate) fn is_group(&self) -> bool {
        matches!(self.class, Class::Group { .. })
    }

    pub(crate) fn is_arbitrary(&self) -> bool {
        matches!(self.class, Class::Arbitrary { .. })
    }

    pub(crate) fn image(&self) -> Option<(ImageId, PixelFormat)> {
        match &self.class {
            Class::Entity(EntityData::Photo { image, format, .. })
            | Class::Entity(EntityData::Glyph { image, format, .. }) => Some((*image, *format)),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Tree {
    pub(crate) nodes: HashMap<NodeId, Node>,
    pub(crate) roots: Vec<NodeId>,
}

impl Tree {
    fn contains(&self, id: NodeId) -> bool {
        self.nodes.contains_key(&id)
    }

    fn parent_of(&self, id: NodeId) -> Option<NodeId> {
        self.nodes.get(&id).and_then(|node| node.parent)
    }

    fn detach(&mut self, id: NodeId) {
        match self.parent_of(id) {
            Some(parent) => {
                if let Some(node) = self.nodes.get_mut(&parent) {
                    node.children.retain(|child| *child != id);
                }
            }
            None => self.roots.retain(|root| *root != id),
        }
        if let Some(node) = self.nodes.get_mut(&id) {
            node.parent = None;
        }
    }

    fn attach(&mut self, parent: NodeId, id: NodeId) {
        if let Some(node) = self.nodes.get_mut(&id) {
            node.parent = Some(parent);
        }
        if let Some(node) = self.nodes.get_mut(&parent) {
            node.children.push(id);
        }
    }

    fn absolute(&self, id: NodeId) -> (i32, i32) {
        let Some(node) = self.nodes.get(&id) else {
            return (0, 0);
        };
        match node.parent {
            Some(parent) => match self.nodes.get(&parent) {
                Some(parent) => (parent.near_x + node.a_x, parent.near_y + node.a_y),
                None => (node.a_x, node.a_y),
            },
            None => (node.a_x, node.a_y),
        }
    }

    /// Ids of `id` and its descendants, for debug-label cleanup.
    pub(crate) fn subtree_ids(&self, id: NodeId) -> Vec<NodeId> {
        let mut out = Vec::new();
        self.collect_subtree(id, &mut out);
        out
    }

    pub(crate) fn all_ids(&self) -> Vec<NodeId> {
        self.nodes.keys().copied().collect()
    }

    fn collect_subtree(&self, id: NodeId, out: &mut Vec<NodeId>) {
        let mut stack = vec![id];
        while let Some(current) = stack.pop() {
            out.push(current);
            if let Some(node) = self.nodes.get(&current) {
                stack.extend(node.children.iter().copied());
            }
        }
    }

    fn remove_subtree(&mut self, id: NodeId) {
        let Some(parent) = self.parent_of(id) else {
            self.roots.retain(|root| *root != id);
            let mut removed = Vec::new();
            self.collect_subtree(id, &mut removed);
            for node in removed {
                self.nodes.remove(&node);
            }
            return;
        };
        if let Some(parent) = self.nodes.get_mut(&parent) {
            parent.children.retain(|child| *child != id);
        }
        let mut removed = Vec::new();
        self.collect_subtree(id, &mut removed);
        for node in removed {
            self.nodes.remove(&node);
        }
    }

    fn is_ancestor(&self, ancestor: NodeId, mut node: NodeId) -> bool {
        let mut guard = 0_u32;
        while let Some(parent) = self.parent_of(node) {
            if parent == ancestor {
                return true;
            }
            node = parent;
            guard += 1;
            if guard > self.nodes.len() as u32 {
                break;
            }
        }
        false
    }
}

pub(crate) struct Reference {
    pub(crate) canon_w: u32,
    pub(crate) canon_h: u32,
    pub(crate) k: u32,
    // Stored for the request contract; no core formula reads `d` (`fgce.md` §10).
    #[allow(dead_code)]
    pub(crate) d: u32,
    pub(crate) pin: Pin,
    pub(crate) enter_cols: u32,
    pub(crate) enter_rows: u32,
    pub(crate) step: u32,
    pub(crate) origin_x: i32,
    pub(crate) origin_y: i32,
    pub(crate) ready: bool,
    pub(crate) generation: u64,
    pub(crate) tree: Tree,
}

impl Reference {
    fn builtin() -> Self {
        Reference {
            canon_w: 0,
            canon_h: 0,
            k: 5,
            d: 1,
            pin: Pin { x: -1, y: 1 },
            enter_cols: 0,
            enter_rows: 0,
            step: 15,
            origin_x: 0,
            origin_y: 0,
            ready: false,
            generation: 0,
            tree: Tree::default(),
        }
    }

    fn service(
        canon_w: u32,
        canon_h: u32,
        k: u32,
        d: u32,
        pin: Pin,
        enter_cols: u32,
        enter_rows: u32,
    ) -> Result<Self, Error> {
        if !(1..=MAX_SIDE).contains(&canon_w) || !(1..=MAX_SIDE).contains(&canon_h) {
            return Err(Error::SurfaceOutOfRange);
        }
        let step = spx::primary(k)?;
        if d < 1 {
            return Err(Error::ScaleOutOfRange);
        }
        lattice::check_pin(pin)?;
        let calc = lattice::compute(canon_w, canon_h, step, pin.x, pin.y)?;
        Ok(Reference {
            canon_w,
            canon_h,
            k,
            d,
            pin,
            enter_cols,
            enter_rows,
            step,
            origin_x: calc.lattice.origin_x as i32,
            origin_y: calc.lattice.origin_y as i32,
            ready: true,
            generation: 0,
            tree: Tree::default(),
        })
    }

    fn set_builtin_canon(&mut self, width: u32, height: u32) -> Result<(), Error> {
        let calc = lattice::compute(width, height, self.step, self.pin.x, self.pin.y)?;
        self.canon_w = width;
        self.canon_h = height;
        self.origin_x = calc.lattice.origin_x as i32;
        self.origin_y = calc.lattice.origin_y as i32;
        self.ready = true;
        Ok(())
    }

    pub(crate) fn context(&self) -> Option<Context> {
        self.ready.then_some(Context {
            k: self.k,
            step: self.step,
            origin_x: self.origin_x,
            origin_y: self.origin_y,
        })
    }
}

pub(crate) struct References {
    builtin: Reference,
    service: HashMap<ReferenceId, Reference>,
    active: Option<ReferenceId>,
    held: Option<ReferenceId>,
    transition_used: bool,
    live: Option<(u32, u32)>,
    image_refs: HashMap<ImageId, Vec<(RefKey, NodeId)>>,
    shows: HashMap<NodeId, Rect>,
}

impl References {
    pub(crate) fn new() -> Self {
        References {
            builtin: Reference::builtin(),
            service: HashMap::new(),
            active: None,
            held: None,
            transition_used: false,
            live: None,
            image_refs: HashMap::new(),
            shows: HashMap::new(),
        }
    }

    pub(crate) fn begin(&mut self, builtin_canon: Option<(u32, u32)>, width: u32, height: u32) {
        if !self.builtin.ready
            && let Some((canon_w, canon_h)) = builtin_canon
        {
            // `Begin` already bounded the side; this lattice call cannot fail here.
            let _ = self.builtin.set_builtin_canon(canon_w, canon_h);
        }
        self.live = Some((width, height));
        self.transition_used = false;
        self.active = self.choose();
    }

    fn choose(&self) -> Option<ReferenceId> {
        if let Some(id) = self.held {
            return Some(id);
        }
        let Some((width, height)) = self.live else {
            return self.active;
        };
        let mut best: Option<(u32, u32)> = None;
        let mut best_ids: Vec<ReferenceId> = Vec::new();
        for (&id, reference) in &self.service {
            let step = reference.step as u64;
            let count_x = (width as u64).div_ceil(step);
            let count_y = (height as u64).div_ceil(step);
            if count_x < reference.enter_cols as u64 || count_y < reference.enter_rows as u64 {
                continue;
            }
            let pair = (reference.enter_cols, reference.enter_rows);
            match best {
                None => {
                    best = Some(pair);
                    best_ids = vec![id];
                }
                Some(current) if pair > current => {
                    best = Some(pair);
                    best_ids = vec![id];
                }
                Some(current) if pair == current => best_ids.push(id),
                _ => {}
            }
        }
        let Some(pair) = best else {
            return self.active;
        };
        if let Some(active) = self.active
            && self
                .service
                .get(&active)
                .is_some_and(|reference| (reference.enter_cols, reference.enter_rows) == pair)
        {
            return Some(active);
        }
        best_ids.into_iter().min_by_key(|id| id.0)
    }
}

pub(crate) struct DefineOp {
    pub(crate) id: ReferenceId,
    pub(crate) canon_w: u32,
    pub(crate) canon_h: u32,
    pub(crate) k: u32,
    pub(crate) d: u32,
    pub(crate) pin: Pin,
    pub(crate) enter_cols: u32,
    pub(crate) enter_rows: u32,
}

impl References {
    pub(crate) fn define(&mut self, op: &DefineOp) -> Result<(), Error> {
        let id = op.id;
        if id.0 == 0 {
            return Err(Error::ReferenceMissing);
        }
        let is_new = !self.service.contains_key(&id);
        let reference = Reference::service(
            op.canon_w,
            op.canon_h,
            op.k,
            op.d,
            op.pin,
            op.enter_cols,
            op.enter_rows,
        )?;
        self.service.insert(id, reference);
        self.remove_refs(RefKey::Service(id));
        if self.active == Some(id) {
            self.shows.clear();
        }
        if is_new && self.active.is_none() && self.held.is_none() {
            self.active = Some(id);
        }
        Ok(())
    }

    pub(crate) fn use_reference(&mut self, id: u32, state: State) -> Result<(), Error> {
        if id != 0 && !self.service.contains_key(&ReferenceId(id)) {
            return Err(Error::ReferenceMissing);
        }
        if id == 0 {
            if self.held.is_none() {
                return Ok(());
            }
            if state == State::Begun && self.transition_used {
                return Err(Error::ReferenceBusy);
            }
            self.held = None;
            match state {
                State::Begun | State::Ended => {
                    let next = self.choose();
                    if next != self.active {
                        if state == State::Begun {
                            self.transition_used = true;
                        }
                        self.active = next;
                    }
                }
                State::Empty => {}
            }
            return Ok(());
        }
        let id = ReferenceId(id);
        if self.active == Some(id) {
            self.held = Some(id);
            return Ok(());
        }
        if state == State::Begun && self.transition_used {
            return Err(Error::ReferenceBusy);
        }
        self.held = Some(id);
        self.active = Some(id);
        if state == State::Begun {
            self.transition_used = true;
        }
        Ok(())
    }

    pub(crate) fn active_key(&self) -> RefKey {
        match self.active {
            Some(id) => RefKey::Service(id),
            None => RefKey::Builtin,
        }
    }

    fn active_ref(&self) -> &Reference {
        match self.active {
            Some(id) => {
                debug_assert!(
                    self.service.contains_key(&id),
                    "active reference must exist"
                );
                self.service.get(&id).unwrap_or(&self.builtin)
            }
            None => &self.builtin,
        }
    }

    pub(crate) fn context(&self) -> Option<Context> {
        self.active_ref().context()
    }

    pub(crate) fn live_size(&self) -> Option<(u32, u32)> {
        self.live
    }

    /// Snapshot generation of the active list (`fgce.md` §5.5).
    pub(crate) fn generation(&self) -> u64 {
        self.active_ref().generation
    }

    /// One-frame `Show` rectangles of the active tree (`fgce.md` §4.7).
    pub(crate) fn shows(&self) -> &HashMap<NodeId, Rect> {
        &self.shows
    }

    pub(crate) fn show(&mut self, id: NodeId, rect: Rect) {
        self.shows.insert(id, rect);
    }

    pub(crate) fn clear_show(&mut self, id: NodeId) {
        self.shows.remove(&id);
    }

    /// Returns `true` when a frame ended with pending `Show` rectangles.
    pub(crate) fn clear_shows(&mut self) -> bool {
        let had = !self.shows.is_empty();
        self.shows.clear();
        had
    }

    /// The live pass of the active list wrote new rectangles.
    pub(crate) fn bump_generation(&mut self) {
        match self.active {
            Some(id) => {
                if let Some(reference) = self.service.get_mut(&id) {
                    reference.generation += 1;
                }
            }
            None => self.builtin.generation += 1,
        }
    }

    pub(crate) fn live_params(&self) -> Option<LiveParams> {
        let (live_w, live_h) = self.live?;
        let reference = self.active_ref();
        if !reference.ready {
            return None;
        }
        Some(LiveParams {
            canon_w: reference.canon_w,
            canon_h: reference.canon_h,
            live_w,
            live_h,
            step: reference.step,
            pin: reference.pin,
        })
    }

    pub(crate) fn context_for(&self, key: RefKey) -> Option<Context> {
        match key {
            RefKey::Builtin => self.builtin.context(),
            RefKey::Service(id) => self.service.get(&id).and_then(Reference::context),
        }
    }

    pub(crate) fn require_canon(&self) -> Result<(), Error> {
        if self.active_ref().ready {
            Ok(())
        } else {
            Err(Error::NotBegun)
        }
    }

    pub(crate) fn tree(&self, key: RefKey) -> &Tree {
        match key {
            RefKey::Builtin => &self.builtin.tree,
            RefKey::Service(id) => {
                debug_assert!(self.service.contains_key(&id), "reference tree must exist");
                self.service
                    .get(&id)
                    .map(|reference| &reference.tree)
                    .unwrap_or(&self.builtin.tree)
            }
        }
    }

    pub(crate) fn tree_mut(&mut self, key: RefKey) -> &mut Tree {
        match key {
            RefKey::Builtin => &mut self.builtin.tree,
            RefKey::Service(id) => {
                debug_assert!(self.service.contains_key(&id), "reference tree must exist");
                self.service
                    .get_mut(&id)
                    .map(|reference| &mut reference.tree)
                    .unwrap_or(&mut self.builtin.tree)
            }
        }
    }

    pub(crate) fn replace_tree(&mut self, key: RefKey, tree: Tree) {
        match key {
            RefKey::Builtin => self.builtin.tree = tree,
            RefKey::Service(id) => {
                if let Some(reference) = self.service.get_mut(&id) {
                    reference.tree = tree;
                }
            }
        }
    }

    pub(crate) fn node_in_other(&self, id: NodeId, key: RefKey) -> bool {
        let in_tree = |tree: &Tree| tree.contains(id);
        match key {
            RefKey::Builtin => self
                .service
                .values()
                .any(|reference| in_tree(&reference.tree)),
            RefKey::Service(active) => {
                in_tree(&self.builtin.tree)
                    || self
                        .service
                        .iter()
                        .any(|(id, reference)| *id != active && in_tree(&reference.tree))
            }
        }
    }

    fn remove_refs(&mut self, key: RefKey) {
        self.image_refs.retain(|_, users| {
            users.retain(|(user_key, _)| *user_key != key);
            !users.is_empty()
        });
    }

    pub(crate) fn rebuild_refs(&mut self, key: RefKey) {
        self.remove_refs(key);
        let mut found = Vec::new();
        {
            let tree = self.tree(key);
            for (id, node) in &tree.nodes {
                if let Some((image, _)) = node.image() {
                    found.push((image, *id));
                }
            }
        }
        for (image, id) in found {
            self.image_refs.entry(image).or_default().push((key, id));
        }
    }

    pub(crate) fn validate_upload(
        &self,
        id: ImageId,
        width: u32,
        height: u32,
        format: PixelFormat,
    ) -> Result<(), Error> {
        let Some(users) = self.image_refs.get(&id) else {
            return Ok(());
        };
        let mut users = users.clone();
        users.sort_by_key(|(key, node)| {
            (
                match key {
                    RefKey::Builtin => 0,
                    RefKey::Service(id) => id.0,
                },
                node.0,
            )
        });
        for (key, node_id) in users {
            let Some(node) = self.tree(key).nodes.get(&node_id) else {
                continue;
            };
            let Some((_, entity_format)) = node.image() else {
                continue;
            };
            if entity_format != format {
                return Err(Error::BufferLayout);
            }
            if width > node.size_x as u32 || height > node.size_y as u32 {
                return Err(Error::BoxOverflow);
            }
        }
        Ok(())
    }

    pub(crate) fn apply_upload(&mut self, id: ImageId, width: u32, height: u32) -> Vec<RefKey> {
        let users = self.image_refs.get(&id).cloned().unwrap_or_default();
        let mut keys = Vec::new();
        for (key, node_id) in users {
            if let Some(node) = self.tree_mut(key).nodes.get_mut(&node_id) {
                node.entity_size_x = width as i32;
                node.entity_size_y = height as i32;
                if !keys.contains(&key) {
                    keys.push(key);
                }
            }
        }
        keys
    }

    pub(crate) fn drop_allowed(&self, id: ImageId) -> bool {
        self.image_refs
            .get(&id)
            .is_none_or(|users| users.is_empty())
    }

    #[cfg(test)]
    pub(crate) fn active_id(&self) -> Option<ReferenceId> {
        self.active
    }

    pub(crate) fn service_tree(&self, id: ReferenceId) -> Option<&Tree> {
        self.service.get(&id).map(|reference| &reference.tree)
    }
}

/// First 15-line at or after `edge` (`fgce.md` §4.4).
pub(crate) fn zero_point(edge: i32, origin: i32, step: u32) -> i32 {
    let step = step as i64;
    let remainder = (edge as i64 - origin as i64).rem_euclid(step);
    if remainder == 0 {
        edge
    } else {
        (edge as i64 + step - remainder) as i32
    }
}

fn check_a(value: i32) -> Result<(), Error> {
    if (value as i64).unsigned_abs() > MAX_COORD as u64 {
        Err(Error::Overflow)
    } else {
        Ok(())
    }
}

fn rect_size(rect: Rect) -> (i32, i32) {
    if rect.is_empty() {
        (0, 0)
    } else {
        (rect.width() as i32, rect.height() as i32)
    }
}

fn entity_data(
    kind: EntityKind<'_>,
    store: &Store,
    scratch: &mut vector::RasterScratch,
) -> Result<(EntityData, i32, i32), Error> {
    match kind {
        EntityKind::Photo {
            format,
            image,
            tint,
        } => {
            if !matches!(format, PixelFormat::Rgb8 | PixelFormat::Rgba8) {
                return Err(Error::BufferLayout);
            }
            if image.0 == 0 {
                return Err(Error::UnknownImage);
            }
            let Some(stored) = store.get(image) else {
                return Err(Error::UnknownImage);
            };
            if stored.format != format {
                return Err(Error::BufferLayout);
            }
            Ok((
                EntityData::Photo {
                    format,
                    image,
                    tint: tint.unwrap_or(Color {
                        r: 255,
                        g: 255,
                        b: 255,
                        a: 255,
                    }),
                },
                stored.width as i32,
                stored.height as i32,
            ))
        }
        EntityKind::Glyph {
            format,
            image,
            tint,
        } => {
            if format != PixelFormat::Alpha8 {
                return Err(Error::BufferLayout);
            }
            if image.0 == 0 {
                return Err(Error::UnknownImage);
            }
            let Some(stored) = store.get(image) else {
                return Err(Error::UnknownImage);
            };
            if stored.format != PixelFormat::Alpha8 {
                return Err(Error::BufferLayout);
            }
            Ok((
                EntityData::Glyph {
                    format,
                    image,
                    tint: tint.unwrap_or(Color {
                        r: 0,
                        g: 0,
                        b: 0,
                        a: 255,
                    }),
                },
                stored.width as i32,
                stored.height as i32,
            ))
        }
        EntityKind::Vector {
            verbs,
            fill,
            stroke,
            color,
        } => {
            let measured = match (fill, stroke) {
                (Some(fill), None) => vector::measure_with(verbs, fill.rule, scratch)?,
                (None, Some(stroke)) => vector::measure_stroke_with(verbs, &stroke, scratch)?,
                _ => return Err(Error::BadPath),
            };
            let (width, height) = rect_size(measured);
            Ok((
                EntityData::Vector {
                    verbs: verbs.to_vec(),
                    fill,
                    stroke,
                    color,
                },
                width,
                height,
            ))
        }
        EntityKind::Flat { color } => Ok((EntityData::Flat { color }, 0, 0)),
        EntityKind::Box {
            fill,
            stroke,
            color,
        } => {
            if fill.is_none() && stroke.is_none() {
                return Err(Error::BadPath);
            }
            Ok((
                EntityData::Box {
                    fill,
                    stroke,
                    color,
                },
                0,
                0,
            ))
        }
        EntityKind::Empty => Ok((EntityData::Empty, 0, 0)),
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn apply_entity(
    tree: &mut Tree,
    entity: &Entity<'_>,
    store: &Store,
    context: &Context,
    active: RefKey,
    references: &References,
    scratch: &mut vector::RasterScratch,
) -> Result<(), Error> {
    if entity.id.0 == 0 {
        return Err(Error::BadParent);
    }
    let existing = tree.contains(entity.id);
    if existing {
        if !matches!(tree.nodes[&entity.id].class, Class::Entity(_)) {
            return Err(Error::BadParent);
        }
    } else if references.node_in_other(entity.id, active) {
        return Err(Error::BadParent);
    }

    let on_grid = entity.on_grid.unwrap_or(true);
    let align = entity.align.unwrap_or(Align { x: 0, y: 0 });
    if !(-1..=1).contains(&align.x) || !(-1..=1).contains(&align.y) {
        return Err(Error::BadAnchor);
    }
    if matches!(
        entity.kind,
        EntityKind::Vector { .. }
            | EntityKind::Flat { .. }
            | EntityKind::Box { .. }
            | EntityKind::Empty
    ) && (align.x != 0 || align.y != 0)
    {
        return Err(Error::BadAnchor);
    }
    if matches!(entity.kind, EntityKind::Vector { .. } | EntityKind::Empty)
        && entity.radius.is_some()
    {
        return Err(Error::BadRadius);
    }
    let edges = spx::parse_edges(entity.edges, on_grid, context.k)?;
    let size_x = edges[2] - edges[0] + 1;
    let size_y = edges[3] - edges[1] + 1;
    if let Some(radius) = entity.radius {
        crate::round::resolve(
            radius,
            Rect {
                x1: 0,
                y1: 0,
                x2: size_x - 1,
                y2: size_y - 1,
            },
            context.k,
        )?;
    }

    let parent = tree.parent_of(entity.id);
    let (parent_near_x, parent_near_y, parent_zero_x, parent_zero_y) = match parent {
        Some(parent) => match tree.nodes.get(&parent) {
            Some(node) => (node.near_x, node.near_y, node.zero_x, node.zero_y),
            None => return Err(Error::BadParent),
        },
        None => (0, 0, 0, 0),
    };
    let near_x = parent_zero_x + edges[0];
    let near_y = parent_zero_y + edges[1];
    let a_x = near_x - parent_near_x;
    let a_y = near_y - parent_near_y;
    check_a(a_x)?;
    check_a(a_y)?;
    let zero_x = zero_point(near_x, context.origin_x, context.step);
    let zero_y = zero_point(near_y, context.origin_y, context.step);

    let (data, mut entity_size_x, mut entity_size_y) = entity_data(entity.kind, store, scratch)?;
    if matches!(
        data,
        EntityData::Flat { .. } | EntityData::Box { .. } | EntityData::Empty
    ) {
        entity_size_x = size_x;
        entity_size_y = size_y;
    }
    if entity_size_x > size_x || entity_size_y > size_y {
        return Err(Error::BoxOverflow);
    }
    let blend = entity.blend.unwrap_or(Blend::SrcOver);

    if existing {
        let Some(node) = tree.nodes.get_mut(&entity.id) else {
            return Err(Error::BadParent);
        };
        node.class = Class::Entity(data);
        node.align = align;
        node.a_x = a_x;
        node.a_y = a_y;
        node.near_x = near_x;
        node.near_y = near_y;
        node.size_x = size_x;
        node.size_y = size_y;
        node.zero_x = zero_x;
        node.zero_y = zero_y;
        node.zero_offset_x = zero_x - near_x;
        node.zero_offset_y = zero_y - near_y;
        node.entity_size_x = entity_size_x;
        node.entity_size_y = entity_size_y;
        node.blend = blend;
        node.radius = entity.radius;
    } else {
        tree.nodes.insert(
            entity.id,
            Node {
                parent: None,
                class: Class::Entity(data),
                align,
                a_x,
                a_y,
                near_x,
                near_y,
                size_x,
                size_y,
                zero_x,
                zero_y,
                zero_offset_x: zero_x - near_x,
                zero_offset_y: zero_y - near_y,
                entity_size_x,
                entity_size_y,
                blend,
                radius: entity.radius,
                children: Vec::new(),
                live: LiveBox::default(),
            },
        );
        tree.roots.push(entity.id);
    }
    Ok(())
}

fn validate_children(
    tree: &Tree,
    id: NodeId,
    children: &[NodeId],
    allow_arbitrary: bool,
) -> Result<(), Error> {
    let mut seen = HashSet::new();
    for &child in children {
        if child == id || child.0 == 0 || !seen.insert(child) {
            return Err(Error::BadParent);
        }
        let Some(node) = tree.nodes.get(&child) else {
            return Err(Error::BadParent);
        };
        if !allow_arbitrary && node.is_arbitrary() {
            return Err(Error::BadParent);
        }
        if matches!(
            node.class,
            Class::Group { inset: Some(_), .. } | Class::Arbitrary { inset: Some(_), .. }
        ) {
            return Err(Error::BadInset);
        }
        if tree.contains(id) && tree.is_ancestor(child, id) {
            return Err(Error::BadParent);
        }
    }
    Ok(())
}

fn parse_inset(inset: Option<Inset>, k: u32) -> Result<Option<[i32; 4]>, Error> {
    match inset {
        Some(inset) => Ok(Some([
            spx::parse_inset_side(inset.left, k)?,
            spx::parse_inset_side(inset.top, k)?,
            spx::parse_inset_side(inset.right, k)?,
            spx::parse_inset_side(inset.bottom, k)?,
        ])),
        None => Ok(None),
    }
}

#[derive(Clone, Copy)]
struct BoxGeometry {
    near_x: i32,
    near_y: i32,
    size_x: i32,
    size_y: i32,
    zero_x: i32,
    zero_y: i32,
    a_x: i32,
    a_y: i32,
}

struct BoxRequest<'a> {
    id: NodeId,
    parent: NodeId,
    children: &'a [NodeId],
    pin: Pin,
    snap: bool,
    inset: Option<Inset>,
    allow_arbitrary: bool,
    on_grid: bool,
    geometry: Option<BoxGeometry>,
}

pub(crate) struct GroupOp<'a> {
    pub(crate) id: NodeId,
    pub(crate) parent: NodeId,
    pub(crate) children: &'a [NodeId],
    pub(crate) pin: Pin,
    pub(crate) snap: bool,
    pub(crate) inset: Option<Inset>,
}

pub(crate) struct ArbitraryOp<'a> {
    pub(crate) id: NodeId,
    pub(crate) parent: NodeId,
    pub(crate) on_grid: Option<bool>,
    pub(crate) edges: Edges,
    pub(crate) children: &'a [NodeId],
    pub(crate) pin: Pin,
    pub(crate) snap: bool,
    pub(crate) inset: Option<Inset>,
}

pub(crate) fn apply_group(
    tree: &mut Tree,
    op: &GroupOp<'_>,
    context: &Context,
    active: RefKey,
    references: &References,
) -> Result<(), Error> {
    let request = BoxRequest {
        id: op.id,
        parent: op.parent,
        children: op.children,
        pin: op.pin,
        snap: op.snap,
        inset: op.inset,
        allow_arbitrary: false,
        on_grid: true,
        geometry: None,
    };
    apply_box(tree, &request, context, active, references)
}

pub(crate) fn apply_arbitrary(
    tree: &mut Tree,
    op: &ArbitraryOp<'_>,
    context: &Context,
    active: RefKey,
    references: &References,
) -> Result<(), Error> {
    let on_grid = op.on_grid.unwrap_or(true);
    let parsed = spx::parse_edges(op.edges, on_grid, context.k)?;
    let current_parent = tree.parent_of(op.id);
    let (parent_near_x, parent_near_y, parent_zero_x, parent_zero_y) = match current_parent {
        Some(parent) => match tree.nodes.get(&parent) {
            Some(node) => (node.near_x, node.near_y, node.zero_x, node.zero_y),
            None => return Err(Error::BadParent),
        },
        None => (0, 0, 0, 0),
    };
    let near_x = parent_zero_x + parsed[0];
    let near_y = parent_zero_y + parsed[1];
    let a_x = near_x - parent_near_x;
    let a_y = near_y - parent_near_y;
    check_a(a_x)?;
    check_a(a_y)?;
    let zero_x = zero_point(near_x, context.origin_x, context.step);
    let zero_y = zero_point(near_y, context.origin_y, context.step);
    let geometry = BoxGeometry {
        near_x,
        near_y,
        size_x: parsed[2] - parsed[0] + 1,
        size_y: parsed[3] - parsed[1] + 1,
        zero_x,
        zero_y,
        a_x,
        a_y,
    };
    let request = BoxRequest {
        id: op.id,
        parent: op.parent,
        children: op.children,
        pin: op.pin,
        snap: op.snap,
        inset: op.inset,
        allow_arbitrary: true,
        on_grid,
        geometry: Some(geometry),
    };
    apply_box(tree, &request, context, active, references)
}

fn apply_box(
    tree: &mut Tree,
    request: &BoxRequest<'_>,
    context: &Context,
    active: RefKey,
    references: &References,
) -> Result<(), Error> {
    let id = request.id;
    if id.0 == 0 {
        return Err(Error::BadParent);
    }
    let existing = tree.contains(id);
    if existing {
        let matches_class = if request.allow_arbitrary {
            tree.nodes[&id].is_arbitrary()
        } else {
            tree.nodes[&id].is_group()
        };
        if !matches_class {
            return Err(Error::BadParent);
        }
    } else if references.node_in_other(id, active) {
        return Err(Error::BadParent);
    }

    let request_parent = if request.parent.0 == 0 {
        None
    } else {
        Some(request.parent)
    };
    let current_parent = tree.parent_of(id);
    if existing {
        if request_parent != current_parent {
            return Err(Error::BadParent);
        }
    } else if request_parent.is_some() {
        return Err(Error::BadParent);
    }

    lattice::check_pin(request.pin)?;
    // An arbitrary box owns explicit edges, so children are optional: a pinned
    // container may legitimately be a leaf. A group is a derived union and
    // still needs exactly two children.
    if !request.allow_arbitrary && request.children.len() != 2 {
        return Err(Error::BadGroup);
    }
    validate_children(tree, id, request.children, request.allow_arbitrary)?;
    if request.inset.is_some() && current_parent.is_some() {
        return Err(Error::BadInset);
    }
    let inset = parse_inset(request.inset, context.k)?;

    let box_near_x = match request.geometry {
        Some(geometry) => geometry.near_x,
        None => {
            if existing {
                tree.nodes[&id].near_x
            } else {
                0
            }
        }
    };
    let box_near_y = match request.geometry {
        Some(geometry) => geometry.near_y,
        None => {
            if existing {
                tree.nodes[&id].near_y
            } else {
                0
            }
        }
    };

    let mut absolutes = Vec::with_capacity(request.children.len());
    let mut was_child = Vec::with_capacity(request.children.len());
    for &child in request.children {
        absolutes.push(tree.absolute(child));
        was_child.push(tree.parent_of(child) == Some(id));
    }

    if existing {
        let old_children = tree.nodes[&id].children.clone();
        let requested: HashSet<NodeId> = request.children.iter().copied().collect();
        for old in old_children {
            if !requested.contains(&old) && tree.parent_of(old) == Some(id) {
                tree.remove_subtree(old);
            }
        }
    }

    for &child in request.children {
        tree.detach(child);
    }

    if existing {
        let Some(node) = tree.nodes.get_mut(&id) else {
            return Err(Error::BadParent);
        };
        if let Some(geometry) = request.geometry {
            node.near_x = geometry.near_x;
            node.near_y = geometry.near_y;
            node.size_x = geometry.size_x;
            node.size_y = geometry.size_y;
            node.zero_x = geometry.zero_x;
            node.zero_y = geometry.zero_y;
            node.zero_offset_x = geometry.zero_x - geometry.near_x;
            node.zero_offset_y = geometry.zero_y - geometry.near_y;
            node.a_x = geometry.a_x;
            node.a_y = geometry.a_y;
        }
        match &mut node.class {
            Class::Group {
                pin,
                snap,
                inset: node_inset,
            } if !request.allow_arbitrary => {
                *pin = request.pin;
                *snap = request.snap;
                *node_inset = inset;
            }
            Class::Arbitrary {
                pin,
                snap,
                inset: node_inset,
                on_grid,
            } if request.allow_arbitrary => {
                *pin = request.pin;
                *snap = request.snap;
                *node_inset = inset;
                *on_grid = request.on_grid;
            }
            _ => return Err(Error::BadParent),
        }
        node.children.clear();
    } else {
        let class = if request.allow_arbitrary {
            Class::Arbitrary {
                pin: request.pin,
                snap: request.snap,
                inset,
                on_grid: request.on_grid,
            }
        } else {
            Class::Group {
                pin: request.pin,
                snap: request.snap,
                inset,
            }
        };
        let geometry = request.geometry;
        tree.nodes.insert(
            id,
            Node {
                parent: None,
                class,
                align: Align { x: 0, y: 0 },
                a_x: geometry.map_or(0, |geometry| geometry.a_x),
                a_y: geometry.map_or(0, |geometry| geometry.a_y),
                near_x: geometry.map_or(0, |geometry| geometry.near_x),
                near_y: geometry.map_or(0, |geometry| geometry.near_y),
                size_x: geometry.map_or(0, |geometry| geometry.size_x),
                size_y: geometry.map_or(0, |geometry| geometry.size_y),
                zero_x: geometry.map_or(0, |geometry| geometry.zero_x),
                zero_y: geometry.map_or(0, |geometry| geometry.zero_y),
                zero_offset_x: geometry.map_or(0, |geometry| geometry.zero_x - geometry.near_x),
                zero_offset_y: geometry.map_or(0, |geometry| geometry.zero_y - geometry.near_y),
                entity_size_x: 0,
                entity_size_y: 0,
                blend: Blend::SrcOver,
                radius: None,
                children: Vec::new(),
                live: LiveBox::default(),
            },
        );
        tree.roots.push(id);
    }

    for (index, &child) in request.children.iter().enumerate() {
        let (absolute_x, absolute_y) = absolutes[index];
        let keep = request.allow_arbitrary && existing && was_child[index];
        tree.attach(id, child);
        if let Some(node) = tree.nodes.get_mut(&child) {
            if keep {
                continue;
            }
            node.a_x = absolute_x - box_near_x;
            node.a_y = absolute_y - box_near_y;
        }
    }
    Ok(())
}

pub(crate) fn apply_remove(tree: &mut Tree, id: NodeId) -> Result<(), Error> {
    if id.0 == 0 {
        return Err(Error::BadParent);
    }
    if !tree.contains(id) {
        return Err(Error::UnknownNode);
    }
    tree.remove_subtree(id);
    Ok(())
}

pub(crate) fn validate_tree(tree: &Tree) -> Result<(), Error> {
    let mut ids: Vec<NodeId> = tree.nodes.keys().copied().collect();
    ids.sort_by_key(|id| id.0);
    for id in ids {
        let Some(node) = tree.nodes.get(&id) else {
            continue;
        };
        check_a(node.a_x)?;
        check_a(node.a_y)?;
        match &node.class {
            Class::Group { .. } => {
                if node.children.len() != 2 {
                    return Err(Error::BadGroup);
                }
                for &child in &node.children {
                    let Some(child_node) = tree.nodes.get(&child) else {
                        return Err(Error::BadParent);
                    };
                    if child_node.is_arbitrary() {
                        return Err(Error::BadParent);
                    }
                }
            }
            Class::Arbitrary { .. } => {
                for &child in &node.children {
                    let Some(child_node) = tree.nodes.get(&child) else {
                        return Err(Error::BadParent);
                    };
                    if child_node.near_x < node.near_x
                        || child_node.near_y < node.near_y
                        || child_node.near_x.saturating_add(child_node.size_x)
                            > node.near_x.saturating_add(node.size_x)
                        || child_node.near_y.saturating_add(child_node.size_y)
                            > node.near_y.saturating_add(node.size_y)
                    {
                        return Err(Error::BoxOverflow);
                    }
                }
            }
            Class::Entity(_) => {
                if node.entity_size_x > node.size_x || node.entity_size_y > node.size_y {
                    return Err(Error::BoxOverflow);
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Engine;
    use crate::Peak;
    use crate::contract::{
        AlphaMode, Cap, Edge, Fill, FillRule, Join, Pixels, Request, Response, Snapshot,
        StrokeAlign,
    };

    fn grid_edge(primary: i32) -> Edge {
        Edge::Grid {
            primary,
            fine: None,
            spx: None,
        }
    }

    fn pixel_edges(x1: i32, y1: i32, x2: i32, y2: i32) -> Edges {
        Edges {
            x1: Edge::Pixel(x1),
            y1: Edge::Pixel(y1),
            x2: Edge::Pixel(x2),
            y2: Edge::Pixel(y2),
        }
    }

    fn flat(id: u32, x1: i32, y1: i32, x2: i32, y2: i32) -> Entity<'static> {
        Entity {
            id: NodeId(id),
            kind: EntityKind::Flat {
                color: Color {
                    r: 255,
                    g: 255,
                    b: 255,
                    a: 255,
                },
            },
            on_grid: Some(false),
            edges: pixel_edges(x1, y1, x2, y2),
            align: None,
            blend: None,
            radius: None,
        }
    }

    fn add_flat(
        engine: &mut Engine,
        id: u32,
        x1: i32,
        y1: i32,
        x2: i32,
        y2: i32,
    ) -> Result<(), Error> {
        engine
            .submit(Request::Entity(flat(id, x1, y1, x2, y2)))
            .map(|_| ())
    }

    fn group(engine: &mut Engine, id: u32, parent: u32, children: &[NodeId]) -> Result<(), Error> {
        group_with(engine, id, parent, children, None)
    }

    fn group_with(
        engine: &mut Engine,
        id: u32,
        parent: u32,
        children: &[NodeId],
        inset: Option<Inset>,
    ) -> Result<(), Error> {
        engine
            .submit(Request::Group {
                id: NodeId(id),
                parent: NodeId(parent),
                children,
                pin: Pin { x: -1, y: 1 },
                snap: false,
                inset,
            })
            .map(|_| ())
    }

    fn arbitrary(
        engine: &mut Engine,
        id: u32,
        parent: u32,
        on_grid: Option<bool>,
        edges: Edges,
        children: &[NodeId],
    ) -> Result<(), Error> {
        engine
            .submit(Request::Arbitrary {
                id: NodeId(id),
                parent: NodeId(parent),
                on_grid,
                edges,
                children,
                pin: Pin { x: -1, y: 1 },
                snap: false,
                inset: None,
            })
            .map(|_| ())
    }

    fn service(pin: Pin) -> Engine {
        let mut engine = Engine::new();
        engine
            .submit(Request::DefineReference {
                id: ReferenceId(7),
                canon_w: 100,
                canon_h: 100,
                k: 5,
                d: 1,
                pin,
                enter_cols: 0,
                enter_rows: 0,
            })
            .unwrap();
        engine
    }

    fn define(engine: &mut Engine, id: u32) {
        define_with(engine, id, 0, 0, 5).unwrap();
    }

    fn define_with(
        engine: &mut Engine,
        id: u32,
        enter_cols: u32,
        enter_rows: u32,
        k: u32,
    ) -> Result<(), Error> {
        engine
            .submit(Request::DefineReference {
                id: ReferenceId(id),
                canon_w: 100,
                canon_h: 100,
                k,
                d: 1,
                pin: Pin { x: -1, y: 1 },
                enter_cols,
                enter_rows,
            })
            .map(|_| ())
    }

    fn use_ref(engine: &mut Engine, id: u32) -> Result<(), Error> {
        engine
            .submit(Request::UseReference {
                id: ReferenceId(id),
            })
            .map(|_| ())
    }

    fn group_pinned(
        engine: &mut Engine,
        id: u32,
        parent: u32,
        children: &[NodeId],
        pin: Pin,
        snap: bool,
        inset: Option<Inset>,
    ) -> Result<(), Error> {
        engine
            .submit(Request::Group {
                id: NodeId(id),
                parent: NodeId(parent),
                children,
                pin,
                snap,
                inset,
            })
            .map(|_| ())
    }

    fn define_d(engine: &mut Engine, id: u32, d: u32) -> Result<(), Error> {
        engine
            .submit(Request::DefineReference {
                id: ReferenceId(id),
                canon_w: 100,
                canon_h: 100,
                k: 5,
                d,
                pin: Pin { x: -1, y: 1 },
                enter_cols: 0,
                enter_rows: 0,
            })
            .map(|_| ())
    }

    fn snapshot(engine: &mut Engine) -> Result<Snapshot, Error> {
        match engine.submit(Request::Snapshot)? {
            Response::Snapshot(list) => Ok(list),
            _ => panic!("expected snapshot"),
        }
    }

    fn show(engine: &mut Engine, id: u32, rect: Rect) -> Result<(), Error> {
        engine
            .submit(Request::Show {
                id: NodeId(id),
                rect,
            })
            .map(|_| ())
    }

    fn place(engine: &mut Engine, id: u32, rect: Rect) -> Result<(), Error> {
        engine
            .submit(Request::Place {
                id: NodeId(id),
                rect,
            })
            .map(|_| ())
    }

    fn read_pixels(engine: &mut Engine, rect: Rect) -> Pixels {
        match engine
            .submit(Request::ReadPixels {
                rect,
                alpha: AlphaMode::Straight,
            })
            .unwrap()
        {
            Response::Pixels(pixels) => pixels,
            _ => panic!("expected pixels"),
        }
    }

    fn pixel(engine: &mut Engine, x: i32, y: i32) -> [u8; 4] {
        let pixels = read_pixels(
            engine,
            Rect {
                x1: x,
                y1: y,
                x2: x,
                y2: y,
            },
        );
        [
            pixels.bytes[0],
            pixels.bytes[1],
            pixels.bytes[2],
            pixels.bytes[3],
        ]
    }

    fn upload_markers(
        engine: &mut Engine,
        id: u32,
        width: u32,
        height: u32,
        markers: &[(u32, u32)],
    ) -> Result<(), Error> {
        let mut bytes = vec![0_u8; (width * height * 4) as usize];
        for &(x, y) in markers {
            let at = ((y * width + x) * 4) as usize;
            bytes[at] = 255;
            bytes[at + 3] = 255;
        }
        engine
            .submit(Request::Upload {
                id: ImageId(id),
                width,
                height,
                stride: width * 4,
                format: PixelFormat::Rgba8,
                alpha: AlphaMode::Straight,
                bytes: &bytes,
            })
            .map(|_| ())
    }

    fn flat_color(id: u32, x1: i32, y1: i32, x2: i32, y2: i32, color: Color) -> Entity<'static> {
        Entity {
            id: NodeId(id),
            kind: EntityKind::Flat { color },
            on_grid: Some(false),
            edges: pixel_edges(x1, y1, x2, y2),
            align: None,
            blend: None,
            radius: None,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn arbitrary_pinned(
        engine: &mut Engine,
        id: u32,
        parent: u32,
        edges: Edges,
        children: &[NodeId],
        pin: Pin,
    ) -> Result<(), Error> {
        engine
            .submit(Request::Arbitrary {
                id: NodeId(id),
                parent: NodeId(parent),
                on_grid: Some(false),
                edges,
                children,
                pin,
                snap: false,
                inset: None,
            })
            .map(|_| ())
    }

    fn remove(engine: &mut Engine, id: u32) -> Result<(), Error> {
        engine
            .submit(Request::Remove { id: NodeId(id) })
            .map(|_| ())
    }

    fn upload(
        engine: &mut Engine,
        id: u32,
        width: u32,
        height: u32,
        format: PixelFormat,
        alpha: AlphaMode,
    ) -> Result<(), Error> {
        let bpp = match format {
            PixelFormat::Rgb8 => 3,
            PixelFormat::Rgba8 => 4,
            PixelFormat::Alpha8 => 1,
        };
        let bytes = vec![0_u8; (width * height * bpp) as usize];
        engine
            .submit(Request::Upload {
                id: ImageId(id),
                width,
                height,
                stride: width * bpp,
                format,
                alpha,
                bytes: &bytes,
            })
            .map(|_| ())
    }

    fn photo(id: u32, format: PixelFormat, image: u32, edges: Edges) -> Entity<'static> {
        Entity {
            id: NodeId(id),
            kind: EntityKind::Photo {
                format,
                image: ImageId(image),
                tint: None,
            },
            on_grid: Some(false),
            edges,
            align: None,
            blend: None,
            radius: None,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn add_photo(
        engine: &mut Engine,
        id: u32,
        format: PixelFormat,
        image: u32,
        x1: i32,
        y1: i32,
        x2: i32,
        y2: i32,
    ) -> Result<(), Error> {
        engine
            .submit(Request::Entity(photo(
                id,
                format,
                image,
                pixel_edges(x1, y1, x2, y2),
            )))
            .map(|_| ())
    }

    fn glyph(id: u32, image: u32, x1: i32, y1: i32, x2: i32, y2: i32) -> Entity<'static> {
        Entity {
            id: NodeId(id),
            kind: EntityKind::Glyph {
                format: PixelFormat::Alpha8,
                image: ImageId(image),
                tint: None,
            },
            on_grid: Some(false),
            edges: pixel_edges(x1, y1, x2, y2),
            align: None,
            blend: None,
            radius: None,
        }
    }

    fn tree(engine: &Engine) -> &Tree {
        engine.references.service_tree(ReferenceId(7)).unwrap()
    }

    #[test]
    fn builtin_tree_waits_for_first_begin() {
        let mut engine = Engine::new();
        assert_eq!(
            add_flat(&mut engine, 1, 0, 0, 9, 9).unwrap_err(),
            Error::NotBegun
        );
        engine
            .submit(Request::Begin {
                width: 100,
                height: 100,
            })
            .unwrap();
        add_flat(&mut engine, 1, 0, 0, 9, 9).unwrap();
        assert_eq!(
            engine.references.tree(RefKey::Builtin).nodes[&NodeId(1)].near_x,
            0
        );
    }

    #[test]
    fn service_reference_works_before_begin_and_zero_uses_canon() {
        let mut engine = service(Pin { x: 0, y: 0 });
        assert_eq!(engine.references.active_id(), Some(ReferenceId(7)));
        add_flat(&mut engine, 1, 10, 0, 19, 9).unwrap();
        assert_eq!(tree(&engine).nodes[&NodeId(1)].zero_x, 12);
        engine
            .submit(Request::Begin {
                width: 91,
                height: 91,
            })
            .unwrap();
        assert_eq!(tree(&engine).nodes[&NodeId(1)].zero_x, 12);
        assert_eq!(zero_point(10, -7, 15), 23);
    }

    #[test]
    fn group_arity_and_child_classes() {
        let mut engine = service(Pin { x: -1, y: 1 });
        add_flat(&mut engine, 1, 0, 0, 9, 9).unwrap();
        add_flat(&mut engine, 2, 10, 0, 19, 9).unwrap();
        add_flat(&mut engine, 3, 20, 0, 29, 9).unwrap();

        assert_eq!(
            group(&mut engine, 10, 0, &[NodeId(1)]).unwrap_err(),
            Error::BadGroup
        );
        assert_eq!(
            group(&mut engine, 10, 0, &[NodeId(1), NodeId(2), NodeId(3)]).unwrap_err(),
            Error::BadGroup
        );
        group(&mut engine, 10, 0, &[NodeId(1), NodeId(2)]).unwrap();
        let node = &tree(&engine).nodes[&NodeId(10)];
        assert_eq!(node.near_x, 0);
        assert_eq!(node.size_x, 20);

        arbitrary(
            &mut engine,
            20,
            0,
            Some(false),
            pixel_edges(0, 0, 29, 29),
            &[NodeId(3)],
        )
        .unwrap();
        assert_eq!(
            group(&mut engine, 11, 0, &[NodeId(1), NodeId(20)]).unwrap_err(),
            Error::BadParent
        );
        assert_eq!(
            group(&mut engine, 12, 1, &[NodeId(1), NodeId(2)]).unwrap_err(),
            Error::BadParent
        );
        assert_eq!(tree(&engine).nodes[&NodeId(10)].children.len(), 2);
    }

    #[test]
    fn arbitrary_children_are_optional_and_stay_inside_parent() {
        let mut engine = service(Pin { x: -1, y: 1 });
        add_flat(&mut engine, 1, 0, 0, 9, 9).unwrap();
        add_flat(&mut engine, 2, 5, 0, 9, 9).unwrap();
        add_flat(&mut engine, 3, 5, 0, 9, 9).unwrap();
        add_flat(&mut engine, 4, 20, 0, 29, 9).unwrap();

        // Explicit edges make children optional: a pinned container may be a
        // leaf.
        arbitrary(
            &mut engine,
            20,
            0,
            Some(false),
            pixel_edges(0, 0, 19, 19),
            &[],
        )
        .unwrap();
        arbitrary(
            &mut engine,
            10,
            0,
            Some(false),
            pixel_edges(0, 0, 19, 19),
            &[NodeId(1)],
        )
        .unwrap();
        arbitrary(
            &mut engine,
            11,
            0,
            Some(false),
            pixel_edges(5, 0, 9, 9),
            &[NodeId(2)],
        )
        .unwrap();
        arbitrary(
            &mut engine,
            10,
            0,
            Some(false),
            pixel_edges(0, 0, 19, 19),
            &[NodeId(1), NodeId(11)],
        )
        .unwrap();
        arbitrary(
            &mut engine,
            12,
            0,
            Some(false),
            pixel_edges(5, 0, 20, 19),
            &[NodeId(3)],
        )
        .unwrap();
        assert_eq!(
            arbitrary(
                &mut engine,
                10,
                0,
                Some(false),
                pixel_edges(0, 0, 19, 19),
                &[NodeId(1), NodeId(11), NodeId(12)]
            )
            .unwrap_err(),
            Error::BoxOverflow
        );
        assert_eq!(tree(&engine).nodes[&NodeId(10)].children.len(), 2);

        assert_eq!(
            arbitrary(
                &mut engine,
                21,
                0,
                Some(true),
                pixel_edges(0, 0, 9, 9),
                &[NodeId(2)]
            )
            .unwrap_err(),
            Error::OffGrid
        );
        arbitrary(
            &mut engine,
            22,
            0,
            Some(false),
            pixel_edges(20, 0, 29, 9),
            &[NodeId(4)],
        )
        .unwrap();
        assert_eq!(tree(&engine).nodes[&NodeId(22)].near_x, 20);
    }

    #[test]
    fn inset_is_only_for_window_children() {
        let mut engine = service(Pin { x: -1, y: 1 });
        add_flat(&mut engine, 1, 0, 0, 9, 9).unwrap();
        add_flat(&mut engine, 2, 10, 0, 19, 9).unwrap();
        add_flat(&mut engine, 3, 20, 0, 29, 9).unwrap();
        add_flat(&mut engine, 4, 30, 0, 39, 9).unwrap();
        let inset = Inset {
            left: Some(grid_edge(1)),
            top: None,
            right: None,
            bottom: None,
        };
        group_with(&mut engine, 10, 0, &[NodeId(1), NodeId(2)], Some(inset)).unwrap();
        group(&mut engine, 12, 0, &[NodeId(3), NodeId(4)]).unwrap();
        arbitrary(
            &mut engine,
            20,
            0,
            Some(false),
            pixel_edges(0, 0, 39, 39),
            &[NodeId(12)],
        )
        .unwrap();
        assert_eq!(
            group_with(&mut engine, 12, 20, &[NodeId(3), NodeId(4)], Some(inset)).unwrap_err(),
            Error::BadInset
        );
    }

    #[test]
    fn inset_box_cannot_become_a_child() {
        let mut engine = service(Pin { x: -1, y: 1 });
        add_flat(&mut engine, 1, 0, 0, 9, 9).unwrap();
        add_flat(&mut engine, 2, 10, 0, 19, 9).unwrap();
        let inset = Inset {
            left: Some(grid_edge(1)),
            top: None,
            right: None,
            bottom: None,
        };
        group_with(&mut engine, 10, 0, &[NodeId(1), NodeId(2)], Some(inset)).unwrap();
        assert_eq!(
            arbitrary(
                &mut engine,
                20,
                0,
                Some(false),
                pixel_edges(0, 0, 29, 29),
                &[NodeId(10)]
            )
            .unwrap_err(),
            Error::BadInset
        );
        assert_eq!(tree(&engine).nodes[&NodeId(10)].parent, None);
        assert!(!tree(&engine).nodes.contains_key(&NodeId(20)));
    }

    #[test]
    fn transfer_preserves_absolute_pixel() {
        let mut engine = service(Pin { x: -1, y: 1 });
        add_flat(&mut engine, 1, 12, 0, 16, 4).unwrap();
        add_flat(&mut engine, 2, 20, 0, 24, 4).unwrap();
        add_flat(&mut engine, 3, 30, 0, 34, 4).unwrap();
        group(&mut engine, 10, 0, &[NodeId(2), NodeId(3)]).unwrap();
        group(&mut engine, 10, 0, &[NodeId(1), NodeId(2)]).unwrap();
        let tree = tree(&engine);
        assert_eq!(tree.nodes[&NodeId(1)].near_x, 12);
        assert_eq!(tree.nodes[&NodeId(2)].near_x, 20);
        assert_eq!(tree.nodes[&NodeId(10)].near_x, 12);
        assert!(!tree.nodes.contains_key(&NodeId(3)));
    }

    #[test]
    fn repeated_entity_moves_the_group_union() {
        let mut engine = service(Pin { x: -1, y: 1 });
        add_flat(&mut engine, 1, 0, 0, 9, 9).unwrap();
        add_flat(&mut engine, 2, 10, 0, 19, 9).unwrap();
        group(&mut engine, 10, 0, &[NodeId(1), NodeId(2)]).unwrap();
        assert_eq!(tree(&engine).nodes[&NodeId(10)].near_x, 0);
        assert_eq!(tree(&engine).nodes[&NodeId(10)].size_x, 20);

        add_flat(&mut engine, 2, 30, 0, 39, 9).unwrap();
        let node = &tree(&engine).nodes[&NodeId(10)];
        assert_eq!(node.near_x, 0);
        assert_eq!(node.size_x, 40);
        assert_eq!(tree(&engine).nodes[&NodeId(1)].near_x, 0);
        assert_eq!(tree(&engine).nodes[&NodeId(2)].near_x, 30);
        assert_eq!(tree(&engine).nodes[&NodeId(2)].a_x, 30);
    }

    #[test]
    fn repeated_group_keeps_the_requested_child_order() {
        let mut engine = service(Pin { x: -1, y: 1 });
        add_flat(&mut engine, 1, 0, 0, 9, 9).unwrap();
        add_flat(&mut engine, 2, 10, 0, 19, 9).unwrap();
        group(&mut engine, 10, 0, &[NodeId(1), NodeId(2)]).unwrap();
        add_flat(&mut engine, 2, 10, 0, 19, 9).unwrap();
        assert_eq!(
            tree(&engine).nodes[&NodeId(10)].children,
            [NodeId(1), NodeId(2)]
        );
        group(&mut engine, 10, 0, &[NodeId(2), NodeId(1)]).unwrap();
        assert_eq!(
            tree(&engine).nodes[&NodeId(10)].children,
            [NodeId(2), NodeId(1)]
        );
        assert_eq!(tree(&engine).nodes[&NodeId(1)].near_x, 0);
        assert_eq!(tree(&engine).nodes[&NodeId(2)].near_x, 10);
    }

    #[test]
    fn derived_group_offset_above_limit_is_overflow() {
        let mut engine = service(Pin { x: -1, y: 1 });
        let max = MAX_COORD as i32;
        add_flat(&mut engine, 1, max - 10, 0, max, 9).unwrap();
        add_flat(&mut engine, 2, max - 20, 0, max - 10, 9).unwrap();
        group(&mut engine, 10, 0, &[NodeId(1), NodeId(2)]).unwrap();
        add_flat(&mut engine, 3, -max, 0, -max + 10, 9).unwrap();
        assert_eq!(
            group(&mut engine, 20, 0, &[NodeId(10), NodeId(3)]).unwrap_err(),
            Error::Overflow
        );
        assert!(!tree(&engine).nodes.contains_key(&NodeId(20)));
        assert_eq!(tree(&engine).nodes[&NodeId(10)].near_x, max - 20);
    }

    #[test]
    fn reversed_edges_are_bad_cell() {
        let mut engine = service(Pin { x: -1, y: 1 });
        assert_eq!(
            add_flat(&mut engine, 1, 9, 0, 0, 9).unwrap_err(),
            Error::BadCell
        );
    }

    #[test]
    fn remove_checks_parent_legality() {
        let mut engine = service(Pin { x: -1, y: 1 });
        add_flat(&mut engine, 1, 0, 0, 9, 9).unwrap();
        add_flat(&mut engine, 2, 10, 0, 19, 9).unwrap();
        add_flat(&mut engine, 3, 20, 0, 29, 9).unwrap();
        add_flat(&mut engine, 4, 40, 0, 49, 9).unwrap();
        arbitrary(
            &mut engine,
            20,
            0,
            Some(false),
            pixel_edges(0, 0, 19, 19),
            &[NodeId(1)],
        )
        .unwrap();
        // An arbitrary box may end up without children: it stays a leaf.
        remove(&mut engine, 1).unwrap();
        assert!(tree(&engine).nodes[&NodeId(20)].children.is_empty());
        group(&mut engine, 10, 0, &[NodeId(2), NodeId(3)]).unwrap();
        assert_eq!(remove(&mut engine, 2).unwrap_err(), Error::BadGroup);
        assert_eq!(remove(&mut engine, 0).unwrap_err(), Error::BadParent);
        assert_eq!(remove(&mut engine, 99).unwrap_err(), Error::UnknownNode);
        remove(&mut engine, 4).unwrap();
        assert!(!tree(&engine).nodes.contains_key(&NodeId(4)));
    }

    #[test]
    fn reference_reset_and_other_tree_ids() {
        let mut engine = service(Pin { x: -1, y: 1 });
        add_flat(&mut engine, 1, 0, 0, 9, 9).unwrap();
        define(&mut engine, 8);
        assert_eq!(engine.references.active_id(), Some(ReferenceId(7)));
        use_ref(&mut engine, 8).unwrap();
        add_flat(&mut engine, 2, 0, 0, 9, 9).unwrap();
        assert_eq!(remove(&mut engine, 1).unwrap_err(), Error::UnknownNode);
        assert_eq!(
            add_flat(&mut engine, 1, 0, 0, 9, 9).unwrap_err(),
            Error::BadParent
        );
        use_ref(&mut engine, 7).unwrap();
        define(&mut engine, 7);
        assert!(tree(&engine).nodes.is_empty());
        assert!(
            engine
                .references
                .service_tree(ReferenceId(8))
                .is_some_and(|tree| tree.nodes.contains_key(&NodeId(2)))
        );
        assert_eq!(engine.references.active_id(), Some(ReferenceId(7)));
        assert_eq!(remove(&mut engine, 1).unwrap_err(), Error::UnknownNode);
    }

    #[test]
    fn image_references_block_drop_and_upload() {
        let mut engine = service(Pin { x: -1, y: 1 });
        upload(
            &mut engine,
            1,
            10,
            10,
            PixelFormat::Rgb8,
            AlphaMode::Straight,
        )
        .unwrap();
        add_photo(&mut engine, 1, PixelFormat::Rgb8, 1, 0, 0, 9, 9).unwrap();
        assert_eq!(
            engine.submit(Request::Drop { id: ImageId(1) }).unwrap_err(),
            Error::UnknownImage
        );
        assert_eq!(
            upload(
                &mut engine,
                1,
                11,
                11,
                PixelFormat::Rgb8,
                AlphaMode::Straight
            )
            .unwrap_err(),
            Error::BoxOverflow
        );
        assert_eq!(engine.store.get(ImageId(1)).unwrap().width, 10);
        assert_eq!(
            upload(
                &mut engine,
                1,
                10,
                10,
                PixelFormat::Rgba8,
                AlphaMode::Straight
            )
            .unwrap_err(),
            Error::BufferLayout
        );
        assert_eq!(
            engine.store.get(ImageId(1)).unwrap().format,
            PixelFormat::Rgb8
        );
        remove(&mut engine, 1).unwrap();
        engine.submit(Request::Drop { id: ImageId(1) }).unwrap();

        assert_eq!(
            add_photo(&mut engine, 2, PixelFormat::Rgb8, 0, 0, 0, 9, 9).unwrap_err(),
            Error::UnknownImage
        );
        upload(
            &mut engine,
            2,
            11,
            11,
            PixelFormat::Rgb8,
            AlphaMode::Straight,
        )
        .unwrap();
        assert_eq!(
            add_photo(&mut engine, 2, PixelFormat::Rgb8, 2, 0, 0, 9, 9).unwrap_err(),
            Error::BoxOverflow
        );
        upload(
            &mut engine,
            3,
            10,
            10,
            PixelFormat::Alpha8,
            AlphaMode::Straight,
        )
        .unwrap();
        engine
            .submit(Request::Entity(glyph(3, 3, 0, 0, 9, 9)))
            .unwrap();
        upload(
            &mut engine,
            4,
            10,
            10,
            PixelFormat::Rgba8,
            AlphaMode::Straight,
        )
        .unwrap();
        assert_eq!(
            engine
                .submit(Request::Entity(glyph(5, 4, 0, 0, 9, 9)))
                .unwrap_err(),
            Error::BufferLayout
        );
    }

    #[test]
    fn reference_transitions_are_limited_inside_a_frame() {
        let mut engine = Engine::new();
        define(&mut engine, 7);
        define(&mut engine, 8);
        assert_eq!(engine.references.active_id(), Some(ReferenceId(7)));
        assert_eq!(
            use_ref(&mut engine, 99).unwrap_err(),
            Error::ReferenceMissing
        );
        use_ref(&mut engine, 8).unwrap();
        assert_eq!(engine.references.active_id(), Some(ReferenceId(8)));
        use_ref(&mut engine, 7).unwrap();
        assert_eq!(engine.references.active_id(), Some(ReferenceId(7)));

        engine
            .submit(Request::Begin {
                width: 100,
                height: 100,
            })
            .unwrap();
        use_ref(&mut engine, 8).unwrap();
        assert_eq!(use_ref(&mut engine, 7).unwrap_err(), Error::ReferenceBusy);
        use_ref(&mut engine, 8).unwrap();
        assert_eq!(use_ref(&mut engine, 0).unwrap_err(), Error::ReferenceBusy);

        engine
            .submit(Request::Begin {
                width: 100,
                height: 100,
            })
            .unwrap();
        use_ref(&mut engine, 0).unwrap();
        assert_eq!(engine.references.active_id(), Some(ReferenceId(8)));
        use_ref(&mut engine, 7).unwrap();
        assert_eq!(engine.references.active_id(), Some(ReferenceId(7)));

        engine
            .submit(Request::Begin {
                width: 100,
                height: 100,
            })
            .unwrap();
        assert_eq!(
            use_ref(&mut engine, 99).unwrap_err(),
            Error::ReferenceMissing
        );
        use_ref(&mut engine, 8).unwrap();
        assert_eq!(engine.references.active_id(), Some(ReferenceId(8)));
    }

    #[test]
    fn reference_change_clears_shows() {
        let mut engine = Engine::new();
        define(&mut engine, 7);
        define(&mut engine, 8);
        engine
            .submit(Request::Begin {
                width: 100,
                height: 100,
            })
            .unwrap();
        add_flat(&mut engine, 1, 0, 0, 9, 9).unwrap();
        show(
            &mut engine,
            1,
            Rect {
                x1: 20,
                y1: 0,
                x2: 29,
                y2: 9,
            },
        )
        .unwrap();
        assert!(!engine.references.shows.is_empty());
        use_ref(&mut engine, 8).unwrap();
        assert!(
            engine.references.shows.is_empty(),
            "reference switch drops every Show"
        );
    }

    #[test]
    fn entity_kind_errors() {
        let mut engine = service(Pin { x: -1, y: 1 });
        let verbs = [
            Verb::Move(0, 0),
            Verb::Line(10, 0),
            Verb::Line(10, 10),
            Verb::Close,
        ];
        let stroke = Stroke {
            width_q8: 256,
            align: StrokeAlign::Outside,
            join: Join::Bevel,
            cap: Cap::Butt,
            peak: Peak::Light,
        };
        let vector_entity = |id: u32, fill: Option<Fill>, stroke: Option<Stroke>| Entity {
            id: NodeId(id),
            kind: EntityKind::Vector {
                verbs: &verbs,
                fill,
                stroke,
                color: Color {
                    r: 255,
                    g: 255,
                    b: 255,
                    a: 255,
                },
            },
            on_grid: Some(false),
            edges: pixel_edges(0, 0, 9, 9),
            align: None,
            blend: None,
            radius: None,
        };
        assert_eq!(
            engine
                .submit(Request::Entity(vector_entity(
                    1,
                    Some(Fill {
                        rule: FillRule::NonZero,
                    }),
                    Some(stroke),
                )))
                .unwrap_err(),
            Error::BadPath
        );
        assert_eq!(
            engine
                .submit(Request::Entity(vector_entity(1, None, None)))
                .unwrap_err(),
            Error::BadPath
        );
        let mut aligned = flat(1, 0, 0, 9, 9);
        aligned.align = Some(Align { x: 1, y: 0 });
        assert_eq!(
            engine.submit(Request::Entity(aligned)).unwrap_err(),
            Error::BadAnchor
        );
        let mut vector_aligned = vector_entity(
            1,
            Some(Fill {
                rule: FillRule::NonZero,
            }),
            None,
        );
        vector_aligned.align = Some(Align { x: 1, y: 0 });
        assert_eq!(
            engine.submit(Request::Entity(vector_aligned)).unwrap_err(),
            Error::BadAnchor
        );
        assert_eq!(
            engine
                .submit(Request::Entity(photo(
                    1,
                    PixelFormat::Rgb8,
                    0,
                    pixel_edges(0, 0, 9, 9)
                )))
                .unwrap_err(),
            Error::UnknownImage
        );
        let mut off_grid = flat(1, 0, 0, 9, 9);
        off_grid.on_grid = Some(true);
        assert_eq!(
            engine.submit(Request::Entity(off_grid)).unwrap_err(),
            Error::OffGrid
        );
    }

    #[test]
    fn negative_window_edge_is_local_minus_three() {
        let mut engine = service(Pin { x: -1, y: 1 });
        let mut entity = flat(1, 0, 0, 0, 0);
        entity.edges = pixel_edges(-3, 0, 6, 9);
        engine.submit(Request::Entity(entity)).unwrap();
        let node = &tree(&engine).nodes[&NodeId(1)];
        assert_eq!(node.near_x, -3);
        assert_eq!(node.a_x, -3);
    }

    #[test]
    fn reference_thresholds_choose_the_larger_pair() {
        let mut engine = Engine::new();
        define_with(&mut engine, 7, 0, 0, 5).unwrap();
        define_with(&mut engine, 8, 2, 0, 5).unwrap();
        define_with(&mut engine, 9, 2, 0, 5).unwrap();
        engine
            .submit(Request::Begin {
                width: 100,
                height: 100,
            })
            .unwrap();
        assert_eq!(engine.references.active_id(), Some(ReferenceId(8)));
        use_ref(&mut engine, 9).unwrap();
        engine
            .submit(Request::Begin {
                width: 100,
                height: 100,
            })
            .unwrap();
        assert_eq!(engine.references.active_id(), Some(ReferenceId(9)));
        use_ref(&mut engine, 0).unwrap();
        engine
            .submit(Request::Begin {
                width: 10,
                height: 100,
            })
            .unwrap();
        assert_eq!(engine.references.active_id(), Some(ReferenceId(7)));
    }

    #[test]
    fn no_fitting_reference_keeps_the_current_one() {
        let mut engine = Engine::new();
        define_with(&mut engine, 7, 2, 0, 5).unwrap();
        engine
            .submit(Request::Begin {
                width: 10,
                height: 10,
            })
            .unwrap();
        assert_eq!(engine.references.active_id(), Some(ReferenceId(7)));
    }

    #[test]
    fn threshold_counts_use_each_reference_scale() {
        let mut engine = Engine::new();
        define_with(&mut engine, 7, 0, 0, 5).unwrap();
        define_with(&mut engine, 8, 5, 0, 1).unwrap();
        engine
            .submit(Request::Begin {
                width: 16,
                height: 16,
            })
            .unwrap();
        assert_eq!(engine.references.active_id(), Some(ReferenceId(8)));
    }

    #[test]
    fn define_in_begun_does_not_spend_the_transition() {
        let mut engine = Engine::new();
        define(&mut engine, 7);
        define(&mut engine, 8);
        engine
            .submit(Request::Begin {
                width: 100,
                height: 100,
            })
            .unwrap();
        define(&mut engine, 9);
        use_ref(&mut engine, 8).unwrap();
        assert_eq!(engine.references.active_id(), Some(ReferenceId(8)));
        assert_eq!(use_ref(&mut engine, 7).unwrap_err(), Error::ReferenceBusy);
    }

    #[test]
    fn reference_validation_codes() {
        let mut engine = Engine::new();
        let define = |engine: &mut Engine, id: u32, canon_w: u32, k: u32, d: u32, pin: Pin| {
            engine
                .submit(Request::DefineReference {
                    id: ReferenceId(id),
                    canon_w,
                    canon_h: 100,
                    k,
                    d,
                    pin,
                    enter_cols: 0,
                    enter_rows: 0,
                })
                .map(|_| ())
        };
        assert_eq!(
            define(&mut engine, 0, 100, 5, 1, Pin { x: -1, y: 1 }).unwrap_err(),
            Error::ReferenceMissing
        );
        assert_eq!(
            define(&mut engine, 7, 0, 5, 1, Pin { x: -1, y: 1 }).unwrap_err(),
            Error::SurfaceOutOfRange
        );
        assert_eq!(
            define(&mut engine, 7, 100, 41, 1, Pin { x: -1, y: 1 }).unwrap_err(),
            Error::ScaleOutOfRange
        );
        assert_eq!(
            define(&mut engine, 7, 100, 5, 0, Pin { x: -1, y: 1 }).unwrap_err(),
            Error::ScaleOutOfRange
        );
        assert_eq!(
            define(&mut engine, 7, 100, 5, 1, Pin { x: 2, y: 0 }).unwrap_err(),
            Error::BadAnchor
        );
    }

    #[test]
    fn entity_class_duplicates_and_cycles() {
        let mut engine = service(Pin { x: -1, y: 1 });
        add_flat(&mut engine, 1, 0, 0, 9, 9).unwrap();
        add_flat(&mut engine, 2, 10, 0, 19, 9).unwrap();
        add_flat(&mut engine, 3, 20, 0, 29, 9).unwrap();
        assert_eq!(
            group(&mut engine, 1, 0, &[NodeId(2), NodeId(3)]).unwrap_err(),
            Error::BadParent
        );
        assert_eq!(
            arbitrary(
                &mut engine,
                10,
                0,
                Some(false),
                pixel_edges(0, 0, 29, 29),
                &[NodeId(1), NodeId(1)]
            )
            .unwrap_err(),
            Error::BadParent
        );
        assert_eq!(
            arbitrary(
                &mut engine,
                10,
                0,
                Some(false),
                pixel_edges(0, 0, 29, 29),
                &[NodeId(1), NodeId(99)]
            )
            .unwrap_err(),
            Error::BadParent
        );
        group(&mut engine, 12, 0, &[NodeId(1), NodeId(2)]).unwrap();
        group(&mut engine, 13, 0, &[NodeId(12), NodeId(3)]).unwrap();
        assert_eq!(
            group(&mut engine, 12, 13, &[NodeId(1), NodeId(13)]).unwrap_err(),
            Error::BadParent
        );
    }

    #[test]
    fn photo_format_and_vector_width_codes() {
        let mut engine = service(Pin { x: -1, y: 1 });
        upload(
            &mut engine,
            1,
            10,
            10,
            PixelFormat::Rgb8,
            AlphaMode::Straight,
        )
        .unwrap();
        assert_eq!(
            add_photo(&mut engine, 1, PixelFormat::Rgba8, 1, 0, 0, 9, 9).unwrap_err(),
            Error::BufferLayout
        );
        upload(
            &mut engine,
            2,
            10,
            10,
            PixelFormat::Alpha8,
            AlphaMode::Straight,
        )
        .unwrap();
        assert_eq!(
            add_photo(&mut engine, 1, PixelFormat::Alpha8, 2, 0, 0, 9, 9).unwrap_err(),
            Error::BufferLayout
        );
        let bad_glyph = Entity {
            id: NodeId(1),
            kind: EntityKind::Glyph {
                format: PixelFormat::Rgb8,
                image: ImageId(1),
                tint: None,
            },
            on_grid: Some(false),
            edges: pixel_edges(0, 0, 9, 9),
            align: None,
            blend: None,
            radius: None,
        };
        assert_eq!(
            engine.submit(Request::Entity(bad_glyph)).unwrap_err(),
            Error::BufferLayout
        );
        let verbs = [Verb::Move(0, 0), Verb::Line(10, 0)];
        let zero_width = Entity {
            id: NodeId(1),
            kind: EntityKind::Vector {
                verbs: &verbs,
                fill: None,
                stroke: Some(Stroke {
                    width_q8: 0,
                    align: StrokeAlign::Outside,
                    join: Join::Bevel,
                    cap: Cap::Butt,
                    peak: Peak::Light,
                }),
                color: Color {
                    r: 255,
                    g: 255,
                    b: 255,
                    a: 255,
                },
            },
            on_grid: Some(false),
            edges: pixel_edges(0, 0, 9, 9),
            align: None,
            blend: None,
            radius: None,
        };
        assert_eq!(
            engine.submit(Request::Entity(zero_width)).unwrap_err(),
            Error::BadStroke
        );
    }

    #[test]
    fn upload_updates_entity_size_and_reset_drops_refs() {
        let mut engine = service(Pin { x: -1, y: 1 });
        upload(
            &mut engine,
            1,
            10,
            10,
            PixelFormat::Rgb8,
            AlphaMode::Straight,
        )
        .unwrap();
        add_photo(&mut engine, 1, PixelFormat::Rgb8, 1, 0, 0, 19, 19).unwrap();
        assert_eq!(tree(&engine).nodes[&NodeId(1)].entity_size_x, 10);
        upload(
            &mut engine,
            1,
            15,
            15,
            PixelFormat::Rgb8,
            AlphaMode::Straight,
        )
        .unwrap();
        assert_eq!(tree(&engine).nodes[&NodeId(1)].entity_size_x, 15);
        assert_eq!(
            upload(
                &mut engine,
                1,
                21,
                21,
                PixelFormat::Rgb8,
                AlphaMode::Straight
            )
            .unwrap_err(),
            Error::BoxOverflow
        );
        assert_eq!(tree(&engine).nodes[&NodeId(1)].entity_size_x, 15);
        define(&mut engine, 7);
        assert!(tree(&engine).nodes.is_empty());
        engine.submit(Request::Drop { id: ImageId(1) }).unwrap();
    }

    #[test]
    fn entity_align_is_stored_for_photos() {
        let mut engine = service(Pin { x: -1, y: 1 });
        upload(
            &mut engine,
            1,
            10,
            10,
            PixelFormat::Rgb8,
            AlphaMode::Straight,
        )
        .unwrap();
        let mut entity = photo(1, PixelFormat::Rgb8, 1, pixel_edges(0, 0, 19, 19));
        entity.align = Some(Align { x: 1, y: 0 });
        engine.submit(Request::Entity(entity)).unwrap();
        assert_eq!(tree(&engine).nodes[&NodeId(1)].align, Align { x: 1, y: 0 });
    }

    #[test]
    fn snapshot_before_begin_is_not_begun() {
        let mut engine = Engine::new();
        assert_eq!(snapshot(&mut engine).unwrap_err(), Error::NotBegun);
        let mut engine = service(Pin { x: -1, y: 1 });
        assert_eq!(snapshot(&mut engine).unwrap_err(), Error::NotBegun);
        engine
            .submit(Request::Begin {
                width: 100,
                height: 100,
            })
            .unwrap();
        let first = snapshot(&mut engine).unwrap();
        engine.submit(Request::End).unwrap();
        assert_eq!(snapshot(&mut engine).unwrap(), first);
    }

    #[test]
    fn snapshot_orders_nodes_and_keeps_empty_rects() {
        let mut engine = service(Pin { x: -1, y: 1 });
        add_flat(&mut engine, 1, 0, 0, 9, 9).unwrap();
        add_flat(&mut engine, 2, 10, 0, 19, 9).unwrap();
        group(&mut engine, 10, 0, &[NodeId(1), NodeId(2)]).unwrap();
        add_flat(&mut engine, 3, 10, 0, 19, 9).unwrap();
        arbitrary(
            &mut engine,
            20,
            0,
            Some(false),
            pixel_edges(0, 0, 29, 29),
            &[NodeId(3)],
        )
        .unwrap();
        add_flat(&mut engine, 4, -20, 0, -11, 9).unwrap();
        add_flat(&mut engine, 5, -10, 0, -1, 9).unwrap();
        group(&mut engine, 11, 0, &[NodeId(4), NodeId(5)]).unwrap();
        engine
            .submit(Request::Begin {
                width: 100,
                height: 100,
            })
            .unwrap();
        let list = snapshot(&mut engine).unwrap();
        let ids: Vec<u32> = list.nodes.iter().map(|node| node.id.0).collect();
        assert_eq!(ids, [10, 1, 2, 20, 3, 11, 4, 5]);
        assert_eq!(list.nodes[0].parent, NodeId(0));
        assert_eq!(list.nodes[1].parent, NodeId(10));
        assert_eq!(list.nodes[3].parent, NodeId(0));
        assert_eq!(list.nodes[4].parent, NodeId(20));
        assert_eq!(
            list.nodes[0].rect,
            Rect {
                x1: 0,
                y1: 0,
                x2: 19,
                y2: 9
            }
        );
        assert_eq!(
            list.nodes[3].rect,
            Rect {
                x1: 0,
                y1: 0,
                x2: 29,
                y2: 29
            }
        );
        assert!(list.nodes[5].rect.is_empty());
        assert!(list.nodes[6].rect.is_empty());
    }

    #[test]
    fn snapshot_generation_waits_for_new_inputs() {
        let mut engine = service(Pin { x: -1, y: 1 });
        add_flat(&mut engine, 1, 0, 0, 9, 9).unwrap();
        engine
            .submit(Request::Begin {
                width: 100,
                height: 100,
            })
            .unwrap();
        let first = snapshot(&mut engine).unwrap().generation;
        assert_eq!(snapshot(&mut engine).unwrap().generation, first);
        engine
            .submit(Request::Begin {
                width: 100,
                height: 100,
            })
            .unwrap();
        assert_eq!(snapshot(&mut engine).unwrap().generation, first);
        engine
            .submit(Request::Begin {
                width: 120,
                height: 100,
            })
            .unwrap();
        let second = snapshot(&mut engine).unwrap().generation;
        assert!(second > first);
        assert_eq!(snapshot(&mut engine).unwrap().generation, second);
    }

    #[test]
    fn generation_belongs_to_the_list() {
        let mut engine = Engine::new();
        define(&mut engine, 7);
        define(&mut engine, 8);
        engine
            .submit(Request::Begin {
                width: 100,
                height: 100,
            })
            .unwrap();
        add_flat(&mut engine, 1, 0, 0, 9, 9).unwrap();
        let reference_a = snapshot(&mut engine).unwrap().generation;

        use_ref(&mut engine, 8).unwrap();
        add_flat(&mut engine, 2, 0, 0, 9, 9).unwrap();
        snapshot(&mut engine).unwrap();

        engine
            .submit(Request::Begin {
                width: 100,
                height: 100,
            })
            .unwrap();
        use_ref(&mut engine, 7).unwrap();
        assert_eq!(snapshot(&mut engine).unwrap().generation, reference_a);
    }

    #[test]
    fn reference_thresholds_follow_the_live_window() {
        let mut engine = Engine::new();
        define_with(&mut engine, 7, 0, 0, 5).unwrap();
        define_with(&mut engine, 8, 40, 0, 5).unwrap();
        engine
            .submit(Request::Begin {
                width: 600,
                height: 100,
            })
            .unwrap();
        assert_eq!(engine.references.active_id(), Some(ReferenceId(8)));
        engine
            .submit(Request::Begin {
                width: 585,
                height: 100,
            })
            .unwrap();
        assert_eq!(engine.references.active_id(), Some(ReferenceId(7)));
    }

    #[test]
    fn reference_ties_keep_the_current_or_pick_the_smallest() {
        let mut engine = Engine::new();
        define_with(&mut engine, 7, 40, 0, 5).unwrap();
        define_with(&mut engine, 8, 40, 0, 5).unwrap();
        engine
            .submit(Request::Begin {
                width: 600,
                height: 100,
            })
            .unwrap();
        assert_eq!(engine.references.active_id(), Some(ReferenceId(7)));

        let mut engine = Engine::new();
        define_with(&mut engine, 7, 40, 0, 5).unwrap();
        define_with(&mut engine, 2, 40, 0, 5).unwrap();
        define_with(&mut engine, 9, 0, 0, 5).unwrap();
        use_ref(&mut engine, 9).unwrap();
        use_ref(&mut engine, 0).unwrap();
        engine
            .submit(Request::Begin {
                width: 600,
                height: 100,
            })
            .unwrap();
        assert_eq!(engine.references.active_id(), Some(ReferenceId(2)));
    }

    #[test]
    fn reference_rows_break_equal_columns() {
        let mut engine = Engine::new();
        define_with(&mut engine, 7, 40, 10, 5).unwrap();
        define_with(&mut engine, 8, 40, 20, 5).unwrap();
        engine
            .submit(Request::Begin {
                width: 600,
                height: 300,
            })
            .unwrap();
        assert_eq!(engine.references.active_id(), Some(ReferenceId(8)));
    }

    #[test]
    fn pixel_ratio_does_not_change_the_layout() {
        let mut one = Engine::new();
        define_d(&mut one, 7, 1).unwrap();
        add_flat(&mut one, 1, 0, 0, 9, 9).unwrap();
        one.submit(Request::Begin {
            width: 91,
            height: 91,
        })
        .unwrap();

        let mut two = Engine::new();
        define_d(&mut two, 7, 2).unwrap();
        add_flat(&mut two, 1, 0, 0, 9, 9).unwrap();
        two.submit(Request::Begin {
            width: 91,
            height: 91,
        })
        .unwrap();

        assert_eq!(snapshot(&mut one).unwrap(), snapshot(&mut two).unwrap());
    }

    #[test]
    fn live_pin_moves_children_with_the_group() {
        let mut engine = service(Pin { x: -1, y: 1 });
        add_flat(&mut engine, 1, 0, 0, 9, 9).unwrap();
        add_flat(&mut engine, 2, 90, 0, 99, 9).unwrap();
        group_pinned(
            &mut engine,
            10,
            0,
            &[NodeId(1), NodeId(2)],
            Pin { x: 1, y: 1 },
            false,
            None,
        )
        .unwrap();
        engine
            .submit(Request::Begin {
                width: 200,
                height: 100,
            })
            .unwrap();
        let list = snapshot(&mut engine).unwrap();
        assert_eq!(
            list.nodes[0].rect,
            Rect {
                x1: 100,
                y1: 0,
                x2: 199,
                y2: 9
            }
        );
        assert_eq!(
            list.nodes[1].rect,
            Rect {
                x1: 100,
                y1: 0,
                x2: 109,
                y2: 9
            }
        );
        assert_eq!(
            list.nodes[2].rect,
            Rect {
                x1: 190,
                y1: 0,
                x2: 199,
                y2: 9
            }
        );
    }

    #[test]
    fn zero_stays_on_the_canonical_origin() {
        let mut engine = service(Pin { x: 1, y: 1 });
        add_flat(&mut engine, 1, 10, 0, 19, 9).unwrap();
        assert_eq!(tree(&engine).nodes[&NodeId(1)].zero_x, 10);

        let mut engine = Engine::new();
        engine
            .submit(Request::Begin {
                width: 100,
                height: 100,
            })
            .unwrap();
        add_flat(&mut engine, 1, 10, 0, 19, 9).unwrap();
        let node = &engine.references.tree(RefKey::Builtin).nodes[&NodeId(1)];
        assert_eq!(node.zero_x, 15);
        assert_eq!(node.zero_offset_x, 5);
        assert_eq!(zero_point(10, 0, 15), 15);
    }

    #[test]
    fn show_photo_is_one_to_one_and_clipped() {
        let mut engine = service(Pin { x: -1, y: 1 });
        upload_markers(&mut engine, 1, 10, 10, &[(0, 0), (1, 1), (7, 7)]).unwrap();
        engine
            .submit(Request::Entity(photo(
                1,
                PixelFormat::Rgba8,
                1,
                pixel_edges(0, 0, 9, 9),
            )))
            .unwrap();
        engine
            .submit(Request::Begin {
                width: 100,
                height: 100,
            })
            .unwrap();
        show(
            &mut engine,
            1,
            Rect {
                x1: 3,
                y1: 3,
                x2: 10,
                y2: 10,
            },
        )
        .unwrap();
        engine.submit(Request::End).unwrap();
        assert_eq!(pixel(&mut engine, 2, 2), [0, 0, 0, 0]);
        assert_eq!(pixel(&mut engine, 3, 3), [255, 0, 0, 255]);
        assert_eq!(pixel(&mut engine, 9, 9), [255, 0, 0, 255]);
        assert_eq!(pixel(&mut engine, 10, 10), [0, 0, 0, 0]);

        engine
            .submit(Request::Begin {
                width: 100,
                height: 100,
            })
            .unwrap();
        show(
            &mut engine,
            1,
            Rect {
                x1: 0,
                y1: 0,
                x2: 11,
                y2: 11,
            },
        )
        .unwrap();
        engine.submit(Request::End).unwrap();
        assert_eq!(pixel(&mut engine, 0, 0), [0, 0, 0, 0]);
        assert_eq!(pixel(&mut engine, 1, 1), [255, 0, 0, 255]);
        assert_eq!(pixel(&mut engine, 8, 8), [255, 0, 0, 255]);
        assert_eq!(pixel(&mut engine, 11, 11), [0, 0, 0, 0]);
    }

    #[test]
    fn show_nested_arbitrary_shifts_children() {
        let mut engine = service(Pin { x: -1, y: 1 });
        add_flat(&mut engine, 1, 5, 5, 9, 9).unwrap();
        arbitrary(
            &mut engine,
            20,
            0,
            Some(false),
            pixel_edges(5, 5, 9, 9),
            &[NodeId(1)],
        )
        .unwrap();
        arbitrary(
            &mut engine,
            10,
            0,
            Some(false),
            pixel_edges(0, 0, 19, 19),
            &[NodeId(20)],
        )
        .unwrap();
        engine
            .submit(Request::Begin {
                width: 100,
                height: 100,
            })
            .unwrap();
        let before = snapshot(&mut engine).unwrap();
        assert_eq!(
            before.nodes[1].rect,
            Rect {
                x1: 5,
                y1: 5,
                x2: 9,
                y2: 9
            }
        );
        show(
            &mut engine,
            20,
            Rect {
                x1: 8,
                y1: 8,
                x2: 12,
                y2: 12,
            },
        )
        .unwrap();
        let after = snapshot(&mut engine).unwrap();
        assert_eq!(
            after.nodes[1].rect,
            Rect {
                x1: 8,
                y1: 8,
                x2: 12,
                y2: 12
            }
        );
        assert_eq!(
            after.nodes[2].rect,
            Rect {
                x1: 8,
                y1: 8,
                x2: 12,
                y2: 12
            }
        );
    }

    #[test]
    fn begin_with_a_new_size_clears_shows() {
        let mut engine = service(Pin { x: -1, y: 1 });
        add_flat(&mut engine, 1, 0, 0, 9, 9).unwrap();
        engine
            .submit(Request::Begin {
                width: 100,
                height: 100,
            })
            .unwrap();
        show(
            &mut engine,
            1,
            Rect {
                x1: 40,
                y1: 0,
                x2: 49,
                y2: 9,
            },
        )
        .unwrap();
        assert_eq!(snapshot(&mut engine).unwrap().nodes[0].rect.x1, 40);
        engine
            .submit(Request::Begin {
                width: 120,
                height: 100,
            })
            .unwrap();
        assert_eq!(snapshot(&mut engine).unwrap().nodes[0].rect.x1, 0);
    }

    #[test]
    fn frame_without_show_drops_it() {
        let mut engine = service(Pin { x: -1, y: 1 });
        add_flat(&mut engine, 1, 0, 0, 9, 9).unwrap();
        engine
            .submit(Request::Begin {
                width: 100,
                height: 100,
            })
            .unwrap();
        show(
            &mut engine,
            1,
            Rect {
                x1: 40,
                y1: 0,
                x2: 49,
                y2: 9,
            },
        )
        .unwrap();
        engine.submit(Request::End).unwrap();
        assert_eq!(pixel(&mut engine, 40, 0), [255, 255, 255, 255]);

        engine
            .submit(Request::Begin {
                width: 100,
                height: 100,
            })
            .unwrap();
        assert_eq!(snapshot(&mut engine).unwrap().nodes[0].rect.x1, 0);
        engine.submit(Request::End).unwrap();
        assert_eq!(pixel(&mut engine, 40, 0), [0, 0, 0, 0]);
        assert_eq!(pixel(&mut engine, 0, 0), [255, 255, 255, 255]);
    }

    #[test]
    fn place_entity_sets_a_size_and_keeps_align() {
        let mut engine = service(Pin { x: -1, y: 1 });
        upload_markers(&mut engine, 1, 10, 10, &[]).unwrap();
        let mut entity = photo(1, PixelFormat::Rgba8, 1, pixel_edges(0, 0, 19, 19));
        entity.align = Some(Align { x: 1, y: 0 });
        engine.submit(Request::Entity(entity)).unwrap();
        engine
            .submit(Request::Begin {
                width: 100,
                height: 100,
            })
            .unwrap();
        place(
            &mut engine,
            1,
            Rect {
                x1: 40,
                y1: 0,
                x2: 49,
                y2: 9,
            },
        )
        .unwrap();
        assert_eq!(
            snapshot(&mut engine).unwrap().nodes[0].rect,
            Rect {
                x1: 40,
                y1: 0,
                x2: 49,
                y2: 9
            }
        );
        {
            let node = &tree(&engine).nodes[&NodeId(1)];
            assert_eq!(node.a_x, 40);
            assert_eq!(node.size_x, 10);
            assert_eq!(node.align, Align { x: 1, y: 0 });
        }
        engine.submit(Request::End).unwrap();
        place(
            &mut engine,
            1,
            Rect {
                x1: 50,
                y1: 0,
                x2: 59,
                y2: 9,
            },
        )
        .unwrap();
        assert_eq!(snapshot(&mut engine).unwrap().nodes[0].rect.x1, 50);
    }

    #[test]
    fn place_photo_into_a_smaller_rect_is_box_overflow() {
        let mut engine = service(Pin { x: -1, y: 1 });
        upload_markers(&mut engine, 1, 10, 10, &[]).unwrap();
        engine
            .submit(Request::Entity(photo(
                1,
                PixelFormat::Rgba8,
                1,
                pixel_edges(0, 0, 19, 19),
            )))
            .unwrap();
        engine
            .submit(Request::Begin {
                width: 100,
                height: 100,
            })
            .unwrap();
        assert_eq!(
            place(
                &mut engine,
                1,
                Rect {
                    x1: 40,
                    y1: 0,
                    x2: 48,
                    y2: 8
                }
            )
            .unwrap_err(),
            Error::BoxOverflow
        );
        let node = &tree(&engine).nodes[&NodeId(1)];
        assert_eq!(node.near_x, 0);
        assert_eq!(node.size_x, 20);
    }

    #[test]
    fn place_group_is_bad_parent() {
        let mut engine = service(Pin { x: -1, y: 1 });
        add_flat(&mut engine, 1, 0, 0, 9, 9).unwrap();
        add_flat(&mut engine, 2, 10, 0, 19, 9).unwrap();
        group(&mut engine, 10, 0, &[NodeId(1), NodeId(2)]).unwrap();
        engine
            .submit(Request::Begin {
                width: 100,
                height: 100,
            })
            .unwrap();
        assert_eq!(
            place(
                &mut engine,
                10,
                Rect {
                    x1: 0,
                    y1: 0,
                    x2: 9,
                    y2: 9
                }
            )
            .unwrap_err(),
            Error::BadParent
        );
    }

    #[test]
    fn place_nested_arbitrary_inverse_pin() {
        let mut engine = service(Pin { x: -1, y: 1 });
        add_flat(&mut engine, 1, 5, 5, 9, 9).unwrap();
        arbitrary(
            &mut engine,
            20,
            0,
            Some(false),
            pixel_edges(5, 5, 9, 9),
            &[NodeId(1)],
        )
        .unwrap();
        arbitrary(
            &mut engine,
            10,
            0,
            Some(false),
            pixel_edges(0, 0, 19, 19),
            &[NodeId(20)],
        )
        .unwrap();
        engine
            .submit(Request::Begin {
                width: 100,
                height: 100,
            })
            .unwrap();
        place(
            &mut engine,
            20,
            Rect {
                x1: 6,
                y1: 5,
                x2: 10,
                y2: 9,
            },
        )
        .unwrap();
        let list = snapshot(&mut engine).unwrap();
        assert_eq!(list.nodes[1].id, NodeId(20));
        assert_eq!(
            list.nodes[1].rect,
            Rect {
                x1: 6,
                y1: 5,
                x2: 10,
                y2: 9
            }
        );
        assert_eq!(list.nodes[2].rect.x1, 6);
        assert_eq!(
            place(
                &mut engine,
                20,
                Rect {
                    x1: 18,
                    y1: 5,
                    x2: 22,
                    y2: 9
                }
            )
            .unwrap_err(),
            Error::BoxOverflow
        );
        assert_eq!(snapshot(&mut engine).unwrap().nodes[1].rect.x1, 6);
    }

    #[test]
    fn place_pin_zero_inverts_the_fraction() {
        let mut engine = Engine::new();
        engine
            .submit(Request::Begin {
                width: 3,
                height: 3,
            })
            .unwrap();
        engine
            .submit(Request::Begin {
                width: 100,
                height: 100,
            })
            .unwrap();
        add_flat(&mut engine, 1, 0, 0, 0, 0).unwrap();
        arbitrary_pinned(
            &mut engine,
            10,
            0,
            pixel_edges(0, 0, 0, 0),
            &[NodeId(1)],
            Pin { x: 0, y: 0 },
        )
        .unwrap();
        place(
            &mut engine,
            10,
            Rect {
                x1: 50,
                y1: 0,
                x2: 50,
                y2: 0,
            },
        )
        .unwrap();
        assert_eq!(
            engine.references.tree(RefKey::Builtin).nodes[&NodeId(10)].a_x,
            1
        );
        assert_eq!(
            snapshot(&mut engine).unwrap().nodes[0].rect,
            Rect {
                x1: 33,
                y1: 0,
                x2: 33,
                y2: 0
            }
        );
        engine
            .submit(Request::Begin {
                width: 100,
                height: 100,
            })
            .unwrap();
        assert_eq!(snapshot(&mut engine).unwrap().nodes[0].rect.x1, 33);
    }

    #[test]
    fn place_uses_the_window_near() {
        let mut engine = service(Pin { x: 0, y: 0 });
        add_flat(&mut engine, 1, 0, 0, 9, 9).unwrap();
        engine
            .submit(Request::Begin {
                width: 90,
                height: 90,
            })
            .unwrap();
        place(
            &mut engine,
            1,
            Rect {
                x1: 40,
                y1: 0,
                x2: 49,
                y2: 9,
            },
        )
        .unwrap();
        assert_eq!(snapshot(&mut engine).unwrap().nodes[0].rect.x1, 40);
    }

    #[test]
    fn show_and_place_validate_ids() {
        let mut engine = Engine::new();
        define(&mut engine, 7);
        define(&mut engine, 8);
        engine
            .submit(Request::Begin {
                width: 100,
                height: 100,
            })
            .unwrap();
        add_flat(&mut engine, 1, 0, 0, 9, 9).unwrap();
        let rect = Rect {
            x1: 0,
            y1: 0,
            x2: 9,
            y2: 9,
        };
        let empty = Rect {
            x1: 0,
            y1: 0,
            x2: -1,
            y2: 9,
        };
        assert_eq!(show(&mut engine, 0, rect).unwrap_err(), Error::BadParent);
        assert_eq!(place(&mut engine, 0, rect).unwrap_err(), Error::BadParent);
        assert_eq!(show(&mut engine, 1, empty).unwrap_err(), Error::BadCell);
        assert_eq!(place(&mut engine, 1, empty).unwrap_err(), Error::BadCell);
        let beyond = Rect {
            x1: 0,
            y1: 0,
            x2: MAX_COORD as i32 + 1,
            y2: 9,
        };
        assert_eq!(show(&mut engine, 1, beyond).unwrap_err(), Error::Overflow);
        assert_eq!(place(&mut engine, 1, beyond).unwrap_err(), Error::Overflow);
        engine.submit(Request::End).unwrap();
        assert_eq!(show(&mut engine, 1, rect).unwrap_err(), Error::NotBegun);
        place(&mut engine, 1, rect).unwrap();

        engine
            .submit(Request::Begin {
                width: 100,
                height: 100,
            })
            .unwrap();
        use_ref(&mut engine, 8).unwrap();
        assert_eq!(show(&mut engine, 1, rect).unwrap_err(), Error::UnknownNode);
        assert_eq!(place(&mut engine, 1, rect).unwrap_err(), Error::UnknownNode);
    }

    #[test]
    fn end_paints_in_draw_order_over_direct_commands() {
        let mut engine = service(Pin { x: -1, y: 1 });
        let red = Color {
            r: 255,
            g: 0,
            b: 0,
            a: 255,
        };
        let blue = Color {
            r: 0,
            g: 0,
            b: 255,
            a: 255,
        };
        let green = Color {
            r: 0,
            g: 255,
            b: 0,
            a: 255,
        };
        engine
            .submit(Request::Entity(flat_color(1, 0, 0, 9, 9, red)))
            .unwrap();
        engine
            .submit(Request::Entity(flat_color(2, 5, 0, 14, 9, blue)))
            .unwrap();
        group(&mut engine, 10, 0, &[NodeId(1), NodeId(2)]).unwrap();
        add_flat(&mut engine, 3, 10, 0, 19, 9).unwrap();
        arbitrary(
            &mut engine,
            20,
            0,
            Some(false),
            pixel_edges(0, 0, 29, 29),
            &[NodeId(3)],
        )
        .unwrap();
        engine
            .submit(Request::Begin {
                width: 100,
                height: 100,
            })
            .unwrap();
        engine
            .submit(Request::FillRect {
                rect: Rect {
                    x1: 0,
                    y1: 0,
                    x2: 39,
                    y2: 39,
                },
                color: green,
                blend: None,
                radius: None,
            })
            .unwrap();
        engine.submit(Request::End).unwrap();
        assert_eq!(pixel(&mut engine, 0, 0), [255, 0, 0, 255]);
        assert_eq!(pixel(&mut engine, 7, 0), [0, 0, 255, 255]);
        assert_eq!(pixel(&mut engine, 12, 0), [255, 255, 255, 255]);
        assert_eq!(pixel(&mut engine, 25, 0), [0, 255, 0, 255]);
        assert_eq!(pixel(&mut engine, 40, 0), [0, 0, 0, 0]);
    }

    #[test]
    fn show_is_clipped_by_the_parent() {
        let mut engine = service(Pin { x: -1, y: 1 });
        add_flat(&mut engine, 1, 0, 0, 9, 9).unwrap();
        arbitrary(
            &mut engine,
            10,
            0,
            Some(false),
            pixel_edges(0, 0, 19, 19),
            &[NodeId(1)],
        )
        .unwrap();
        engine
            .submit(Request::Begin {
                width: 100,
                height: 100,
            })
            .unwrap();
        show(
            &mut engine,
            1,
            Rect {
                x1: 15,
                y1: 0,
                x2: 24,
                y2: 9,
            },
        )
        .unwrap();
        engine.submit(Request::End).unwrap();
        assert_eq!(pixel(&mut engine, 18, 0), [255, 255, 255, 255]);
        assert_eq!(pixel(&mut engine, 20, 0), [0, 0, 0, 0]);
    }

    #[test]
    fn vector_paints_from_zero_offset() {
        let mut engine = service(Pin { x: -1, y: 1 });
        let verbs = [
            Verb::Move(0, 0),
            Verb::Line(10, 0),
            Verb::Line(10, 10),
            Verb::Line(0, 10),
            Verb::Close,
        ];
        let entity = Entity {
            id: NodeId(1),
            kind: EntityKind::Vector {
                verbs: &verbs,
                fill: Some(Fill {
                    rule: FillRule::NonZero,
                }),
                stroke: None,
                color: Color {
                    r: 255,
                    g: 0,
                    b: 0,
                    a: 255,
                },
            },
            on_grid: Some(false),
            edges: pixel_edges(10, 10, 19, 19),
            align: None,
            blend: None,
            radius: None,
        };
        engine.submit(Request::Entity(entity)).unwrap();
        engine
            .submit(Request::Begin {
                width: 100,
                height: 100,
            })
            .unwrap();
        engine.submit(Request::End).unwrap();
        assert_eq!(pixel(&mut engine, 14, 14), [0, 0, 0, 0]);
        assert_eq!(pixel(&mut engine, 15, 15), [255, 0, 0, 255]);
        assert_eq!(pixel(&mut engine, 19, 19), [255, 0, 0, 255]);
        assert_eq!(pixel(&mut engine, 20, 20), [0, 0, 0, 0]);
    }

    #[test]
    fn end_repaints_after_a_same_size_begin() {
        let mut engine = service(Pin { x: -1, y: 1 });
        add_flat(&mut engine, 1, 0, 0, 9, 9).unwrap();
        engine
            .submit(Request::Begin {
                width: 100,
                height: 100,
            })
            .unwrap();
        let first = snapshot(&mut engine).unwrap().generation;
        engine.submit(Request::End).unwrap();
        assert_eq!(pixel(&mut engine, 0, 0), [255, 255, 255, 255]);
        engine
            .submit(Request::Begin {
                width: 100,
                height: 100,
            })
            .unwrap();
        engine.submit(Request::End).unwrap();
        assert_eq!(pixel(&mut engine, 0, 0), [255, 255, 255, 255]);
        assert_eq!(snapshot(&mut engine).unwrap().generation, first);
    }
}
