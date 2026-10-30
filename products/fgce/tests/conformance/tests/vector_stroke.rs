//! §12 rows 87, 88, 111, 112, 137: stroke ring, `Outside` band, caps and `Measure`.
//!
//! Rows 135, 136 (miter limit boundary) and 138 (exact round arc points) observe
//! the 8.8 join math and are covered by unit tests inside `fgce` (`vector.rs`).

use fgce::{Cap, Error, Join, Peak, Rect, Stroke, StrokeAlign, Verb};
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
            width_q8: 256,
            align: StrokeAlign::Outside,
            join: Join::Miter { limit_q8: 1024 },
            cap: Cap::Butt,
            peak: Peak::Light,
        }),
    );
    assert_eq!(area, rect(-1, -1, 10, 10));
}

#[test]
fn row_88_measure_covers_miter_arc_and_square_cap() {
    let mut h = Harness::new();
    let triangle = [
        Verb::Move(0, 0),
        Verb::Line(10, 10),
        Verb::Line(20, 0),
        Verb::Close,
    ];
    let measure_with = |h: &mut Harness, join: Join, width: u32| {
        h.measure(
            &triangle,
            None,
            Some(Stroke {
                width_q8: width * 256,
                align: StrokeAlign::Outside,
                join,
                cap: Cap::Butt,
                peak: Peak::Light,
            }),
        )
    };
    assert_eq!(
        measure_with(&mut h, Join::Miter { limit_q8: 1024 }, 1),
        rect(-3, -1, 22, 11),
        "miter spike is included"
    );
    assert_eq!(
        measure_with(&mut h, Join::Bevel, 1),
        rect(-1, -1, 20, 10),
        "bevel does not include the spike"
    );
    assert_eq!(
        measure_with(&mut h, Join::Round, 4),
        rect(-4, -4, 23, 13),
        "round arc reaches one width past the bisector"
    );
    assert_eq!(measure_with(&mut h, Join::Bevel, 4), rect(-3, -4, 22, 12));

    let line = [Verb::Move(0, 5), Verb::Line(10, 5)];
    let butt = h.measure(
        &line,
        None,
        Some(Stroke {
            width_q8: 256,
            align: StrokeAlign::Center,
            join: Join::Bevel,
            cap: Cap::Butt,
            peak: Peak::Light,
        }),
    );
    assert_eq!(butt, rect(0, 4, 9, 5));
    let square = h.measure(
        &line,
        None,
        Some(Stroke {
            width_q8: 256,
            align: StrokeAlign::Center,
            join: Join::Bevel,
            cap: Cap::Square,
            peak: Peak::Light,
        }),
    );
    assert_eq!(square, rect(-1, 4, 10, 5), "square cap adds half a width");
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
        StrokeAlign::Center,
        Join::Bevel,
        Cap::Square,
    );
    assert_eq!(square.pixel_premul(9, 0)[3], 128);
    assert_eq!(square.pixel_premul(10, 0)[3], 64, "half-width extension");
    assert_eq!(square.pixel_premul(11, 0)[3], 0);

    let mut butt = Harness::new();
    butt.begin(16, 16);
    stroke(
        &mut butt,
        &verbs,
        1,
        StrokeAlign::Center,
        Join::Bevel,
        Cap::Butt,
    );
    assert_eq!(butt.pixel_premul(9, 0)[3], 128);
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
        StrokeAlign::Center,
        Join::Bevel,
        Cap::Square,
    );
    assert_eq!(square.pixel_premul(4, 5)[3], 64);

    let mut butt = Harness::new();
    butt.begin(16, 16);
    stroke(
        &mut butt,
        &verbs,
        1,
        StrokeAlign::Center,
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
fn stroke_outside_rejects_an_open_contour() {
    let mut h = Harness::new();
    h.begin(16, 16);
    let open = [Verb::Move(0, 0), Verb::Line(10, 0)];
    assert_eq!(
        h.try_stroke_path(
            &open,
            1,
            StrokeAlign::Outside,
            Join::Bevel,
            Cap::Butt,
            WHITE
        ),
        Error::BadPath
    );
}

#[test]
fn row_g7_center_odd_and_even_widths() {
    let mut odd = Harness::new();
    odd.begin(16, 16);
    stroke(
        &mut odd,
        &rectangle(1, 1, 11, 11),
        1,
        StrokeAlign::Center,
        Join::Miter { limit_q8: 1024 },
        Cap::Butt,
    );
    assert_eq!(odd.pixel_premul(0, 5)[3], 128, "half edge outside");
    assert_eq!(odd.pixel_premul(1, 5)[3], 128, "half edge inside");
    assert_eq!(odd.pixel_premul(2, 5)[3], 0, "no full pixel at w = 1");

    let mut even = Harness::new();
    even.begin(16, 16);
    stroke(
        &mut even,
        &rectangle(1, 1, 11, 11),
        2,
        StrokeAlign::Center,
        Join::Miter { limit_q8: 1024 },
        Cap::Butt,
    );
    assert_eq!(even.pixel_premul(0, 5)[3], 255);
    assert_eq!(even.pixel_premul(1, 5)[3], 255);
    assert_eq!(even.pixel_premul(2, 5)[3], 0);
}

#[test]
fn row_g7_center_ink_and_symmetry() {
    let ink = |h: &mut Harness| -> f64 {
        let pixels = h.pixels(rect(0, 0, 31, 31));
        pixels.bytes.chunks_exact(4).map(|p| p[3] as f64).sum()
    };
    // 0°, 45° and a shallow 21.8° segment, each at an odd and an even width.
    for width in [1, 2] {
        for (dx, dy) in [(10, 0), (8, 8), (10, 4)] {
            let mut h = Harness::new();
            h.begin(32, 32);
            stroke(
                &mut h,
                &[Verb::Move(4, 10), Verb::Line(4 + dx, 10 + dy)],
                width,
                StrokeAlign::Center,
                Join::Bevel,
                Cap::Butt,
            );
            let length = f64::from(dx * dx + dy * dy).sqrt();
            let expected = f64::from(width) * length * 255.0;
            let actual = ink(&mut h);
            assert!(
                (actual - expected).abs() / expected <= 0.02,
                "width {width}, direction {dx},{dy}: ink {actual}, expected {expected}"
            );
        }
    }
    for width in [1, 2] {
        let mut diagonal = Harness::new();
        diagonal.begin(32, 32);
        stroke(
            &mut diagonal,
            &[Verb::Move(4, 10), Verb::Line(12, 18)],
            width,
            StrokeAlign::Center,
            Join::Bevel,
            Cap::Butt,
        );
        assert_eq!(
            diagonal.pixel_premul(7, 14),
            diagonal.pixel_premul(8, 13),
            "the centered diagonal is symmetric at width {width}"
        );
        let pixels = diagonal.pixels(rect(0, 0, 31, 31));
        let stride = pixels.stride as usize;
        let (mut weight, mut sx, mut sy) = (0.0_f64, 0.0_f64, 0.0_f64);
        let (mut min_x, mut max_x, mut min_y, mut max_y) = (31, 0, 31, 0);
        for y in 0..32 {
            for x in 0..32 {
                let alpha = pixels.bytes[y as usize * stride + x as usize * 4 + 3] as f64;
                if alpha == 0.0 {
                    continue;
                }
                weight += alpha;
                sx += alpha * x as f64;
                sy += alpha * y as f64;
                min_x = min_x.min(x);
                max_x = max_x.max(x);
                min_y = min_y.min(y);
                max_y = max_y.max(y);
            }
        }
        assert!(weight > 0.0);
        assert!(
            (sx / weight - 8.0).abs() <= 0.5,
            "centroid x, width {width}"
        );
        assert!(
            (sy / weight - 14.0).abs() <= 0.5,
            "centroid y, width {width}"
        );
        assert!(
            ((min_x + max_x) as f64 / 2.0 - 8.0).abs() <= 0.5,
            "bbox centre x, width {width}"
        );
        assert!(
            ((min_y + max_y) as f64 / 2.0 - 14.0).abs() <= 0.5,
            "bbox centre y, width {width}"
        );
    }
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
            width_q8: 256,
            align: StrokeAlign::Inside,
            join: Join::Miter { limit_q8: 1024 },
            cap: Cap::Butt,
            peak: Peak::Light,
        }),
    );
    assert_eq!(area, rect(0, 0, 9, 9));
}
