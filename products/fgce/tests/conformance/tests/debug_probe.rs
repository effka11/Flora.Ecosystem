//! Conformance probe for the FGCE debug layer (`docs/fgce.md` §5.3, §12).
//!
//! The checks pin the engine behaviour a host inspector relies on: the depth
//! ramp, the label pass and its layout, the pin arrows, the disabled-mode frame
//! and the name bookkeeping. They use only the public `fgce` API, so an engine
//! change cannot silently alter the debug layer.

use fgce::{
    AlphaMode, Color, DebugGridStyle, DebugPoint, Edge, Edges, Engine, Entity, EntityKind, Error,
    NodeId, Pin, Rect, ReferenceId, Request, Response,
};

const SIDE: i32 = 64;
const FRAME: Rect = Rect {
    x1: 0,
    y1: 0,
    x2: SIDE - 1,
    y2: SIDE - 1,
};

const WINDOW: NodeId = NodeId(0);
const OUTER: NodeId = NodeId(1);
const INNER: NodeId = NodeId(2);
const LEAF: NodeId = NodeId(3);
const PIN: Pin = Pin { x: -1, y: 1 };

const WHITE: Color = Color {
    r: 255,
    g: 255,
    b: 255,
    a: 255,
};
const BLACK: Color = Color {
    r: 0,
    g: 0,
    b: 0,
    a: 255,
};
const RED: Color = Color {
    r: 255,
    g: 0,
    b: 0,
    a: 255,
};
const BLUE: Color = Color {
    r: 0,
    g: 0,
    b: 255,
    a: 255,
};
const GREEN: Color = Color {
    r: 0,
    g: 255,
    b: 0,
    a: 255,
};

fn begin(engine: &mut Engine) {
    engine
        .submit(Request::Begin {
            width: SIDE as u32,
            height: SIDE as u32,
        })
        .expect("begin");
}

fn edges(x1: i32, y1: i32, x2: i32, y2: i32) -> Edges {
    Edges {
        x1: Edge::Pixel(x1),
        y1: Edge::Pixel(y1),
        x2: Edge::Pixel(x2),
        y2: Edge::Pixel(y2),
    }
}

fn rect(x1: i32, y1: i32, x2: i32, y2: i32) -> Rect {
    Rect { x1, y1, x2, y2 }
}

fn empty_entity(engine: &mut Engine, id: NodeId, rect: Rect) {
    engine
        .submit(Request::Entity(Entity {
            id,
            kind: EntityKind::Empty,
            on_grid: Some(false),
            edges: edges(rect.x1, rect.y1, rect.x2, rect.y2),
            align: None,
            blend: None,
            radius: None,
        }))
        .expect("empty entity");
}

fn arbitrary_at(engine: &mut Engine, id: NodeId, rect: Rect, children: &[NodeId], pin: Pin) {
    engine
        .submit(Request::Arbitrary {
            id,
            parent: WINDOW,
            on_grid: Some(false),
            edges: edges(rect.x1, rect.y1, rect.x2, rect.y2),
            children,
            pin,
            snap: false,
            inset: None,
        })
        .expect("arbitrary");
}

fn arbitrary_node(engine: &mut Engine, id: NodeId, rect: Rect, children: &[NodeId]) {
    arbitrary_at(engine, id, rect, children, PIN);
}

/// Window → `OUTER` → `INNER` → `LEAF`, three levels below the root.
///
/// All boxes are `Empty`, so the frame contains outlines and labels only.
fn build_tree(engine: &mut Engine) {
    empty_entity(engine, LEAF, rect(15, 15, 45, 45));
    arbitrary_node(engine, INNER, rect(10, 10, 50, 50), &[LEAF]);
    arbitrary_node(engine, OUTER, rect(5, 5, 55, 55), &[INNER]);
}

fn style(label_alpha: u8) -> DebugGridStyle {
    DebugGridStyle::new(WHITE, BLACK, label_alpha, 1)
}

fn label(engine: &mut Engine, id: NodeId, text: &str) {
    engine
        .submit(Request::DebugLabel {
            id,
            text: Some(text),
        })
        .expect("label");
}

fn hover(engine: &mut Engine, point: Option<(i32, i32)>) {
    engine
        .submit(Request::DebugHover(point.map(|(x, y)| DebugPoint { x, y })))
        .expect("hover");
}

fn read(engine: &mut Engine) -> Vec<[u8; 4]> {
    read_rect(engine, SIDE, SIDE)
}

fn read_rect(engine: &mut Engine, width: i32, height: i32) -> Vec<[u8; 4]> {
    let area = Rect {
        x1: 0,
        y1: 0,
        x2: width - 1,
        y2: height - 1,
    };
    let Response::Pixels(pixels) = engine
        .submit(Request::ReadPixels {
            rect: area,
            alpha: AlphaMode::Straight,
        })
        .expect("pixels")
    else {
        panic!("pixels");
    };
    let mut frame = Vec::with_capacity((width * height) as usize);
    for y in 0..height as usize {
        let row = &pixels.bytes[y * pixels.stride as usize..][..pixels.width as usize * 4];
        for pixel in row.chunks_exact(4) {
            frame.push([pixel[0], pixel[1], pixel[2], pixel[3]]);
        }
    }
    frame
}

