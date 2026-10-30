//! §12 0.16 rows: `Peak::Light` is the default and `Peak::Nominal` normalizes
//! the whole stroke by its maximum coverage.

use fgce::{
    Cap, Entity, EntityKind, Join, NodeId, Peak, Radius, Request, Stroke, StrokeAlign, Verb,
};
use fgce_conformance::{Harness, WHITE, pixels, rect};

fn stroke(width: u32, align: StrokeAlign, peak: Peak) -> Stroke {
    Stroke {
        width_q8: width * 256,
        align,
        join: Join::Bevel,
        cap: Cap::Butt,
        peak,
    }
}

fn draw(h: &mut Harness, verbs: &[Verb], stroke: Stroke) -> Vec<u8> {
    h.begin(16, 16);
    h.ok(Request::StrokePath {
        verbs,
        stroke,
        color: WHITE,
        blend: None,
    });
    h.end().bytes
}

fn max_alpha(bytes: &[u8]) -> u8 {
    bytes
        .chunks_exact(4)
        .map(|pixel| pixel[3])
        .max()
        .unwrap_or(0)
}

fn ink(bytes: &[u8]) -> f64 {
    bytes.chunks_exact(4).map(|pixel| pixel[3] as f64).sum()
}

#[test]
fn row_g9_light_is_the_default_and_keeps_the_frame() {
    let verbs = [Verb::Move(0, 0), Verb::Line(10, 10)];
    let mut default = Harness::new();
    default.begin(16, 16);
    default.stroke_path(
        &verbs,
        1,
        StrokeAlign::Center,
        Join::Bevel,
        Cap::Butt,
        WHITE,
    );
    let default = default.end().bytes;

    let mut light = Harness::new();
    let light = draw(
        &mut light,
        &verbs,
        stroke(1, StrokeAlign::Center, Peak::Light),
    );
    assert_eq!(default, light);

    let mut nominal = Harness::new();
    let nominal = draw(
        &mut nominal,
        &verbs,
        stroke(1, StrokeAlign::Center, Peak::Nominal),
    );
    assert_ne!(light, nominal, "a diagonal stroke is normalized");
}

#[test]
fn row_g9_diagonal_and_horizontal_peak_are_equal() {
    for width in [1, 2] {
        let mut horizontal = Harness::new();
        let horizontal = draw(
            &mut horizontal,
            &[Verb::Move(0, 5), Verb::Line(10, 5)],
            stroke(width, StrokeAlign::Center, Peak::Nominal),
        );
        let mut diagonal = Harness::new();
        let diagonal = draw(
            &mut diagonal,
            &[Verb::Move(0, 0), Verb::Line(10, 10)],
            stroke(width, StrokeAlign::Center, Peak::Nominal),
        );
        assert_eq!(
            max_alpha(&horizontal),
            max_alpha(&diagonal),
            "width {width}: peak must be the same in both directions"
        );
        assert_eq!(max_alpha(&diagonal), 255);
    }
}

#[test]
fn row_g9_peak_is_global_and_scales_the_whole_stroke() {
    let verbs = [Verb::Move(0, 0), Verb::Line(8, 8)];
    let mut light = Harness::new();
    let light = draw(
        &mut light,
        &verbs,
        stroke(1, StrokeAlign::Center, Peak::Light),
    );
    let mut nominal = Harness::new();
    let nominal = draw(
        &mut nominal,
        &verbs,
        stroke(1, StrokeAlign::Center, Peak::Nominal),
    );
    let light_peak = max_alpha(&light);
    assert!(light_peak > 128, "a 45° pixel peak is above half");
    // Integer `256 / peak` would be 1 here; the fixed-point formula must lift
    // the whole profile to 256.
    assert_eq!(max_alpha(&nominal), 255);
    let ratio = ink(&nominal) / ink(&light);
    assert!(ratio > 1.0, "normalization adds light, ratio {ratio}");
    let width_light = light
        .chunks_exact(4)
        .filter(|pixel| pixel[3] > light_peak / 2)
        .count();
    let width_nominal = nominal
        .chunks_exact(4)
        .filter(|pixel| pixel[3] > 128)
        .count();
    assert_eq!(width_light, width_nominal, "the profile width is preserved");
}

