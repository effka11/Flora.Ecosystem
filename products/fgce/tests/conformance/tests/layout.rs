//! §12 rows 11–14, 17–19, 32–37, 51–56, 72–76, 91, 94, 95, 97, 133:
//! pin, `align`, inset, `snap`, reference choice, `zero` and generation.

use fgce::{
    Align, Edges, Entity, EntityKind, Error, Fill, FillRule, Inset, NodeId, Pin, Request, Verb,
};
use fgce_conformance::{Harness, RED, WHITE, flat, grid, pixels, rect};

const CENTER: Pin = Pin { x: 0, y: 0 };
const LEFT_TOP: Pin = Pin { x: -1, y: 1 };

fn group(
    h: &mut Harness,
    id: u32,
    children: &[NodeId],
    pin: Pin,
    snap: bool,
    inset: Option<Inset>,
) {
    h.ok(Request::Group {
        id: NodeId(id),
        parent: NodeId(0),
        children,
        pin,
        snap,
        inset,
    });
}

fn node_rect(h: &mut Harness, id: u32) -> Option<fgce::Rect> {
    h.snapshot()
        .nodes
        .into_iter()
        .find(|node| node.id == NodeId(id))
        .map(|node| node.rect)
}

fn inset_cells() -> Inset {
    Inset {
        left: Some(grid(1)),
        top: None,
        right: Some(grid(1)),
        bottom: None,
    }
}

#[test]
fn row_11_14_pin_axes() {
    let mut h = Harness::new();
    h.define_reference(7, (1000, 1000), 5, 1, CENTER, (0, 0));
    h.ok(flat(1, 400, 0, 449, 49, WHITE));
    h.ok(flat(2, 400, 0, 449, 49, WHITE));
    group(&mut h, 10, &[NodeId(1), NodeId(2)], CENTER, false, None);
    h.begin(1100, 1100);
    assert_eq!(
        node_rect(&mut h, 10),
        Some(rect(440, 0, 489, 49)),
        "pin 0: (400 * 1100) / 1000 = 440"
    );

    group(
        &mut h,
        10,
        &[NodeId(1), NodeId(2)],
        Pin { x: 1, y: 1 },
        false,
        None,
    );
    assert_eq!(
        node_rect(&mut h, 10),
        Some(rect(500, 0, 549, 49)),
        "far pin keeps the 550 px gap; near pin keeps a"
    );

    h.begin(1101, 1101);
    group(&mut h, 10, &[NodeId(1), NodeId(2)], CENTER, false, None);
    let grown = node_rect(&mut h, 10).expect("group");
    assert!(
        (440..=441).contains(&grown.x1),
        "one pixel of window growth moves pin 0 by 0 or 1, got {}",
        grown.x1
    );
}

fn photo_with_align(align: Align) -> Harness {
    let mut h = Harness::new();
    h.begin(20, 20);
    h.upload_rgba(1, 4, 4, fgce::AlphaMode::Straight, &[200; 64]);
    h.ok(Request::Entity(Entity {
        id: NodeId(1),
        kind: EntityKind::Photo {
            format: fgce::PixelFormat::Rgba8,
            image: fgce::ImageId(1),
            tint: None,
        },
        on_grid: Some(false),
        edges: pixels(0, 0, 9, 9),
        align: Some(align),
        blend: None,
        radius: None,
    }));
    h.end();
    h
}

#[test]
fn row_17_align_right_and_center() {
    let mut h = photo_with_align(Align { x: 1, y: 0 });
    assert_eq!(h.pixel_premul(9, 3)[3], 200, "right edge matches");
    assert_eq!(h.pixel_premul(9, 2)[3], 0, "vertical is centred");
    assert_eq!(h.pixel_premul(5, 3)[3], 0);
}

#[test]
fn row_18_align_left_bottom() {
    let mut h = photo_with_align(Align { x: -1, y: -1 });
    assert_eq!(h.pixel_premul(0, 9)[3], 200, "left bottom corner");
    assert_eq!(h.pixel_premul(0, 5)[3], 0);
    assert_eq!(h.pixel_premul(4, 9)[3], 0);
}

