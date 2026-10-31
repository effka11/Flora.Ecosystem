//! §12 0.16 rows: `DebugGrid`, `DebugHover` and `DebugLabel`.

use fgce::{Color, DebugGridStyle, DebugPoint, NodeId, Pin, Request};
use fgce_conformance::{Harness, RED, flat, pixels, rect};

const DEBUG_TEXT_1: &[u8] = include_bytes!("../fixtures/debug_text_1.bin");
const DEBUG_TEXT_3: &[u8] = include_bytes!("../fixtures/debug_text_3.bin");
const DEBUG_ARROWS: &[u8] = include_bytes!("../fixtures/debug_arrows.bin");

const BASE: Color = Color {
    r: 10,
    g: 10,
    b: 10,
    a: 255,
};
const TIP: Color = Color {
    r: 250,
    g: 250,
    b: 250,
    a: 255,
};

fn style(label_alpha: u8, label_scale: u8) -> DebugGridStyle {
    DebugGridStyle::new(BASE, TIP, label_alpha, label_scale)
}

fn grid(h: &mut Harness, style: Option<DebugGridStyle>) {
    h.ok(Request::DebugGrid { style });
}

fn label(h: &mut Harness, id: u32, text: Option<&str>) {
    h.ok(Request::DebugLabel {
        id: NodeId(id),
        text,
    });
}

fn hover(h: &mut Harness, point: Option<DebugPoint>) {
    h.ok(Request::DebugHover(point));
}

fn arbitrary(h: &mut Harness, id: u32, parent: u32, area: fgce::Rect, children: &[u32], pin: Pin) {
    let ids: Vec<NodeId> = children.iter().map(|id| NodeId(*id)).collect();
    h.ok(Request::Arbitrary {
        id: NodeId(id),
        parent: NodeId(parent),
        on_grid: Some(false),
        edges: pixels(area.x1, area.y1, area.x2, area.y2),
        children: &ids,
        pin,
        snap: false,
        inset: None,
    });
}

#[test]
fn row_g6_disabled_layer_does_not_touch_the_frame() {
    let mut absent = Harness::new();
    absent.begin(16, 16);
    absent.ok(flat(1, 0, 0, 15, 15, RED));
    let absent = absent.end().bytes;

    let mut disabled = Harness::new();
    disabled.begin(16, 16);
    disabled.ok(flat(1, 0, 0, 15, 15, RED));
    grid(&mut disabled, None);
    assert_eq!(absent, disabled.end().bytes);
}

#[test]
fn row_g6_state_survives_begin_and_labels_survive_disable() {
    let mut h = Harness::new();
    h.begin(16, 16);
    h.ok(flat(1, 0, 0, 15, 15, RED));
    label(&mut h, 1, Some("node"));
    hover(&mut h, Some(DebugPoint { x: 4, y: 4 }));
    grid(&mut h, Some(style(255, 1)));
    let first = h.end().bytes;

    h.begin(16, 16);
    h.ok(flat(1, 0, 0, 15, 15, RED));
    let second = h.end();
    assert_eq!(first, second.bytes, "style, hover and names survive Begin");

    grid(&mut h, None);
    assert_eq!(
        h.submit(Request::DebugGrid {
            style: Some(style(255, 0)),
        })
        .unwrap_err(),
        fgce::Error::BufferLayout
    );
    grid(&mut h, Some(style(255, 1)));
    h.begin(16, 16);
    h.ok(flat(1, 0, 0, 15, 15, RED));
    hover(&mut h, Some(DebugPoint { x: 4, y: 4 }));
    assert_eq!(first, h.end().bytes, "names survive a disabled grid");
}

#[test]
fn row_g6_label_validation_keeps_the_state() {
    let mut h = Harness::new();
    h.begin(8, 8);
    let too_long = "x".repeat(65);
    assert_eq!(
        h.submit(Request::DebugLabel {
            id: NodeId(1),
            text: Some(&too_long),
        })
        .unwrap_err(),
        fgce::Error::BufferLayout
    );
    label(&mut h, 1, Some("ok"));
    assert!(h.submit(Request::DebugGrid { style: None }).is_ok());
    grid(&mut h, Some(style(255, 1)));
    label(&mut h, 0, Some("window"));
    let _ = h.end();
}

