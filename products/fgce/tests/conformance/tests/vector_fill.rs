//! §12 rows 82, 86, 89, 90, 101, 102, 113–116, 128–132, 151, 152:
//! path grammar, fill coverage, `NonZero`/`EvenOdd`, `Measure` fill and limits.
//!
//! Rows 103, 104, 134 and 139 observe the internal flattening/8.8 rounding and
//! are covered by unit tests inside `fgce` (`vector.rs`), not through `submit`.

use fgce::{Color, Error, Fill, FillRule, Rect, Verb};
use fgce_conformance::{Harness, RED, WHITE, rect};

fn closed_rectangle(x1: i32, y1: i32, x2: i32, y2: i32) -> [Verb; 5] {
    [
        Verb::Move(x1, y1),
        Verb::Line(x2, y1),
        Verb::Line(x2, y2),
        Verb::Line(x1, y2),
        Verb::Close,
    ]
}

fn frame(h: &mut Harness, width: i32, height: i32) -> Vec<[u8; 4]> {
    (0..height)
        .flat_map(|y| (0..width).map(move |x| (x, y)))
        .map(|(x, y)| h.pixel(x, y))
        .collect()
}

#[test]
fn row_82_line_after_close_is_bad_path() {
    let mut h = Harness::new();
    h.begin(16, 16);
    let verbs = [
        Verb::Move(0, 0),
        Verb::Line(4, 0),
        Verb::Close,
        Verb::Line(0, 4),
    ];
    assert_eq!(
        h.try_fill_path(&verbs, FillRule::NonZero, WHITE),
        Error::BadPath
    );
    assert_eq!(
        h.try_stroke_path(
            &verbs,
            1,
            fgce::StrokeAlign::Outside,
            fgce::Join::Bevel,
            fgce::Cap::Butt,
            WHITE
        ),
        Error::BadPath
    );
}

#[test]
fn row_86_measure_rectangle() {
    let mut h = Harness::new();
    let area = h.measure(
        &closed_rectangle(0, 0, 10, 10),
        Some(Fill {
            rule: FillRule::NonZero,
        }),
        None,
    );
    assert_eq!(area, rect(0, 0, 9, 9), "path (0,0)-(10,10) paints 0..=9");
}

#[test]
fn row_89_measure_empty_path_is_bad_path() {
    let mut h = Harness::new();
    assert_eq!(
        h.try_measure(
            &[],
            Some(Fill {
                rule: FillRule::NonZero,
            }),
            None,
        ),
        Error::BadPath
    );
}

#[test]
fn row_90_coverage_of_one_512th_is_one() {
    let mut h = Harness::new();
    h.begin(4, 4);
    // Hypotenuse (0,0)-(256,1) cuts 1/512 of pixel (0,0): cover = 1, alpha = 1.
    let verbs = [
        Verb::Move(0, 0),
        Verb::Line(256, 0),
        Verb::Line(256, 1),
        Verb::Close,
    ];
    h.fill_path(&verbs, FillRule::NonZero, WHITE);
    assert_eq!(h.pixel(0, 0)[3], 1);
}

#[test]
fn row_101_path_rectangle_matches_fill_rect() {
    let mut path = Harness::new();
    path.begin(16, 16);
    path.fill_path(&closed_rectangle(0, 0, 10, 10), FillRule::NonZero, WHITE);

    let mut direct = Harness::new();
    direct.begin(16, 16);
    direct.fill(rect(0, 0, 9, 9), WHITE);

    assert_eq!(frame(&mut path, 16, 16), frame(&mut direct, 16, 16));
}

#[test]
fn row_102_fill_path_without_close_equals_with_close() {
    let open = [
        Verb::Move(0, 0),
        Verb::Line(10, 0),
        Verb::Line(10, 10),
        Verb::Line(0, 10),
    ];
    let mut without = Harness::new();
    without.begin(16, 16);
    without.fill_path(&open, FillRule::NonZero, WHITE);

    let mut with = Harness::new();
    with.begin(16, 16);
    with.fill_path(&closed_rectangle(0, 0, 10, 10), FillRule::NonZero, WHITE);

    assert_eq!(frame(&mut without, 16, 16), frame(&mut with, 16, 16));
}

