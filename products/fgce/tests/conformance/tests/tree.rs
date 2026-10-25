//! §12 rows 15, 20–22, 24–31, 42–47, 50, 57, 58, 60–64, 66, 68, 69,
//! 92, 93, 140–144, 155, 156: tree, groups, arbitrary boxes, references, `Place`.
//!
//! Rows 23 (negative local edge), 65 (`Entity` without `edges`) and 67
//! (`stroke` without `width`) are either internal or not representable in the
//! typed contract; see the conformance README.

use fgce::{
    Align, Cap, Edge, Edges, Entity, EntityKind, Error, Fill, FillRule, ImageId, Inset, Join,
    NodeId, Pin, PixelFormat, Request, Stroke, StrokeAlign, Verb,
};
use fgce_conformance::{Harness, RED, WHITE, flat, grid, photo, pixels, rect};

fn group(
    h: &mut Harness,
    id: u32,
    parent: u32,
    children: &[NodeId],
    pin: Pin,
    snap: bool,
    inset: Option<Inset>,
) {
    h.ok(Request::Group {
        id: NodeId(id),
        parent: NodeId(parent),
        children,
        pin,
        snap,
        inset,
    });
}

fn try_group(
    h: &mut Harness,
    id: u32,
    parent: u32,
    children: &[NodeId],
    pin: Pin,
    inset: Option<Inset>,
) -> Error {
    h.err(Request::Group {
        id: NodeId(id),
        parent: NodeId(parent),
        children,
        pin,
        snap: false,
        inset,
    })
}

#[allow(clippy::too_many_arguments)]
fn arbitrary(
    h: &mut Harness,
    id: u32,
    parent: u32,
    on_grid: bool,
    edges: Edges,
    children: &[NodeId],
    pin: Pin,
    inset: Option<Inset>,
) {
    h.ok(Request::Arbitrary {
        id: NodeId(id),
        parent: NodeId(parent),
        on_grid: Some(on_grid),
        edges,
        children,
        pin,
        snap: false,
        inset,
    });
}

#[allow(clippy::too_many_arguments)]
fn try_arbitrary(
    h: &mut Harness,
    id: u32,
    parent: u32,
    on_grid: bool,
    edges: Edges,
    children: &[NodeId],
    pin: Pin,
    inset: Option<Inset>,
) -> Error {
    h.err(Request::Arbitrary {
        id: NodeId(id),
        parent: NodeId(parent),
        on_grid: Some(on_grid),
        edges,
        children,
        pin,
        snap: false,
        inset,
    })
}

fn node_rect(h: &mut Harness, id: u32) -> Option<fgce::Rect> {
    h.snapshot()
        .nodes
        .into_iter()
        .find(|node| node.id == NodeId(id))
        .map(|node| node.rect)
}

const CENTER: Pin = Pin { x: 0, y: 0 };

#[test]
fn row_15_entity_wider_than_the_box_overflows() {
    let mut h = Harness::new();
    h.begin(20, 20);
    h.upload_rgba(1, 10, 10, fgce::AlphaMode::Straight, &[255; 400]);
    assert_eq!(
        h.err(photo(1, PixelFormat::Rgba8, 1, 0, 0, 8, 8)),
        Error::BoxOverflow
    );
}

#[test]
fn row_20_bad_nudges() {
    let mut h = Harness::new();
    assert_eq!(
        h.err(Request::EdgePx {
            edge: Edge::Grid {
                primary: 0,
                fine: None,
                spx: Some(5),
            },
            k: 5,
        }),
        Error::BadNudge
    );
    assert_eq!(
        h.err(Request::EdgePx {
            edge: Edge::Grid {
                primary: 0,
                fine: Some(3),
                spx: None,
            },
            k: 5,
        }),
        Error::BadNudge
    );
    h.begin(100, 100);
    let three_offsets = Edges {
        x1: Edge::Grid {
            primary: 0,
            fine: Some(1),
            spx: None,
        },
        y1: Edge::Grid {
            primary: 0,
            fine: Some(0),
            spx: Some(2),
        },
        x2: Edge::Grid {
            primary: 9,
            fine: Some(1),
            spx: None,
        },
        y2: Edge::Grid {
            primary: 9,
            fine: None,
            spx: None,
        },
    };
    assert_eq!(
        h.err(Request::Entity(Entity {
            id: NodeId(1),
            kind: EntityKind::Flat { color: WHITE },
            on_grid: Some(true),
            edges: three_offsets,
            align: None,
            blend: None,
            radius: None,
        })),
        Error::BadNudge
    );
}