#[test]
fn row_19_vector_and_flat_reject_align() {
    let mut h = Harness::new();
    h.begin(20, 20);
    let mut flat_entity = match flat(1, 0, 0, 9, 9, WHITE) {
        Request::Entity(entity) => entity,
        _ => unreachable!(),
    };
    flat_entity.align = Some(Align { x: 1, y: 0 });
    assert_eq!(h.err(Request::Entity(flat_entity)), Error::BadAnchor);

    let verbs = [Verb::Move(0, 0), Verb::Line(9, 0), Verb::Line(0, 9)];
    let mut vector = Entity {
        id: NodeId(2),
        kind: EntityKind::Vector {
            verbs: &verbs,
            fill: Some(Fill {
                rule: FillRule::NonZero,
            }),
            stroke: None,
            color: WHITE,
        },
        on_grid: Some(false),
        edges: pixels(0, 0, 9, 9),
        align: Some(Align { x: -1, y: 0 }),
        blend: None,
        radius: None,
    };
    assert_eq!(h.err(Request::Entity(vector)), Error::BadAnchor);
    vector.align = None;
    h.ok(Request::Entity(vector));
}

fn inset_case(window: u32, child_left: i32, snap: bool) -> fgce::Rect {
    let mut h = Harness::new();
    h.begin(window, 100);
    h.ok(flat(1, child_left, 0, child_left + 49, 9, WHITE));
    h.ok(flat(2, child_left + 50, 0, child_left + 99, 9, WHITE));
    group(
        &mut h,
        10,
        &[NodeId(1), NodeId(2)],
        CENTER,
        snap,
        Some(inset_cells()),
    );
    node_rect(&mut h, 10).expect("group")
}

#[test]
fn row_32_34_inset_clamps_the_pin_origin() {
    assert_eq!(
        inset_case(160, 0, false),
        rect(15, 0, 114, 9),
        "left gap 15"
    );
    assert_eq!(inset_case(160, 30, false), rect(30, 0, 129, 9), "gap 30");
    assert_eq!(
        inset_case(160, 50, false),
        rect(45, 0, 144, 9),
        "right gap 15"
    );
}

#[test]
fn row_35_36_inset_shortage_splits_both_gaps() {
    assert_eq!(inset_case(120, 0, false), rect(10, 0, 109, 9));
    assert_eq!(inset_case(119, 0, false), rect(10, 0, 109, 9));
}

#[test]
fn row_37_snap_does_not_beat_the_inset() {
    let area = inset_case(120, 0, true);
    assert_eq!(area, rect(10, 0, 109, 9));
    assert_ne!(area.x1 % 15, 0, "10 is not a primary line");
}

fn arbitrary(
    h: &mut Harness,
    id: u32,
    parent: u32,
    on_grid: bool,
    edges: Edges,
    children: &[NodeId],
    inset: Option<Inset>,
) -> Result<(), Error> {
    h.submit(Request::Arbitrary {
        id: NodeId(id),
        parent: NodeId(parent),
        on_grid: Some(on_grid),
        edges,
        children,
        pin: CENTER,
        snap: false,
        inset,
    })
    .map(|_| ())
}

#[test]
fn row_51_52_arbitrary_grid_flag() {
    let mut h = Harness::new();
    h.begin(100, 100);
    h.ok(flat(1, 20, 0, 29, 9, WHITE));
    assert_eq!(
        arbitrary(
            &mut h,
            10,
            0,
            false,
            pixels(20, 0, 29, 9),
            &[NodeId(1)],
            None
        ),
        Ok(())
    );
    assert_eq!(node_rect(&mut h, 10), Some(rect(20, 0, 29, 9)));
    assert_eq!(
        arbitrary(
            &mut h,
            11,
            0,
            true,
            pixels(20, 0, 29, 9),
            &[NodeId(1)],
            None
        ),
        Err(Error::OffGrid)
    );
}

