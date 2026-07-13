//! Кодирование квантованных коэффициентов (нормативное).
//!
//! Схема на блок трансформа:
//! 1. `cbf` — есть ли ненулевые коэффициенты (контекст: тип плоскости × размер).
//! 2. По зигзаг-скану для каждой позиции — бит `nz` (контекст: плоскость × полоса ×
//!    величина предыдущего коэффициента). Для ненулевого: величина (gt1/gt2/gt3,
//!    дальше — унарная категория + сырые биты), знак (сырой бит) и бит `eob`
//!    («дальше ненулевых нет», контекст: плоскость × полоса).
//!
//! Все вероятности адаптивные, сбрасываются на каждом кадре (кадры независимы).

use crate::ec::{BoolDecoder, BoolEncoder, Prob};
use crate::scan::{NUM_BANDS, band, scans};

/// Максимальный кодируемый уровень.
pub const MAX_LEVEL: i32 = 32_767;
/// Максимум унарной категории (уровни 4..=4+2^15-2 покрывают MAX_LEVEL).
const CAT_MAX: usize = 15;

#[inline]
fn size_idx(n: usize) -> usize {
    match n {
        4 => 0,
        8 => 1,
        16 => 2,
        _ => 3,
    }
}

#[inline]
fn prev_mag_ctx(mag: u32) -> usize {
    match mag {
        0 => 0,
        1 => 1,
        _ => 2,
    }
}

/// Адаптивные модели коэффициентов одного кадра.
pub struct CoeffModel {
    cbf: [[Prob; 4]; 2],
    nz: [[[Prob; 3]; NUM_BANDS]; 2],
    gt1: [[[Prob; 3]; NUM_BANDS]; 2],
    gt2: [[Prob; NUM_BANDS]; 2],
    gt3: [[Prob; NUM_BANDS]; 2],
    cat: [[Prob; CAT_MAX]; 2],
    eob: [[Prob; NUM_BANDS]; 2],
}

impl Default for CoeffModel {
    fn default() -> Self {
        CoeffModel {
            cbf: [[Prob::new(16_384); 4]; 2],
            // P(ноль) высокая: хвосты скана почти пустые.
            nz: [[[Prob::new(26_000); 3]; NUM_BANDS]; 2],
            gt1: [[[Prob::new(20_000); 3]; NUM_BANDS]; 2],
            gt2: [[Prob::new(18_000); NUM_BANDS]; 2],
            gt3: [[Prob::new(16_384); NUM_BANDS]; 2],
            cat: [[Prob::new(20_000); CAT_MAX]; 2],
            eob: [[Prob::new(16_384); NUM_BANDS]; 2],
        }
    }
}

impl CoeffModel {
    /// Кодирует блок `n×n` квантованных уровней (raster). `pt` — 0 люма / 1 хрома.
    pub fn encode_block(&mut self, enc: &mut BoolEncoder, pt: usize, n: usize, levels: &[i32]) {
        let n2 = n * n;
        let scan = scans().get(n);
        let last = scan.iter().rposition(|&rp| levels[rp as usize] != 0);
        let si = size_idx(n);
        enc.put(&mut self.cbf[pt][si], last.is_some());
        let Some(last) = last else { return };

        let mut prev_mag = 0u32;
        for (pos, &rp) in scan.iter().enumerate() {
            let level = levels[rp as usize];
            let b = band(pos, n2);
            let pctx = prev_mag_ctx(prev_mag);
            enc.put(&mut self.nz[pt][b][pctx], level != 0);
            if level == 0 {
                prev_mag = 0;
                continue;
            }
            let mag = level.unsigned_abs();
            self.encode_magnitude(enc, pt, b, pctx, mag);
            enc.put_raw(level < 0);
            prev_mag = mag;
            if pos == last {
                if pos < n2 - 1 {
                    enc.put(&mut self.eob[pt][b], true);
                }
                return;
            }
            enc.put(&mut self.eob[pt][b], false);
        }
    }

    fn encode_magnitude(
        &mut self,
        enc: &mut BoolEncoder,
        pt: usize,
        b: usize,
        pctx: usize,
        mag: u32,
    ) {
        debug_assert!(mag >= 1 && mag <= MAX_LEVEL as u32);
        enc.put(&mut self.gt1[pt][b][pctx], mag > 1);
        if mag == 1 {
            return;
        }
        enc.put(&mut self.gt2[pt][b], mag > 2);
        if mag == 2 {
            return;
        }
        enc.put(&mut self.gt3[pt][b], mag > 3);
        if mag == 3 {
            return;
        }
        // r+1 ∈ [1, 2^15-1]; категория c = bitlen(r+1)-1, затем c сырых бит.
        let r_plus_1 = mag - 3; // r = mag - 4, r+1 = mag - 3
        let c = r_plus_1.ilog2() as usize;
        for i in 0..c {
            enc.put(&mut self.cat[pt][i], true);
        }
        if c < CAT_MAX - 1 {
            enc.put(&mut self.cat[pt][c], false);
        }
        enc.put_raw_bits(r_plus_1 - (1 << c), c as u32);
    }