#[test]
fn row_21_spx_under_a_larger_scale_is_accepted() {
    let mut h = Harness::new();
    match h
        .submit(Request::EdgePx {
            edge: Edge::Grid {
                primary: 0,
                fine: Some(0),
                spx: Some(5),
            },
            k: 10,
        })
        .expect("spx 5 is inside k - 1 = 9")
    {
        fgce::Response::EdgePx(value) => assert_eq!(value, 5),
        _ => panic!("EdgePx response"),
    }
}

#[test]
fn row_22_k1_forbids_any_spx() {
    let mut h = Harness::new();
    assert_eq!(
        h.err(Request::EdgePx {
            edge: Edge::Grid {
                primary: 0,
                fine: None,
                spx: Some(1),
            },
            k: 1,
        }),
        Error::BadNudge
    );
}

#[test]
fn row_24_25_group_arity_and_arbitrary_container() {
    let mut h = Harness::new();
    h.begin(100, 100);
    h.ok(flat(1, 0, 0, 9, 9, WHITE));
    h.ok(flat(2, 10, 0, 19, 9, WHITE));
    h.ok(flat(3, 20, 0, 29, 9, WHITE));

    h.ok(flat(4, 0, 0, 9, 9, WHITE));
    h.ok(flat(5, 10, 0, 19, 9, WHITE));
    h.ok(flat(6, 20, 0, 29, 9, WHITE));

    assert_eq!(
        try_group(&mut h, 10, 0, &[NodeId(1)], CENTER, None),
        Error::BadGroup
    );
    assert_eq!(
        try_group(
            &mut h,
            10,
            0,
            &[NodeId(1), NodeId(2), NodeId(3)],
            CENTER,
            None
        ),
        Error::BadGroup
    );
    group(&mut h, 10, 0, &[NodeId(1), NodeId(2)], CENTER, false, None);
    arbitrary(
        &mut h,
        20,
        0,
        false,
        pixels(0, 0, 29, 29),
        &[NodeId(4), NodeId(5), NodeId(6)],
        CENTER,
        None,
    );
}

#[test]
fn row_26_group_near_sits_on_the_new_child() {
    let mut h = Harness::new();
    h.begin(100, 100);
    h.ok(flat(1, 10, 0, 19, 9, WHITE));
    h.ok(flat(2, 20, 0, 29, 9, WHITE));
    group(&mut h, 10, 0, &[NodeId(1), NodeId(2)], CENTER, false, None);
    assert_eq!(node_rect(&mut h, 10), Some(rect(10, 0, 29, 9)));

    h.ok(flat(3, 0, 0, 9, 9, WHITE));
    group(&mut h, 10, 0, &[NodeId(3), NodeId(1)], CENTER, false, None);
    assert_eq!(node_rect(&mut h, 10), Some(rect(0, 0, 19, 9)));
    assert_eq!(node_rect(&mut h, 1), Some(rect(10, 0, 19, 9)));
}

#[test]
fn row_27_place_child_does_not_move_the_sibling() {
    let mut h = Harness::new();
    h.begin(100, 100);
    h.ok(flat(1, 10, 0, 19, 9, WHITE));
    h.ok(flat(2, 20, 0, 29, 9, WHITE));
    group(&mut h, 10, 0, &[NodeId(1), NodeId(2)], CENTER, false, None);
    h.place(1, rect(0, 0, 9, 9));
    assert_eq!(node_rect(&mut h, 1), Some(rect(0, 0, 9, 9)));
    assert_eq!(node_rect(&mut h, 2), Some(rect(20, 0, 29, 9)));
}

