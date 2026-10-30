//! §12 0.2.0 rows: fractional stroke widths (`Stroke::width_q8`, REQ-9).
//!
//! `width_q8` counts 1/256 sPx, so `205` is 0.8 sPx and `179` is 0.7 sPx. The
//! golden icons of `icons.rs` keep their whole-pixel widths: a whole width is
//! `width · 256` and stays byte-identical.

use fgce::{
    Cap, Color, Entity, EntityKind, Error, Join, NodeId, Peak, Radius, Rect, Request, SPX_Q8,
    Stroke, StrokeAlign, Verb,
};
use fgce_conformance::{Harness, WHITE, pixels, rect};

const MUTED: Color = Color {
    r: 171,
    g: 171,
    b: 171,
    a: 255,
};

/// 0.8 sPx in 1/256 steps: `round(0.8 · 256)`.
const FRAME_WIDTH: u32 = 205;
/// 0.7 sPx in 1/256 steps: `round(0.7 · 256)`.
const CROSS_WIDTH: u32 = 179;

struct Stats {
    bbox: Option<Rect>,
    max_channel: u8,
    max_alpha: u8,
    ink: f64,
}

fn stats(bytes: &[u8], width: u32, height: u32) -> Stats {
    let stride = bytes.len() / height as usize;
    let mut bbox: Option<Rect> = None;
    let mut max_channel = 0;
    let mut max_alpha = 0;
    let mut ink = 0.0;
    for y in 0..height as i32 {
        for x in 0..width as i32 {
            let at = y as usize * stride + x as usize * 4;
            let alpha = bytes[at + 3];
            max_alpha = max_alpha.max(alpha);
            max_channel = max_channel.max(bytes[at].max(bytes[at + 1]).max(bytes[at + 2]));
            ink += alpha as f64 / 255.0;
            if alpha == 0 {
                continue;
            }
            bbox = Some(match bbox {
                None => rect(x, y, x, y),
                Some(area) => rect(
                    area.x1.min(x),
                    area.y1.min(y),
                    area.x2.max(x),
                    area.y2.max(y),
                ),
            });
        }
    }
    Stats {
        bbox,
        max_channel,
        max_alpha,
        ink,
    }
}

fn square(x: i32, y: i32, side: i32) -> [Verb; 5] {
    [
        Verb::Move(x, y),
        Verb::Line(x + side, y),
        Verb::Line(x + side, y + side),
        Verb::Line(x, y + side),
        Verb::Close,
    ]
}

fn inside(width_q8: u32, peak: Peak) -> Stroke {
    Stroke {
        width_q8,
        align: StrokeAlign::Inside,
        join: Join::Miter { limit_q8: 1024 },
        cap: Cap::Butt,
        peak,
    }
}

fn center(width_q8: u32, peak: Peak) -> Stroke {
    Stroke {
        width_q8,
        align: StrokeAlign::Center,
        join: Join::Bevel,
        cap: Cap::Butt,
        peak,
    }
}

#[test]
fn row_g12_frame_icon_with_a_fractional_width() {
    let mut h = Harness::new();
    h.begin(16, 16);
    h.ok(Request::StrokeRoundRect {
        rect: rect(0, 0, 12, 12),
        radius: None,
        // `Stroke::q8` is the short form of the spec: Miter 1024, Butt, Light.
        stroke: Stroke::q8(FRAME_WIDTH, StrokeAlign::Inside),
        color: MUTED,
        blend: None,
    });
    let frame = h.end();
    let stats = stats(&frame.bytes, frame.width, frame.height);
    assert_eq!(stats.bbox, Some(rect(0, 0, 12, 12)));
    // The corner pixel carries two `0.8` bands minus their square: coverage
    // `2·205/256 − (205/256)²` rounds to 246, alpha 245. The mask's corner gave
    // 156; the difference is exactly these four ring pixels, the ink matches.
    assert_eq!(stats.max_alpha, 245);
    assert_eq!(stats.max_channel, 164);
    // Exact band area: `13² − (13 − 2·205/256)²`, quantized per pixel to 1/256.
    assert!(
        (stats.ink - 39.043).abs() < 0.01,
        "frame ink = {}",
        stats.ink
    );
}

