//! §12 addendum: fuzz `submit` and check that every `Err` leaves the observable
//! state and bytes unchanged.
//!
//! Deterministic `xorshift64*`; no external crates. A failure prints the seed and
//! the operation index.

use fgce::{
    Align, AlphaMode, Blend, Cap, Color, DebugGridStyle, DebugPoint, Edge, Edges, Entity,
    EntityKind, Error, Fill, FillRule, ImageId, Inset, Join, NodeId, Peak, Pin, PixelFormat,
    Radius, ReferenceId, Request, Sample, Stroke, StrokeAlign, Verb,
};
use fgce_conformance::{Harness, Lcg, bpp};

const SEQUENCES: usize = 10_000;
const OPS: usize = 16;

fn color(lcg: &mut Lcg) -> Color {
    Color {
        r: lcg.next_u32() as u8,
        g: lcg.next_u32() as u8,
        b: lcg.next_u32() as u8,
        a: lcg.next_u32() as u8,
    }
}

fn area(lcg: &mut Lcg) -> fgce::Rect {
    fgce::Rect {
        x1: lcg.range(-4, 40),
        y1: lcg.range(-4, 40),
        x2: lcg.range(-4, 40),
        y2: lcg.range(-4, 40),
    }
}

fn pin(lcg: &mut Lcg) -> Pin {
    Pin {
        x: lcg.range(-1, 1) as i8,
        y: lcg.range(-1, 1) as i8,
    }
}

fn edges(lcg: &mut Lcg) -> Edges {
    if lcg.pick(2) == 0 {
        Edges {
            x1: Edge::Pixel(lcg.range(-8, 40)),
            y1: Edge::Pixel(lcg.range(-8, 40)),
            x2: Edge::Pixel(lcg.range(-8, 40)),
            y2: Edge::Pixel(lcg.range(-8, 40)),
        }
    } else {
        Edges {
            x1: Edge::Grid {
                primary: lcg.range(0, 4),
                fine: None,
                spx: None,
            },
            y1: Edge::Grid {
                primary: lcg.range(0, 4),
                fine: None,
                spx: None,
            },
            x2: Edge::Grid {
                primary: lcg.range(0, 4),
                fine: None,
                spx: None,
            },
            y2: Edge::Grid {
                primary: lcg.range(0, 4),
                fine: None,
                spx: None,
            },
        }
    }
}

fn triangle(lcg: &mut Lcg) -> [Verb; 4] {
    [
        Verb::Move(lcg.range(-8, 40), lcg.range(-8, 40)),
        Verb::Line(lcg.range(-8, 40), lcg.range(-8, 40)),
        Verb::Line(lcg.range(-8, 40), lcg.range(-8, 40)),
        Verb::Close,
    ]
}

fn stroke(lcg: &mut Lcg) -> Stroke {
    Stroke {
        width_q8: lcg.below(4) * fgce::SPX_Q8 + lcg.below(fgce::SPX_Q8),
        align: match lcg.pick(3) {
            0 => StrokeAlign::Inside,
            1 => StrokeAlign::Outside,
            _ => StrokeAlign::Center,
        },
        join: match lcg.pick(3) {
            0 => Join::Miter { limit_q8: 1024 },
            1 => Join::Bevel,
            _ => Join::Round,
        },
        cap: match lcg.pick(3) {
            0 => Cap::Butt,
            1 => Cap::Square,
            _ => Cap::Round,
        },
        peak: if lcg.pick(2) == 0 {
            Peak::Light
        } else {
            Peak::Nominal
        },
    }
}

fn entity(lcg: &mut Lcg) -> Entity<'static> {
    let kind = match lcg.pick(5) {
        0 => EntityKind::Flat { color: color(lcg) },
        1 => EntityKind::Photo {
            format: PixelFormat::Rgba8,
            image: ImageId(lcg.below(3)),
            tint: None,
        },
        2 => EntityKind::Glyph {
            format: PixelFormat::Alpha8,
            image: ImageId(lcg.below(3)),
            tint: None,
        },
        3 => EntityKind::Empty,
        _ => EntityKind::Vector {
            verbs: &[],
            fill: Some(Fill {
                rule: FillRule::NonZero,
            }),
            stroke: None,
            color: color(lcg),
        },
    };
    Entity {
        id: NodeId(lcg.below(8)),
        kind,
        on_grid: Some(lcg.pick(2) == 0),
        edges: edges(lcg),
        align: Some(Align {
            x: lcg.range(-1, 1) as i8,
            y: lcg.range(-1, 1) as i8,
        }),
        blend: Some(match lcg.pick(3) {
            0 => Blend::SrcOver,
            1 => Blend::Src,
            _ => Blend::Clear,
        }),
        radius: None,
    }
}