#[test]
fn row_g6_three_levels_use_base_middle_and_tip() {
    let mut h = Harness::new();
    h.begin(16, 16);
    h.ok(flat(1, 4, 4, 7, 7, RED));
    arbitrary(&mut h, 2, 0, rect(2, 2, 13, 13), &[1], Pin { x: -1, y: 1 });
    grid(&mut h, Some(style(0, 1)));
    let frame = h.end();
    assert_eq!(frame.pixel(4, 5), [TIP.r, TIP.g, TIP.b, 255], "leaf tip");
    assert_eq!(
        frame.pixel(2, 5),
        [130, 130, 130, 255],
        "root is halfway between base and tip"
    );
    assert_eq!(
        frame.pixel(0, 5),
        [BASE.r, BASE.g, BASE.b, 255],
        "window is the base"
    );
}

#[test]
fn row_g6_five_levels_interpolate_base_to_tip() {
    let mut h = Harness::new();
    h.begin(16, 16);
    h.ok(flat(1, 5, 5, 6, 6, RED));
    arbitrary(&mut h, 2, 0, rect(4, 4, 11, 11), &[1], Pin { x: -1, y: 1 });
    arbitrary(&mut h, 3, 0, rect(3, 3, 12, 12), &[2], Pin { x: -1, y: 1 });
    arbitrary(&mut h, 4, 0, rect(2, 2, 13, 13), &[3], Pin { x: -1, y: 1 });
    grid(&mut h, Some(style(0, 1)));
    let frame = h.end();
    assert_eq!(frame.pixel(0, 6), [BASE.r, BASE.g, BASE.b, 255]);
    assert_eq!(frame.pixel(2, 6), [70, 70, 70, 255], "depth 1");
    assert_eq!(frame.pixel(3, 6), [130, 130, 130, 255], "depth 2");
    assert_eq!(frame.pixel(4, 6), [190, 190, 190, 255], "depth 3");
    assert_eq!(frame.pixel(5, 6), [TIP.r, TIP.g, TIP.b, 255], "depth 4");
}

#[test]
fn row_g6_invisible_branch_does_not_count_in_max_depth() {
    let mut h = Harness::new();
    h.begin(16, 16);
    h.ok(flat(2, 4, 4, 7, 7, RED));
    h.ok(flat(4, 4, 4, 7, 7, RED));
    arbitrary(&mut h, 3, 0, rect(2, 2, 9, 9), &[4], Pin { x: -1, y: 1 });
    arbitrary(
        &mut h,
        1,
        0,
        rect(0, 0, 15, 15),
        &[2, 3],
        Pin { x: -1, y: 1 },
    );
    // Move the deeper branch outside the frame: it becomes invisible.
    h.show(3, rect(20, 20, 29, 29));
    grid(&mut h, Some(style(0, 1)));
    let frame = h.end();
    assert_eq!(
        frame.pixel(4, 5),
        [TIP.r, TIP.g, TIP.b, 255],
        "the visible deepest node gets the tip"
    );
}

#[test]
fn row_g6_hover_over_empty_space_draws_no_labels() {
    let mut with = Harness::new();
    with.begin(32, 32);
    with.ok(flat(1, 0, 0, 5, 5, RED));
    grid(&mut with, Some(style(255, 1)));
    hover(&mut with, Some(DebugPoint { x: 20, y: 20 }));
    let with = with.end().bytes;

    let mut without = Harness::new();
    without.begin(32, 32);
    without.ok(flat(1, 0, 0, 5, 5, RED));
    grid(&mut without, Some(style(255, 1)));
    assert_eq!(with, without.end().bytes);
}

#[test]
fn row_g6_hover_none_removes_the_labels() {
    let mut h = Harness::new();
    h.begin(32, 32);
    h.ok(flat(1, 0, 0, 15, 15, RED));
    grid(&mut h, Some(style(255, 1)));
    hover(&mut h, Some(DebugPoint { x: 4, y: 4 }));
    let with = h.end().bytes;

    h.begin(32, 32);
    h.ok(flat(1, 0, 0, 15, 15, RED));
    hover(&mut h, None);
    let without = h.end().bytes;
    assert_ne!(with, without, "a hovered node shows a label");
}

#[test]
fn row_g6_label_scale_and_alpha_change_the_pixels() {
    let mut scale_one = Harness::new();
    scale_one.begin(64, 32);
    scale_one.ok(flat(1, 8, 8, 40, 20, RED));
    label(&mut scale_one, 1, Some("#123"));
    hover(&mut scale_one, Some(DebugPoint { x: 10, y: 10 }));
    grid(&mut scale_one, Some(style(255, 1)));
    let scale_one = scale_one.end().bytes;

    let mut scale_three = Harness::new();
    scale_three.begin(64, 32);
    scale_three.ok(flat(1, 8, 8, 40, 20, RED));
    label(&mut scale_three, 1, Some("#123"));
    hover(&mut scale_three, Some(DebugPoint { x: 10, y: 10 }));
    grid(&mut scale_three, Some(style(255, 3)));
    let scale_three = scale_three.end().bytes;
    assert_ne!(scale_one, scale_three);
}