#[test]
fn row_g12_cross_icon_with_a_fractional_width() {
    // Corner to corner, as Luna's cross: the strokes run `(0,0)→(10,10)` and
    // `(10,0)→(0,10)` inside an 11×11 box.
    let mut h = Harness::new();
    h.begin(16, 16);
    for verbs in [
        [Verb::Move(0, 0), Verb::Line(10, 10)],
        [Verb::Move(10, 0), Verb::Line(0, 10)],
    ] {
        h.ok(Request::StrokePath {
            verbs: &verbs,
            stroke: center(CROSS_WIDTH, Peak::Nominal),
            color: MUTED,
            blend: None,
        });
    }
    let frame = h.end();
    let stats = stats(&frame.bytes, frame.width, frame.height);
    assert_eq!(stats.bbox, Some(rect(0, 0, 10, 10)));
    // `Peak::Nominal` lifts the global coverage peak to full coverage, so the
    // crossing pixel keeps the opaque `MUTED` channel.
    assert_eq!(stats.max_alpha, 255);
    assert_eq!(stats.max_channel, 171);
    assert!(
        (stats.ink - 25.663).abs() < 0.01,
        "cross ink = {}",
        stats.ink
    );
}

#[test]
fn row_g12_whole_width_is_256() {
    let verbs = square(1, 1, 9);
    let mut whole = Harness::new();
    whole.begin(16, 16);
    whole.ok(Request::StrokePath {
        verbs: &verbs,
        stroke: Stroke::px(1, StrokeAlign::Inside),
        color: WHITE,
        blend: None,
    });
    let whole = whole.end().bytes;

    let mut q8 = Harness::new();
    q8.begin(16, 16);
    q8.ok(Request::StrokePath {
        verbs: &verbs,
        stroke: inside(SPX_Q8, Peak::Light),
        color: WHITE,
        blend: None,
    });
    assert_eq!(whole, q8.end().bytes, "1 sPx is 256 q8 units");
}

#[test]
fn row_g12_zero_width_q8_is_bad_stroke() {
    let zero = inside(0, Peak::Light);
    let verbs = square(0, 0, 9);
    let mut h = Harness::new();
    h.begin(16, 16);
    for request in [
        Request::StrokePath {
            verbs: &verbs,
            stroke: zero,
            color: WHITE,
            blend: None,
        },
        Request::StrokeRoundRect {
            rect: rect(0, 0, 9, 9),
            radius: None,
            stroke: zero,
            color: WHITE,
            blend: None,
        },
        Request::Entity(Entity {
            id: NodeId(1),
            kind: EntityKind::Vector {
                verbs: &verbs,
                fill: None,
                stroke: Some(zero),
                color: WHITE,
            },
            on_grid: Some(false),
            edges: pixels(0, 0, 9, 9),
            align: None,
            blend: None,
            radius: None,
        }),
    ] {
        assert_eq!(h.submit(request).unwrap_err(), Error::BadStroke);
    }
    assert_eq!(
        h.submit(Request::Measure {
            verbs: &verbs,
            fill: None,
            stroke: Some(zero),
        })
        .unwrap_err(),
        Error::BadStroke
    );
    // `Box` has no geometric measure of its own: the width is read on paint.
    h.ok(Request::Entity(Entity {
        id: NodeId(2),
        kind: EntityKind::Box {
            fill: None,
            stroke: Some(zero),
            color: WHITE,
        },
        on_grid: Some(false),
        edges: pixels(0, 0, 9, 9),
        align: None,
        blend: None,
        radius: None,
    }));
    assert_eq!(h.submit(Request::End).unwrap_err(), Error::BadStroke);
}

