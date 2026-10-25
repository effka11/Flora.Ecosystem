//! §12 rows 1–10, 84, 85, 149, 150, 158, 159: crate metadata, sPx, lattice, limits.

use fgce::{Error, Lattice, PixelFormat, Request, Response};
use fgce_conformance::Harness;

const FGCE_MANIFEST: &str = include_str!("../../../crates/fgce/Cargo.toml");

fn lattice(h: &mut Harness, span_x: u32, span_y: u32, step: u32, pin_x: i8, pin_y: i8) -> Lattice {
    match h
        .submit(Request::Lattice {
            span_x,
            span_y,
            step,
            pin_x,
            pin_y,
        })
        .expect("Lattice")
    {
        Response::Lattice(value) => value,
        _ => unreachable!("Lattice returns Lattice"),
    }
}

fn grid(h: &mut Harness, k: u32) -> fgce::Grid {
    match h.submit(Request::Grid { k }).expect("Grid") {
        Response::Grid(value) => value,
        _ => unreachable!("Grid returns Grid"),
    }
}

fn length(h: &mut Harness, n: u32, k: u32) -> u32 {
    match h.submit(Request::Length { n, k }).expect("Length") {
        Response::Length(value) => value,
        _ => unreachable!("Length returns Length"),
    }
}

#[test]
fn row_01_version_is_the_package_version() {
    let needle = "version = \"";
    let at = FGCE_MANIFEST.find(needle).expect("version field") + needle.len();
    let rest = &FGCE_MANIFEST[at..];
    let version = &rest[..rest.find('"').expect("closing quote")];
    assert_eq!(fgce::VERSION, version);
}

#[test]
fn row_02_info_limits() {
    let mut h = Harness::new();
    let info = h.info();
    assert_eq!(info.max_side, 8192);
    assert_eq!(info.max_k, 40);
    assert_eq!(info.max_clip, 32);
    assert_eq!(info.max_vertices, 65_536);
    assert_eq!(info.max_coord, 1_048_576);
    assert_eq!(info.pixel_format, PixelFormat::Rgba8);
    assert!(info.premultiplied);
}

#[test]
fn row_03_scale_pair() {
    let mut h = Harness::new();
    for k in 1..=40 {
        let value = grid(&mut h, k);
        assert_eq!(value.fine, k, "k = {k}");
        assert_eq!(value.primary, 3 * k, "k = {k}");
    }
}

#[test]
fn row_04_length() {
    let mut h = Harness::new();
    assert_eq!(length(&mut h, 2, 3), 1);
    assert_eq!(length(&mut h, 22, 3), 13);
    assert_eq!(length(&mut h, 15, 6), 18);
    assert_eq!(length(&mut h, 1, 1), 0);
    assert_eq!(length(&mut h, 1, 3), 1);
}

#[test]
fn row_05_lattice_window_91() {
    let mut h = Harness::new();
    let value = lattice(&mut h, 91, 91, 15, -1, 1);
    assert_eq!(value.count_x, 7);
    assert_eq!(value.origin_x, 0);
    assert_eq!(value.count_x as i64 * 15, 105);
}

#[test]
fn row_06_lattice_window_90() {
    let mut h = Harness::new();
    let value = lattice(&mut h, 90, 90, 15, -1, 1);
    assert_eq!(value.count_x, 6);
    assert_eq!(value.origin_x, 0);
    assert_eq!(value.count_x as i64 * 15, 90);
}

#[test]
fn row_07_live_window_91_by_90() {
    let mut h = Harness::new();
    let value = lattice(&mut h, 91, 90, 15, -1, 1);
    assert_eq!(value.count_x, 7, "7 columns");
    assert_eq!(value.count_y, 6, "6 rows");
}

#[test]
fn row_08_lattice_window_100_pin_zero() {
    let mut h = Harness::new();
    let value = lattice(&mut h, 100, 100, 15, 0, 0);
    assert_eq!(value.count_x, 7);
    let slack = 100 - value.count_x as i64 * 15;
    assert_eq!(slack, -5);
    assert_eq!(value.origin_x, -3, "lead");
    assert_eq!(slack - value.origin_x, -2, "trail");
}