#[test]
fn row_g6_label_alpha_zero_disables_labels() {
    let mut h = Harness::new();
    h.begin(32, 32);
    h.ok(flat(1, 0, 0, 15, 15, RED));
    label(&mut h, 1, Some("node"));
    hover(&mut h, Some(DebugPoint { x: 4, y: 4 }));
    grid(&mut h, Some(style(0, 1)));
    let transparent = h.end().bytes;

    let mut plain = Harness::new();
    plain.begin(32, 32);
    plain.ok(flat(1, 0, 0, 15, 15, RED));
    grid(&mut plain, Some(style(0, 1)));
    assert_eq!(transparent, plain.end().bytes);
}

fn text_frame(scale: u8) -> Vec<u8> {
    let mut h = Harness::new();
    h.begin(64, 32);
    h.ok(flat(1, 8, 8, 40, 20, RED));
    label(&mut h, 1, Some("#123"));
    hover(&mut h, Some(DebugPoint { x: 10, y: 10 }));
    grid(&mut h, Some(style(255, scale)));
    h.end().bytes
}

const INK_BG: Color = Color {
    r: 14,
    g: 14,
    b: 14,
    a: 255,
};
const BLACK: Color = Color {
    r: 0,
    g: 0,
    b: 0,
    a: 255,
};
const LABEL_BASE: Color = Color {
    r: 0xF2,
    g: 0xF2,
    b: 0xF2,
    a: 255,
};
const LABEL_TIP: Color = Color {
    r: 0x8E,
    g: 0x8E,
    b: 0x8E,
    a: 255,
};

/// One layout-only node under the window, hovered so both labels show.
fn own_scale_frame(style: DebugGridStyle) -> Vec<u8> {
    let mut h = Harness::new();
    h.begin(32, 32);
    h.fill(rect(0, 0, 31, 31), INK_BG);
    h.ok(Request::Entity(fgce::Entity {
        id: NodeId(1),
        kind: fgce::EntityKind::Empty,
        on_grid: Some(false),
        edges: pixels(4, 4, 11, 11),
        align: None,
        blend: None,
        radius: None,
    }));
    h.ok(Request::DebugGrid { style: Some(style) });
    h.ok(Request::DebugHover(Some(DebugPoint { x: 5, y: 5 })));
    h.end().bytes
}

#[test]
fn row_g12_labels_have_their_own_scale() {
    let style = DebugGridStyle::new(BLACK, BLACK, 200, 1).with_label_colors(LABEL_BASE, LABEL_TIP);
    let bytes = own_scale_frame(style);
    let mut values: Vec<u8> = bytes
        .chunks_exact(4)
        .map(|pixel| pixel[0].max(pixel[1]).max(pixel[2]))
        .collect();
    values.sort_unstable();
    values.dedup();
    assert_eq!(
        values,
        vec![0, INK_BG.r, 127, 217],
        "labels keep their own scale: black outlines, #F2 and #8E labels at alpha 200 over #0E"
    );
}

#[test]
fn row_g12_default_label_colors_keep_the_frame() {
    let shared = own_scale_frame(DebugGridStyle::new(BASE, TIP, 255, 1));
    let explicit =
        own_scale_frame(DebugGridStyle::new(BASE, TIP, 255, 1).with_label_colors(BASE, TIP));
    assert_eq!(
        shared, explicit,
        "unset label colors inherit base and tip byte for byte"
    );
}

#[test]
fn row_g12_arrows_follow_the_label_color() {
    let arrow = |style: DebugGridStyle| {
        let frame = own_scale_frame(style);
        // The root label `#0` starts at (2, 2). Its arrow column begins after
        // the text and ARROW_GAP: `#0` is two glyphs at scale 1, so the
        // documented advance gives text_width = 2 * 6 - 1 = 11.
        let text_width = 2 * 6 - 1;
        let arrow_x = 2 + text_width + 2;
        let stride = 32 * 4;
        let at = 2 * stride + arrow_x * 4;
        [frame[at], frame[at + 1], frame[at + 2], frame[at + 3]]
    };
    let shared = arrow(DebugGridStyle::new(BLACK, BLACK, 200, 1));
    let own =
        arrow(DebugGridStyle::new(BLACK, BLACK, 200, 1).with_label_colors(LABEL_BASE, LABEL_TIP));
    assert_eq!(
        shared,
        [3, 3, 3, 255],
        "the window arrow keeps the outline color at label_alpha 200 over #0E"
    );
    assert_eq!(
        own,
        [217, 217, 217, 255],
        "the window arrow is painted with its label color"
    );
}