#[test]
fn row_g12_carriers_agree_on_a_fraction() {
    let verbs = square(0, 0, 10);
    let stroke = inside(FRAME_WIDTH, Peak::Light);

    let mut direct = Harness::new();
    direct.begin(16, 16);
    direct.ok(Request::StrokePath {
        verbs: &verbs,
        stroke,
        color: WHITE,
        blend: None,
    });
    let direct = direct.end().bytes;

    let mut round_rect = Harness::new();
    round_rect.begin(16, 16);
    round_rect.ok(Request::StrokeRoundRect {
        rect: rect(0, 0, 9, 9),
        radius: Some(Radius::Percent(0)),
        stroke,
        color: WHITE,
        blend: None,
    });
    let round_rect = round_rect.end().bytes;

    let mut vector = Harness::new();
    vector.begin(16, 16);
    vector.ok(Request::Entity(Entity {
        id: NodeId(1),
        kind: EntityKind::Vector {
            verbs: &verbs,
            fill: None,
            stroke: Some(stroke),
            color: WHITE,
        },
        on_grid: Some(false),
        edges: pixels(0, 0, 15, 15),
        align: None,
        blend: None,
        radius: None,
    }));
    let vector = vector.end().bytes;

    let mut boxed = Harness::new();
    boxed.begin(16, 16);
    boxed.ok(Request::Entity(Entity {
        id: NodeId(1),
        kind: EntityKind::Box {
            fill: None,
            stroke: Some(stroke),
            color: WHITE,
        },
        on_grid: Some(false),
        edges: pixels(0, 0, 9, 9),
        align: None,
        blend: None,
        radius: None,
    }));
    let boxed = boxed.end().bytes;

    assert_eq!(direct, round_rect, "StrokeRoundRect matches StrokePath");
    assert_eq!(direct, vector, "Vector matches StrokePath");
    assert_eq!(direct, boxed, "Box stroke matches StrokePath");
}

#[test]
fn row_g12_light_keeps_the_band_light() {
    // One 45° stroke of 0.7 sPx: the light is `w · L`, independent of the
    // direction; only the per-pixel profile is antialiased.
    let mut h = Harness::new();
    h.begin(32, 32);
    h.ok(Request::StrokePath {
        verbs: &[Verb::Move(4, 4), Verb::Line(20, 20)],
        stroke: center(CROSS_WIDTH, Peak::Light),
        color: WHITE,
        blend: None,
    });
    let frame = h.end();
    let stats = stats(&frame.bytes, frame.width, frame.height);
    let length = (16.0_f64 * 16.0 + 16.0 * 16.0).sqrt();
    let expected = (CROSS_WIDTH as f64 / 256.0) * length;
    assert!(
        (stats.ink - expected).abs() / expected <= 0.02,
        "light ink {} against w·L {}",
        stats.ink,
        expected
    );
}

#[test]
fn row_g12_nominal_lifts_the_fractional_peak() {
    let verbs = [Verb::Move(4, 4), Verb::Line(20, 20)];
    let mut light = Harness::new();
    light.begin(32, 32);
    light.ok(Request::StrokePath {
        verbs: &verbs,
        stroke: center(CROSS_WIDTH, Peak::Light),
        color: WHITE,
        blend: None,
    });
    let light = light.end();

    let mut nominal = Harness::new();
    nominal.begin(32, 32);
    nominal.ok(Request::StrokePath {
        verbs: &verbs,
        stroke: center(CROSS_WIDTH, Peak::Nominal),
        color: WHITE,
        blend: None,
    });
    let nominal = nominal.end();

    let light_stats = stats(&light.bytes, light.width, light.height);
    let nominal_stats = stats(&nominal.bytes, nominal.width, nominal.height);
    assert!(
        light_stats.max_alpha < 255,
        "a 45° band below one sPx never covers a pixel fully"
    );
    assert_eq!(
        nominal_stats.max_alpha, 255,
        "Nominal normalizes the global peak to full coverage"
    );
    assert!(nominal_stats.ink > light_stats.ink);
}