fn end_and_read(engine: &mut Engine) -> Vec<[u8; 4]> {
    engine.submit(Request::End).expect("end");
    read(engine)
}

fn end_and_read_rect(engine: &mut Engine, width: i32, height: i32) -> Vec<[u8; 4]> {
    engine.submit(Request::End).expect("end");
    read_rect(engine, width, height)
}

fn pixel_in(frame: &[[u8; 4]], width: i32, x: i32, y: i32) -> [u8; 4] {
    frame[y as usize * width as usize + x as usize]
}

fn pixel(frame: &[[u8; 4]], x: i32, y: i32) -> [u8; 4] {
    pixel_in(frame, SIDE, x, y)
}

/// Inclusive ink bounds of one exact colour, for layout assertions.
fn bounds(frame: &[[u8; 4]], width: i32, height: i32, color: [u8; 4]) -> Option<Rect> {
    let mut found: Option<Rect> = None;
    for y in 0..height {
        for x in 0..width {
            if pixel_in(frame, width, x, y) != color {
                continue;
            }
            found = Some(match found {
                None => Rect {
                    x1: x,
                    y1: y,
                    x2: x,
                    y2: y,
                },
                Some(area) => Rect {
                    x1: area.x1.min(x),
                    y1: area.y1.min(y),
                    x2: area.x2.max(x),
                    y2: area.y2.max(y),
                },
            });
        }
    }
    found
}

fn changed_in(after: &[[u8; 4]], before: &[[u8; 4]], x1: i32, y1: i32, x2: i32, y2: i32) -> usize {
    let mut changed = 0;
    for y in y1..=y2 {
        for x in x1..=x2 {
            if pixel(after, x, y) != pixel(before, x, y) {
                changed += 1;
            }
        }
    }
    changed
}

#[test]
fn outline_ramp_matches_three_and_five_levels() {
    // Three-level tree (window plus two): 0 / 50 / 100. The invisible
    // branch must not raise `max_depth`, so the visible ramp stays at depth 2.
    let mut engine = Engine::new();
    begin(&mut engine);
    empty_entity(&mut engine, NodeId(2), rect(15, 15, 45, 45));
    arbitrary_node(&mut engine, NodeId(1), rect(10, 10, 50, 50), &[NodeId(2)]);
    empty_entity(&mut engine, NodeId(20), rect(100, 100, 110, 110));
    arbitrary_node(
        &mut engine,
        NodeId(21),
        rect(100, 100, 120, 120),
        &[NodeId(20)],
    );
    arbitrary_node(
        &mut engine,
        NodeId(22),
        rect(100, 100, 124, 124),
        &[NodeId(21)],
    );
    engine
        .submit(Request::DebugGrid {
            style: Some(style(0)),
        })
        .expect("grid");
    let frame = end_and_read(&mut engine);
    assert_eq!(pixel(&frame, 0, 30), [255, 255, 255, 255], "window");
    assert_eq!(pixel(&frame, 10, 30), [128, 128, 128, 255], "mid");
    assert_eq!(
        pixel(&frame, 15, 30),
        [0, 0, 0, 255],
        "the Empty leaf is outlined at the tip"
    );

    // Five levels below the root: 0 / 25 / 50 / 75 / 100.
    let mut engine = Engine::new();
    begin(&mut engine);
    empty_entity(&mut engine, NodeId(4), rect(20, 20, 40, 40));
    arbitrary_node(&mut engine, NodeId(3), rect(15, 15, 45, 45), &[NodeId(4)]);
    arbitrary_node(&mut engine, NodeId(2), rect(10, 10, 50, 50), &[NodeId(3)]);
    arbitrary_node(&mut engine, NodeId(1), rect(5, 5, 55, 55), &[NodeId(2)]);
    engine
        .submit(Request::DebugGrid {
            style: Some(style(0)),
        })
        .expect("grid");
    let frame = end_and_read(&mut engine);
    assert_eq!(pixel(&frame, 0, 30), [255, 255, 255, 255], "window");
    assert_eq!(pixel(&frame, 5, 30), [191, 191, 191, 255], "25 %");
    assert_eq!(pixel(&frame, 10, 30), [128, 128, 128, 255], "50 %");
    assert_eq!(pixel(&frame, 15, 30), [64, 64, 64, 255], "75 %");
    assert_eq!(pixel(&frame, 20, 30), [0, 0, 0, 255], "100 %");
}

