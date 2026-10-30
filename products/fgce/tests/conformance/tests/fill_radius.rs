//! §12 0.16 rows: `FillRect { radius }` and `StrokeRoundRect`.

use fgce::{
    Blend, Cap, Color, Edge, Entity, EntityKind, Join, NodeId, Peak, Radius, Rect, Request, Stroke,
    StrokeAlign,
};
use fgce_conformance::{Harness, RED, WHITE, pixels, rect};

const BLUE: Color = Color {
    r: 20,
    g: 40,
    b: 200,
    a: 255,
};

fn box_entity(
    id: u32,
    area: Rect,
    radius: Option<Radius>,
    stroke: Option<Stroke>,
) -> Request<'static> {
    Request::Entity(Entity {
        id: NodeId(id),
        kind: EntityKind::Box {
            fill: if stroke.is_some() {
                None
            } else {
                Some(fgce::Fill {
                    rule: fgce::FillRule::NonZero,
                })
            },
            stroke,
            color: WHITE,
        },
        on_grid: Some(false),
        edges: pixels(area.x1, area.y1, area.x2, area.y2),
        align: None,
        blend: None,
        radius,
    })
}

fn fill_radius(
    area: Rect,
    radius: Option<Radius>,
    blend: Option<Blend>,
    color: Color,
) -> Request<'static> {
    Request::FillRect {
        rect: area,
        color,
        blend,
        radius,
    }
}

fn frame(mut harness: Harness) -> Vec<u8> {
    harness.end().bytes
}

fn compare(area: Rect, radius: Radius) {
    let mut painted = Harness::new();
    painted.begin(48, 48);
    painted.ok(fill_radius(area, Some(radius), None, WHITE));
    let painted = frame(painted);

    let mut entity = Harness::new();
    entity.begin(48, 48);
    entity.ok(box_entity(1, area, Some(radius), None));
    let entity = frame(entity);
    assert_eq!(
        painted, entity,
        "FillRect radius must match Box, radius {radius:?}"
    );
}

#[test]
fn row_g1_fill_rect_radius_matches_box() {
    compare(rect(0, 0, 44, 44), Radius::Percent(50));
    compare(rect(0, 0, 44, 29), Radius::Percent(50));
    compare(rect(0, 0, 19, 29), Radius::Edge(Edge::Pixel(100)));
}

#[test]
fn row_g2_none_and_zero_radius_are_the_plain_rect() {
    let mut plain = Harness::new();
    plain.begin(8, 8);
    plain.ok(fill_radius(rect(0, 0, 7, 7), None, None, BLUE));
    let plain = frame(plain);

    let mut zero = Harness::new();
    zero.begin(8, 8);
    zero.ok(fill_radius(
        rect(0, 0, 7, 7),
        Some(Radius::Edge(Edge::Pixel(0))),
        None,
        BLUE,
    ));
    assert_eq!(plain, frame(zero));
}

#[test]
fn fill_rect_dst_out_erases_the_shape() {
    let mut h = Harness::new();
    h.begin(12, 12);
    h.fill(rect(0, 0, 11, 11), RED);
    h.ok(fill_radius(
        rect(2, 2, 9, 9),
        Some(Radius::Edge(Edge::Pixel(3))),
        Some(Blend::DstOut),
        WHITE,
    ));
    assert_eq!(h.pixel_premul(5, 5), [0, 0, 0, 0], "the shape is erased");
    assert!(
        h.pixel_premul(2, 2)[0] > 240,
        "the outside of the rounded corner stays red"
    );
    assert_eq!(h.pixel_premul(0, 0), [255, 0, 0, 255], "outside stays red");
}

