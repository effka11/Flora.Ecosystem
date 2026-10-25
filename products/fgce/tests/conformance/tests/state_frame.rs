//! §12 rows 77–81, 117–119, 148, 157: engine states, clip stack, `Err` invariants.

use fgce::{AlphaMode, Error, Pin, Request};
use fgce_conformance::{Harness, WHITE, flat, rect};

#[test]
fn row_77_snapshot_before_begin() {
    let mut h = Harness::new();
    assert_eq!(h.err(Request::Snapshot), Error::NotBegun);
}

#[test]
fn row_78_read_pixels_and_clip_push_before_begin() {
    let mut h = Harness::new();
    assert_eq!(
        h.err(Request::ReadPixels {
            rect: rect(0, 0, 0, 0),
            alpha: AlphaMode::Straight,
        }),
        Error::NotBegun
    );
    assert_eq!(
        h.err(Request::ClipPush {
            rect: rect(0, 0, 0, 0),
        }),
        Error::NotBegun
    );
}

#[test]
fn row_79_end_twice_without_begin() {
    let mut h = Harness::new();
    h.begin(10, 10);
    h.end();
    assert_eq!(h.err(Request::End), Error::NotBegun);
}

#[test]
fn row_80_drawing_after_end() {
    let mut h = Harness::new();
    h.begin(10, 10);
    h.end();
    assert_eq!(
        h.err(Request::FillRect {
            rect: rect(0, 0, 0, 0),
            color: WHITE,
            blend: None,
        }),
        Error::NotBegun
    );
    assert_eq!(
        h.err(Request::ClipPush {
            rect: rect(0, 0, 0, 0),
        }),
        Error::NotBegun
    );
    assert_eq!(h.err(Request::ClipPop), Error::NotBegun);
}

#[test]
fn row_81_read_pixels_and_snapshot_after_end() {
    let mut h = Harness::new();
    h.begin(4, 4);
    h.fill(rect(0, 0, 1, 1), WHITE);
    h.end();
    assert_eq!(h.pixel(0, 0), [255, 255, 255, 255]);
    let snapshot = h.snapshot();
    assert_eq!(snapshot.nodes.len(), 0);
}

#[test]
fn row_117_clip_push_narrows_the_frame() {
    let mut h = Harness::new();
    h.begin(10, 10);
    h.ok(Request::ClipPush {
        rect: rect(2, 2, 4, 4),
    });
    h.fill(rect(0, 0, 9, 9), WHITE);
    h.ok(Request::ClipPop);
    assert_eq!(h.pixel(3, 3), [255, 255, 255, 255]);
    assert_eq!(h.pixel(0, 0), [0, 0, 0, 0]);
    assert_eq!(h.pixel(5, 5), [0, 0, 0, 0]);
}

#[test]
fn row_118_33rd_clip_push_overflows() {
    let mut h = Harness::new();
    h.begin(10, 10);
    for _ in 0..32 {
        h.ok(Request::ClipPush {
            rect: rect(0, 0, 9, 9),
        });
    }
    assert_eq!(
        h.err(Request::ClipPush {
            rect: rect(0, 0, 9, 9),
        }),
        Error::ClipOverflow
    );
}

#[test]
fn row_119_clip_pop_underflow() {
    let mut h = Harness::new();
    h.begin(10, 10);
    assert_eq!(h.err(Request::ClipPop), Error::ClipUnderflow);
}

#[test]
fn row_148_two_begins_do_not_keep_pixels() {
    let mut h = Harness::new();
    h.begin(10, 10);
    h.fill(rect(0, 0, 9, 9), WHITE);
    h.end();
    assert_eq!(h.pixel(0, 0), [255, 255, 255, 255]);
    h.begin(10, 10);
    h.end();
    assert_eq!(h.pixel(0, 0), [0, 0, 0, 0]);
}

#[test]
fn row_157_error_keeps_state_and_bytes() {
    let mut h = Harness::new();
    h.begin(10, 10);
    h.fill(rect(0, 0, 9, 9), WHITE);
    let before = h.pixels(rect(0, 0, 9, 9)).bytes;
    let snapshot_before = h.snapshot();
    assert_eq!(
        h.try_remove(99),
        Error::UnknownNode,
        "no tree mutation may go through"
    );
    assert_eq!(
        h.try_blit(1, rect(0, 0, 0, 0), rect(0, 0, 2, 2), fgce::Sample::Crisp),
        Error::UnknownImage
    );
    assert_eq!(h.pixels(rect(0, 0, 9, 9)).bytes, before);
    assert_eq!(h.snapshot(), snapshot_before);
    h.end();
    assert_eq!(h.pixels(rect(0, 0, 9, 9)).bytes, before);
}

#[test]
fn state_table_remove_works_before_begin() {
    let mut h = Harness::new();
    h.define_reference(7, (100, 100), 5, 1, Pin { x: -1, y: 1 }, (0, 0));
    h.ok(flat(1, 0, 0, 9, 9, WHITE));
    h.remove(1);
    assert_eq!(
        h.err(Request::Snapshot),
        Error::NotBegun,
        "Remove must not begin a frame"
    );
    assert_eq!(h.try_remove(1), Error::UnknownNode, "the node is gone");
}

#[test]
fn state_table_place_works_after_end() {
    let mut h = Harness::new();
    h.begin(20, 20);
    h.ok(flat(1, 0, 0, 4, 4, WHITE));
    h.end();
    h.place(1, rect(10, 10, 14, 14));
    let snapshot = h.snapshot();
    assert_eq!(snapshot.nodes.len(), 1);
    assert_eq!(snapshot.nodes[0].rect, rect(10, 10, 14, 14));
    assert_eq!(
        h.err(Request::End),
        Error::NotBegun,
        "Place must not reopen the frame"
    );
}
