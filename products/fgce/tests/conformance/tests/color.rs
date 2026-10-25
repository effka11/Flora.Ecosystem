//! §12 rows 98–99: premultiply, `over` and `straight` against the §6 formulas.

use fgce::{AlphaMode, Blend, Color, PixelFormat, Request, Sample};
use fgce_conformance::{Harness, rect};

const SIDE: u32 = 256;

fn pm(c: u8, a: u8) -> u8 {
    ((c as u16 * a as u16 + 127) / 255) as u8
}

fn straight(c: u8, a: u8) -> u8 {
    if a == 0 {
        0
    } else {
        ((c as u16 * 255 + a as u16 / 2) / a as u16) as u8
    }
}

fn over(src: u8, dst: u8, src_a: u8) -> u8 {
    (src as u16 + (dst as u16 * (255 - src_a as u16) + 127) / 255) as u8
}

fn premul_table() -> Vec<u8> {
    let mut bytes = Vec::with_capacity((SIDE * SIDE * 4) as usize);
    for a in 0..SIDE {
        for c in 0..SIDE {
            bytes.extend_from_slice(&[c as u8, c as u8, c as u8, a as u8]);
        }
    }
    bytes
}

#[test]
fn row_98_premultiply_holds_for_every_pair() {
    let mut h = Harness::new();
    h.upload_rgba(1, SIDE, SIDE, AlphaMode::Straight, &premul_table());
    h.begin(SIDE, SIDE);
    h.blit(
        1,
        rect(0, 0, SIDE as i32 - 1, SIDE as i32 - 1),
        rect(0, 0, SIDE as i32 - 1, SIDE as i32 - 1),
        Sample::Crisp,
    );
    let frame = h.end();
    for a in 0..SIDE {
        for c in 0..SIDE {
            let pixel = frame.pixel(c as i32, a as i32);
            let expected = pm(c as u8, a as u8);
            assert_eq!(
                pixel,
                [expected, expected, expected, a as u8],
                "c = {c}, a = {a}"
            );
        }
    }
}

#[test]
fn row_98_over_holds_for_every_channel_pair() {
    let mut h = Harness::new();
    h.upload_rgba(1, SIDE, SIDE, AlphaMode::Straight, &premul_table());
    for dst in 0..SIDE {
        h.begin(SIDE, SIDE);
        let gray = Color {
            r: dst as u8,
            g: dst as u8,
            b: dst as u8,
            a: 255,
        };
        h.fill(rect(0, 0, SIDE as i32 - 1, SIDE as i32 - 1), gray);
        h.ok(Request::Blit {
            id: fgce::ImageId(1),
            dest: rect(0, 0, SIDE as i32 - 1, SIDE as i32 - 1),
            src: rect(0, 0, SIDE as i32 - 1, SIDE as i32 - 1),
            sample: Sample::Crisp,
            tint: None,
            blend: Some(Blend::SrcOver),
            radius: None,
        });
        let frame = h.end();
        for a in 0..SIDE {
            for c in 0..SIDE {
                let pixel = frame.pixel(c as i32, a as i32);
                let src = pm(c as u8, a as u8);
                let expected = over(src, dst as u8, a as u8);
                assert_eq!(pixel[0], expected, "src_c = {c}, src_a = {a}, dst = {dst}");
                assert_eq!(pixel[3], 255, "opaque destination stays opaque");
            }
        }
    }
}

#[test]
fn row_99_straight_holds_for_every_valid_pair() {
    let mut h = Harness::new();
    let mut bytes = vec![0_u8; (SIDE * SIDE * 4) as usize];
    for a in 0..SIDE {
        for c in 0..=a {
            let at = ((a * SIDE + c) * 4) as usize;
            bytes[at] = c as u8;
            bytes[at + 1] = (c / 2) as u8;
            bytes[at + 3] = a as u8;
        }
    }
    h.upload_rgba(1, SIDE, SIDE, AlphaMode::Premul, &bytes);
    h.begin(SIDE, SIDE);
    h.blit(
        1,
        rect(0, 0, SIDE as i32 - 1, SIDE as i32 - 1),
        rect(0, 0, SIDE as i32 - 1, SIDE as i32 - 1),
        Sample::Crisp,
    );
    let pixels = h.pixels(rect(0, 0, SIDE as i32 - 1, SIDE as i32 - 1));
    let stride = pixels.stride as usize;
    for a in 0..SIDE {
        for c in 0..=a {
            let at = a as usize * stride + c as usize * 4;
            assert_eq!(
                pixels.bytes[at],
                straight(c as u8, a as u8),
                "r: c = {c}, a = {a}"
            );
            assert_eq!(
                pixels.bytes[at + 1],
                straight((c / 2) as u8, a as u8),
                "g: c = {c}, a = {a}"
            );
            assert_eq!(pixels.bytes[at + 2], 0, "b: c = {c}, a = {a}");
            assert_eq!(pixels.bytes[at + 3], a as u8, "alpha: c = {c}, a = {a}");
        }
    }
}

#[test]
fn row_98_pixel_format_of_the_table_is_rgba8() {
    let mut h = Harness::new();
    assert_eq!(h.info().pixel_format, PixelFormat::Rgba8);
}
