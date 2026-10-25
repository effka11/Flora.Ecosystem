//! §12 rows 87, 88, 111, 112, 137: stroke ring, `Outside` band, caps and `Measure`.
//!
//! Rows 135, 136 (miter limit boundary) and 138 (exact round arc points) observe
//! the 8.8 join math and are covered by unit tests inside `fgce` (`vector.rs`).

use fgce::{Cap, Error, Join, Rect, Stroke, StrokeAlign, Verb};
use fgce_conformance::{Harness, WHITE, rect};

fn rectangle(x1: i32, y1: i32, x2: i32, y2: i32) -> [Verb; 5] {
    [
        Verb::Move(x1, y1),
        Verb::Line(x1, y2),
        Verb::Line(x2, y2),
        Verb::Line(x2, y1),
        Verb::Close,
    ]
}

fn stroke(h: &mut Harness, verbs: &[Verb], width: u32, align: StrokeAlign, join: Join, cap: Cap) {
    h.stroke_path(verbs, width, align, join, cap, WHITE);
}

#[test]
fn row_87_measure_outside_stroke_includes_the_band() {
    let mut h = Harness::new();
    let area = h.measure(
        &rectangle(0, 0, 10, 10),
        None,
        Some(Stroke {
            width: 1,
            align: StrokeAlign::Outside,
            join: Join::Miter { limit_q8: 1024 },
            cap: Cap::Butt,
        }),
    );
    assert_eq!(area, rect(-1, -1, 10, 10));
}

#[test]
fn row_88_measure_covers_miter_arc_and_square_cap() {
    let mut h = Harness::new();
    let v = [Verb::Move(0, 0), Verb::Line(10, 10), Verb::Line(20, 0)];
    let measure_with = |h: &mut Harness, join: Join, width: u32| {
        h.measure(
            &v,
            None,
            Some(Stroke {
                width,
                align: StrokeAlign::Outside,
                join,
                cap: Cap::Butt,
            }),
        )
    };
    assert_eq!(
        measure_with(&mut h, Join::Miter { limit_q8: 1024 }, 1),
        rect(-1, 0, 20, 11),
        "miter spike is included"
    );
    assert_eq!(
        measure_with(&mut h, Join::Bevel, 1),
        rect(-1, 0, 20, 10),
        "bevel does not include the spike"
    );
    assert_eq!(
        measure_with(&mut h, Join::Round, 4),
        rect(-3, 0, 22, 13),
        "round arc reaches one width past the bisector"
    );
    assert_eq!(measure_with(&mut h, Join::Bevel, 4), rect(-3, 0, 22, 12));

    let line = [Verb::Move(0, 5), Verb::Line(10, 5)];
    let butt = h.measure(
        &line,
        None,
        Some(Stroke {
            width: 1,
            align: StrokeAlign::Outside,
            join: Join::Bevel,
            cap: Cap::Butt,
        }),
    );
    assert_eq!(butt, rect(0, 5, 9, 5));
    let square = h.measure(
        &line,
        None,
        Some(Stroke {
            width: 1,
            align: StrokeAlign::Outside,
            join: Join::Bevel,
            cap: Cap::Square,
        }),
    );
    assert_eq!(square, rect(-1, 5, 10, 5), "square cap adds one width");
}

#[test]
fn row_111_inside_stroke_is_a_ring_with_empty_interior() {
    let mut h = Harness::new();
    h.begin(16, 16);
    stroke(
        &mut h,
        &rectangle(0, 0, 10, 10),
        1,
        StrokeAlign::Inside,
        Join::Miter { limit_q8: 1024 },
        Cap::Butt,
    );
    for i in 0..10 {
        assert_eq!(h.pixel_premul(i, 0)[3], 255, "top ring at x = {i}");
        assert_eq!(h.pixel_premul(i, 9)[3], 255, "bottom ring at x = {i}");
        assert_eq!(h.pixel_premul(0, i)[3], 255, "left ring at y = {i}");
        assert_eq!(h.pixel_premul(9, i)[3], 255, "right ring at y = {i}");
    }
    assert_eq!(h.pixel_premul(1, 5)[3], 0);
    assert_eq!(h.pixel_premul(5, 5)[3], 0);
    assert_eq!(h.pixel_premul(8, 5)[3], 0);
}