fn arrows_frame() -> Vec<u8> {
    let mut h = Harness::new();
    h.begin(64, 64);
    h.ok(flat(1, 28, 28, 35, 35, RED));
    let pins = [
        (1, 1),
        (-1, 1),
        (1, -1),
        (-1, -1),
        (0, 1),
        (0, -1),
        (1, 0),
        (-1, 0),
        (0, 0),
    ];
    // Build the chain from the innermost box outwards; every box starts at 0
    // so `zero` stays 0 and local edges align with window coordinates.
    let mut child = 1_u32;
    for (index, (x, y)) in pins.iter().enumerate().rev() {
        let id = index as u32 + 2;
        let far = 41 + (9 - index as i32) * 2;
        arbitrary(
            &mut h,
            id,
            0,
            rect(0, 0, far, far),
            &[child],
            Pin { x: *x, y: *y },
        );
        child = id;
    }
    hover(&mut h, Some(DebugPoint { x: 30, y: 30 }));
    grid(&mut h, Some(style(255, 1)));
    h.end().bytes
}

#[test]
fn row_g6_debug_layer_is_painted_after_the_immediate_overlay() {
    let mut h = Harness::new();
    h.begin(16, 16);
    h.ok(flat(1, 0, 0, 15, 15, RED));
    h.ok(Request::DrawTree);
    h.fill(
        rect(0, 0, 15, 15),
        fgce::Color {
            r: 0,
            g: 0,
            b: 255,
            a: 255,
        },
    );
    grid(&mut h, Some(style(0, 1)));
    let frame = h.end();
    assert_eq!(
        frame.pixel(0, 5),
        [BASE.r, BASE.g, BASE.b, 255],
        "the debug outline is above the immediate layer"
    );
    assert_eq!(
        frame.pixel(5, 5),
        [0, 0, 255, 255],
        "the overlay hides the tree"
    );
}

#[test]
fn row_g6_empty_entity_is_outlined() {
    let mut h = Harness::new();
    h.begin(16, 16);
    h.ok(Request::Entity(fgce::Entity {
        id: NodeId(1),
        kind: fgce::EntityKind::Empty,
        on_grid: Some(false),
        edges: pixels(4, 4, 7, 7),
        align: None,
        blend: None,
        radius: None,
    }));
    grid(&mut h, Some(style(0, 1)));
    let frame = h.end();
    assert_eq!(frame.pixel(4, 5), [TIP.r, TIP.g, TIP.b, 255]);
    assert_eq!(frame.pixel(5, 5), [0, 0, 0, 0], "Empty paints no pixels");
}

#[test]
fn row_g6_window_label_is_supported() {
    let build = |window: Option<&str>| {
        let mut h = Harness::new();
        h.begin(32, 32);
        h.ok(flat(1, 0, 0, 9, 9, RED));
        if let Some(text) = window {
            label(&mut h, 0, Some(text));
        }
        hover(&mut h, Some(DebugPoint { x: 4, y: 4 }));
        grid(&mut h, Some(style(255, 1)));
        h.end().bytes
    };
    assert_ne!(build(None), build(Some("window")));
}

#[test]
fn row_g6_text_fixtures_are_frozen() {
    assert_eq!(text_frame(1), DEBUG_TEXT_1);
    assert_eq!(text_frame(3), DEBUG_TEXT_3);
}

#[test]
fn row_g6_arrow_fixture_is_frozen() {
    assert_eq!(arrows_frame(), DEBUG_ARROWS);
}

#[test]
fn row_g6_default_label_is_hash_id() {
    let mut default = Harness::new();
    default.begin(32, 32);
    default.ok(flat(1, 0, 0, 9, 9, RED));
    hover(&mut default, Some(DebugPoint { x: 4, y: 4 }));
    grid(&mut default, Some(style(255, 1)));
    let default = default.end().bytes;

    let mut named = Harness::new();
    named.begin(32, 32);
    named.ok(flat(1, 0, 0, 9, 9, RED));
    label(&mut named, 1, Some("#1"));
    hover(&mut named, Some(DebugPoint { x: 4, y: 4 }));
    grid(&mut named, Some(style(255, 1)));
    assert_eq!(default, named.end().bytes);
}

