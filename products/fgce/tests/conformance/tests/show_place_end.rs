//! §12 rows 38–41, 48, 49, 59, 96, 145: `Show`, its lifetime and clipping.
//!
//! Row 146 (one raster pass per `End`) is an invariant checked by the benchmark.

use fgce::{Error, NodeId, Pin, Request};
use fgce_conformance::{Harness, RED, WHITE, flat, pixels, rect};

const CENTER: Pin = Pin { x: 0, y: 0 };

fn arbitrary(h: &mut Harness, id: u32, parent: u32, edges: fgce::Edges, children: &[NodeId]) {
    h.ok(Request::Arbitrary {
        id: NodeId(id),
        parent: NodeId(parent),
        on_grid: Some(false),
        edges,
        children,
        pin: CENTER,
        snap: false,
        inset: None,
    });
}

fn node_rect(h: &mut Harness, id: u32) -> Option<fgce::Rect> {
    h.snapshot()
        .nodes
        .into_iter()
        .find(|node| node.id == NodeId(id))
        .map(|node| node.rect)
}

#[test]
fn row_38_begin_with_a_new_size_clears_shows() {
    let mut h = Harness::new();
    h.begin(100, 100);
    h.ok(flat(1, 0, 0, 9, 9, WHITE));
    h.show(1, rect(20, 0, 29, 9));
    assert_eq!(node_rect(&mut h, 1), Some(rect(20, 0, 29, 9)));
    h.begin(200, 200);
    assert_eq!(
        node_rect(&mut h, 1),
        Some(rect(0, 0, 9, 9)),
        "Show is gone, the box is back on its canonical position"
    );
}

#[test]
fn row_39_show_of_a_parent_shifts_the_child_by_the_delta() {
    let mut h = Harness::new();
    h.begin(100, 100);
    h.ok(flat(1, 0, 0, 9, 9, WHITE));
    arbitrary(&mut h, 10, 0, pixels(0, 0, 19, 19), &[NodeId(1)]);
    h.show(10, rect(1, 0, 20, 19));
    assert_eq!(node_rect(&mut h, 1), Some(rect(1, 0, 10, 9)), "child at 1");
}

#[test]
fn row_40_show_of_an_ancestor_moves_the_child_to_its_start() {
    let mut h = Harness::new();
    h.begin(100, 100);
    h.ok(flat(1, 10, 0, 19, 9, WHITE));
    arbitrary(&mut h, 10, 0, pixels(10, 0, 29, 19), &[NodeId(1)]);
    h.show(10, rect(15, 0, 34, 19));
    assert_eq!(node_rect(&mut h, 1), Some(rect(15, 0, 24, 9)));
}

#[test]
fn row_41_a_frame_without_show_drops_it() {
    let mut h = Harness::new();
    h.begin(100, 100);
    h.ok(flat(1, 0, 0, 9, 9, WHITE));
    h.show(1, rect(20, 0, 29, 9));
    h.end();
    h.begin(100, 100);
    assert_eq!(node_rect(&mut h, 1), Some(rect(0, 0, 9, 9)));
}

#[test]
fn row_48_show_clips_a_photo_without_stretching() {
    let mut h = Harness::new();
    h.begin(100, 100);
    h.upload_rgba(1, 10, 10, fgce::AlphaMode::Straight, &[200; 400]);
    h.ok(fgce_conformance::photo(
        1,
        fgce::PixelFormat::Rgba8,
        1,
        0,
        0,
        9,
        9,
    ));
    h.show(1, rect(0, 0, 7, 7));
    h.end();
    assert_eq!(h.pixel_premul(7, 7)[3], 200, "inside the shown rect");
    assert_eq!(h.pixel_premul(8, 8)[3], 0, "outside the shown rect");
}

