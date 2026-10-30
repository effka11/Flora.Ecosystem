//! §12 rows 88 and 132: frozen byte fixtures (implementation plan D8).
//!
//! The active tests compare against files generated once by the reference
//! implementation. Regenerate explicitly with:
//!
//! ```text
//! cargo test -p fgce-conformance --test fixtures -- --ignored --nocapture
//! ```
//!
//! Review the resulting diff; fixtures outside this package are not touched.

use fgce::{Cap, Color, FillRule, Join, Peak, PixelFormat, Sample, Stroke, StrokeAlign, Verb};
use fgce_conformance::{Harness, WHITE, rect};

const BOWTIE: &[u8] = include_bytes!("../fixtures/bowtie.bin");
const MITER_45: &[u8] = include_bytes!("../fixtures/miter_45.bin");
const OPAQUE_010: &[u8] = include_bytes!("../fixtures/opaque_010.bin");
const FILL_RECT_PLAIN: &[u8] = include_bytes!("../fixtures/fill_rect_plain.bin");
const STROKE_CLOSED_010: &[u8] = include_bytes!("../fixtures/stroke_closed_010.bin");
const FRACTIONAL_STROKE: &[u8] = include_bytes!("../fixtures/fractional_stroke.bin");

fn bowtie_frame() -> Vec<u8> {
    let mut h = Harness::new();
    h.begin(16, 16);
    h.fill_path(
        &[
            Verb::Move(0, 0),
            Verb::Line(10, 10),
            Verb::Line(10, 0),
            Verb::Line(0, 10),
            Verb::Close,
        ],
        FillRule::NonZero,
        WHITE,
    );
    h.end().bytes
}

/// W0 baseline (a): every written pixel has coverage 0 or 256, alpha 255 and
/// `SrcOver` only. W1 must leave these bytes untouched.
fn opaque_frame() -> Vec<u8> {
    let texels: Vec<u8> = (0..16 * 8)
        .flat_map(|index| {
            let x = (index % 16) as u8;
            let y = (index / 16) as u8;
            [x * 16, y * 32, 200 - x * 3, 255]
        })
        .collect();
    let mut h = Harness::new();
    h.upload(
        1,
        16,
        8,
        PixelFormat::Rgba8,
        fgce::AlphaMode::Straight,
        &texels,
    );
    h.begin(64, 48);
    h.fill(
        rect(0, 0, 15, 15),
        Color {
            r: 200,
            g: 100,
            b: 50,
            a: 255,
        },
    );
    h.fill(
        rect(20, 0, 35, 15),
        Color {
            r: 10,
            g: 20,
            b: 30,
            a: 255,
        },
    );
    h.fill_path(
        &[
            Verb::Move(40, 0),
            Verb::Line(56, 0),
            Verb::Line(56, 16),
            Verb::Line(40, 16),
            Verb::Close,
        ],
        FillRule::NonZero,
        WHITE,
    );
    h.ok(fgce::Request::Blit {
        id: fgce::ImageId(1),
        dest: rect(0, 24, 15, 31),
        src: rect(0, 0, 15, 7),
        sample: Sample::Crisp,
        tint: None,
        blend: None,
        radius: None,
    });
    h.ok(fgce::Request::Blit {
        id: fgce::ImageId(1),
        dest: rect(20, 24, 35, 31),
        src: rect(0, 0, 15, 7),
        sample: Sample::Area,
        tint: None,
        blend: None,
        radius: None,
    });
    h.fill(
        rect(0, 40, 63, 47),
        Color {
            r: 5,
            g: 6,
            b: 7,
            a: 255,
        },
    );
    h.end().bytes
}

fn fill_rect_plain_frame() -> Vec<u8> {
    let mut h = Harness::new();
    h.begin(8, 8);
    h.fill(
        rect(0, 0, 7, 7),
        Color {
            r: 171,
            g: 14,
            b: 35,
            a: 255,
        },
    );
    h.end().bytes
}

fn stroke_closed_010_frame() -> Vec<u8> {
    let square = |x: i32| {
        [
            Verb::Move(x, 0),
            Verb::Line(x + 10, 0),
            Verb::Line(x + 10, 10),
            Verb::Line(x, 10),
            Verb::Close,
        ]
    };
    let mut h = Harness::new();
    h.begin(64, 24);
    let cases = [
        (0, 1, StrokeAlign::Inside),
        (15, 1, StrokeAlign::Outside),
        (30, 2, StrokeAlign::Inside),
        (45, 2, StrokeAlign::Outside),
    ];
    for (x, width, align) in cases {
        h.stroke_path(
            &square(x),
            width,
            align,
            Join::Miter { limit_q8: 1024 },
            Cap::Butt,
            WHITE,
        );
    }
    h.end().bytes
}