#[test]
fn row_112_outside_band_lies_beyond_the_contour() {
    let mut h = Harness::new();
    h.begin(16, 16);
    // The row uses vertices 0 and 10 and reads x = -1 / x = 10; a frame has no
    // negative column, so the same contour is shifted by +1 and read at 0 / 11.
    stroke(
        &mut h,
        &rectangle(1, 1, 11, 11),
        1,
        StrokeAlign::Outside,
        Join::Miter { limit_q8: 1024 },
        Cap::Butt,
    );
    assert_eq!(h.pixel_premul(0, 5)[3], 255, "left of the contour");
    assert_eq!(h.pixel_premul(11, 5)[3], 255, "right of the contour");
    assert_eq!(h.pixel_premul(5, 0)[3], 255, "above the contour");
    assert_eq!(h.pixel_premul(5, 11)[3], 255, "below the contour");
    assert_eq!(h.pixel_premul(1, 5)[3], 0, "inner column is not painted");
    assert_eq!(h.pixel_premul(5, 10)[3], 0, "inner row is not painted");
    assert_eq!(h.pixel_premul(5, 5)[3], 0);
}

#[test]
fn row_137_square_cap_extends_but_butt_does_not() {
    let verbs = [Verb::Move(0, 0), Verb::Line(10, 0)];

    let mut square = Harness::new();
    square.begin(16, 16);
    stroke(
        &mut square,
        &verbs,
        1,
        StrokeAlign::Outside,
        Join::Bevel,
        Cap::Square,
    );
    assert_eq!(square.pixel_premul(9, 0)[3], 255);
    assert_eq!(square.pixel_premul(10, 0)[3], 255);
    assert_eq!(square.pixel_premul(11, 0)[3], 0);

    let mut butt = Harness::new();
    butt.begin(16, 16);
    stroke(
        &mut butt,
        &verbs,
        1,
        StrokeAlign::Outside,
        Join::Bevel,
        Cap::Butt,
    );
    assert_eq!(butt.pixel_premul(9, 0)[3], 255);
    assert_eq!(butt.pixel_premul(10, 0)[3], 0);
}

#[test]
fn row_137_start_cap_is_drawn() {
    let verbs = [Verb::Move(5, 5), Verb::Line(10, 5)];

    let mut square = Harness::new();
    square.begin(16, 16);
    stroke(
        &mut square,
        &verbs,
        1,
        StrokeAlign::Outside,
        Join::Bevel,
        Cap::Square,
    );
    assert_eq!(square.pixel_premul(4, 5)[3], 255);

    let mut butt = Harness::new();
    butt.begin(16, 16);
    stroke(
        &mut butt,
        &verbs,
        1,
        StrokeAlign::Outside,
        Join::Bevel,
        Cap::Butt,
    );
    assert_eq!(butt.pixel_premul(4, 5)[3], 0);
}

#[test]
fn stroke_inside_rejects_an_open_contour() {
    let mut h = Harness::new();
    h.begin(16, 16);
    let open = [Verb::Move(0, 0), Verb::Line(10, 0)];
    assert_eq!(
        h.try_stroke_path(&open, 1, StrokeAlign::Inside, Join::Bevel, Cap::Butt, WHITE),
        Error::BadPath
    );
}

#[test]
fn stroke_zero_width_is_bad_stroke() {
    let mut h = Harness::new();
    h.begin(16, 16);
    assert_eq!(
        h.try_stroke_path(
            &rectangle(0, 0, 10, 10),
            0,
            StrokeAlign::Outside,
            Join::Miter { limit_q8: 1024 },
            Cap::Butt,
            WHITE
        ),
        Error::BadStroke
    );
}

#[test]
fn stroke_measure_rounds_like_the_spec_bounds() {
    let mut h = Harness::new();
    let area: Rect = h.measure(
        &rectangle(0, 0, 10, 10),
        None,
        Some(Stroke {
            width: 1,
            align: StrokeAlign::Inside,
            join: Join::Miter { limit_q8: 1024 },
            cap: Cap::Butt,
        }),
    );
    assert_eq!(area, rect(0, 0, 9, 9));
}