#[test]
fn row_49_show_larger_than_the_image_keeps_one_to_one() {
    let mut h = Harness::new();
    h.begin(100, 100);
    h.upload_rgba(1, 10, 10, fgce::AlphaMode::Straight, &[200; 400]);
    h.ok(fgce_conformance::photo(
        1,
        fgce::PixelFormat::Rgba8,
        1,
        0,
        0,
        9,
        9,
    ));
    h.show(1, rect(0, 0, 11, 11));
    h.end();
    assert_eq!(h.pixel_premul(0, 0)[3], 0, "align is preserved");
    assert_eq!(h.pixel_premul(1, 1)[3], 200);
    assert_eq!(h.pixel_premul(10, 10)[3], 200);
    assert_eq!(h.pixel_premul(11, 11)[3], 0, "no texel stretching");
}

#[test]
fn row_59_show_of_a_nested_arbitrary_shifts_children() {
    let mut h = Harness::new();
    h.begin(100, 100);
    h.ok(flat(1, 0, 0, 9, 9, WHITE));
    h.ok(flat(2, 5, 0, 9, 4, WHITE));
    arbitrary(&mut h, 10, 0, pixels(0, 0, 19, 19), &[NodeId(1)]);
    arbitrary(&mut h, 11, 0, pixels(5, 0, 9, 4), &[NodeId(2)]);
    h.ok(Request::Arbitrary {
        id: NodeId(10),
        parent: NodeId(0),
        on_grid: Some(false),
        edges: pixels(0, 0, 19, 19),
        children: &[NodeId(1), NodeId(11)],
        pin: CENTER,
        snap: false,
        inset: None,
    });
    h.show(11, rect(8, 0, 12, 4));
    assert_eq!(node_rect(&mut h, 11), Some(rect(8, 0, 12, 4)));
    assert_eq!(
        node_rect(&mut h, 2),
        Some(rect(8, 0, 12, 4)),
        "shifted by 3"
    );
}

#[test]
fn reference_switch_shows_only_the_new_tree() {
    let mut h = Harness::new();
    h.define_reference(7, (100, 100), 5, 1, CENTER, (0, 0));
    h.define_reference(8, (100, 100), 5, 1, CENTER, (0, 0));
    h.ok(flat(1, 0, 0, 9, 9, WHITE));
    h.begin(100, 100);
    h.show(1, rect(20, 0, 29, 9));
    h.use_reference(8);
    h.ok(flat(2, 0, 0, 9, 9, WHITE));
    let snapshot = h.snapshot();
    assert_eq!(
        snapshot
            .nodes
            .iter()
            .map(|node| node.id.0)
            .collect::<Vec<_>>(),
        [2],
        "only the new reference tree is visible"
    );
    assert_eq!(node_rect(&mut h, 2), Some(rect(0, 0, 9, 9)));
    h.end();
    h.begin(100, 100);
    h.use_reference(7);
    assert_eq!(
        node_rect(&mut h, 1),
        Some(rect(0, 0, 9, 9)),
        "the old tree is back, the Show is gone"
    );
}

#[test]
fn row_145_repeated_show_keeps_the_same_rectangles() {
    let mut h = Harness::new();
    h.begin(100, 100);
    h.ok(flat(1, 0, 0, 9, 9, RED));
    h.show(1, rect(10, 0, 19, 9));
    let first = h.snapshot();
    h.show(1, rect(10, 0, 19, 9));
    let second = h.snapshot();
    assert_eq!(first.nodes, second.nodes);
    h.end();
    assert_eq!(h.pixel_premul(10, 0), [255, 0, 0, 255]);
}

#[test]
fn show_and_place_reject_empty_rectangles() {
    let mut h = Harness::new();
    h.begin(100, 100);
    h.ok(flat(1, 0, 0, 9, 9, WHITE));
    assert_eq!(
        h.err(Request::Show {
            id: NodeId(1),
            rect: rect(10, 0, 9, 9)
        }),
        Error::BadCell
    );
    assert_eq!(h.try_place(1, rect(10, 0, 9, 9)), Error::BadCell);
}