#[test]
fn row_28_place_child_of_a_nested_group_keeps_the_outer_neighbour() {
    let mut h = Harness::new();
    h.begin(100, 100);
    h.ok(flat(1, 10, 0, 19, 9, WHITE));
    h.ok(flat(2, 20, 0, 29, 9, WHITE));
    h.ok(flat(3, 40, 0, 49, 9, WHITE));
    group(&mut h, 10, 0, &[NodeId(1), NodeId(2)], CENTER, false, None);
    group(&mut h, 11, 0, &[NodeId(10), NodeId(3)], CENTER, false, None);
    h.place(1, rect(0, 0, 9, 9));
    assert_eq!(node_rect(&mut h, 1), Some(rect(0, 0, 9, 9)));
    assert_eq!(node_rect(&mut h, 2), Some(rect(20, 0, 29, 9)));
    assert_eq!(node_rect(&mut h, 3), Some(rect(40, 0, 49, 9)));
}

#[test]
fn row_29_repeated_entity_recomputes_the_group_union() {
    let mut h = Harness::new();
    h.begin(100, 100);
    h.ok(flat(1, 0, 0, 9, 9, WHITE));
    h.ok(flat(2, 10, 0, 19, 9, WHITE));
    group(&mut h, 10, 0, &[NodeId(1), NodeId(2)], CENTER, false, None);
    h.ok(flat(2, 30, 0, 39, 9, WHITE));
    assert_eq!(node_rect(&mut h, 10), Some(rect(0, 0, 39, 9)));
    assert_eq!(node_rect(&mut h, 1), Some(rect(0, 0, 9, 9)));
    assert_eq!(node_rect(&mut h, 2), Some(rect(30, 0, 39, 9)));
}

#[test]
fn row_30_arbitrary_without_children_is_bad_arbitrary() {
    let mut h = Harness::new();
    h.begin(100, 100);
    h.ok(flat(1, 0, 0, 9, 9, WHITE));
    assert_eq!(
        try_arbitrary(
            &mut h,
            20,
            0,
            false,
            pixels(0, 0, 19, 19),
            &[],
            CENTER,
            None
        ),
        Error::BadArbitrary
    );
}

#[test]
fn row_31_inset_needs_a_window_parent() {
    let mut h = Harness::new();
    h.begin(100, 100);
    h.ok(flat(1, 0, 0, 9, 9, WHITE));
    h.ok(flat(2, 10, 0, 19, 9, WHITE));
    h.ok(flat(3, 20, 0, 29, 9, WHITE));
    h.ok(flat(4, 30, 0, 39, 9, WHITE));
    group(&mut h, 10, 0, &[NodeId(1), NodeId(2)], CENTER, false, None);
    group(&mut h, 12, 0, &[NodeId(3), NodeId(4)], CENTER, false, None);
    arbitrary(
        &mut h,
        20,
        0,
        false,
        pixels(0, 0, 39, 39),
        &[NodeId(12)],
        CENTER,
        None,
    );
    let inset = Inset {
        left: Some(grid(1)),
        top: None,
        right: None,
        bottom: None,
    };
    assert_eq!(
        try_group(&mut h, 12, 20, &[NodeId(3), NodeId(4)], CENTER, Some(inset)),
        Error::BadInset
    );
}

#[test]
fn row_42_place_near_pin_sets_a() {
    let mut h = Harness::new();
    h.begin(100, 100);
    h.ok(flat(1, 0, 0, 9, 9, WHITE));
    h.place(1, rect(40, 0, 49, 9));
    assert_eq!(node_rect(&mut h, 1), Some(rect(40, 0, 49, 9)));
}

#[test]
fn row_43_place_group_is_bad_parent() {
    let mut h = Harness::new();
    h.begin(100, 100);
    h.ok(flat(1, 0, 0, 9, 9, WHITE));
    h.ok(flat(2, 10, 0, 19, 9, WHITE));
    group(&mut h, 10, 0, &[NodeId(1), NodeId(2)], CENTER, false, None);
    assert_eq!(h.try_place(10, rect(40, 0, 59, 9)), Error::BadParent);
    assert_eq!(node_rect(&mut h, 10), Some(rect(0, 0, 19, 9)));
}