#[test]
fn row_g1_stroke_round_rect_matches_box_stroke() {
    // A tree entity clips its paint to its coordinate box, so the shared case
    // is an `Inside` stroke; `Center` would be cut on the outside.
    let stroke = Stroke {
        width_q8: 512,
        align: StrokeAlign::Inside,
        join: Join::Miter { limit_q8: 1024 },
        cap: Cap::Butt,
        peak: Peak::Light,
    };
    let area = rect(2, 2, 40, 30);
    let radius = Radius::Percent(30);

    let mut direct = Harness::new();
    direct.begin(48, 48);
    direct.ok(Request::StrokeRoundRect {
        rect: area,
        radius: Some(radius),
        stroke,
        color: WHITE,
        blend: None,
    });
    let direct = frame(direct);

    let mut entity = Harness::new();
    entity.begin(48, 48);
    entity.ok(box_entity(1, area, Some(radius), Some(stroke)));
    assert_eq!(direct, frame(entity));

    // `Center` is where the two differ by contract: a `Box` clips paint to its
    // coordinate box (§5.5), `StrokeRoundRect` only to the frame clip.
    let centered = Stroke {
        align: StrokeAlign::Center,
        ..stroke
    };
    let mut direct = Harness::new();
    direct.begin(48, 48);
    direct.ok(Request::StrokeRoundRect {
        rect: area,
        radius: Some(radius),
        stroke: centered,
        color: WHITE,
        blend: None,
    });
    let direct = direct.end();

    let mut entity = Harness::new();
    entity.begin(48, 48);
    entity.ok(box_entity(1, area, Some(radius), Some(centered)));
    let entity = entity.end();

    assert_ne!(
        direct.bytes, entity.bytes,
        "a centered stroke differs: the entity clips at its box"
    );
    assert!(
        direct.pixel(1, 15)[3] > 0,
        "the immediate stroke paints outside the rect"
    );
    assert_eq!(
        entity.pixel(1, 15)[3],
        0,
        "the entity clips the outside half at the box edge"
    );
}

#[test]
fn stroke_round_rect_validation_and_plain_rectangle() {
    let mut h = Harness::new();
    h.begin(16, 16);
    assert_eq!(
        h.submit(Request::StrokeRoundRect {
            rect: rect(0, 0, 9, 9),
            radius: None,
            stroke: Stroke {
                width_q8: 0,
                align: StrokeAlign::Center,
                join: Join::Bevel,
                cap: Cap::Butt,
                peak: Peak::Light,
            },
            color: WHITE,
            blend: None,
        })
        .unwrap_err(),
        fgce::Error::BadStroke
    );

    let stroke = Stroke {
        width_q8: 256,
        align: StrokeAlign::Inside,
        join: Join::Miter { limit_q8: 1024 },
        cap: Cap::Butt,
        peak: Peak::Light,
    };
    let mut rounded = Harness::new();
    rounded.begin(16, 16);
    rounded.ok(Request::StrokeRoundRect {
        rect: rect(1, 1, 11, 11),
        radius: Some(Radius::Edge(Edge::Pixel(0))),
        stroke,
        color: WHITE,
        blend: None,
    });
    let rounded = frame(rounded);

    let path = [
        fgce::Verb::Move(1, 1),
        fgce::Verb::Line(12, 1),
        fgce::Verb::Line(12, 12),
        fgce::Verb::Line(1, 12),
        fgce::Verb::Close,
    ];
    let mut plain = Harness::new();
    plain.begin(16, 16);
    plain.stroke_path(
        &path,
        1,
        StrokeAlign::Inside,
        Join::Miter { limit_q8: 1024 },
        Cap::Butt,
        WHITE,
    );
    assert_eq!(rounded, frame(plain), "radius 0 is a plain rectangle");
}

#[test]
fn stroke_round_rect_inside_stays_within_the_rect() {
    let mut h = Harness::new();
    h.begin(16, 16);
    h.ok(Request::StrokeRoundRect {
        rect: rect(2, 2, 11, 11),
        radius: Some(Radius::Percent(50)),
        stroke: Stroke {
            width_q8: 512,
            align: StrokeAlign::Inside,
            join: Join::Miter { limit_q8: 1024 },
            cap: Cap::Butt,
            peak: Peak::Light,
        },
        color: WHITE,
        blend: None,
    });
    assert_eq!(h.pixel_premul(1, 6)[3], 0, "outside the rect");
    assert!(h.pixel_premul(2, 6)[3] > 0, "the inside stroke is painted");
    assert_eq!(h.pixel_premul(12, 6)[3], 0, "right of the rect");
}

#[test]
fn fill_rect_radius_is_validated() {
    let mut h = Harness::new();
    h.begin(8, 8);
    assert_eq!(
        h.submit(fill_radius(
            rect(0, 0, 7, 7),
            Some(Radius::Percent(51)),
            None,
            WHITE,
        ))
        .unwrap_err(),
        fgce::Error::BadRadius
    );
}