#[test]
fn debug_layer_draws_over_immediate_commands() {
    let mut engine = Engine::new();
    begin(&mut engine);
    build_tree(&mut engine);
    engine
        .submit(Request::DebugGrid {
            style: Some(style(0)),
        })
        .expect("grid");
    engine.submit(Request::DrawTree).expect("tree");
    let green = Color {
        r: 0,
        g: 255,
        b: 0,
        a: 255,
    };
    engine
        .submit(Request::FillRect {
            rect: Rect {
                x1: 0,
                y1: 30,
                x2: 0,
                y2: 30,
            },
            color: green,
            blend: None,
            radius: None,
        })
        .expect("fill");
    let frame = end_and_read(&mut engine);
    assert_eq!(
        pixel(&frame, 0, 30),
        [255, 255, 255, 255],
        "the debug pass must run after immediate commands"
    );
}

#[test]
fn disabled_grid_restores_the_plain_frame() {
    let mut engine = Engine::new();
    begin(&mut engine);
    build_tree(&mut engine);
    let plain = end_and_read(&mut engine);

    begin(&mut engine);
    engine
        .submit(Request::DebugGrid {
            style: Some(style(255)),
        })
        .expect("grid");
    label(&mut engine, WINDOW, "WINDOW");
    label(&mut engine, LEAF, "LEAF");
    hover(&mut engine, Some((30, 30)));
    let lit = end_and_read(&mut engine);
    assert_ne!(lit, plain, "the debug layer must change the frame");

    begin(&mut engine);
    engine
        .submit(Request::DebugGrid { style: None })
        .expect("grid off");
    let off = end_and_read(&mut engine);
    assert_eq!(
        off, plain,
        "DebugGrid {{ style: None }} must restore the plain frame"
    );

    begin(&mut engine);
    engine
        .submit(Request::DebugGrid {
            style: Some(style(255)),
        })
        .expect("grid on again");
    let reenabled = end_and_read(&mut engine);
    assert_eq!(
        reenabled, lit,
        "names and hover must survive DebugGrid {{ style: None }}"
    );
}

#[test]
fn label_alpha_zero_and_no_hover_draw_no_labels() {
    let mut engine = Engine::new();
    begin(&mut engine);
    build_tree(&mut engine);
    engine
        .submit(Request::DebugGrid {
            style: Some(style(0)),
        })
        .expect("grid");
    label(&mut engine, LEAF, "LEAF");
    hover(&mut engine, Some((30, 30)));
    let muted = end_and_read(&mut engine);

    begin(&mut engine);
    engine
        .submit(Request::DebugGrid {
            style: Some(style(255)),
        })
        .expect("grid");
    hover(&mut engine, None);
    let no_hover = end_and_read(&mut engine);

    assert_eq!(
        muted, no_hover,
        "label_alpha = 0 and DebugHover(None) must paint outlines only"
    );
    assert_eq!(
        pixel(&muted, 0, 30),
        [255, 255, 255, 255],
        "label_alpha = 0 must keep the outlines"
    );
}

#[test]
fn hover_over_empty_space_draws_no_labels() {
    let mut engine = Engine::new();
    begin(&mut engine);
    build_tree(&mut engine);
    engine
        .submit(Request::DebugGrid {
            style: Some(style(255)),
        })
        .expect("grid");
    label(&mut engine, WINDOW, "WINDOW");
    hover(&mut engine, Some((63, 0)));
    let empty = end_and_read(&mut engine);

    begin(&mut engine);
    hover(&mut engine, None);
    let no_hover = end_and_read(&mut engine);
    assert_eq!(empty, no_hover, "the window is not a hover candidate");

    begin(&mut engine);
    hover(&mut engine, Some((-5, -5)));
    let outside = end_and_read(&mut engine);
    assert_eq!(
        outside, no_hover,
        "a point outside the frame draws no labels"
    );

    begin(&mut engine);
    hover(&mut engine, Some((30, 30)));
    let leaf = end_and_read(&mut engine);
    let window_label = changed_in(&leaf, &no_hover, 0, 0, 40, 10);
    assert!(
        window_label > 10,
        "NodeId(0) must be labelled at its pin (top-left), got {window_label} px"
    );
}

#[test]
fn remove_forgets_the_label_and_unnamed_nodes_use_their_id() {
    let mut engine = Engine::new();
    begin(&mut engine);
    build_tree(&mut engine);
    engine
        .submit(Request::DebugGrid {
            style: Some(style(255)),
        })
        .expect("grid");
    label(&mut engine, LEAF, "MMMMM");
    hover(&mut engine, Some((30, 30)));
    let named = end_and_read(&mut engine);

    begin(&mut engine);
    engine
        .submit(Request::Remove { id: OUTER })
        .expect("remove");
    build_tree(&mut engine);
    hover(&mut engine, Some((30, 30)));
    let forgotten = end_and_read(&mut engine);
    assert!(
        changed_in(&forgotten, &named, 10, 15, 50, 30) > 0,
        "Remove must forget the name; the default label differs from MMMMM"
    );

    begin(&mut engine);
    label(&mut engine, LEAF, "#3");
    hover(&mut engine, Some((30, 30)));
    let explicit = end_and_read(&mut engine);
    assert_eq!(
        explicit, forgotten,
        "an unnamed node must render as #<NodeId>"
    );

    begin(&mut engine);
    engine
        .submit(Request::DebugLabel {
            id: LEAF,
            text: None,
        })
        .expect("clear label");
    hover(&mut engine, Some((30, 30)));
    let cleared = end_and_read(&mut engine);
    assert_eq!(
        cleared, forgotten,
        "DebugLabel {{ text: None }} must fall back to #<NodeId>"
    );
}