#[test]
fn row_44_place_entity_sets_size_and_keeps_align() {
    let mut h = Harness::new();
    h.begin(100, 100);
    h.upload_rgba(1, 4, 4, fgce::AlphaMode::Straight, &[9; 64]);
    h.ok(Request::Entity(Entity {
        id: NodeId(1),
        kind: EntityKind::Photo {
            format: PixelFormat::Rgba8,
            image: ImageId(1),
            tint: None,
        },
        on_grid: Some(false),
        edges: pixels(0, 0, 9, 9),
        align: Some(Align { x: 1, y: 0 }),
        blend: None,
        radius: None,
    }));
    h.place(1, rect(40, 0, 49, 9));
    assert_eq!(node_rect(&mut h, 1), Some(rect(40, 0, 49, 9)));
    h.end();
    h.begin(100, 100);
    h.end();
    assert_eq!(h.pixel_premul(49, 3)[3], 9, "right-aligned image edge");
    assert_eq!(h.pixel_premul(45, 3)[3], 0, "left part of the box is empty");
}

#[test]
fn row_45_place_entity_smaller_than_the_image_overflows() {
    let mut h = Harness::new();
    h.begin(100, 100);
    h.upload_rgba(1, 10, 10, fgce::AlphaMode::Straight, &[255; 400]);
    h.ok(photo(1, PixelFormat::Rgba8, 1, 0, 0, 9, 9));
    assert_eq!(h.try_place(1, rect(20, 0, 28, 8)), Error::BoxOverflow);
    assert_eq!(node_rect(&mut h, 1), Some(rect(0, 0, 9, 9)));
}

#[test]
fn row_46_group_cannot_hold_an_arbitrary_box() {
    let mut h = Harness::new();
    h.begin(100, 100);
    h.ok(flat(1, 0, 0, 9, 9, WHITE));
    h.ok(flat(2, 10, 0, 19, 9, WHITE));
    arbitrary(
        &mut h,
        20,
        0,
        false,
        pixels(0, 0, 19, 19),
        &[NodeId(2)],
        CENTER,
        None,
    );
    assert_eq!(
        try_group(&mut h, 10, 0, &[NodeId(1), NodeId(20)], CENTER, None),
        Error::BadParent
    );
}

#[test]
fn row_50_photo_format_must_match_the_store() {
    let mut h = Harness::new();
    h.begin(20, 20);
    h.upload(
        1,
        4,
        4,
        PixelFormat::Rgb8,
        fgce::AlphaMode::Straight,
        &[7; 48],
    );
    assert_eq!(
        h.err(photo(1, PixelFormat::Rgba8, 1, 0, 0, 3, 3)),
        Error::BufferLayout
    );
}

#[test]
fn row_57_place_nested_arbitrary_uses_the_rect() {
    let mut h = Harness::new();
    h.begin(100, 100);
    h.ok(flat(1, 0, 0, 9, 9, WHITE));
    h.ok(flat(2, 5, 0, 9, 4, WHITE));
    arbitrary(
        &mut h,
        10,
        0,
        false,
        pixels(0, 0, 19, 19),
        &[NodeId(1)],
        CENTER,
        None,
    );
    arbitrary(
        &mut h,
        11,
        0,
        false,
        pixels(5, 0, 9, 4),
        &[NodeId(2)],
        CENTER,
        None,
    );
    arbitrary(
        &mut h,
        10,
        0,
        false,
        pixels(0, 0, 19, 19),
        &[NodeId(1), NodeId(11)],
        CENTER,
        None,
    );
    h.place(11, rect(6, 0, 10, 4));
    assert_eq!(node_rect(&mut h, 11), Some(rect(6, 0, 10, 4)));
}

