//! §12 rows for §8.5 rounded boxes and `Blend::DstOut`.

use fgce::{
    AlphaMode, Blend, Color, Edge, Entity, EntityKind, Error, ImageId, NodeId, Peak, Radius,
    Request, Sample, Verb,
};
use fgce_conformance::{Harness, pixels, rect};

const WHITE: Color = Color {
    r: 255,
    g: 255,
    b: 255,
    a: 255,
};

const RED: [u8; 4] = [255, 0, 0, 255];

fn entity(id: u32, kind: EntityKind<'static>, radius: Option<Radius>) -> Request<'static> {
    Request::Entity(Entity {
        id: NodeId(id),
        kind,
        on_grid: Some(false),
        edges: pixels(0, 0, 7, 7),
        align: None,
        blend: None,
        radius,
    })
}

#[test]
fn rounded_flat_clears_the_corners() {
    let mut h = Harness::new();
    h.begin(8, 8);
    h.ok(entity(
        1,
        EntityKind::Flat { color: WHITE },
        Some(Radius::Edge(Edge::Pixel(4))),
    ));
    let frame = h.end();
    assert_eq!(frame.pixel(0, 0), [0, 0, 0, 0]);
    assert_eq!(frame.pixel(7, 7), [0, 0, 0, 0]);
    assert_eq!(frame.pixel(4, 4), [255, 255, 255, 255]);
}

#[test]
fn percent_fifty_is_a_circle() {
    let mut h = Harness::new();
    h.begin(10, 10);
    h.ok(Request::Entity(Entity {
        id: NodeId(1),
        kind: EntityKind::Flat { color: WHITE },
        on_grid: Some(false),
        edges: pixels(0, 0, 9, 9),
        align: None,
        blend: None,
        radius: Some(Radius::Percent(50)),
    }));
    let frame = h.end();
    assert_eq!(frame.pixel(0, 0), [0, 0, 0, 0]);
    assert_eq!(frame.pixel(9, 9), [0, 0, 0, 0]);
    assert_eq!(frame.pixel(5, 5), [255, 255, 255, 255]);
    let edge = frame.pixel(0, 5);
    assert!(
        edge[3] > 0 && edge[3] < 255,
        "the circle edge antialiases: {edge:?}"
    );
}

#[test]
fn rounded_blit_cuts_what_is_under_it() {
    let mut h = Harness::new();
    let mut rgba = Vec::with_capacity(8 * 8 * 4);
    for _ in 0..64 {
        rgba.extend_from_slice(&RED);
    }
    h.upload_rgba(1, 8, 8, AlphaMode::Straight, &rgba);
    h.begin(8, 8);
    h.fill(rect(0, 0, 7, 7), WHITE);
    h.ok(Request::Blit {
        id: ImageId(1),
        dest: rect(0, 0, 7, 7),
        src: rect(0, 0, 7, 7),
        sample: Sample::Crisp,
        tint: None,
        blend: Some(Blend::SrcOver),
        radius: Some(Radius::Edge(Edge::Pixel(4))),
    });
    let frame = h.end();
    assert_eq!(frame.pixel(0, 0), [0, 0, 0, 0]);
    assert_eq!(frame.pixel(4, 4), RED);
}

#[test]
fn box_with_fill_and_stroke_is_a_ring() {
    let mut h = Harness::new();
    h.begin(12, 12);
    h.ok(Request::Entity(Entity {
        id: NodeId(1),
        kind: EntityKind::Box {
            fill: None,
            stroke: Some(fgce::Stroke {
                width_q8: 256,
                align: fgce::StrokeAlign::Inside,
                join: fgce::Join::Round,
                cap: fgce::Cap::Butt,
                peak: Peak::Light,
            }),
            color: WHITE,
        },
        on_grid: Some(false),
        edges: pixels(0, 0, 11, 11),
        align: None,
        blend: None,
        radius: Some(Radius::Edge(Edge::Pixel(4))),
    }));
    let frame = h.end();
    assert_eq!(
        frame.pixel(0, 4),
        [255, 255, 255, 255],
        "the border is drawn"
    );
    assert_eq!(frame.pixel(6, 6), [0, 0, 0, 0], "the inside stays hollow");
}

#[test]
fn bad_radius_is_rejected() {
    let mut h = Harness::new();
    h.begin(8, 8);
    assert_eq!(
        h.err(entity(
            1,
            EntityKind::Flat { color: WHITE },
            Some(Radius::Percent(51)),
        )),
        Error::BadRadius
    );
    assert_eq!(
        h.err(entity(
            1,
            EntityKind::Flat { color: WHITE },
            Some(Radius::Edge(Edge::Pixel(-1))),
        )),
        Error::BadRadius
    );
    const VERBS: [Verb; 5] = [
        Verb::Move(0, 0),
        Verb::Line(8, 0),
        Verb::Line(8, 8),
        Verb::Line(0, 8),
        Verb::Close,
    ];
    assert_eq!(
        h.err(Request::Entity(Entity {
            id: NodeId(1),
            kind: EntityKind::Vector {
                verbs: &VERBS,
                fill: Some(fgce::Fill {
                    rule: fgce::FillRule::NonZero,
                }),
                stroke: None,
                color: WHITE,
            },
            on_grid: Some(false),
            edges: pixels(0, 0, 7, 7),
            align: None,
            blend: None,
            radius: Some(Radius::Edge(Edge::Pixel(2))),
        })),
        Error::BadRadius
    );
}

#[test]
fn a_box_without_paint_is_bad_path() {
    let mut h = Harness::new();
    h.begin(8, 8);
    assert_eq!(
        h.err(entity(
            1,
            EntityKind::Box {
                fill: None,
                stroke: None,
                color: WHITE,
            },
            None,
        )),
        Error::BadPath
    );
}