#[test]
fn label_colors_interpolate_on_their_own_scale() {
    let mut engine = Engine::new();
    begin(&mut engine);
    build_tree(&mut engine);
    engine
        .submit(Request::DebugGrid {
            style: Some(style(255).with_label_colors(RED, BLUE)),
        })
        .expect("grid");
    label(&mut engine, WINDOW, "WINDOW");
    hover(&mut engine, Some((30, 30)));
    let frame = end_and_read(&mut engine);

    let has = |color: [u8; 4], x1: i32, y1: i32, x2: i32, y2: i32| {
        (y1..=y2).any(|y| (x1..=x2).any(|x| pixel(&frame, x, y) == color))
    };
    assert!(
        has([RED.r, RED.g, RED.b, 255], 0, 0, 40, 10),
        "the root label must use label_base"
    );
    assert!(
        has([BLUE.r, BLUE.g, BLUE.b, 255], 10, 15, 50, 30),
        "the deepest label must use label_tip"
    );
}

#[test]
fn pin_moves_the_label_and_arrow_corner() {
    fn render(pin: Pin, label_alpha: u8) -> Vec<[u8; 4]> {
        let mut engine = Engine::new();
        begin(&mut engine);
        empty_entity(&mut engine, NodeId(2), rect(10, 10, 50, 50));
        arbitrary_at(
            &mut engine,
            NodeId(1),
            rect(10, 10, 50, 50),
            &[NodeId(2)],
            pin,
        );
        engine
            .submit(Request::DebugGrid {
                style: Some(style(label_alpha)),
            })
            .expect("grid");
        // A blank leaf label keeps the stack from pushing ink into the checked
        // corners; the node label and its arrow stay readable.
        label(&mut engine, NodeId(2), " ");
        hover(&mut engine, Some((30, 30)));
        end_and_read(&mut engine)
    }

    let outline = render(Pin { x: -1, y: 1 }, 0);
    let left = render(Pin { x: -1, y: 1 }, 255);
    assert!(
        changed_in(&left, &outline, 10, 10, 20, 16) > 0,
        "a top-left pin puts the label and the arrow in the top-left corner"
    );
    assert_eq!(changed_in(&left, &outline, 40, 10, 50, 16), 0);

    let outline = render(Pin { x: 1, y: 1 }, 0);
    let right = render(Pin { x: 1, y: 1 }, 255);
    assert_eq!(changed_in(&right, &outline, 10, 10, 20, 16), 0);
    assert!(
        changed_in(&right, &outline, 40, 10, 50, 16) > 0,
        "a top-right pin moves the label and the arrow to the top-right corner"
    );
}

#[test]
fn arrow_uses_the_label_color() {
    let mut engine = Engine::new();
    begin(&mut engine);
    empty_entity(&mut engine, NodeId(2), rect(10, 10, 50, 50));
    arbitrary_at(
        &mut engine,
        NodeId(1),
        rect(10, 10, 50, 50),
        &[NodeId(2)],
        PIN,
    );
    engine
        .submit(Request::DebugGrid {
            style: Some(style(255).with_label_colors(GREEN, GREEN)),
        })
        .expect("grid");
    // A blank label keeps the text off the canvas, so the only ink in the
    // arrow column comes from the arrow itself.
    label(&mut engine, NodeId(1), "  ");
    hover(&mut engine, Some((30, 30)));
    let frame = end_and_read(&mut engine);
    let green = [GREEN.r, GREEN.g, GREEN.b, 255];
    let arrow = (10..=20).any(|y| (10..=40).any(|x| pixel(&frame, x, y) == green));
    assert!(arrow, "the pin arrow must use the label colour");
}

#[test]
fn pin_directions_place_the_arrow() {
    let pins = [
        Pin { x: -1, y: 1 },
        Pin { x: 0, y: 1 },
        Pin { x: 1, y: 1 },
        Pin { x: -1, y: 0 },
        Pin { x: 0, y: 0 },
        Pin { x: 1, y: 0 },
        Pin { x: -1, y: -1 },
        Pin { x: 0, y: -1 },
        Pin { x: 1, y: -1 },
    ];
    for pin in pins {
        let mut engine = Engine::new();
        begin(&mut engine);
        empty_entity(&mut engine, NodeId(2), rect(10, 10, 50, 50));
        arbitrary_at(
            &mut engine,
            NodeId(1),
            rect(10, 10, 50, 50),
            &[NodeId(2)],
            pin,
        );
        engine
            .submit(Request::DebugGrid {
                style: Some(style(255).with_label_colors(GREEN, GREEN)),
            })
            .expect("grid");
        // Blank glyphs keep the letterbox free, so only the arrow is in ink.
        label(&mut engine, NodeId(1), "  ");
        hover(&mut engine, Some((30, 30)));
        let frame = end_and_read(&mut engine);

        // The arrow sits in its own column right after the blank text, on the
        // pinned side of the box: x = 12 + 11 + 2 for left/centre pins, and
        // x = 51 - 2 - (11 + 2 + 7) + 11 + 2 = 42 for right pins.
        let x = if pin.x == 1 { 42 } else { 25 };
        let y = if pin.y == -1 { 42 } else { 12 };
        let green = [GREEN.r, GREEN.g, GREEN.b, 255];
        let arrow = (y..=y + 6).any(|yy| (x..=x + 6).any(|xx| pixel(&frame, xx, yy) == green));
        assert!(arrow, "pin {pin:?} must draw the arrow at ({x},{y})");
    }
}