#[test]
fn row_g9_mixed_orientation_with_an_axial_segment_stays_light() {
    // A full axis-aligned segment has peak 256, so the global scale is one and
    // the diagonal part of the same stroke stays unnormalized.
    let verbs = [Verb::Move(0, 5), Verb::Line(10, 5), Verb::Line(15, 10)];
    let mut light = Harness::new();
    let light = draw(
        &mut light,
        &verbs,
        stroke(2, StrokeAlign::Center, Peak::Light),
    );
    let mut nominal = Harness::new();
    let nominal = draw(
        &mut nominal,
        &verbs,
        stroke(2, StrokeAlign::Center, Peak::Nominal),
    );
    assert_eq!(light, nominal);
}

#[test]
fn row_g9_empty_geometry_is_a_no_op() {
    let mut h = Harness::new();
    h.begin(8, 8);
    h.ok(Request::StrokePath {
        verbs: &[Verb::Move(2, 2)],
        stroke: stroke(1, StrokeAlign::Center, Peak::Nominal),
        color: WHITE,
        blend: None,
    });
    assert_eq!(h.pixel_premul(2, 2), [0, 0, 0, 0]);
}

#[test]
fn row_g9_carriers_normalize_the_same_diagonal() {
    let verbs = [Verb::Move(1, 1), Verb::Line(10, 10)];
    let mut direct = Harness::new();
    direct.begin(16, 16);
    direct.ok(Request::StrokePath {
        verbs: &verbs,
        stroke: stroke(1, StrokeAlign::Center, Peak::Nominal),
        color: WHITE,
        blend: None,
    });
    let direct = direct.end().bytes;

    let mut entity = Harness::new();
    entity.begin(16, 16);
    entity.ok(Request::Entity(Entity {
        id: NodeId(1),
        kind: EntityKind::Vector {
            verbs: &verbs,
            fill: None,
            stroke: Some(stroke(1, StrokeAlign::Center, Peak::Nominal)),
            color: WHITE,
        },
        on_grid: Some(false),
        edges: pixels(0, 0, 15, 15),
        align: None,
        blend: None,
        radius: None,
    }));
    let entity = entity.end().bytes;
    assert_eq!(direct, entity, "StrokePath and EntityKind::Vector agree");

    let mut rounded = Harness::new();
    rounded.begin(16, 16);
    rounded.ok(Request::StrokeRoundRect {
        rect: rect(2, 2, 13, 13),
        radius: Some(Radius::Percent(50)),
        stroke: stroke(1, StrokeAlign::Inside, Peak::Nominal),
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
            stroke: Some(stroke(1, StrokeAlign::Inside, Peak::Nominal)),
            color: WHITE,
        },
        on_grid: Some(false),
        edges: pixels(2, 2, 13, 13),
        align: None,
        blend: None,
        radius: Some(Radius::Percent(50)),
    }));
    let boxed = boxed.end().bytes;
    assert_eq!(
        rounded, boxed,
        "StrokeRoundRect and Box stroke agree on a rounded contour"
    );
}

#[test]
fn row_g9_diagonal_is_not_byte_identical_to_light() {
    // The price is documented: a diagonal at width 1 gains about 9.4 % of light
    // when the integer scale trap is avoided.
    let verbs = [Verb::Move(1, 1), Verb::Line(10, 10)];
    let mut light = Harness::new();
    let light = draw(
        &mut light,
        &verbs,
        stroke(1, StrokeAlign::Center, Peak::Light),
    );
    let mut nominal = Harness::new();
    let nominal = draw(
        &mut nominal,
        &verbs,
        stroke(1, StrokeAlign::Center, Peak::Nominal),
    );
    let ratio = ink(&nominal) / ink(&light);
    assert!(
        (ratio - 1.094).abs() < 0.05,
        "documented nominal price is about +9.4 %, got {ratio}"
    );
}