    /// Декодирует блок в `out` (raster, длина `n²`, будет обнулён). Возвращает cbf.
    pub fn decode_block(
        &mut self,
        dec: &mut BoolDecoder<'_>,
        pt: usize,
        n: usize,
        out: &mut [i32],
    ) -> bool {
        let n2 = n * n;
        out[..n2].fill(0);
        let si = size_idx(n);
        if !dec.get(&mut self.cbf[pt][si]) {
            return false;
        }
        let scan = scans().get(n);
        let mut prev_mag = 0u32;
        for (pos, &rp) in scan.iter().enumerate() {
            let b = band(pos, n2);
            let pctx = prev_mag_ctx(prev_mag);
            if !dec.get(&mut self.nz[pt][b][pctx]) {
                prev_mag = 0;
                continue;
            }
            let mag = self.decode_magnitude(dec, pt, b, pctx);
            let neg = dec.get_raw();
            out[rp as usize] = if neg { -(mag as i32) } else { mag as i32 };
            prev_mag = mag;
            if pos < n2 - 1 && dec.get(&mut self.eob[pt][b]) {
                break;
            }
        }
        true
    }

    fn decode_magnitude(
        &mut self,
        dec: &mut BoolDecoder<'_>,
        pt: usize,
        b: usize,
        pctx: usize,
    ) -> u32 {
        if !dec.get(&mut self.gt1[pt][b][pctx]) {
            return 1;
        }
        if !dec.get(&mut self.gt2[pt][b]) {
            return 2;
        }
        if !dec.get(&mut self.gt3[pt][b]) {
            return 3;
        }
        let mut c = 0usize;
        while c < CAT_MAX - 1 && dec.get(&mut self.cat[pt][c]) {
            c += 1;
        }
        let extra = dec.get_raw_bits(c as u32);
        let mag = 3 + (1u32 << c) + extra;
        mag.min(MAX_LEVEL as u32)
    }

    /// RD-оптимизация квантованных уровней (только энкодер, битстрим не меняется).
    ///
    /// Жадный проход по ненулевым уровням от хвоста скана: для каждого пробуем
    /// |l|−1 и 0; принимаем, если `ΔD·λ_den + ΔR·λ_num·64 < 0` (дисторсия в домене
    /// коэффициентов ×64 = пиксельный SSE: домен 8×ортонормальный). Наибольший
    /// выигрыш — обрезка хвостовых ±1 (сдвиг EOB к началу).
    #[allow(clippy::too_many_arguments)]
    pub fn optimize_levels(
        &self,
        pt: usize,
        n: usize,
        coeffs: &[i32],
        levels: &mut [i32],
        qp: u8,
        lambda_num: u64,
        lambda_den: u64,
    ) {
        use crate::quant::{ac_step, dc_step};
        /// Дороже не считаем: у плотных блоков (низкий qp) выигрыш RDOQ минимален.
        const MAX_VISITS: usize = 48;

        let scan = scans().get(n);
        let nz: Vec<usize> = scan
            .iter()
            .map(|&rp| rp as usize)
            .filter(|&rp| levels[rp] != 0)
            .collect();
        let mut rate = i128::from(self.estimate_block(pt, n, levels));
        for &rp in nz.iter().rev().take(MAX_VISITS) {
            let l = levels[rp];
            let step = i128::from(if rp == 0 { dc_step(qp) } else { ac_step(qp) });
            let c = i128::from(coeffs[rp]);
            let sign = if l < 0 { -1i32 } else { 1 };
            let mag = l.unsigned_abs() as i32;
            let err = |m: i32| -> i128 {
                let e = c - i128::from(sign) * i128::from(m) * step;
                e * e
            };
            let base_err = err(mag);
            let mut best: Option<(i128, i32, i128)> = None; // (Δcost, уровень, rate)
            let candidates: &[i32] = if mag == 1 { &[0] } else { &[mag - 1, 0] };
            for &cand in candidates {
                levels[rp] = sign * cand;
                let new_rate = i128::from(self.estimate_block(pt, n, levels));
                let d_cost = (err(cand) - base_err) * i128::from(lambda_den)
                    + (new_rate - rate) * i128::from(lambda_num) * 64;
                if d_cost < 0 && best.as_ref().is_none_or(|(bc, _, _)| d_cost < *bc) {
                    best = Some((d_cost, sign * cand, new_rate));
                }
            }
            match best {
                Some((_, new_l, new_rate)) => {
                    levels[rp] = new_l;
                    rate = new_rate;
                }
                None => levels[rp] = l,
            }
        }
    }