#[test]
fn row_g12_measure_includes_the_fractional_band() {
    let mut h = Harness::new();
    let contour = square(0, 0, 10);
    let outside_stroke = Stroke {
        align: StrokeAlign::Outside,
        ..inside(FRAME_WIDTH, Peak::Light)
    };
    let outside = h.measure(&contour, None, Some(outside_stroke));
    assert_eq!(
        outside,
        rect(-1, -1, 10, 10),
        "0.8 sPx outside reaches the neighbouring pixel rows"
    );

    let inside_area = h.measure(&contour, None, Some(inside(FRAME_WIDTH, Peak::Light)));
    assert_eq!(inside_area, rect(0, 0, 9, 9), "inside stays in the contour");
}

#[test]
fn row_g12_outside_band_paints_the_fraction() {
    let mut h = Harness::new();
    h.begin(16, 16);
    h.ok(Request::StrokePath {
        verbs: &square(4, 4, 8),
        stroke: Stroke {
            align: StrokeAlign::Outside,
            ..inside(FRAME_WIDTH, Peak::Light)
        },
        color: WHITE,
        blend: None,
    });
    let frame = h.end();
    // The band starts at the contour edge and is 0.8 wide: the pixel just
    // outside carries coverage 0.8, the interior and the pixel beyond stay clear.
    assert_eq!(frame.pixel(3, 5)[3], 204, "0.8 sPx outside band");
    assert_eq!(frame.pixel(12, 5)[3], 204, "far side of the band");
    assert_eq!(frame.pixel(4, 5)[3], 0, "the contour pixel is not painted");
    assert_eq!(frame.pixel(2, 5)[3], 0, "the band does not reach further");
}

#[test]
fn row_g12_center_joins_caps_and_radius_keep_the_fraction() {
    let path = [Verb::Move(2, 2), Verb::Line(8, 2), Verb::Line(8, 8)];
    let ink = |join: Join, cap: Cap| -> f64 {
        let mut h = Harness::new();
        h.begin(16, 16);
        h.ok(Request::StrokePath {
            verbs: &path,
            stroke: Stroke {
                width_q8: CROSS_WIDTH,
                align: StrokeAlign::Center,
                join,
                cap,
                peak: Peak::Light,
            },
            color: WHITE,
            blend: None,
        });
        h.end()
            .bytes
            .chunks_exact(4)
            .map(|pixel| pixel[3] as f64 / 255.0)
            .sum()
    };
    let bevel = ink(Join::Bevel, Cap::Butt);
    let round = ink(Join::Round, Cap::Butt);
    let miter = ink(Join::Miter { limit_q8: 1024 }, Cap::Butt);
    assert!(round > bevel, "round join adds light: {round} vs {bevel}");
    assert!(
        miter >= round,
        "miter join is at least as heavy: {miter} vs {round}"
    );
    assert!(
        ink(Join::Bevel, Cap::Square) > bevel,
        "square cap adds light"
    );
    assert!(ink(Join::Bevel, Cap::Round) > bevel, "round cap adds light");

    // A rounded contour keeps the same fraction through its arcs.
    let stroke = Stroke::q8(FRAME_WIDTH, StrokeAlign::Inside);
    let mut rounded = Harness::new();
    rounded.begin(16, 16);
    rounded.ok(Request::StrokeRoundRect {
        rect: rect(2, 2, 13, 13),
        radius: Some(Radius::Percent(50)),
        stroke,
        color: WHITE,
        blend: None,
    });
    let rounded = rounded.end().bytes;

    let mut boxed = Harness::new();
    boxed.begin(16, 16);
    boxed.ok(Request::Entity(Entity {
        id: NodeId(1),
        kind: EntityKind::Box {
            fill: None,
            stroke: Some(stroke),
            color: WHITE,
        },
        on_grid: Some(false),
        edges: pixels(2, 2, 13, 13),
        align: None,
        blend: None,
        radius: Some(Radius::Percent(50)),
    }));
    assert_eq!(
        rounded,
        boxed.end().bytes,
        "rounded contours agree at 0.8 sPx"
    );
}