#[test]
fn diagonal_arrow_spans_seven_pixels() {
    let mut engine = Engine::new();
    begin(&mut engine);
    empty_entity(&mut engine, NodeId(2), rect(10, 10, 50, 50));
    arbitrary_at(
        &mut engine,
        NodeId(1),
        rect(10, 10, 50, 50),
        &[NodeId(2)],
        Pin { x: -1, y: 1 },
    );
    engine
        .submit(Request::DebugGrid {
            style: Some(style(255).with_label_colors(GREEN, GREEN)),
        })
        .expect("grid");
    label(&mut engine, NodeId(1), "  ");
    hover(&mut engine, Some((30, 30)));
    let frame = end_and_read(&mut engine);

    // The up-left arrow starts under the blank text at (25, 12). Its shaft
    // reaches the opposite corner of the 7×7 mask, and the two barbs are four
    // pixels long, so the head stays readable at the label scale.
    let green = |x: i32, y: i32| pixel(&frame, x, y) == [GREEN.r, GREEN.g, GREEN.b, 255];
    assert!(green(25, 12), "the point sits at the pinned corner");
    for offset in 0..7 {
        assert!(green(25 + offset, 12 + offset), "shaft must reach {offset}");
    }
    for offset in 0..4 {
        assert!(green(25 + offset, 12), "top barb at {offset}");
        assert!(green(25, 12 + offset), "left barb at {offset}");
    }
    assert!(
        !green(25 + 4, 12) && !green(25, 12 + 4),
        "the barbs are four pixels long"
    );
    assert!(
        !green(31, 12) && !green(25, 18),
        "the mask is 7×7, not larger"
    );
}

#[test]
fn label_colours_match_the_documented_brightness() {
    let mut engine = Engine::new();
    begin(&mut engine);
    engine
        .submit(Request::FillRect {
            rect: FRAME,
            color: Color {
                r: 0x0E,
                g: 0x0E,
                b: 0x0E,
                a: 255,
            },
            blend: None,
            radius: None,
        })
        .expect("background");
    build_tree(&mut engine);
    engine
        .submit(Request::DebugGrid {
            style: Some(style(200).with_label_colors(
                Color {
                    r: 0xF2,
                    g: 0xF2,
                    b: 0xF2,
                    a: 255,
                },
                Color {
                    r: 0x8E,
                    g: 0x8E,
                    b: 0x8E,
                    a: 255,
                },
            )),
        })
        .expect("grid");
    label(&mut engine, WINDOW, "WINDOW");
    hover(&mut engine, Some((30, 30)));
    let frame = end_and_read(&mut engine);

    let has = |value: u8, x1: i32, y1: i32, x2: i32, y2: i32| {
        (y1..=y2).any(|y| (x1..=x2).any(|x| pixel(&frame, x, y) == [value, value, value, 255]))
    };
    assert!(has(217, 0, 0, 40, 10), "the root label must land on 217");
    assert!(
        has(127, 10, 15, 50, 30),
        "the deepest label must land on 127"
    );
}

#[test]
fn reference_reset_forgets_labels() {
    let mut engine = Engine::new();
    let define = |engine: &mut Engine| {
        engine
            .submit(Request::DefineReference {
                id: ReferenceId(1),
                canon_w: SIDE as u32,
                canon_h: SIDE as u32,
                k: 5,
                d: 1,
                pin: PIN,
                enter_cols: 0,
                enter_rows: 0,
            })
            .expect("define reference");
    };
    define(&mut engine);
    begin(&mut engine);
    build_tree(&mut engine);
    engine
        .submit(Request::DebugGrid {
            style: Some(style(255)),
        })
        .expect("grid");
    label(&mut engine, LEAF, "MMMMM");
    hover(&mut engine, Some((30, 30)));
    let named = end_and_read(&mut engine);

    define(&mut engine);
    begin(&mut engine);
    build_tree(&mut engine);
    hover(&mut engine, Some((30, 30)));
    let forgotten = end_and_read(&mut engine);
    assert_ne!(named, forgotten, "a reference reset must forget the name");

    begin(&mut engine);
    label(&mut engine, LEAF, "#3");
    hover(&mut engine, Some((30, 30)));
    let explicit = end_and_read(&mut engine);
    assert_eq!(explicit, forgotten, "the reset name must be #<NodeId>");
}

