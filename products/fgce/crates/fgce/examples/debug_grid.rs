//! Standalone debug-layer example: build a tree, enable `DebugGrid`, hover a
//! node and print the resulting frame as ASCII art.
//!
//! Run with `cargo run -p fgce --example debug_grid` from `products/fgce`.
//! The kernel is the only dependency.

use fgce::{
    Color, DebugGridStyle, DebugPoint, Edge, Edges, Engine, Entity, EntityKind, NodeId, Pin,
    Request, Response,
};

const WIDTH: u32 = 64;
const HEIGHT: u32 = 40;

const WINDOW: NodeId = NodeId(0);
const OUTER: NodeId = NodeId(1);
const INNER: NodeId = NodeId(2);
const LEAF: NodeId = NodeId(3);

fn edges(x1: i32, y1: i32, x2: i32, y2: i32) -> Edges {
    Edges {
        x1: Edge::Pixel(x1),
        y1: Edge::Pixel(y1),
        x2: Edge::Pixel(x2),
        y2: Edge::Pixel(y2),
    }
}

fn main() -> Result<(), fgce::Error> {
    let mut engine = Engine::new();
    engine.submit(Request::Begin {
        width: WIDTH,
        height: HEIGHT,
    })?;

    engine.submit(Request::Entity(Entity {
        id: LEAF,
        kind: EntityKind::Empty,
        on_grid: Some(false),
        edges: edges(20, 12, 43, 27),
        align: None,
        blend: None,
        radius: None,
    }))?;
    engine.submit(Request::Arbitrary {
        id: INNER,
        parent: WINDOW,
        on_grid: Some(false),
        edges: edges(14, 10, 49, 29),
        children: &[LEAF],
        pin: Pin { x: -1, y: 1 },
        snap: false,
        inset: None,
    })?;
    engine.submit(Request::Arbitrary {
        id: OUTER,
        parent: WINDOW,
        on_grid: Some(false),
        edges: edges(6, 6, 57, 33),
        children: &[INNER],
        pin: Pin { x: -1, y: 1 },
        snap: false,
        inset: None,
    })?;

    engine.submit(Request::DebugLabel {
        id: WINDOW,
        text: Some("WINDOW"),
    })?;
    engine.submit(Request::DebugLabel {
        id: OUTER,
        text: Some("OUTER"),
    })?;
    engine.submit(Request::DebugLabel {
        id: INNER,
        text: Some("INNER"),
    })?;
    engine.submit(Request::DebugLabel {
        id: LEAF,
        text: Some("LEAF"),
    })?;
    engine.submit(Request::DebugGrid {
        style: Some(
            DebugGridStyle::new(
                Color {
                    r: 200,
                    g: 200,
                    b: 200,
                    a: 255,
                },
                Color {
                    r: 80,
                    g: 80,
                    b: 80,
                    a: 255,
                },
                255,
                1,
            )
            .with_label_colors(
                Color {
                    r: 255,
                    g: 220,
                    b: 120,
                    a: 255,
                },
                Color {
                    r: 120,
                    g: 200,
                    b: 255,
                    a: 255,
                },
            ),
        ),
    })?;
    engine.submit(Request::DebugHover(Some(DebugPoint { x: 30, y: 20 })))?;

    let Response::Frame(frame) = engine.submit(Request::End)? else {
        unreachable!("End returns a frame");
    };

    println!("frame {}x{}, hover (30, 20)", frame.width, frame.height);
    for y in 0..frame.height as usize {
        let row = &frame.pixels[y * frame.stride as usize..][..frame.width as usize * 4];
        let line: String = row
            .chunks_exact(4)
            .map(|pixel| {
                let (r, g, b, a) = (pixel[0], pixel[1], pixel[2], pixel[3]);
                match a {
                    0 => '.',
                    255 if r.max(g).max(b) > 200 => '#',
                    255 if r.max(g).max(b) > 100 => '+',
                    _ => ':',
                }
            })
            .collect();
        println!("{line}");
    }
    Ok(())
}
