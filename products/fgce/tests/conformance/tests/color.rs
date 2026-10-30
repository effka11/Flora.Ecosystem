//! §12 rows 98–99 and the 0.16 linear-light rows: premultiply, `over`,
//! `straight` and `SrcOver` of a partial source against the §6 formulas.

use fgce::{AlphaMode, Blend, Color, ImageId, PixelFormat, Request, Sample};
use fgce_conformance::{Harness, WHITE, rect};

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

/// sRGB EOTF, IEC 61966-2-1, in 16-bit light (the normative table of §6).
fn decode(c: u8) -> u16 {
    let encoded = c as f64 / 255.0;
    let linear = if encoded <= 0.040_45 {
        encoded / 12.92
    } else {
        ((encoded + 0.055) / 1.055).powf(2.4)
    };
    (linear * 65535.0).round() as u16
}

fn encode(light: u16) -> u8 {
    let linear = light as f64 / 65535.0;
    let encoded = if linear <= 0.003_130_8 {
        12.92 * linear
    } else {
        1.055 * linear.powf(1.0 / 2.4) - 0.055
    };
    (encoded * 255.0).round().clamp(0.0, 255.0) as u8
}

/// §6: channels of a partial `SrcOver` mix are composed in linear light.
fn mix_straight(src: u8, src_a: u8, dst: u8, dst_a: u8, out_a: u8) -> u8 {
    if out_a == 0 {
        return 0;
    }
    let numerator = decode(src) as u64 * src_a as u64 * 255
        + decode(dst) as u64 * dst_a as u64 * (255 - src_a) as u64;
    let denominator = 255 * out_a as u64;
    encode(((numerator + denominator / 2) / denominator).min(65535) as u16)
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
            id: ImageId(1),
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
                if a == 0 {
                    continue;
                }
                let out_a = over(a as u8, 255, a as u8);
                let premul = pm(c as u8, a as u8);
                let write = straight(premul, a as u8);
                let expected = if a == 255 {
                    c as u8
                } else {
                    pm(mix_straight(write, a as u8, dst as u8, 255, out_a), out_a)
                };
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

#[test]
fn row_w1_linear_oracle_table_ab_over_0e() {
    // #AB (171) over #0E (14) in linear light: coverage to encoded channel.
    let cases: [(f64, u8); 5] = [(0.0, 14), (0.25, 91), (0.44, 118), (0.70, 146), (1.0, 171)];
    for (coverage, expected) in cases {
        let src_a = (coverage * 255.0).round() as u8;
        let out_a = over(src_a, 255, src_a);
        let mixed = if src_a == 0 {
            14
        } else if src_a == 255 {
            171
        } else {
            pm(mix_straight(171, src_a, 14, 255, out_a), out_a)
        };
        assert!(
            mixed.abs_diff(expected) <= 1,
            "coverage {coverage}: expected {expected}, got {mixed}"
        );
    }
}

#[test]
fn row_w1_full_cover_is_the_color_itself() {
    let mut h = Harness::new();
    h.begin(1, 1);
    h.fill(
        rect(0, 0, 0, 0),
        Color {
            r: 171,
            g: 14,
            b: 35,
            a: 255,
        },
    );
    assert_eq!(h.pixel_premul(0, 0), [171, 14, 35, 255]);
}

#[test]
fn row_w1_coverage_drift_between_colors_is_at_most_one_255th() {
    // Coverage is a property of geometry, not of paint: two halves of one square
    // split by a diagonal must give complementary alphas in every pixel, so the
    // seam between two colors drifts by at most one code level.
    let lower = [
        fgce::Verb::Move(0, 0),
        fgce::Verb::Line(4, 0),
        fgce::Verb::Line(0, 4),
        fgce::Verb::Close,
    ];
    let upper = [
        fgce::Verb::Move(4, 0),
        fgce::Verb::Line(4, 4),
        fgce::Verb::Line(0, 4),
        fgce::Verb::Close,
    ];
    let mut first = Harness::new();
    first.begin(4, 4);
    first.fill_path(&lower, fgce::FillRule::NonZero, WHITE);
    let first = first.end();
    let mut second = Harness::new();
    second.begin(4, 4);
    second.fill_path(&upper, fgce::FillRule::NonZero, WHITE);
    let second = second.end();
    for y in 0..4 {
        for x in 0..4 {
            let sum = first.pixel(x, y)[3] as i16 + second.pixel(x, y)[3] as i16;
            assert!(
                (sum - 255).abs() <= 1,
                "pixel ({x}, {y}) alphas sum to {sum}"
            );
        }
    }
}

#[test]
fn row_w1_color_drift_is_one_fraction() {
    let lower = [
        fgce::Verb::Move(0, 0),
        fgce::Verb::Line(4, 0),
        fgce::Verb::Line(0, 4),
        fgce::Verb::Close,
    ];
    let paint = |src: Color| {
        let mut h = Harness::new();
        h.begin(4, 4);
        h.fill(
            rect(0, 0, 3, 3),
            Color {
                r: 14,
                g: 14,
                b: 14,
                a: 255,
            },
        );
        h.fill_path(&lower, fgce::FillRule::NonZero, src);
        h.end()
    };
    let first = paint(Color {
        r: 171,
        g: 171,
        b: 171,
        a: 255,
    });
    let second = paint(Color {
        r: 250,
        g: 250,
        b: 250,
        a: 255,
    });
    let mut partial = 0;
    for y in 0..4 {
        for x in 0..4 {
            let a = first.pixel(x, y)[0];
            let b = second.pixel(x, y)[0];
            if a == 14 || a == 171 || b == 14 || b == 250 {
                continue;
            }
            let dst = decode(14) as f64;
            let first_src = decode(171) as f64;
            let second_src = decode(250) as f64;
            let f1 = (decode(a) as f64 - dst) / (first_src - dst);
            let f2 = (decode(b) as f64 - dst) / (second_src - dst);
            assert!(
                (f1 - f2).abs() <= 1.0 / 255.0 + f64::EPSILON,
                "pixel ({x}, {y}): fractions {f1} and {f2}"
            );
            partial += 1;
        }
    }
    assert!(partial > 0, "the diagonal must have partial pixels");
}

#[test]
fn row_w1_blit_alpha8_half_coverage_mixes_in_light() {
    // Alpha8 texel 128 with an opaque tint is a partially transparent source:
    // its channel over an opaque destination follows the linear mix.
    let mut h = Harness::new();
    h.upload(1, 1, 1, PixelFormat::Alpha8, AlphaMode::Straight, &[128]);
    h.begin(1, 1);
    h.fill(
        rect(0, 0, 0, 0),
        Color {
            r: 14,
            g: 14,
            b: 14,
            a: 255,
        },
    );
    h.blit_full(
        1,
        rect(0, 0, 0, 0),
        rect(0, 0, 0, 0),
        Sample::Crisp,
        Some(Color {
            r: 171,
            g: 171,
            b: 171,
            a: 255,
        }),
        None,
    );
    let src_a = 128;
    let expected = pm(mix_straight(171, src_a, 14, 255, 255), 255);
    assert!(h.pixel_premul(0, 0)[0].abs_diff(expected) <= 1);
}

#[test]
fn row_w1_rgba_semi_transparent_tint_mixes_in_light() {
    let mut h = Harness::new();
    h.upload(
        1,
        1,
        1,
        PixelFormat::Rgba8,
        AlphaMode::Straight,
        &[200, 200, 200, 255],
    );
    h.begin(1, 1);
    h.fill(
        rect(0, 0, 0, 0),
        Color {
            r: 14,
            g: 14,
            b: 14,
            a: 255,
        },
    );
    h.blit_full(
        1,
        rect(0, 0, 0, 0),
        rect(0, 0, 0, 0),
        Sample::Crisp,
        Some(Color {
            r: 200,
            g: 200,
            b: 200,
            a: 64,
        }),
        None,
    );
    // The tinted source is stored premultiplied: tinted straight 157 at alpha 64
    // becomes premul 39, and `Blit` reconstructs its straight value from there.
    let tinted_a = ((255_u32 * 64 + 127) / 255) as u8;
    let tinted = ((200_u32 * 200 + 127) / 255) as u8;
    let premul = pm(tinted, tinted_a);
    let write = straight(premul, tinted_a);
    let expected = pm(mix_straight(write, tinted_a, 14, 255, 255), 255);
    assert!(h.pixel_premul(0, 0)[0].abs_diff(expected) <= 1);
}