#[test]
fn repeated_debug_grid_replaces_the_style() {
    let mut engine = Engine::new();
    begin(&mut engine);
    build_tree(&mut engine);
    engine
        .submit(Request::DebugGrid {
            style: Some(style(0)),
        })
        .expect("grid off labels");
    engine
        .submit(Request::DebugGrid {
            style: Some(style(255)),
        })
        .expect("grid on labels");
    label(&mut engine, WINDOW, "WINDOW");
    hover(&mut engine, Some((30, 30)));
    let repeated = end_and_read(&mut engine);

    begin(&mut engine);
    engine
        .submit(Request::DebugGrid {
            style: Some(style(255)),
        })
        .expect("grid");
    let once = end_and_read(&mut engine);
    assert_eq!(
        repeated, once,
        "a repeated DebugGrid must replace the style"
    );
}

#[test]
fn label_color_overrides_fall_back_to_the_outline_ends() {
    let mut engine = Engine::new();
    begin(&mut engine);
    build_tree(&mut engine);
    engine
        .submit(Request::DebugGrid {
            style: Some(DebugGridStyle {
                base: WHITE,
                tip: BLACK,
                label_base: Some(GREEN),
                label_tip: None,
                label_alpha: 255,
                label_scale: 1,
            }),
        })
        .expect("grid");
    label(&mut engine, WINDOW, "WINDOW");
    hover(&mut engine, Some((30, 30)));
    let frame = end_and_read(&mut engine);

    let has = |color: [u8; 4], x1: i32, y1: i32, x2: i32, y2: i32| {
        (y1..=y2).any(|y| (x1..=x2).any(|x| pixel(&frame, x, y) == color))
    };
    assert!(
        has([GREEN.r, GREEN.g, GREEN.b, 255], 0, 0, 40, 10),
        "the root label must use label_base"
    );
    assert!(
        has([BLACK.r, BLACK.g, BLACK.b, 255], 16, 28, 40, 36),
        "an unset label_tip must inherit the outline tip"
    );
}

#[test]
fn debug_state_survives_begin() {
    let mut engine = Engine::new();
    begin(&mut engine);
    build_tree(&mut engine);
    let plain = end_and_read(&mut engine);

    begin(&mut engine);
    engine
        .submit(Request::DebugGrid {
            style: Some(style(255)),
        })
        .expect("grid");
    label(&mut engine, WINDOW, "WINDOW");
    hover(&mut engine, Some((30, 30)));
    let first = end_and_read(&mut engine);
    assert_ne!(first, plain, "the debug layer must draw on top of the tree");

    begin(&mut engine);
    let second = end_and_read(&mut engine);
    assert_eq!(first, second, "Begin must keep the style, names and hover");
}

#[test]
fn outlines_follow_cell_boundaries_and_clip_at_the_frame() {
    let mut engine = Engine::new();
    begin(&mut engine);
    empty_entity(&mut engine, NodeId(1), rect(4, 4, 7, 7));
    engine
        .submit(Request::DebugGrid {
            style: Some(style(0)),
        })
        .expect("grid");
    let frame = end_and_read(&mut engine);

    assert_eq!(pixel(&frame, 4, 5), [0, 0, 0, 255], "left line");
    assert_eq!(
        pixel(&frame, 8, 5),
        [0, 0, 0, 255],
        "the right line sits on the cell boundary"
    );
    assert_eq!(pixel(&frame, 5, 8), [0, 0, 0, 255], "the bottom line");
    assert_eq!(
        pixel(&frame, 9, 5),
        [0, 0, 0, 0],
        "the next cell stays background"
    );

    assert_eq!(pixel(&frame, 0, 30), [255, 255, 255, 255], "window left");
    assert_eq!(pixel(&frame, 30, 0), [255, 255, 255, 255], "window top");
    assert_eq!(
        pixel(&frame, 63, 30),
        [0, 0, 0, 0],
        "the window right line is clipped, not clamped"
    );
    assert_eq!(
        pixel(&frame, 30, 63),
        [0, 0, 0, 0],
        "the window bottom line is clipped, not clamped"
    );
}