#[test]
fn row_58_place_nested_arbitrary_outside_the_parent_overflows() {
    let mut h = Harness::new();
    h.begin(100, 100);
    h.ok(flat(1, 0, 0, 9, 9, WHITE));
    h.ok(flat(2, 5, 0, 9, 4, WHITE));
    arbitrary(
        &mut h,
        10,
        0,
        false,
        pixels(0, 0, 19, 19),
        &[NodeId(1)],
        CENTER,
        None,
    );
    arbitrary(
        &mut h,
        11,
        0,
        false,
        pixels(5, 0, 9, 4),
        &[NodeId(2)],
        CENTER,
        None,
    );
    arbitrary(
        &mut h,
        10,
        0,
        false,
        pixels(0, 0, 19, 19),
        &[NodeId(1), NodeId(11)],
        CENTER,
        None,
    );
    assert_eq!(h.try_place(11, rect(15, 0, 24, 4)), Error::BoxOverflow);
    assert_eq!(node_rect(&mut h, 11), Some(rect(5, 0, 9, 4)));
}

#[test]
fn row_60_remove_the_only_arbitrary_child_is_bad_arbitrary() {
    let mut h = Harness::new();
    h.begin(100, 100);
    h.ok(flat(1, 0, 0, 9, 9, WHITE));
    arbitrary(
        &mut h,
        10,
        0,
        false,
        pixels(0, 0, 19, 19),
        &[NodeId(1)],
        CENTER,
        None,
    );
    assert_eq!(h.try_remove(1), Error::BadArbitrary);
    assert_eq!(node_rect(&mut h, 1), Some(rect(0, 0, 9, 9)));
}

#[test]
fn row_61_transfer_keeps_the_absolute_pixel() {
    let mut h = Harness::new();
    h.begin(100, 100);
    h.ok(flat(1, 0, 0, 9, 9, WHITE));
    h.ok(flat(2, 40, 0, 49, 9, WHITE));
    h.ok(flat(3, 12, 0, 16, 4, WHITE));
    arbitrary(
        &mut h,
        10,
        0,
        false,
        pixels(0, 0, 19, 19),
        &[NodeId(1), NodeId(3)],
        CENTER,
        None,
    );
    arbitrary(
        &mut h,
        11,
        0,
        false,
        pixels(0, 0, 49, 19),
        &[NodeId(2)],
        CENTER,
        None,
    );
    arbitrary(
        &mut h,
        11,
        0,
        false,
        pixels(0, 0, 49, 19),
        &[NodeId(2), NodeId(3)],
        CENTER,
        None,
    );
    assert_eq!(node_rect(&mut h, 3), Some(rect(12, 0, 16, 4)));
    let snapshot = h.snapshot();
    let parent = snapshot
        .nodes
        .iter()
        .find(|node| node.id == NodeId(3))
        .map(|node| node.parent);
    assert_eq!(parent, Some(NodeId(11)));
}

#[test]
fn row_62_photo_needs_a_stored_image() {
    let mut h = Harness::new();
    h.begin(20, 20);
    assert_eq!(
        h.err(photo(1, PixelFormat::Rgba8, 0, 0, 0, 9, 9)),
        Error::UnknownImage
    );
    assert_eq!(
        h.err(photo(2, PixelFormat::Rgba8, 5, 0, 0, 9, 9)),
        Error::UnknownImage
    );
}

#[test]
fn row_63_vector_needs_verbs() {
    let mut h = Harness::new();
    h.begin(20, 20);
    let entity = Entity {
        id: NodeId(1),
        kind: EntityKind::Vector {
            verbs: &[],
            fill: Some(Fill {
                rule: FillRule::NonZero,
            }),
            stroke: None,
            color: WHITE,
        },
        on_grid: Some(false),
        edges: pixels(0, 0, 9, 9),
        align: None,
        blend: None,
        radius: None,
    };
    assert_eq!(h.err(Request::Entity(entity)), Error::BadPath);
}

#[test]
fn row_64_flat_color_is_written_to_the_frame() {
    let mut h = Harness::new();
    h.begin(20, 20);
    h.ok(flat(1, 0, 0, 9, 9, RED));
    h.end();
    assert_eq!(h.pixel_premul(0, 0), [255, 0, 0, 255]);
}