#[test]
fn row_53_nested_arbitrary_keeps_its_own_box() {
    let mut h = Harness::new();
    h.begin(100, 100);
    h.ok(flat(1, 0, 0, 9, 9, RED));
    h.ok(flat(2, 5, 0, 9, 4, RED));
    arbitrary(
        &mut h,
        10,
        0,
        false,
        pixels(0, 0, 19, 19),
        &[NodeId(1)],
        None,
    )
    .unwrap();
    arbitrary(&mut h, 11, 0, false, pixels(5, 0, 9, 4), &[NodeId(2)], None).unwrap();
    arbitrary(
        &mut h,
        10,
        0,
        false,
        pixels(0, 0, 19, 19),
        &[NodeId(1), NodeId(11)],
        None,
    )
    .unwrap();
    assert_eq!(node_rect(&mut h, 11), Some(rect(5, 0, 9, 4)));
    assert_eq!(node_rect(&mut h, 2), Some(rect(5, 0, 9, 4)));
    h.show(2, rect(0, 0, 19, 4));
    assert_eq!(
        node_rect(&mut h, 2),
        Some(rect(5, 0, 9, 4)),
        "visible rect is clipped by the parent arbitrary"
    );
    h.end();
    assert_eq!(h.pixel_premul(10, 0), [0, 0, 0, 0], "clipped at 9");
    assert_eq!(h.pixel_premul(7, 0), [255, 0, 0, 255]);
}

#[test]
fn row_54_55_nested_arbitrary_limits() {
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
        None,
    )
    .unwrap();
    arbitrary(&mut h, 11, 0, false, pixels(5, 0, 9, 4), &[NodeId(2)], None).unwrap();
    arbitrary(
        &mut h,
        10,
        0,
        false,
        pixels(0, 0, 19, 19),
        &[NodeId(1), NodeId(11)],
        None,
    )
    .unwrap();
    assert_eq!(
        arbitrary(
            &mut h,
            11,
            10,
            false,
            pixels(15, 0, 24, 4),
            &[NodeId(2)],
            None
        ),
        Err(Error::BoxOverflow)
    );
    let inset = Inset {
        left: Some(grid(1)),
        top: None,
        right: None,
        bottom: None,
    };
    assert_eq!(
        arbitrary(
            &mut h,
            11,
            10,
            false,
            pixels(5, 0, 9, 4),
            &[NodeId(2)],
            Some(inset)
        ),
        Err(Error::BadInset)
    );
}

fn reference_tree(h: &mut Harness) -> Vec<u32> {
    h.snapshot().nodes.iter().map(|node| node.id.0).collect()
}

#[test]
fn row_56_new_arbitrary_parent_must_already_hold_the_id() {
    let mut h = Harness::new();
    h.begin(100, 100);
    h.ok(flat(1, 0, 0, 9, 9, WHITE));
    h.ok(flat(2, 40, 0, 49, 9, WHITE));
    arbitrary(
        &mut h,
        10,
        0,
        false,
        pixels(0, 0, 19, 19),
        &[NodeId(1)],
        None,
    )
    .unwrap();
    arbitrary(
        &mut h,
        11,
        0,
        false,
        pixels(40, 0, 49, 19),
        &[NodeId(2)],
        None,
    )
    .unwrap();
    assert_eq!(
        arbitrary(
            &mut h,
            11,
            10,
            false,
            pixels(40, 0, 49, 19),
            &[NodeId(2)],
            None
        ),
        Err(Error::BadParent)
    );
    assert_eq!(node_rect(&mut h, 11), Some(rect(40, 0, 49, 19)));
}

fn snap_group(pin: Pin, left: i32) -> fgce::Rect {
    let mut h = Harness::new();
    h.define_reference(7, (100, 100), 2, 1, LEFT_TOP, (0, 0));
    h.begin(100, 100);
    h.ok(flat(1, left, 0, left + 4, 9, WHITE));
    h.ok(flat(2, left + 5, 0, left + 9, 9, WHITE));
    group(&mut h, 10, &[NodeId(1), NodeId(2)], pin, true, None);
    node_rect(&mut h, 10).expect("group")
}