#[test]
fn row_09_lattice_window_100_near_pin() {
    let mut h = Harness::new();
    let value = lattice(&mut h, 100, 100, 15, -1, 1);
    assert_eq!(value.origin_x, 0);
    assert_eq!(value.origin_y, 0);
    let slack = 100 - value.count_x as i64 * 15;
    assert_eq!(value.origin_x, 0, "lead");
    assert_eq!(slack - value.origin_x, -5, "trail");
}

#[test]
fn row_10_lattice_window_100_far_pin() {
    let mut h = Harness::new();
    let value = lattice(&mut h, 100, 100, 15, 1, -1);
    assert_eq!(value.origin_x, -5);
    assert_eq!(value.origin_y, -5);
    let slack = 100 - value.count_x as i64 * 15;
    assert_eq!(value.origin_x, -5, "lead");
    assert_eq!(slack - value.origin_x, 0, "trail");
}

#[test]
fn row_84_pin_outside_the_triple_is_bad_anchor() {
    let mut h = Harness::new();
    assert_eq!(
        h.err(Request::Lattice {
            span_x: 10,
            span_y: 10,
            step: 15,
            pin_x: 2,
            pin_y: 0,
        }),
        Error::BadAnchor
    );
    assert_eq!(
        h.err(Request::DefineReference {
            id: fgce::ReferenceId(7),
            canon_w: 100,
            canon_h: 100,
            k: 5,
            d: 1,
            pin: fgce::Pin { x: 0, y: -2 },
            enter_cols: 0,
            enter_rows: 0,
        }),
        Error::BadAnchor
    );
}

#[test]
fn row_85_lattice_step_zero_is_bad_cell() {
    let mut h = Harness::new();
    assert_eq!(
        h.err(Request::Lattice {
            span_x: 10,
            span_y: 10,
            step: 0,
            pin_x: 0,
            pin_y: 0,
        }),
        Error::BadCell
    );
}

#[test]
fn row_149_frame_and_canon_sides() {
    let mut h = Harness::new();
    for side in [0_u32, 8193] {
        assert_eq!(
            h.err(Request::Begin {
                width: side,
                height: 100,
            }),
            Error::SurfaceOutOfRange,
            "Begin width = {side}"
        );
        assert_eq!(
            h.err(Request::DefineReference {
                id: fgce::ReferenceId(7),
                canon_w: side,
                canon_h: 100,
                k: 5,
                d: 1,
                pin: fgce::Pin { x: -1, y: 1 },
                enter_cols: 0,
                enter_rows: 0,
            }),
            Error::SurfaceOutOfRange,
            "canon_w = {side}"
        );
    }
}

#[test]
fn row_150_image_sides() {
    let mut h = Harness::new();
    for side in [0_u32, 8193] {
        assert_eq!(
            h.err(Request::Upload {
                id: fgce::ImageId(1),
                width: side,
                height: 10,
                stride: 0,
                format: PixelFormat::Rgb8,
                alpha: fgce::AlphaMode::Straight,
                bytes: &[],
            }),
            Error::ImageTooLarge,
            "width = {side}"
        );
    }
}

#[test]
fn row_158_crate_has_no_dependencies() {
    assert!(FGCE_MANIFEST.contains("[dependencies]"));
    let after = &FGCE_MANIFEST[FGCE_MANIFEST.find("[dependencies]").unwrap() + 14..];
    for line in after.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') {
            break;
        }
        panic!("fgce must have zero dependencies, found: {line}");
    }
    assert!(FGCE_MANIFEST.contains("unsafe_code = \"forbid\""));
}

#[test]
fn row_159_portable_copy_has_no_workspace_inheritance() {
    for line in FGCE_MANIFEST.lines() {
        assert!(
            !line.contains("workspace = true"),
            "portable copy must not inherit from a workspace: {line}"
        );
    }
}
