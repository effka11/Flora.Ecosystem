//! Pure color formulas (`fgce.md` §6).

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

    pub(crate) fn over(self, dst: Premul) -> Premul {
        Premul {
            r: over(self.r, dst.r, self.a),
            g: over(self.g, dst.g, self.a),
            b: over(self.b, dst.b, self.a),
            a: over(self.a, dst.a, self.a),
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
        assert_eq!(pixel.r, 157);
        assert_eq!(pixel.g, 78);
        assert_eq!(pixel.b, 39);
        assert_eq!(pixel.a, 200);
        let zero = Premul {
            r: 0,
            g: 0,
            b: 0,
            a: 0,
        };
        assert_eq!(pixel.over(zero), pixel);
    }
}