#[test]
fn row_113_half_covered_pixel_is_alpha_128() {
    let mut h = Harness::new();
    h.begin(16, 16);
    h.fill_path(
        &[
            Verb::Move(0, 0),
            Verb::Line(4, 0),
            Verb::Line(0, 4),
            Verb::Close,
        ],
        FillRule::NonZero,
        WHITE,
    );
    assert_eq!(h.pixel_premul(3, 0), [128, 128, 128, 128]);
    assert_eq!(h.pixel_premul(0, 0), [255, 255, 255, 255]);
    assert_eq!(h.pixel_premul(4, 0), [0, 0, 0, 0]);
}

#[test]
fn row_114_shallow_edge_area_is_fifteen_sixteenths() {
    let mut h = Harness::new();
    h.begin(16, 16);
    h.fill_path(
        &[
            Verb::Move(0, 0),
            Verb::Line(8, 1),
            Verb::Line(0, 1),
            Verb::Close,
        ],
        FillRule::NonZero,
        WHITE,
    );
    assert_eq!(h.pixel_premul(0, 0)[3], 239, "cover 240, alpha 239");
}

#[test]
fn row_115_exact_area_is_not_midpoint_sampling() {
    let mut h = Harness::new();
    h.begin(16, 16);
    h.fill_path(
        &[
            Verb::Move(0, 0),
            Verb::Line(8, 1),
            Verb::Line(0, 1),
            Verb::Close,
        ],
        FillRule::NonZero,
        WHITE,
    );
    let alpha = h.pixel_premul(0, 0)[3];
    assert_eq!(alpha, 239, "exact area 15/16");
    assert_ne!(alpha, 255, "midpoint sampling would paint the whole pixel");
}

#[test]
fn row_116_half_coverage_scales_the_color_alpha() {
    let mut h = Harness::new();
    h.begin(16, 16);
    h.fill_path(
        &[
            Verb::Move(0, 0),
            Verb::Line(4, 0),
            Verb::Line(0, 4),
            Verb::Close,
        ],
        FillRule::NonZero,
        Color {
            r: 255,
            g: 0,
            b: 0,
            a: 128,
        },
    );
    assert_eq!(h.pixel_premul(3, 0), [64, 0, 0, 64]);
}

fn square_with_hole() -> [Verb; 10] {
    [
        Verb::Move(0, 0),
        Verb::Line(6, 0),
        Verb::Line(6, 6),
        Verb::Line(0, 6),
        Verb::Close,
        Verb::Move(2, 2),
        Verb::Line(4, 2),
        Verb::Line(4, 4),
        Verb::Line(2, 4),
        Verb::Close,
    ]
}

#[test]
fn row_128_even_odd_keeps_the_hole() {
    let mut h = Harness::new();
    h.begin(16, 16);
    h.fill_path(&square_with_hole(), FillRule::EvenOdd, WHITE);
    assert_eq!(h.pixel_premul(3, 3), [0, 0, 0, 0], "hole centre");
    assert_eq!(h.pixel_premul(0, 0), [255, 255, 255, 255], "outer corner");
}

#[test]
fn row_129_nonzero_fills_the_hole() {
    let mut h = Harness::new();
    h.begin(16, 16);
    h.fill_path(&square_with_hole(), FillRule::NonZero, WHITE);
    assert_eq!(h.pixel_premul(3, 3), [255, 255, 255, 255], "hole centre");
    assert_eq!(h.pixel_premul(0, 0), [255, 255, 255, 255], "outer corner");
}

fn bands(reverse_second: bool) -> [Verb; 10] {
    let second = if reverse_second {
        [
            Verb::Move(5, 0),
            Verb::Line(5, 10),
            Verb::Line(15, 10),
            Verb::Line(15, 0),
            Verb::Close,
        ]
    } else {
        [
            Verb::Move(5, 0),
            Verb::Line(15, 0),
            Verb::Line(15, 10),
            Verb::Line(5, 10),
            Verb::Close,
        ]
    };
    [
        Verb::Move(0, 0),
        Verb::Line(10, 0),
        Verb::Line(10, 10),
        Verb::Line(0, 10),
        Verb::Close,
        second[0],
        second[1],
        second[2],
        second[3],
        second[4],
    ]
}

#[test]
fn row_130_same_winding_bands_nonzero_paints_evenodd_does_not() {
    let mut nonzero = Harness::new();
    nonzero.begin(16, 16);
    nonzero.fill_path(&bands(false), FillRule::NonZero, WHITE);
    assert_eq!(nonzero.pixel_premul(5, 0)[3], 255);

    let mut evenodd = Harness::new();
    evenodd.begin(16, 16);
    evenodd.fill_path(&bands(false), FillRule::EvenOdd, WHITE);
    assert_eq!(evenodd.pixel_premul(5, 0)[3], 0);
}