#[test]
fn row_105_snap_near_pin_goes_to_the_lower_line() {
    assert_eq!(snap_group(LEFT_TOP, 3), rect(0, 0, 9, 9));
}

#[test]
fn row_106_snap_far_pin_goes_to_the_upper_line() {
    assert_eq!(snap_group(Pin { x: 1, y: 1 }, 3), rect(6, 0, 15, 9));
}

#[test]
fn row_107_snap_centre_breaks_the_tie_down() {
    assert_eq!(snap_group(CENTER, 3), rect(6, 0, 15, 9));
}

#[test]
fn row_108_snap_counts_from_the_parent_near() {
    let mut h = Harness::new();
    h.define_reference(7, (100, 100), 2, 1, LEFT_TOP, (0, 0));
    h.begin(100, 100);
    h.ok(flat(1, 13, 0, 17, 9, WHITE));
    h.ok(flat(2, 18, 0, 22, 9, WHITE));
    h.ok(flat(3, 10, 20, 19, 29, WHITE));
    h.ok(Request::Group {
        id: NodeId(11),
        parent: NodeId(0),
        children: &[NodeId(1), NodeId(2)],
        pin: LEFT_TOP,
        snap: true,
        inset: None,
    });
    h.ok(Request::Arbitrary {
        id: NodeId(10),
        parent: NodeId(0),
        on_grid: Some(false),
        edges: pixels(10, 0, 29, 29),
        children: &[NodeId(3), NodeId(11)],
        pin: CENTER,
        snap: false,
        inset: None,
    });
    assert_eq!(node_rect(&mut h, 11), Some(rect(12, 0, 21, 9)));
}

#[test]
fn row_72_threshold_40_wins_over_0() {
    let mut h = Harness::new();
    h.define_reference(7, (600, 600), 5, 1, LEFT_TOP, (0, 0));
    h.define_reference(8, (600, 600), 5, 1, LEFT_TOP, (40, 0));
    h.ok(flat(1, 0, 0, 9, 9, WHITE));
    h.use_reference(8);
    h.ok(flat(2, 0, 0, 9, 9, WHITE));
    h.use_reference(0);
    h.begin(600, 600);
    assert_eq!(reference_tree(&mut h), [2], "reference with threshold 40");
}

#[test]
fn row_73_one_column_short_falls_back_to_threshold_0() {
    let mut h = Harness::new();
    h.define_reference(7, (600, 600), 5, 1, LEFT_TOP, (0, 0));
    h.define_reference(8, (600, 600), 5, 1, LEFT_TOP, (40, 0));
    h.ok(flat(1, 0, 0, 9, 9, WHITE));
    h.use_reference(8);
    h.ok(flat(2, 0, 0, 9, 9, WHITE));
    h.use_reference(0);
    h.begin(585, 585);
    assert_eq!(reference_tree(&mut h), [1], "39 columns do not fit 40");
}

#[test]
fn row_74_equal_thresholds_keep_the_first() {
    let mut h = Harness::new();
    h.define_reference(7, (600, 600), 5, 1, LEFT_TOP, (0, 0));
    h.define_reference(8, (600, 600), 5, 1, LEFT_TOP, (0, 0));
    h.ok(flat(1, 0, 0, 9, 9, WHITE));
    h.use_reference(8);
    h.ok(flat(2, 0, 0, 9, 9, WHITE));
    h.use_reference(7);
    h.use_reference(0);
    h.begin(600, 600);
    assert_eq!(reference_tree(&mut h), [1]);
}

#[test]
fn row_75_current_outside_the_pair_picks_the_smallest_id() {
    let mut h = Harness::new();
    h.define_reference(7, (600, 600), 5, 1, LEFT_TOP, (40, 0));
    h.define_reference(2, (600, 600), 5, 1, LEFT_TOP, (40, 0));
    h.define_reference(9, (600, 600), 5, 1, LEFT_TOP, (0, 0));
    h.ok(flat(1, 0, 0, 9, 9, WHITE));
    h.use_reference(2);
    h.ok(flat(2, 0, 0, 9, 9, WHITE));
    h.use_reference(9);
    h.ok(flat(9, 0, 0, 9, 9, WHITE));
    h.use_reference(0);
    h.begin(600, 600);
    assert_eq!(
        reference_tree(&mut h),
        [2],
        "smaller ReferenceId of the pair"
    );
}