#[test]
fn row_g6_pin_moves_the_label_corner() {
    let build = |pin: Pin| {
        let mut h = Harness::new();
        h.begin(48, 48);
        h.ok(flat(1, 8, 8, 23, 23, RED));
        arbitrary(&mut h, 2, 0, rect(4, 4, 32, 32), &[1], pin);
        label(&mut h, 1, Some("leaf"));
        hover(&mut h, Some(DebugPoint { x: 10, y: 10 }));
        grid(&mut h, Some(style(255, 1)));
        h.end().bytes
    };
    let left = build(Pin { x: -1, y: 1 });
    let right = build(Pin { x: 1, y: 1 });
    let bottom = build(Pin { x: -1, y: -1 });
    assert_ne!(left, right);
    assert_ne!(left, bottom);
}

#[test]
fn row_g6_hover_labels_only_the_hovered_branch() {
    let mut h = Harness::new();
    h.begin(48, 24);
    h.ok(flat(1, 2, 10, 9, 17, RED));
    h.ok(flat(2, 22, 10, 29, 17, RED));
    label(&mut h, 1, Some("a"));
    label(&mut h, 2, Some("b"));
    hover(&mut h, Some(DebugPoint { x: 5, y: 10 }));
    grid(&mut h, Some(style(255, 1)));
    let frame = h.end();

    let ink_points = |x1: i32, y1: i32, x2: i32, y2: i32| {
        let mut points = Vec::new();
        for y in y1..=y2 {
            for x in x1..=x2 {
                if frame.pixel(x, y)[3] > 0 {
                    points.push((x, y));
                }
            }
        }
        points
    };
    assert!(
        !ink_points(2, 2, 7, 8).is_empty(),
        "the hovered node is labelled"
    );
    assert!(
        ink_points(22, 2, 27, 8).is_empty(),
        "its sibling is not labelled: {:?}",
        ink_points(22, 2, 27, 8)
    );
}

#[test]
fn row_g6_label_clamps_into_the_frame_at_the_bottom_edge() {
    let mut h = Harness::new();
    h.begin(32, 16);
    h.ok(flat(1, 2, 2, 9, 15, RED));
    label(&mut h, 1, Some("a"));
    hover(&mut h, Some(DebugPoint { x: 5, y: 5 }));
    grid(&mut h, Some(style(255, 1)));
    let frame = h.end();

    let mut ink = false;
    for y in 9..16 {
        for x in 1..7 {
            ink |= frame.pixel(x, y) == [TIP.r, TIP.g, TIP.b, 255];
        }
    }
    assert!(ink, "the label is clamped into the frame");
}

#[test]
#[ignore = "regenerates the debug fixtures; review the diff"]
fn regen_debug_fixtures() {
    std::fs::create_dir_all("fixtures").unwrap();
    std::fs::write("fixtures/debug_text_1.bin", text_frame(1)).unwrap();
    std::fs::write("fixtures/debug_text_3.bin", text_frame(3)).unwrap();
    std::fs::write("fixtures/debug_arrows.bin", arrows_frame()).unwrap();
}

#[test]
fn row_g6_remove_and_redefine_forget_names() {
    let mut h = Harness::new();
    h.begin(32, 32);
    h.ok(flat(1, 0, 0, 9, 9, RED));
    label(&mut h, 1, Some("first"));
    h.remove(1);
    h.ok(flat(1, 0, 0, 9, 9, RED));
    hover(&mut h, Some(DebugPoint { x: 4, y: 4 }));
    grid(&mut h, Some(style(255, 1)));
    // The old name is gone; the default `#1` is drawn.
    let after_remove = h.end().bytes;

    h.begin(32, 32);
    h.ok(flat(1, 0, 0, 9, 9, RED));
    hover(&mut h, Some(DebugPoint { x: 4, y: 4 }));
    let default_name = h.end().bytes;
    assert_eq!(after_remove, default_name);

    h.define_reference(7, (32, 32), 5, 1, Pin { x: -1, y: 1 }, (0, 0));
    h.use_reference(7);
    h.begin(32, 32);
    h.ok(flat(2, 0, 0, 9, 9, RED));
    label(&mut h, 2, Some("named"));
    h.define_reference(7, (32, 32), 5, 1, Pin { x: -1, y: 1 }, (0, 0));
    h.begin(32, 32);
    h.ok(flat(2, 0, 0, 9, 9, RED));
    hover(&mut h, Some(DebugPoint { x: 4, y: 4 }));
    grid(&mut h, Some(style(255, 1)));
    let after_redefine = h.end().bytes;

    let mut default_name = Harness::new();
    default_name.begin(32, 32);
    default_name.ok(flat(2, 0, 0, 9, 9, RED));
    hover(&mut default_name, Some(DebugPoint { x: 4, y: 4 }));
    grid(&mut default_name, Some(style(255, 1)));
    assert_eq!(
        after_redefine,
        default_name.end().bytes,
        "DefineReference forgets the old name"
    );
}
