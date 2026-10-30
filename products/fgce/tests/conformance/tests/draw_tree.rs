//! §12 0.16 rows: `DrawTree`, immediate overlay and `EntityKind::Empty`.

use fgce::{Blend, Color, Entity, EntityKind, FillRule, NodeId, Request, StrokeAlign, Verb};
use fgce_conformance::{Harness, RED, WHITE, flat, pixels, rect};

fn tree(h: &mut Harness) {
    h.ok(flat(1, 0, 0, 15, 15, RED));
    h.ok(flat(2, 4, 4, 11, 11, WHITE));
}

fn empty_entity(id: u32, x1: i32, y1: i32, x2: i32, y2: i32) -> Request<'static> {
    Request::Entity(Entity {
        id: NodeId(id),
        kind: EntityKind::Empty,
        on_grid: Some(false),
        edges: pixels(x1, y1, x2, y2),
        align: None,
        blend: None,
        radius: None,
    })
}

#[test]
fn draw_tree_is_idempotent_and_end_does_not_paint_it_again() {
    let mut once = Harness::new();
    once.begin(16, 16);
    tree(&mut once);
    once.ok(Request::DrawTree);
    let first = once.end();

    let mut twice = Harness::new();
    twice.begin(16, 16);
    tree(&mut twice);
    twice.ok(Request::DrawTree);
    twice.ok(Request::DrawTree);
    let second = twice.end();
    assert_eq!(first.bytes, second.bytes);
}

#[test]
fn draw_tree_before_begin_is_not_begun() {
    let mut h = Harness::new();
    assert_eq!(
        h.submit(Request::DrawTree).unwrap_err(),
        fgce::Error::NotBegun
    );
    h.begin(8, 8);
    h.ok(Request::DrawTree);
    h.end();
    assert_eq!(
        h.submit(Request::DrawTree).unwrap_err(),
        fgce::Error::NotBegun
    );
}

#[test]
fn immediate_layer_after_draw_tree_lies_on_top() {
    let mut h = Harness::new();
    h.begin(16, 16);
    tree(&mut h);
    h.ok(Request::DrawTree);
    h.ok(Request::FillRect {
        rect: rect(0, 0, 3, 3),
        color: Color {
            r: 0,
            g: 0,
            b: 255,
            a: 255,
        },
        blend: None,
        radius: None,
    });
    h.ok(Request::FillPath {
        verbs: &[
            Verb::Move(4, 0),
            Verb::Line(7, 0),
            Verb::Line(7, 3),
            Verb::Line(4, 3),
            Verb::Close,
        ],
        rule: FillRule::NonZero,
        color: Color {
            r: 0,
            g: 255,
            b: 0,
            a: 255,
        },
        blend: None,
    });
    h.ok(Request::StrokePath {
        verbs: &[
            Verb::Move(8, 0),
            Verb::Line(12, 0),
            Verb::Line(12, 4),
            Verb::Line(8, 4),
            Verb::Close,
        ],
        stroke: fgce::Stroke {
            width_q8: 256,
            align: StrokeAlign::Inside,
            join: fgce::Join::Bevel,
            cap: fgce::Cap::Butt,
            peak: fgce::Peak::Light,
        },
        color: Color {
            r: 255,
            g: 255,
            b: 0,
            a: 255,
        },
        blend: None,
    });
    h.clip_push(rect(12, 0, 15, 3));
    h.ok(Request::FillRect {
        rect: rect(0, 0, 15, 3),
        color: Color {
            r: 255,
            g: 0,
            b: 255,
            a: 255,
        },
        blend: Some(Blend::SrcOver),
        radius: None,
    });
    h.clip_pop();
    let frame = h.end();
    assert_eq!(frame.pixel(1, 1), [0, 0, 255, 255]);
    assert_eq!(frame.pixel(5, 1), [0, 255, 0, 255]);
    assert_eq!(frame.pixel(13, 1), [255, 0, 255, 255]);
    assert_eq!(
        frame.pixel(1, 5),
        [255, 0, 0, 255],
        "tree under the overlay"
    );
}

#[test]
fn draw_tree_keeps_the_snapshot() {
    let mut with = Harness::new();
    with.begin(16, 16);
    tree(&mut with);
    with.ok(Request::DrawTree);
    let with = with.snapshot();

    let mut without = Harness::new();
    without.begin(16, 16);
    tree(&mut without);
    let without = without.snapshot();
    assert_eq!(with, without);
}

#[test]
fn empty_is_invisible_but_present_in_the_snapshot() {
    let mut with = Harness::new();
    with.begin(16, 16);
    with.ok(flat(1, 0, 0, 15, 15, RED));
    with.ok(empty_entity(2, 8, 8, 12, 12));
    let frame = with.end();

    let mut without = Harness::new();
    without.begin(16, 16);
    without.ok(flat(1, 0, 0, 15, 15, RED));
    let plain = without.end();
    assert_eq!(frame.bytes, plain.bytes);

    let snapshot = with.snapshot();
    let node = snapshot
        .nodes
        .iter()
        .find(|node| node.id == NodeId(2))
        .expect("Empty stays in the snapshot");
    assert_eq!(node.rect, rect(8, 8, 12, 12));
}

#[test]
fn empty_place_and_show_match_flat() {
    let mut empty = Harness::new();
    empty.begin(32, 32);
    empty.ok(empty_entity(1, 0, 0, 9, 9));
    empty.place(1, rect(4, 4, 13, 13));
    let empty = empty.snapshot();

    let mut painted = Harness::new();
    painted.begin(32, 32);
    painted.ok(flat(1, 0, 0, 9, 9, RED));
    painted.place(1, rect(4, 4, 13, 13));
    let painted = painted.snapshot();
    assert_eq!(
        empty.nodes, painted.nodes,
        "Place writes the same rectangle"
    );

    let mut shown_empty = Harness::new();
    shown_empty.begin(32, 32);
    shown_empty.ok(empty_entity(1, 0, 0, 9, 9));
    shown_empty.show(1, rect(6, 6, 15, 15));
    let shown_empty = shown_empty.snapshot();
    let mut shown_flat = Harness::new();
    shown_flat.begin(32, 32);
    shown_flat.ok(flat(1, 0, 0, 9, 9, RED));
    shown_flat.show(1, rect(6, 6, 15, 15));
    assert_eq!(shown_empty.nodes, shown_flat.snapshot().nodes);
}

#[test]
fn empty_anchor_and_radius_codes() {
    let mut h = Harness::new();
    h.begin(8, 8);
    let mut request = empty_entity(1, 0, 0, 3, 3);
    if let Request::Entity(entity) = &mut request {
        entity.align = Some(fgce::Align { x: 1, y: 0 });
    }
    assert_eq!(h.submit(request).unwrap_err(), fgce::Error::BadAnchor);
    let mut request = empty_entity(1, 0, 0, 3, 3);
    if let Request::Entity(entity) = &mut request {
        entity.radius = Some(fgce::Radius::Percent(10));
    }
    assert_eq!(h.submit(request).unwrap_err(), fgce::Error::BadRadius);
}

#[test]
fn repeated_empty_entity_replaces_its_fields() {
    let mut h = Harness::new();
    h.begin(16, 16);
    h.ok(empty_entity(1, 0, 0, 3, 3));
    h.ok(empty_entity(1, 4, 4, 9, 9));
    let snapshot = h.snapshot();
    let node = snapshot
        .nodes
        .iter()
        .find(|node| node.id == NodeId(1))
        .expect("node");
    assert_eq!(node.rect, rect(4, 4, 9, 9));
    assert_eq!(snapshot.nodes.len(), 1);
}