fn miter_45_frame() -> Vec<u8> {
    let mut h = Harness::new();
    h.begin(24, 16);
    h.stroke_path(
        &[
            Verb::Move(0, 0),
            Verb::Line(10, 10),
            Verb::Line(20, 0),
            Verb::Close,
        ],
        1,
        StrokeAlign::Outside,
        Join::Miter { limit_q8: 1024 },
        Cap::Butt,
        WHITE,
    );
    h.end().bytes
}

/// REQ-9 acceptance pair: the 13×13 frame at `width_q8 = 205` inside, and the
/// corner-to-corner 11×11 cross at `width_q8 = 179` centered with `Peak::Nominal`.
fn fractional_stroke_frame() -> Vec<u8> {
    let ink = Color {
        r: 171,
        g: 171,
        b: 171,
        a: 255,
    };
    let mut h = Harness::new();
    h.begin(32, 16);
    h.ok(fgce::Request::StrokeRoundRect {
        rect: rect(0, 0, 12, 12),
        radius: None,
        stroke: Stroke {
            width_q8: 205,
            align: StrokeAlign::Inside,
            join: Join::Miter { limit_q8: 1024 },
            cap: Cap::Butt,
            peak: Peak::Light,
        },
        color: ink,
        blend: None,
    });
    let cross = Stroke {
        width_q8: 179,
        align: StrokeAlign::Center,
        join: Join::Bevel,
        cap: Cap::Butt,
        peak: Peak::Nominal,
    };
    for verbs in [
        [Verb::Move(17, 1), Verb::Line(27, 11)],
        [Verb::Move(27, 1), Verb::Line(17, 11)],
    ] {
        h.ok(fgce::Request::StrokePath {
            verbs: &verbs,
            stroke: cross,
            color: ink,
            blend: None,
        });
    }
    h.end().bytes
}

#[test]
fn row_132_bowtie_bytes_are_frozen() {
    assert_eq!(bowtie_frame(), BOWTIE);
}

#[test]
fn row_88_miter_45_bytes_are_frozen() {
    assert_eq!(miter_45_frame(), MITER_45);
}

#[test]
fn row_g12_fractional_stroke_is_frozen() {
    assert_eq!(fractional_stroke_frame(), FRACTIONAL_STROKE);
}

#[test]
fn row_88_miter_45_measure_is_frozen() {
    let mut h = Harness::new();
    let area = h.measure(
        &[
            Verb::Move(0, 0),
            Verb::Line(10, 10),
            Verb::Line(20, 0),
            Verb::Close,
        ],
        None,
        Some(Stroke {
            width_q8: 256,
            align: StrokeAlign::Outside,
            join: Join::Miter { limit_q8: 1024 },
            cap: Cap::Butt,
            peak: Peak::Light,
        }),
    );
    assert_eq!(area, rect(-3, -1, 22, 11));
}

#[test]
fn row_g8_opaque_frame_is_unchanged() {
    assert_eq!(opaque_frame(), OPAQUE_010);
}

#[test]
fn row_g2_fill_rect_plain_is_frozen() {
    assert_eq!(fill_rect_plain_frame(), FILL_RECT_PLAIN);
}

#[test]
fn stroke_closed_010_is_frozen() {
    assert_eq!(stroke_closed_010_frame(), STROKE_CLOSED_010);
}

/// The three 0.1.0 baseline frames are written once. An existing file is a
/// rejection, not a silent rewrite: only the reference implementation of the
/// released version may create them.
fn write_once(name: &str, bytes: &[u8]) {
    let path = format!("fixtures/{name}");
    assert!(
        !std::path::Path::new(&path).exists(),
        "{path} already exists; the 0.1.0 baseline is write-once"
    );
    std::fs::write(&path, bytes).expect("baseline fixture");
}

#[test]
#[ignore = "regenerates the frozen fixtures; review the diff"]
fn regen_fixtures() {
    std::fs::create_dir_all("fixtures").expect("fixtures directory");
    std::fs::write("fixtures/bowtie.bin", bowtie_frame()).expect("bowtie fixture");
    std::fs::write("fixtures/miter_45.bin", miter_45_frame()).expect("miter fixture");
    std::fs::write("fixtures/fractional_stroke.bin", fractional_stroke_frame())
        .expect("fractional stroke fixture");
    eprintln!("fixtures regenerated");
}

#[test]
#[ignore = "writes the 0.1.0 baseline fixtures once; review the diff"]
fn regen_baseline_fixtures() {
    std::fs::create_dir_all("fixtures").expect("fixtures directory");
    write_once("opaque_010.bin", &opaque_frame());
    write_once("fill_rect_plain.bin", &fill_rect_plain_frame());
    write_once("stroke_closed_010.bin", &stroke_closed_010_frame());
    eprintln!("baseline fixtures written");
}