#[test]
fn root_label_follows_the_window_pin() {
    fn frame(pin: Pin, label_alpha: u8) -> Vec<[u8; 4]> {
        let mut engine = Engine::new();
        engine
            .submit(Request::DefineReference {
                id: ReferenceId(1),
                canon_w: SIDE as u32,
                canon_h: SIDE as u32,
                k: 5,
                d: 1,
                pin,
                enter_cols: 0,
                enter_rows: 0,
            })
            .expect("reference");
        engine
            .submit(Request::UseReference { id: ReferenceId(1) })
            .expect("use reference");
        begin(&mut engine);
        build_tree(&mut engine);
        engine
            .submit(Request::DebugGrid {
                style: Some(style(label_alpha)),
            })
            .expect("grid");
        hover(&mut engine, Some((30, 30)));
        end_and_read(&mut engine)
    }

    let left_outline = frame(Pin { x: -1, y: 1 }, 0);
    let left = frame(Pin { x: -1, y: 1 }, 255);
    assert!(
        changed_in(&left, &left_outline, 0, 0, 30, 6) > 0,
        "the default top-left window pin labels the top-left corner"
    );
    assert_eq!(
        changed_in(&left, &left_outline, 35, 0, 63, 6),
        0,
        "the default pin draws no root label on the right"
    );

    let right_outline = frame(Pin { x: 1, y: 1 }, 0);
    let right = frame(Pin { x: 1, y: 1 }, 255);
    assert!(
        changed_in(&right, &right_outline, 35, 0, 63, 6) > 0,
        "a top-right window pin moves the root label and arrow right"
    );
    assert_eq!(
        changed_in(&right, &right_outline, 0, 0, 30, 6),
        0,
        "the top-right pin draws no root label on the left"
    );
}

#[test]
fn pin_masks_match_the_calibrated_geometry() {
    const UP: [u8; 7] = [0x08, 0x14, 0x22, 0x49, 0x08, 0x08, 0x08];
    const DOWN: [u8; 7] = [0x08, 0x08, 0x08, 0x49, 0x22, 0x14, 0x08];
    const LEFT: [u8; 7] = [0x08, 0x10, 0x20, 0x7F, 0x20, 0x10, 0x08];
    const RIGHT: [u8; 7] = [0x08, 0x04, 0x02, 0x7F, 0x02, 0x04, 0x08];
    const UP_LEFT: [u8; 7] = [0x78, 0x60, 0x50, 0x48, 0x04, 0x02, 0x01];
    const UP_RIGHT: [u8; 7] = [0x0F, 0x03, 0x05, 0x09, 0x10, 0x20, 0x40];
    const DOWN_LEFT: [u8; 7] = [0x01, 0x02, 0x04, 0x48, 0x50, 0x60, 0x78];
    const DOWN_RIGHT: [u8; 7] = [0x40, 0x20, 0x10, 0x09, 0x05, 0x03, 0x0F];
    const CIRCLE: [u8; 7] = [0x1C, 0x22, 0x41, 0x41, 0x41, 0x22, 0x1C];

    fn arrow_frame(pin: Pin) -> Vec<[u8; 4]> {
        let mut engine = Engine::new();
        begin(&mut engine);
        empty_entity(&mut engine, NodeId(2), rect(10, 10, 50, 50));
        arbitrary_at(
            &mut engine,
            NodeId(1),
            rect(10, 10, 50, 50),
            &[NodeId(2)],
            pin,
        );
        let invisible = Color {
            r: 0,
            g: 0,
            b: 0,
            a: 0,
        };
        engine
            .submit(Request::DebugGrid {
                style: Some(
                    DebugGridStyle::new(invisible, invisible, 255, 1)
                        .with_label_colors(GREEN, GREEN),
                ),
            })
            .expect("grid");
        label(&mut engine, NodeId(1), "  ");
        hover(&mut engine, Some((30, 30)));
        end_and_read(&mut engine)
    }

    let pins = [
        (Pin { x: 0, y: 1 }, UP),
        (Pin { x: 0, y: -1 }, DOWN),
        (Pin { x: -1, y: 0 }, LEFT),
        (Pin { x: 1, y: 0 }, RIGHT),
        (Pin { x: -1, y: 1 }, UP_LEFT),
        (Pin { x: 1, y: 1 }, UP_RIGHT),
        (Pin { x: -1, y: -1 }, DOWN_LEFT),
        (Pin { x: 1, y: -1 }, DOWN_RIGHT),
        (Pin { x: 0, y: 0 }, CIRCLE),
    ];
    let green = [GREEN.r, GREEN.g, GREEN.b, 255];
    for (pin, mask) in pins {
        let frame = arrow_frame(pin);
        let x = if pin.x == 1 { 42 } else { 25 };
        let y = if pin.y == -1 { 42 } else { 12 };
        for (row, bits) in mask.iter().enumerate() {
            for column in 0..7 {
                let expected = bits & (1 << (6 - column)) != 0;
                let actual = pixel(&frame, x + column, y + row as i32) == green;
                assert_eq!(
                    actual, expected,
                    "pin {pin:?} must match the 7×7 mask at ({column}, {row})"
                );
            }
        }
    }
}

