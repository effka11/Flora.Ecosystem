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

use fgce::{Cap, FillRule, Join, Stroke, StrokeAlign, Verb};
use fgce_conformance::{Harness, WHITE, rect};

const BOWTIE: &[u8] = include_bytes!("../fixtures/bowtie.bin");
const MITER_45: &[u8] = include_bytes!("../fixtures/miter_45.bin");

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

fn miter_45_frame() -> Vec<u8> {
    let mut h = Harness::new();
    h.begin(24, 16);
    h.stroke_path(
        &[Verb::Move(0, 0), Verb::Line(10, 10), Verb::Line(20, 0)],
        1,
        StrokeAlign::Outside,
        Join::Miter { limit_q8: 1024 },
        Cap::Butt,
        WHITE,
    );
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
fn row_88_miter_45_measure_is_frozen() {
    let mut h = Harness::new();
    let area = h.measure(
        &[Verb::Move(0, 0), Verb::Line(10, 10), Verb::Line(20, 0)],
        None,
        Some(Stroke {
            width: 1,
            align: StrokeAlign::Outside,
            join: Join::Miter { limit_q8: 1024 },
            cap: Cap::Butt,
        }),
    );
    assert_eq!(area, rect(-1, 0, 20, 11));
}

#[test]
#[ignore = "regenerates the frozen fixtures; review the diff"]
fn regen_fixtures() {
    std::fs::create_dir_all("fixtures").expect("fixtures directory");
    std::fs::write("fixtures/bowtie.bin", bowtie_frame()).expect("bowtie fixture");
    std::fs::write("fixtures/miter_45.bin", miter_45_frame()).expect("miter fixture");
    eprintln!("fixtures regenerated");
}
