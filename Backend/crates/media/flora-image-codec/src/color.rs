//! Цветовые преобразования (FIC.md §4).
//!
//! - Lossless: YCoCg-R — обратимое целочисленное lifting-преобразование.
//! - Lossy: YCbCr BT.601 full-range в фиксированной точке (детерминизм
//!   на всех платформах важнее последней доли dB).

/// RGB → YCoCg-R. Возвращает `(y, co, cg)`: y в 0..=255, co/cg в -255..=255.
#[inline]
pub fn rgb_to_ycocg_r(r: i32, g: i32, b: i32) -> (i32, i32, i32) {
    let co = r - b;
    let t = b + (co >> 1);
    let cg = g - t;
    let y = t + (cg >> 1);
    (y, co, cg)
}

/// Обратное YCoCg-R → RGB (точное).
#[inline]
pub fn ycocg_r_to_rgb(y: i32, co: i32, cg: i32) -> (i32, i32, i32) {
    let t = y - (cg >> 1);
    let g = cg + t;
    let b = t - (co >> 1);
    let r = b + co;
    (r, g, b)
}

// Коэффициенты BT.601 в фиксированной точке 16.16.
const FIX: i32 = 16;
const HALF: i32 = 1 << (FIX - 1);
const CR_R: i32 = 19_595; // 0.299
const CG_G: i32 = 38_470; // 0.587
const CB_B: i32 = 7_471; //  0.114
const CB_R: i32 = -11_059; // -0.168736
const CB_G: i32 = -21_709; // -0.331264
const CB_B2: i32 = 32_768; // 0.5
const CR_R2: i32 = 32_768; // 0.5
const CR_G: i32 = -27_439; // -0.418688
const CR_B: i32 = -5_329; // -0.081312
const R_CR: i32 = 91_881; // 1.402
const G_CB: i32 = -22_553; // -0.344136
const G_CR: i32 = -46_802; // -0.714136
const B_CB: i32 = 116_130; // 1.772

#[inline]
fn clamp_u8(v: i32) -> i32 {
    v.clamp(0, 255)
}

/// RGB → YCbCr (full range, все компоненты 0..=255).
#[inline]
pub fn rgb_to_ycbcr(r: i32, g: i32, b: i32) -> (i32, i32, i32) {
    let y = (CR_R * r + CG_G * g + CB_B * b + HALF) >> FIX;
    let cb = ((CB_R * r + CB_G * g + CB_B2 * b + HALF) >> FIX) + 128;
    let cr = ((CR_R2 * r + CR_G * g + CR_B * b + HALF) >> FIX) + 128;
    (clamp_u8(y), clamp_u8(cb), clamp_u8(cr))
}

/// YCbCr → RGB (full range) с клампом в 0..=255.
#[inline]
pub fn ycbcr_to_rgb(y: i32, cb: i32, cr: i32) -> (i32, i32, i32) {
    let cb = cb - 128;
    let cr = cr - 128;
    let r = y + ((R_CR * cr + HALF) >> FIX);
    let g = y + ((G_CB * cb + G_CR * cr + HALF) >> FIX);
    let b = y + ((B_CB * cb + HALF) >> FIX);
    (clamp_u8(r), clamp_u8(g), clamp_u8(b))
}

/// Даунсэмплинг 2x2 средним (края нечётных размеров — репликация).
///
/// Вход: буфер `w x h`; выход: `ceil(w/2) x ceil(h/2)`.
pub fn downsample_420(src: &[i16], w: usize, h: usize) -> Vec<i16> {
    let cw = w.div_ceil(2);
    let ch = h.div_ceil(2);
    let mut out = Vec::with_capacity(cw * ch);
    for cy in 0..ch {
        let y0 = cy * 2;
        let y1 = (y0 + 1).min(h - 1);
        for cx in 0..cw {
            let x0 = cx * 2;
            let x1 = (x0 + 1).min(w - 1);
            let sum = i32::from(src[y0 * w + x0])
                + i32::from(src[y0 * w + x1])
                + i32::from(src[y1 * w + x0])
                + i32::from(src[y1 * w + x1]);
            out.push(((sum + 2) >> 2) as i16);
        }
    }
    out
}

/// Билинейный апсэмплинг 2x (co-sited с левым верхним отсчётом), в буфер `w x h`.
pub fn upsample_420(src: &[i16], cw: usize, ch: usize, w: usize, h: usize) -> Vec<i16> {
    let mut out = vec![0i16; w * h];
    for y in 0..h {
        let fy = y / 2;
        let ny = if y % 2 == 1 { (fy + 1).min(ch - 1) } else { fy };
        for x in 0..w {
            let fx = x / 2;
            let nx = if x % 2 == 1 { (fx + 1).min(cw - 1) } else { fx };
            let a = i32::from(src[fy * cw + fx]);
            let b = i32::from(src[fy * cw + nx]);
            let c = i32::from(src[ny * cw + fx]);
            let d = i32::from(src[ny * cw + nx]);
            out[y * w + x] = ((a + b + c + d + 2) >> 2) as i16;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ycocg_r_is_lossless_for_all_extremes_and_sampled_space() {
        let mut check = |r: i32, g: i32, b: i32| {
            let (y, co, cg) = rgb_to_ycocg_r(r, g, b);
            assert!((0..=255).contains(&y), "y={y} вне диапазона для rgb=({r},{g},{b})");
            assert!((-255..=255).contains(&co));
            assert!((-255..=255).contains(&cg));
            assert_eq!(ycocg_r_to_rgb(y, co, cg), (r, g, b));
        };
        for r in (0..=255).step_by(5) {
            for g in (0..=255).step_by(5) {
                for b in (0..=255).step_by(5) {
                    check(r, g, b);
                }
            }
        }
        for &v in &[0, 1, 254, 255] {
            for &u in &[0, 1, 254, 255] {
                for &w in &[0, 1, 254, 255] {
                    check(v, u, w);
                }
            }
        }
    }

    #[test]
    fn ycbcr_roundtrip_error_is_small() {
        for r in (0..=255).step_by(17) {
            for g in (0..=255).step_by(17) {
                for b in (0..=255).step_by(17) {
                    let (y, cb, cr) = rgb_to_ycbcr(r, g, b);
                    let (r2, g2, b2) = ycbcr_to_rgb(y, cb, cr);
                    assert!((r - r2).abs() <= 2 && (g - g2).abs() <= 2 && (b - b2).abs() <= 2);
                }
            }
        }
    }

    #[test]
    fn subsample_roundtrip_flat() {
        let w = 7;
        let h = 5;
        let src = vec![100i16; w * h];
        let down = downsample_420(&src, w, h);
        assert_eq!(down.len(), 4 * 3);
        let up = upsample_420(&down, 4, 3, w, h);
        assert_eq!(up, src);
    }
}