#[test]
fn label_chain_stacks_without_overlap_inside_the_frame() {
    let mut engine = Engine::new();
    begin(&mut engine);
    build_tree(&mut engine);
    let invisible = Color {
        r: 0,
        g: 0,
        b: 0,
        a: 0,
    };
    engine
        .submit(Request::DebugGrid {
            style: Some(
                DebugGridStyle::new(invisible, invisible, 255, 1).with_label_colors(RED, BLUE),
            ),
        })
        .expect("grid");
    hover(&mut engine, Some((30, 30)));
    let frame = end_and_read(&mut engine);

    let labels = [
        ([RED.r, RED.g, RED.b, 255], "root"),
        ([170, 0, 85, 255], "outer"),
        ([85, 0, 170, 255], "inner"),
        ([BLUE.r, BLUE.g, BLUE.b, 255], "leaf"),
    ];
    let mut areas = Vec::new();
    for (color, name) in labels {
        let area = bounds(&frame, SIDE, SIDE, color)
            .unwrap_or_else(|| panic!("{name} label must be drawn"));
        assert!(
            area.x1 >= 0 && area.y1 >= 0 && area.x2 < SIDE && area.y2 < SIDE,
            "{name} label must stay inside the frame: {area:?}"
        );
        areas.push((name, area));
    }
    for (index, (name, area)) in areas.iter().enumerate() {
        for (other_name, other) in areas.iter().skip(index + 1) {
            assert!(
                area.x2 < other.x1
                    || other.x2 < area.x1
                    || area.y2 < other.y1
                    || other.y2 < area.y1,
                "{name} {area:?} and {other_name} {other:?} must not overlap"
            );
        }
    }
    assert!(
        areas[0].1.y1 < areas[1].1.y1 && areas[1].1.y1 < areas[2].1.y1,
        "the chain stacks top to bottom: {:?}",
        areas
            .iter()
            .map(|(name, area)| (*name, area.y1))
            .collect::<Vec<_>>()
    );
}

#[test]
fn small_frame_clamps_the_label_chain_into_the_bottom_band() {
    const WIDTH: i32 = 32;
    const HEIGHT: i32 = 16;

    let mut engine = Engine::new();
    engine
        .submit(Request::Begin {
            width: WIDTH as u32,
            height: HEIGHT as u32,
        })
        .expect("begin");
    empty_entity(&mut engine, LEAF, rect(12, 6, 19, 11));
    arbitrary_at(&mut engine, INNER, rect(8, 4, 23, 12), &[LEAF], PIN);
    arbitrary_at(&mut engine, OUTER, rect(4, 2, 27, 13), &[INNER], PIN);
    let invisible = Color {
        r: 0,
        g: 0,
        b: 0,
        a: 0,
    };
    engine
        .submit(Request::DebugGrid {
            style: Some(
                DebugGridStyle::new(invisible, invisible, 255, 1).with_label_colors(RED, BLUE),
            ),
        })
        .expect("grid");
    hover(&mut engine, Some((15, 8)));
    let frame = end_and_read_rect(&mut engine, WIDTH, HEIGHT);

    let root = bounds(&frame, WIDTH, HEIGHT, [RED.r, RED.g, RED.b, 255])
        .expect("the root label must be drawn");
    assert_eq!(
        (root.y1, root.y2),
        (2, 8),
        "the root label keeps the top band: {root:?}"
    );

    let labels = [
        ([170, 0, 85, 255], "outer"),
        ([85, 0, 170, 255], "inner"),
        ([BLUE.r, BLUE.g, BLUE.b, 255], "leaf"),
    ];
    let mut areas = Vec::new();
    for (color, name) in labels {
        let area = bounds(&frame, WIDTH, HEIGHT, color)
            .unwrap_or_else(|| panic!("{name} label must be drawn"));
        assert_eq!(area.y1, 9, "{name} is clamped to the bottom band: {area:?}");
        assert!(
            area.x1 >= 0 && area.x2 < WIDTH && area.y2 < HEIGHT,
            "{name} stays inside the frame: {area:?}"
        );
        areas.push((name, area));
    }

    let overlaps = |a: Rect, b: Rect| a.x1 <= b.x2 && b.x1 <= a.x2 && a.y1 <= b.y2 && b.y1 <= a.y2;
    assert!(
        overlaps(areas[0].1, areas[1].1),
        "a chain taller than the frame lets the outer and inner labels overlap: {areas:?}"
    );
    assert!(
        overlaps(areas[1].1, areas[2].1),
        "the leaf joins the same bottom band: {areas:?}"
    );
}

#[test]
fn label_validation_limits() {
    let mut engine = Engine::new();
    let long = "x".repeat(65);
    assert_eq!(
        engine
            .submit(Request::DebugLabel {
                id: LEAF,
                text: Some(&long),
            })
            .unwrap_err(),
        Error::BufferLayout
    );
    let limit = "x".repeat(64);
    engine
        .submit(Request::DebugLabel {
            id: LEAF,
            text: Some(&limit),
        })
        .expect("64 bytes fit");
    assert_eq!(
        engine
            .submit(Request::DebugGrid {
                style: Some(DebugGridStyle::new(WHITE, BLACK, 255, 5)),
            })
            .unwrap_err(),
        Error::BufferLayout
    );
    for scale in 1..=4 {
        engine
            .submit(Request::DebugGrid {
                style: Some(DebugGridStyle::new(WHITE, BLACK, 255, scale)),
            })
            .expect("label_scale 1..=4 fits");
    }
}