#[test]
fn row_66_vector_branch_needs_its_parameters() {
    let mut h = Harness::new();
    h.begin(20, 20);
    let verbs = [Verb::Move(0, 0), Verb::Line(9, 0), Verb::Line(0, 9)];
    let stroke = Some(Stroke {
        width: 1,
        align: StrokeAlign::Outside,
        join: Join::Bevel,
        cap: Cap::Butt,
    });
    let vector = |fill: Option<Fill>, stroke: Option<Stroke>| Entity {
        id: NodeId(1),
        kind: EntityKind::Vector {
            verbs: &verbs,
            fill,
            stroke,
            color: WHITE,
        },
        on_grid: Some(false),
        edges: pixels(0, 0, 9, 9),
        align: None,
        blend: None,
        radius: None,
    };
    assert_eq!(
        h.err(Request::Entity(vector(
            Some(Fill {
                rule: FillRule::NonZero,
            }),
            stroke
        ))),
        Error::BadPath,
        "fill and stroke together are rejected"
    );
    assert_eq!(
        h.err(Request::Entity(vector(None, None))),
        Error::BadPath,
        "neither branch is rejected"
    );
    assert_eq!(
        h.err(Request::Entity(vector(
            None,
            Some(Stroke {
                width: 0,
                align: StrokeAlign::Outside,
                join: Join::Bevel,
                cap: Cap::Butt,
            })
        ))),
        Error::BadStroke,
        "width 0 is BadStroke"
    );
}

#[test]
fn row_68_place_pin_zero_inverts_the_fraction() {
    let mut h = Harness::new();
    h.define_reference(7, (3, 100), 5, 1, CENTER, (0, 0));
    h.ok(flat(1, 0, 0, 0, 0, WHITE));
    h.ok(Request::Arbitrary {
        id: NodeId(10),
        parent: NodeId(0),
        on_grid: Some(false),
        edges: pixels(0, 0, 2, 99),
        children: &[NodeId(1)],
        pin: CENTER,
        snap: false,
        inset: None,
    });
    h.begin(100, 100);
    h.place(10, rect(50, 0, 50, 0));
    // The canonical `a = 1` is internal; the live rectangle follows pin 0 and
    // already shows the next frame value `(1 * 100) / 3 = 33`.
    assert_eq!(node_rect(&mut h, 10), Some(rect(33, 0, 33, 0)));
}

#[test]
fn row_69_place_uses_the_live_window_near() {
    let mut h = Harness::new();
    h.define_reference(7, (100, 100), 5, 1, CENTER, (0, 0));
    h.begin(100, 100);
    h.begin(90, 90);
    h.ok(flat(1, 0, 0, 9, 9, WHITE));
    h.place(1, rect(40, 0, 49, 9));
    assert_eq!(node_rect(&mut h, 1), Some(rect(40, 0, 49, 9)));
}

#[test]
fn row_92_builtin_reference_waits_for_begin() {
    let mut h = Harness::new();
    assert_eq!(h.err(flat(1, 0, 0, 9, 9, WHITE)), Error::NotBegun);
}

#[test]
fn row_93_defined_reference_accepts_entities_before_begin() {
    let mut h = Harness::new();
    h.define_reference(7, (100, 100), 5, 1, CENTER, (0, 0));
    h.ok(flat(1, 0, 0, 9, 9, WHITE));
    h.begin(100, 100);
    assert_eq!(node_rect(&mut h, 1), Some(rect(0, 0, 9, 9)));
}

#[test]
fn row_140_other_reference_ids_are_unknown_nodes() {
    let mut h = Harness::new();
    h.define_reference(7, (100, 100), 5, 1, CENTER, (0, 0));
    h.define_reference(8, (100, 100), 5, 1, CENTER, (0, 0));
    h.ok(flat(1, 0, 0, 9, 9, WHITE));
    h.use_reference(8);
    h.ok(flat(2, 0, 0, 9, 9, WHITE));
    h.begin(100, 100);
    assert_eq!(h.try_remove(1), Error::UnknownNode);
    assert_eq!(h.try_place(1, rect(10, 0, 19, 9)), Error::UnknownNode);
    assert_eq!(
        h.err(Request::Show {
            id: NodeId(1),
            rect: rect(0, 0, 9, 9)
        }),
        Error::UnknownNode
    );
    assert_eq!(node_rect(&mut h, 1), None);
    h.use_reference(7);
    assert_eq!(node_rect(&mut h, 1), Some(rect(0, 0, 9, 9)));
}