#[test]
fn row_76_more_rows_break_equal_columns() {
    let mut h = Harness::new();
    h.define_reference(7, (600, 600), 5, 1, LEFT_TOP, (40, 0));
    h.define_reference(8, (600, 600), 5, 1, LEFT_TOP, (40, 10));
    h.ok(flat(1, 0, 0, 9, 9, WHITE));
    h.use_reference(8);
    h.ok(flat(2, 0, 0, 9, 9, WHITE));
    h.use_reference(0);
    h.begin(600, 600);
    assert_eq!(reference_tree(&mut h), [2], "larger enter_rows");
}

fn vector_at(h: &mut Harness, id: u32, left: i32) {
    let verbs = [Verb::Move(0, 0), Verb::Line(10, 0), Verb::Line(0, 10)];
    h.ok(Request::Entity(Entity {
        id: NodeId(id),
        kind: EntityKind::Vector {
            verbs: &verbs,
            fill: Some(Fill {
                rule: FillRule::NonZero,
            }),
            stroke: None,
            color: RED,
        },
        on_grid: Some(false),
        edges: pixels(left, 0, left + 9, 19),
        align: None,
        blend: None,
        radius: None,
    }));
}

#[test]
fn row_91_zero_uses_the_canonical_origin() {
    let mut h = Harness::new();
    h.define_reference(7, (100, 100), 5, 1, CENTER, (0, 0));
    h.begin(91, 91);
    vector_at(&mut h, 1, 10);
    h.end();
    assert_eq!(h.pixel_premul(12, 12)[3], 255, "zero = 12 from canon 100");
    assert_eq!(h.pixel_premul(11, 12)[3], 0);
}

#[test]
fn row_94_local_zero_paints_on_the_first_primary_line() {
    let mut h = Harness::new();
    h.begin(100, 100);
    vector_at(&mut h, 1, 10);
    h.end();
    assert_eq!(h.pixel_premul(15, 0)[3], 255);
    assert_eq!(h.pixel_premul(14, 0)[3], 0);
}

#[test]
fn row_95_far_pin_puts_the_edge_on_the_line() {
    let mut h = Harness::new();
    h.define_reference(7, (100, 100), 5, 1, Pin { x: 1, y: 1 }, (0, 0));
    h.begin(100, 100);
    vector_at(&mut h, 1, 10);
    h.end();
    assert_eq!(h.pixel_premul(10, 0)[3], 255);
    assert_eq!(h.pixel_premul(9, 0)[3], 0);
}

#[test]
fn row_97_pixel_ratio_does_not_change_the_layout() {
    let mut one = Harness::new();
    one.define_reference(7, (100, 100), 5, 1, LEFT_TOP, (0, 0));
    one.ok(flat(1, 0, 0, 9, 9, WHITE));
    one.begin(91, 91);

    let mut two = Harness::new();
    two.define_reference(7, (100, 100), 5, 2, LEFT_TOP, (0, 0));
    two.ok(flat(1, 0, 0, 9, 9, WHITE));
    two.begin(91, 91);

    assert_eq!(one.snapshot().nodes, two.snapshot().nodes);
}

#[test]
fn row_133_generation_waits_for_new_inputs_and_end_repaints() {
    let mut h = Harness::new();
    h.begin(100, 100);
    h.ok(flat(1, 0, 0, 9, 9, RED));
    let first = h.snapshot();
    let second = h.snapshot();
    assert_eq!(
        first.generation, second.generation,
        "no inputs, no new pass"
    );
    assert_eq!(first.nodes, second.nodes);
    h.end();
    assert_eq!(h.pixel_premul(0, 0), [255, 0, 0, 255]);
    h.begin(100, 100);
    h.end();
    assert_eq!(
        h.pixel_premul(0, 0),
        [255, 0, 0, 255],
        "End after Begin paints the stored rectangles again"
    );
}