fn one_op(h: &mut Harness, lcg: &mut Lcg) -> Result<(), Error> {
    match lcg.pick(24) {
        0 => h.try_begin(lcg.below(80), lcg.below(80)).map(|_| ()),
        1 => h.submit(Request::End).map(|_| ()),
        2 => {
            let format = match lcg.pick(3) {
                0 => PixelFormat::Rgb8,
                1 => PixelFormat::Rgba8,
                _ => PixelFormat::Alpha8,
            };
            let width = lcg.below(8);
            let height = lcg.below(8);
            let stride = width * bpp(format) + lcg.below(3);
            let mut bytes = vec![0_u8; (stride * height) as usize];
            for byte in &mut bytes {
                *byte = lcg.next_u32() as u8;
            }
            h.submit(Request::Upload {
                id: ImageId(lcg.below(3)),
                width,
                height,
                stride,
                format,
                alpha: if lcg.pick(2) == 0 {
                    AlphaMode::Straight
                } else {
                    AlphaMode::Premul
                },
                bytes: &bytes,
            })
            .map(|_| ())
        }
        3 => h
            .submit(Request::Drop {
                id: ImageId(lcg.below(3)),
            })
            .map(|_| ()),
        4 => h
            .submit(Request::FillRect {
                rect: area(lcg),
                color: color(lcg),
                blend: Some(match lcg.pick(3) {
                    0 => Blend::SrcOver,
                    1 => Blend::Src,
                    _ => Blend::Clear,
                }),
                radius: if lcg.pick(3) == 0 {
                    Some(Radius::Percent(lcg.below(51) as u8))
                } else {
                    None
                },
            })
            .map(|_| ()),
        5 => h
            .submit(Request::Blit {
                id: ImageId(lcg.below(3)),
                dest: area(lcg),
                src: area(lcg),
                sample: if lcg.pick(2) == 0 {
                    Sample::Crisp
                } else {
                    Sample::Area
                },
                tint: Some(color(lcg)),
                blend: None,
                radius: None,
            })
            .map(|_| ()),
        6 => h.submit(Request::ClipPush { rect: area(lcg) }).map(|_| ()),
        7 => h.submit(Request::ClipPop).map(|_| ()),
        8 => h.submit(Request::Entity(entity(lcg))).map(|_| ()),
        9 => {
            let children = [NodeId(lcg.below(8)), NodeId(lcg.below(8))];
            h.submit(Request::Group {
                id: NodeId(lcg.below(8)),
                parent: NodeId(lcg.below(2)),
                children: &children,
                pin: pin(lcg),
                snap: lcg.pick(2) == 0,
                inset: None,
            })
            .map(|_| ())
        }
        10 => {
            let children = [NodeId(lcg.below(8))];
            let inset = if lcg.pick(2) == 0 {
                Some(Inset {
                    left: Some(Edge::Pixel(lcg.below(4) as i32)),
                    top: None,
                    right: None,
                    bottom: None,
                })
            } else {
                None
            };
            h.submit(Request::Arbitrary {
                id: NodeId(lcg.below(8)),
                parent: NodeId(lcg.below(2)),
                on_grid: Some(lcg.pick(2) == 0),
                edges: edges(lcg),
                children: &children,
                pin: pin(lcg),
                snap: lcg.pick(2) == 0,
                inset,
            })
            .map(|_| ())
        }
        11 => h
            .submit(Request::Show {
                id: NodeId(lcg.below(8)),
                rect: area(lcg),
            })
            .map(|_| ()),
        12 => h
            .submit(Request::Place {
                id: NodeId(lcg.below(8)),
                rect: area(lcg),
            })
            .map(|_| ()),
        13 => h
            .submit(Request::Remove {
                id: NodeId(lcg.below(8)),
            })
            .map(|_| ()),
        14 => h
            .submit(Request::DefineReference {
                id: ReferenceId(lcg.below(3)),
                canon_w: lcg.below(80),
                canon_h: lcg.below(80),
                k: 1 + lcg.below(10),
                d: 1 + lcg.below(2),
                pin: pin(lcg),
                enter_cols: lcg.below(4),
                enter_rows: lcg.below(4),
            })
            .map(|_| ()),
        15 => h
            .submit(Request::UseReference {
                id: ReferenceId(lcg.below(3)),
            })
            .map(|_| ()),
        16 => {
            let verbs = triangle(lcg);
            if lcg.pick(2) == 0 {
                h.submit(Request::FillPath {
                    verbs: &verbs,
                    rule: if lcg.pick(2) == 0 {
                        FillRule::NonZero
                    } else {
                        FillRule::EvenOdd
                    },
                    color: color(lcg),
                    blend: None,
                })
                .map(|_| ())
            } else {
                let stroke = stroke(lcg);
                h.submit(Request::StrokePath {
                    verbs: &verbs,
                    stroke,
                    color: color(lcg),
                    blend: None,
                })
                .map(|_| ())
            }
        }
        18 => h.submit(Request::DrawTree).map(|_| ()),
        19 => {
            let radius = if lcg.pick(2) == 0 {
                Some(Radius::Percent(lcg.below(51) as u8))
            } else {
                None
            };
            h.submit(Request::StrokeRoundRect {
                rect: area(lcg),
                radius,
                stroke: stroke(lcg),
                color: color(lcg),
                blend: None,
            })
            .map(|_| ())
        }
        20 => {
            let step = 1 + lcg.below(15);
            let primary_step = if lcg.pick(2) == 0 {
                Some(1 + lcg.below(45))
            } else {
                None
            };
            h.submit(Request::FillLattice {
                rect: area(lcg),
                step,
                primary_step,
                fine_color: color(lcg),
                primary_color: color(lcg),
                blend: None,
            })
            .map(|_| ())
        }
        21 => {
            let style = DebugGridStyle {
                base: color(lcg),
                tip: color(lcg),
                label_base: (lcg.pick(2) == 0).then(|| color(lcg)),
                label_tip: (lcg.pick(2) == 0).then(|| color(lcg)),
                label_alpha: lcg.next_u32() as u8,
                label_scale: 1 + lcg.below(4) as u8,
            };
            h.submit(Request::DebugGrid {
                style: if lcg.pick(4) == 0 { None } else { Some(style) },
            })
            .map(|_| ())
        }
        22 => {
            let point = if lcg.pick(2) == 0 {
                None
            } else {
                Some(DebugPoint {
                    x: lcg.range(-8, 40),
                    y: lcg.range(-8, 40),
                })
            };
            h.submit(Request::DebugHover(point)).map(|_| ())
        }
        23 => h
            .submit(Request::DebugLabel {
                id: NodeId(lcg.below(8)),
                text: if lcg.pick(2) == 0 { None } else { Some("fuzz") },
            })
            .map(|_| ()),
        _ => {
            let verbs = triangle(lcg);
            h.submit(Request::Measure {
                verbs: &verbs,
                fill: Some(Fill {
                    rule: FillRule::NonZero,
                }),
                stroke: None,
            })
            .map(|_| ())
        }
    }
}

#[test]
fn err_does_not_move_state_or_bytes() {
    for sequence in 0..SEQUENCES {
        let seed = 0x9E37_79B9_7F4A_7C15_u64 ^ sequence as u64;
        let mut lcg = Lcg::new(seed);
        let mut h = Harness::new();
        for op in 0..OPS {
            let before = h.fingerprint();
            if one_op(&mut h, &mut lcg).is_err() {
                let after = h.fingerprint();
                assert_eq!(
                    after, before,
                    "sequence {sequence} op {op} seed {seed:#x}: Err changed the state"
                );
            }
        }
    }
}
