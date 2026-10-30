//! Pure color formulas (`fgce.md` §6).
//!
//! The frame stays premultiplied sRGB. A `SrcOver` mix of a partially covered or
//! partially transparent source is composed in linear light; dense opaque writes
//! keep the byte formulas unchanged.

use std::sync::OnceLock;

use crate::contract::Color;

/// Premultiplied RGBA8 pixel as stored in the frame and in the image store.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct Premul {
    pub(crate) r: u8,
    pub(crate) g: u8,
    pub(crate) b: u8,
    pub(crate) a: u8,
}

impl Premul {
    pub(crate) fn from_color(color: Color) -> Self {
        Premul {
            r: pm(color.r, color.a),
            g: pm(color.g, color.a),
            b: pm(color.b, color.a),
            a: color.a,
        }
    }
}

pub(crate) fn pm(c: u8, a: u8) -> u8 {
    ((c as u16 * a as u16 + 127) / 255) as u8
}

pub(crate) fn over(src: u8, dst: u8, src_a: u8) -> u8 {
    let value = src as u16 + (dst as u16 * (255 - src_a) as u16 + 127) / 255;
    value.min(255) as u8
}

pub(crate) fn straight(c: u8, a: u8) -> u8 {
    if a == 0 {
        0
    } else {
        ((c as u32 * 255 + a as u32 / 2) / a as u32).min(255) as u8
    }
}

/// sRGB EOTF in 16-bit light: `decode[c]` is `round(65535 * linear(c / 255))`.
fn decode_table() -> &'static [u16; 256] {
    static TABLE: OnceLock<[u16; 256]> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut table = [0_u16; 256];
        for (value, slot) in table.iter_mut().enumerate() {
            let encoded = value as f64 / 255.0;
            let linear = if encoded <= 0.040_45 {
                encoded / 12.92
            } else {
                ((encoded + 0.055) / 1.055).powf(2.4)
            };
            *slot = (linear * 65535.0).round() as u16;
        }
        table
    })
}

/// Inverse sRGB transfer for every 16-bit light value.
fn encode_table() -> &'static [u8; 65536] {
    static TABLE: OnceLock<Box<[u8; 65536]>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut table = Box::new([0_u8; 65536]);
        for (value, slot) in table.iter_mut().enumerate() {
            let linear = value as f64 / 65535.0;
            let encoded = if linear <= 0.003_130_8 {
                12.92 * linear
            } else {
                1.055 * linear.powf(1.0 / 2.4) - 0.055
            };
            *slot = (encoded * 255.0).round().clamp(0.0, 255.0) as u8;
        }
        table
    })
}

pub(crate) fn decode(c: u8) -> u16 {
    decode_table()[c as usize]
}

pub(crate) fn encode(light: u16) -> u8 {
    encode_table()[light as usize]
}

/// Mixes two straight sRGB channels in linear light and returns the encoded
/// straight result. `out_a` is the premultiplied `over` alpha of the same mix.
///
/// ```text
/// light = (L(src) * src_a * 255 + L(dst) * dst_a * (255 - src_a))
///         / (255 * out_a)
/// ```
///
/// No intermediate 8-bit quantization happens: both operands enter the formula
/// as 16-bit light and the result is encoded once.
pub(crate) fn mix_straight(src: u8, src_a: u8, dst: u8, dst_a: u8, out_a: u8) -> u8 {
    if out_a == 0 {
        return 0;
    }
    let numerator = decode(src) as u64 * src_a as u64 * 255
        + decode(dst) as u64 * dst_a as u64 * (255 - src_a) as u64;
    let denominator = 255 * out_a as u64;
    let light = ((numerator + denominator / 2) / denominator).min(65535) as u16;
    encode(light)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pm_matches_formula_for_every_pair() {
        for c in 0..=255_u16 {
            for a in 0..=255_u16 {
                let expected = ((c * a + 127) / 255) as u8;
                assert_eq!(pm(c as u8, a as u8), expected, "pm({c}, {a})");
            }
        }
    }

    #[test]
    fn over_matches_formula_for_every_triple() {
        for src in 0..=255_u16 {
            for dst in 0..=255_u16 {
                for src_a in 0..=255_u16 {
                    let expected = (src + (dst * (255 - src_a) + 127) / 255).min(255) as u8;
                    assert_eq!(
                        over(src as u8, dst as u8, src_a as u8),
                        expected,
                        "over({src}, {dst}, {src_a})"
                    );
                }
            }
        }
    }

    #[test]
    fn over_alpha_uses_same_formula() {
        assert_eq!(over(255, 0, 255), 255);
        assert_eq!(over(255, 0, 0), 255);
        assert_eq!(over(128, 0, 128), 128);
    }

    #[test]
    fn straight_matches_formula_on_valid_range() {
        for a in 0..=255_u8 {
            for c in 0..=a {
                let expected = if a == 0 {
                    0
                } else {
                    ((c as u32 * 255 + a as u32 / 2) / a as u32).min(255) as u8
                };
                assert_eq!(straight(c, a), expected, "straight({c}, {a})");
            }
            assert_eq!(straight(a, a), if a == 0 { 0 } else { 255 });
        }
        assert_eq!(straight(0, 0), 0);
    }

    #[test]
    fn decode_encode_round_trip_is_within_one() {
        for value in 0..=255_u8 {
            let round = encode(decode(value));
            assert!(
                round.abs_diff(value) <= 1,
                "round trip of {value} gave {round}"
            );
        }
    }

    #[test]
    fn linear_mix_matches_the_oracle_table() {
        // §12: #AB over #0E in linear light, table of coverage to encoded channel.
        let cases: [(f64, u8); 4] = [(0.25, 91), (0.44, 118), (0.70, 146), (1.00, 171)];
        for (coverage, expected) in cases {
            let src_a = (coverage * 255.0).round() as u8;
            let out_a = over(src_a, 255, src_a);
            let mixed = mix_straight(0xAB, src_a, 0x0E, 255, out_a);
            assert!(
                mixed.abs_diff(expected) <= 1,
                "coverage {coverage}: expected {expected}, got {mixed}"
            );
        }
    }

    #[test]
    fn opaque_source_over_writes_source() {
        for value in 0..=255_u8 {
            assert_eq!(over(value, 42, 255), value);
        }
    }

    #[test]
    fn premul_helpers() {
        let color = Color {
            r: 200,
            g: 100,
            b: 50,
            a: 200,
        };
        let pixel = Premul::from_color(color);
        assert_eq!(
            pixel,
            Premul {
                r: 157,
                g: 78,
                b: 39,
                a: 200,
            }
        );
    }
}