    /// Оценка стоимости кодирования блока в 1/256 бита (без адаптации моделей).
    pub fn estimate_block(&self, pt: usize, n: usize, levels: &[i32]) -> u64 {
        let n2 = n * n;
        let scan = scans().get(n);
        let last = scan.iter().rposition(|&rp| levels[rp as usize] != 0);
        let si = size_idx(n);
        let mut cost = u64::from(self.cbf[pt][si].cost(last.is_some()));
        let Some(last) = last else { return cost };

        let mut prev_mag = 0u32;
        for (pos, &rp) in scan.iter().enumerate() {
            let level = levels[rp as usize];
            let b = band(pos, n2);
            let pctx = prev_mag_ctx(prev_mag);
            cost += u64::from(self.nz[pt][b][pctx].cost(level != 0));
            if level == 0 {
                prev_mag = 0;
                continue;
            }
            let mag = level.unsigned_abs();
            cost += self.estimate_magnitude(pt, b, pctx, mag);
            cost += 256; // знак
            prev_mag = mag;
            if pos == last {
                if pos < n2 - 1 {
                    cost += u64::from(self.eob[pt][b].cost(true));
                }
                return cost;
            }
            cost += u64::from(self.eob[pt][b].cost(false));
        }
        cost
    }

    fn estimate_magnitude(&self, pt: usize, b: usize, pctx: usize, mag: u32) -> u64 {
        let mut cost = u64::from(self.gt1[pt][b][pctx].cost(mag > 1));
        if mag == 1 {
            return cost;
        }
        cost += u64::from(self.gt2[pt][b].cost(mag > 2));
        if mag == 2 {
            return cost;
        }
        cost += u64::from(self.gt3[pt][b].cost(mag > 3));
        if mag == 3 {
            return cost;
        }
        let r_plus_1 = mag - 3;
        let c = r_plus_1.ilog2() as usize;
        for i in 0..c {
            cost += u64::from(self.cat[pt][i].cost(true));
        }
        if c < CAT_MAX - 1 {
            cost += u64::from(self.cat[pt][c].cost(false));
        }
        cost + 256 * c as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u32 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (self.0 >> 33) as u32
        }
    }

    #[test]
    fn roundtrip_blocks() {
        let mut rng = Lcg(0xC0FFEE);
        let mut enc_model = CoeffModel::default();
        let mut enc = BoolEncoder::new();
        let mut blocks = Vec::new();
        for _ in 0..300 {
            let n = [4usize, 8, 16, 32][(rng.next() % 4) as usize];
            let pt = (rng.next() % 2) as usize;
            let mut levels = vec![0i32; n * n];
            // Реалистичное распределение: плотная низкочастотная часть.
            let density = rng.next() % 40;
            for (i, l) in levels.iter_mut().enumerate() {
                let p = 100 * i as u32 / (n * n) as u32; // позиция в %
                if rng.next() % 100 < density.saturating_sub(p / 2) {
                    let m = 1 + (rng.next() % 200) as i32;
                    let m = if rng.next().is_multiple_of(7) {
                        m * 97
                    } else {
                        m
                    };
                    *l = if rng.next().is_multiple_of(2) { -m } else { m };
                }
            }
            enc_model.encode_block(&mut enc, pt, n, &levels);
            blocks.push((pt, n, levels));
        }
        let data = enc.finish();

        let mut dec_model = CoeffModel::default();
        let mut dec = BoolDecoder::new(&data);
        let mut out = vec![0i32; 32 * 32];
        for (i, (pt, n, levels)) in blocks.iter().enumerate() {
            dec_model.decode_block(&mut dec, *pt, *n, &mut out);
            assert_eq!(&out[..n * n], &levels[..], "block {i} (pt={pt}, n={n})");
        }
    }

    #[test]
    fn max_level_roundtrip() {
        let mut enc_model = CoeffModel::default();
        let mut enc = BoolEncoder::new();
        let mut levels = vec![0i32; 16];
        levels[0] = MAX_LEVEL;
        levels[5] = -MAX_LEVEL;
        enc_model.encode_block(&mut enc, 0, 4, &levels);
        let data = enc.finish();
        let mut dec_model = CoeffModel::default();
        let mut dec = BoolDecoder::new(&data);
        let mut out = vec![0i32; 16];
        dec_model.decode_block(&mut dec, 0, 4, &mut out);
        assert_eq!(out, levels);
    }
}