#[test]
fn row_141_new_node_with_an_id_from_another_reference_is_bad_parent() {
    let mut h = Harness::new();
    h.define_reference(7, (100, 100), 5, 1, CENTER, (0, 0));
    h.define_reference(8, (100, 100), 5, 1, CENTER, (0, 0));
    h.ok(flat(1, 0, 0, 9, 9, WHITE));
    h.use_reference(8);
    assert_eq!(h.err(flat(1, 0, 0, 9, 9, WHITE)), Error::BadParent);
}

#[test]
fn row_142_repeat_entity_replaces_fields_and_keeps_order() {
    let mut h = Harness::new();
    h.begin(100, 100);
    h.ok(flat(1, 0, 0, 9, 9, RED));
    h.ok(flat(2, 10, 0, 19, 9, WHITE));
    group(&mut h, 10, 0, &[NodeId(1), NodeId(2)], CENTER, false, None);
    h.ok(flat(1, 0, 0, 9, 9, WHITE));
    let order: Vec<u32> = h
        .snapshot()
        .nodes
        .iter()
        .filter(|node| node.parent == NodeId(10))
        .map(|node| node.id.0)
        .collect();
    assert_eq!(order, [1, 2]);
    h.end();
    assert_eq!(h.pixel_premul(0, 0), [255, 255, 255, 255]);
}

#[test]
fn row_143_group_with_a_parent_outside_children_is_bad_parent() {
    let mut h = Harness::new();
    h.begin(100, 100);
    h.ok(flat(1, 0, 0, 9, 9, WHITE));
    h.ok(flat(2, 10, 0, 19, 9, WHITE));
    group(&mut h, 10, 0, &[NodeId(1), NodeId(2)], CENTER, false, None);
    assert_eq!(
        try_group(&mut h, 20, 10, &[NodeId(1), NodeId(2)], CENTER, None),
        Error::BadParent
    );
    let ids: Vec<u32> = h.snapshot().nodes.iter().map(|node| node.id.0).collect();
    assert!(!ids.contains(&20));
}

#[test]
fn row_144_redefine_clears_only_its_own_tree() {
    let mut h = Harness::new();
    h.define_reference(7, (100, 100), 5, 1, CENTER, (0, 0));
    h.define_reference(8, (100, 100), 5, 1, CENTER, (0, 0));
    h.ok(flat(1, 0, 0, 9, 9, WHITE));
    h.use_reference(8);
    h.ok(flat(2, 0, 0, 9, 9, WHITE));
    h.use_reference(7);
    h.define_reference(7, (200, 200), 5, 1, CENTER, (0, 0));
    h.begin(100, 100);
    assert_eq!(node_rect(&mut h, 1), None);
    h.use_reference(8);
    assert_eq!(node_rect(&mut h, 2), Some(rect(0, 0, 9, 9)));
}

#[test]
fn row_155_second_transition_in_a_frame_is_busy() {
    let mut h = Harness::new();
    h.define_reference(7, (100, 100), 5, 1, CENTER, (0, 0));
    h.define_reference(8, (100, 100), 5, 1, CENTER, (0, 0));
    h.begin(100, 100);
    h.use_reference(8);
    assert_eq!(h.try_use_reference(7), Error::ReferenceBusy);
    assert_eq!(h.try_use_reference(0), Error::ReferenceBusy);
}

#[test]
fn row_156_missing_reference_does_not_spend_the_transition() {
    let mut h = Harness::new();
    h.define_reference(7, (100, 100), 5, 1, CENTER, (0, 0));
    h.define_reference(8, (100, 100), 5, 1, CENTER, (0, 0));
    h.begin(100, 100);
    assert_eq!(h.try_use_reference(99), Error::ReferenceMissing);
    h.use_reference(8);
    assert_eq!(h.try_use_reference(0), Error::ReferenceBusy);
}