#[test]
fn row_131_reversed_band_cancels_nonzero() {
    let mut nonzero = Harness::new();
    nonzero.begin(16, 16);
    nonzero.fill_path(&bands(true), FillRule::NonZero, WHITE);
    assert_eq!(nonzero.pixel_premul(5, 0)[3], 0);

    let mut evenodd = Harness::new();
    evenodd.begin(16, 16);
    evenodd.fill_path(&bands(true), FillRule::EvenOdd, WHITE);
    assert_eq!(evenodd.pixel_premul(5, 0)[3], 0);
}

#[test]
fn row_132_bow_tie_cover_sum_is_fifty_squares() {
    let verbs = [
        Verb::Move(0, 0),
        Verb::Line(10, 10),
        Verb::Line(10, 0),
        Verb::Line(0, 10),
        Verb::Close,
    ];
    for rule in [FillRule::NonZero, FillRule::EvenOdd] {
        let mut h = Harness::new();
        h.begin(16, 16);
        h.fill_path(&verbs, rule, WHITE);
        // `cover = alpha * 256 / 255` recovers the exact sum up to one per pixel.
        let mut cover = 0_u64;
        for y in 0..16 {
            for x in 0..16 {
                let alpha = h.pixel_premul(x, y)[3] as u64;
                cover += (alpha * 256 + 127) / 255;
            }
        }
        let expected = 50 * 256;
        assert!(
            cover.abs_diff(expected) <= 256,
            "{rule:?}: cover sum {cover} vs {expected}"
        );
    }
}

#[test]
fn row_151_65537_vertices_is_bad_path() {
    let mut h = Harness::new();
    h.begin(16, 16);
    let mut verbs = Vec::with_capacity(65_537);
    verbs.push(Verb::Move(0, 0));
    for i in 0..65_536 {
        verbs.push(Verb::Line(i % 8, i % 8));
    }
    assert_eq!(verbs.len(), 65_537);
    assert_eq!(
        h.try_fill_path(&verbs, FillRule::NonZero, WHITE),
        Error::BadPath
    );
    assert_eq!(
        h.try_measure(
            &verbs,
            Some(Fill {
                rule: FillRule::NonZero
            }),
            None
        ),
        Error::BadPath
    );
}

#[test]
fn row_152_coordinate_over_the_limit_is_overflow() {
    let mut h = Harness::new();
    h.begin(16, 16);
    let verbs = [
        Verb::Move(1_048_577, 0),
        Verb::Line(0, 0),
        Verb::Line(0, 1),
        Verb::Close,
    ];
    assert_eq!(
        h.try_fill_path(&verbs, FillRule::NonZero, WHITE),
        Error::Overflow
    );
    assert_eq!(
        h.try_measure(
            &verbs,
            Some(Fill {
                rule: FillRule::NonZero,
            }),
            None,
        ),
        Error::Overflow
    );
    assert_eq!(
        h.err(fgce::Request::EdgePx {
            edge: fgce::Edge::Pixel(1_048_577),
            k: 5,
        }),
        Error::Overflow,
        "edge coordinate"
    );
    h.ok(fgce_conformance::flat(1, 0, 0, 9, 9, WHITE));
    assert_eq!(
        h.try_place(1, rect(1_048_577, 0, 1_048_586, 9)),
        Error::Overflow,
        "a coordinate"
    );
}

#[test]
fn row_101_rect_paints_the_pixel_range_only() {
    let mut h = Harness::new();
    h.begin(6, 1);
    h.fill_path(&closed_rectangle(0, 0, 4, 1), FillRule::NonZero, RED);
    assert_eq!(h.pixel_premul(0, 0), [255, 0, 0, 255]);
    assert_eq!(h.pixel_premul(3, 0), [255, 0, 0, 255]);
    assert_eq!(h.pixel_premul(4, 0), [0, 0, 0, 0], "vertices stop at 4");
}

#[test]
fn path_rectangle_rect_helper_matches_spec_bounds() {
    let mut h = Harness::new();
    let area: Rect = h.measure(
        &closed_rectangle(-3, 2, 7, 5),
        Some(Fill {
            rule: FillRule::NonZero,
        }),
        None,
    );
    assert_eq!(area, rect(-3, 2, 6, 4));
}
