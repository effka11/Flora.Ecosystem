//! Синтаксическая модель кадра: вероятности разбиения, режимов, inter-элементов
//! (is_inter / MVD / skip) и модель коэффициентов. Сбрасывается на каждом кадре.
//!
//! Дерево люма-режима (7 режимов):
//! `directional?` → нет: `dc?` → DC | `tm?` → TM | PLANAR
//!              → да: `diag?` → нет: `h?` → H | V
//!                             → да: `d135?` → D135 | D45
//!
//! Хрома-режим: бит `cm_same` (совпадает с люмой); иначе `cm_dir` →
//! нет: `cm_dc?` → DC | TM; да: `cm_h?` → H | V.
//!
//! MVD-компонента: `nz`; величина gt1/gt2/gt3, дальше категория (унарно) +
//! сырые биты (как у коэффициентов, кап 2047); знак — сырой бит.

use crate::ec::{BoolDecoder, BoolEncoder, Prob};
use crate::mc::{MVD_MAX, Mv};
use crate::predict::{
    MODE_D45, MODE_D135, MODE_DC, MODE_H, MODE_PLANAR, MODE_TM, MODE_V, is_directional,
};
use crate::tokens::CoeffModel;

/// Категории величины MVD: r+1 ∈ [1, 2044] → c ≤ 10.
const MVD_CAT_MAX: usize = 11;

/// Модель одной компоненты MVD.
pub struct MvdComp {
    nz: Prob,
    gt1: Prob,
    gt2: Prob,
    gt3: Prob,
    cat: [Prob; MVD_CAT_MAX],
}

impl Default for MvdComp {
    fn default() -> Self {
        MvdComp {
            nz: Prob::new(12_000),
            gt1: Prob::new(14_000),
            gt2: Prob::new(16_384),
            gt3: Prob::new(18_000),
            cat: [Prob::new(20_000); MVD_CAT_MAX],
        }
    }
}

impl MvdComp {
    fn encode(&mut self, enc: &mut BoolEncoder, d: i32) {
        debug_assert!(d.abs() <= MVD_MAX);
        enc.put(&mut self.nz, d != 0);
        if d == 0 {
            return;
        }
        let mag = d.unsigned_abs();
        enc.put(&mut self.gt1, mag > 1);
        if mag > 1 {
            enc.put(&mut self.gt2, mag > 2);
            if mag > 2 {
                enc.put(&mut self.gt3, mag > 3);
                if mag > 3 {
                    let r_plus_1 = mag - 3;
                    let c = r_plus_1.ilog2() as usize;
                    for i in 0..c {
                        enc.put(&mut self.cat[i], true);
                    }
                    if c < MVD_CAT_MAX - 1 {
                        enc.put(&mut self.cat[c], false);
                    }
                    enc.put_raw_bits(r_plus_1 - (1 << c), c as u32);
                }
            }
        }
        enc.put_raw(d < 0);
    }

    fn decode(&mut self, dec: &mut BoolDecoder<'_>) -> i32 {
        if !dec.get(&mut self.nz) {
            return 0;
        }
        let mut mag = 1u32;
        if dec.get(&mut self.gt1) {
            mag = 2;
            if dec.get(&mut self.gt2) {
                mag = 3;
                if dec.get(&mut self.gt3) {
                    let mut c = 0usize;
                    while c < MVD_CAT_MAX - 1 && dec.get(&mut self.cat[c]) {
                        c += 1;
                    }
                    let extra = dec.get_raw_bits(c as u32);
                    mag = (3 + (1u32 << c) + extra).min(MVD_MAX as u32);
                }
            }
        }
        let neg = dec.get_raw();
        if neg { -(mag as i32) } else { mag as i32 }
    }

    fn cost(&self, d: i32) -> u64 {
        let mut c = u64::from(self.nz.cost(d != 0));
        if d == 0 {
            return c;
        }
        let mag = d.unsigned_abs();
        c += u64::from(self.gt1.cost(mag > 1));
        if mag > 1 {
            c += u64::from(self.gt2.cost(mag > 2));
            if mag > 2 {
                c += u64::from(self.gt3.cost(mag > 3));
                if mag > 3 {
                    let r_plus_1 = mag - 3;
                    let cc = r_plus_1.ilog2() as usize;
                    for i in 0..cc {
                        c += u64::from(self.cat[i].cost(true));
                    }
                    if cc < MVD_CAT_MAX - 1 {
                        c += u64::from(self.cat[cc].cost(false));
                    }
                    c += 256 * cc as u64;
                }
            }
        }
        c + 256 // знак
    }
}

pub struct SyntaxModel {
    /// Флаг разбиения по глубине узла (64→32, 32→16, 16→8).
    pub split: [Prob; 3],
    /// Бит «режим направленный», контекст — направленность соседей (0..=2).
    pub directional: [Prob; 3],
    pub dc: Prob,
    pub tm: Prob,
    pub diag: Prob,
    pub h: Prob,
    pub d135: Prob,
    /// Хрома-режим листа.
    pub cm_same: Prob,
    pub cm_dir: Prob,
    pub cm_dc: Prob,
    pub cm_h: Prob,
    /// Флаг «трансформ вдвое мельче» по размеру листа (8/16/32/64).
    pub tx_split: [Prob; 4],
    /// Бит inter-листа, контекст — число inter-соседей (0..=2).
    pub is_inter: [Prob; 3],
    /// Бит «лист без остатка» (после MVD).
    pub skip: Prob,
    pub mvd_x: MvdComp,
    pub mvd_y: MvdComp,
    pub coeffs: CoeffModel,
}

impl Default for SyntaxModel {
    fn default() -> Self {
        SyntaxModel {
            split: [Prob::new(20_000), Prob::new(18_000), Prob::new(16_384)],
            directional: [Prob::new(22_000), Prob::new(16_384), Prob::new(10_000)],
            dc: Prob::new(14_000),
            tm: Prob::new(16_384),
            diag: Prob::new(20_000),
            h: Prob::new(16_384),
            d135: Prob::new(16_384),
            cm_same: Prob::new(6_000),
            cm_dir: Prob::new(16_384),
            cm_dc: Prob::new(12_000),
            cm_h: Prob::new(16_384),
            tx_split: [Prob::new(20_000); 4],
            is_inter: [Prob::new(16_384); 3],
            skip: Prob::new(16_384),
            mvd_x: MvdComp::default(),
            mvd_y: MvdComp::default(),
            coeffs: CoeffModel::default(),
        }
    }
}

#[inline]
pub fn depth_idx(n: usize) -> usize {
    match n {
        64 => 0,
        32 => 1,
        _ => 2,
    }
}

#[inline]
fn leaf_size_idx(n: usize) -> usize {
    match n {
        8 => 0,
        16 => 1,
        32 => 2,
        _ => 3,
    }
}

impl SyntaxModel {
    pub fn encode_split(&mut self, enc: &mut BoolEncoder, n: usize, split: bool) {
        enc.put(&mut self.split[depth_idx(n)], split);
    }

    pub fn decode_split(&mut self, dec: &mut BoolDecoder<'_>, n: usize) -> bool {
        dec.get(&mut self.split[depth_idx(n)])
    }

    pub fn split_cost(&self, n: usize, split: bool) -> u64 {
        u64::from(self.split[depth_idx(n)].cost(split))
    }

    pub fn encode_tx_split(&mut self, enc: &mut BoolEncoder, n: usize, split: bool) {
        enc.put(&mut self.tx_split[leaf_size_idx(n)], split);
    }

    pub fn decode_tx_split(&mut self, dec: &mut BoolDecoder<'_>, n: usize) -> bool {
        dec.get(&mut self.tx_split[leaf_size_idx(n)])
    }

    pub fn tx_split_cost(&self, n: usize, split: bool) -> u64 {
        u64::from(self.tx_split[leaf_size_idx(n)].cost(split))
    }

    pub fn encode_mode(&mut self, enc: &mut BoolEncoder, dir_ctx: usize, mode: u8) {
        let dir = is_directional(mode);
        enc.put(&mut self.directional[dir_ctx], dir);
        if dir {
            let diag = mode == MODE_D45 || mode == MODE_D135;
            enc.put(&mut self.diag, diag);
            if diag {
                enc.put(&mut self.d135, mode == MODE_D135);
            } else {
                enc.put(&mut self.h, mode == MODE_H);
            }
        } else {
            let is_dc = mode == MODE_DC;
            enc.put(&mut self.dc, is_dc);
            if !is_dc {
                enc.put(&mut self.tm, mode == MODE_TM);
            }
        }
    }

    pub fn decode_mode(&mut self, dec: &mut BoolDecoder<'_>, dir_ctx: usize) -> u8 {
        if dec.get(&mut self.directional[dir_ctx]) {
            if dec.get(&mut self.diag) {
                if dec.get(&mut self.d135) {
                    MODE_D135
                } else {
                    MODE_D45
                }
            } else if dec.get(&mut self.h) {
                MODE_H
            } else {
                MODE_V
            }
        } else if dec.get(&mut self.dc) {
            MODE_DC
        } else if dec.get(&mut self.tm) {
            MODE_TM
        } else {
            MODE_PLANAR
        }
    }

    pub fn mode_cost(&self, dir_ctx: usize, mode: u8) -> u64 {
        let dir = is_directional(mode);
        let mut c = u64::from(self.directional[dir_ctx].cost(dir));
        if dir {
            let diag = mode == MODE_D45 || mode == MODE_D135;
            c += u64::from(self.diag.cost(diag));
            c += if diag {
                u64::from(self.d135.cost(mode == MODE_D135))
            } else {
                u64::from(self.h.cost(mode == MODE_H))
            };
        } else {
            let is_dc = mode == MODE_DC;
            c += u64::from(self.dc.cost(is_dc));
            if !is_dc {
                c += u64::from(self.tm.cost(mode == MODE_TM));
            }
        }
        c
    }

    /// Хрома-режим: `None` = совпадает с люмой, иначе DC/TM/V/H.
    pub fn encode_chroma_mode(&mut self, enc: &mut BoolEncoder, cm: Option<u8>) {
        enc.put(&mut self.cm_same, cm.is_none());
        if let Some(m) = cm {
            let dir = m == MODE_V || m == MODE_H;
            enc.put(&mut self.cm_dir, dir);
            if dir {
                enc.put(&mut self.cm_h, m == MODE_H);
            } else {
                enc.put(&mut self.cm_dc, m == MODE_DC);
            }
        }
    }

    pub fn decode_chroma_mode(&mut self, dec: &mut BoolDecoder<'_>) -> Option<u8> {
        if dec.get(&mut self.cm_same) {
            return None;
        }
        Some(if dec.get(&mut self.cm_dir) {
            if dec.get(&mut self.cm_h) {
                MODE_H
            } else {
                MODE_V
            }
        } else if dec.get(&mut self.cm_dc) {
            MODE_DC
        } else {
            MODE_TM
        })
    }

    pub fn chroma_mode_cost(&self, cm: Option<u8>) -> u64 {
        let mut c = u64::from(self.cm_same.cost(cm.is_none()));
        if let Some(m) = cm {
            let dir = m == MODE_V || m == MODE_H;
            c += u64::from(self.cm_dir.cost(dir));
            c += if dir {
                u64::from(self.cm_h.cost(m == MODE_H))
            } else {
                u64::from(self.cm_dc.cost(m == MODE_DC))
            };
        }
        c
    }

    pub fn encode_is_inter(&mut self, enc: &mut BoolEncoder, ctx: usize, inter: bool) {
        enc.put(&mut self.is_inter[ctx], inter);
    }

    pub fn decode_is_inter(&mut self, dec: &mut BoolDecoder<'_>, ctx: usize) -> bool {
        dec.get(&mut self.is_inter[ctx])
    }

    pub fn is_inter_cost(&self, ctx: usize, inter: bool) -> u64 {
        u64::from(self.is_inter[ctx].cost(inter))
    }

    pub fn encode_skip(&mut self, enc: &mut BoolEncoder, skip: bool) {
        enc.put(&mut self.skip, skip);
    }

    pub fn decode_skip(&mut self, dec: &mut BoolDecoder<'_>) -> bool {
        dec.get(&mut self.skip)
    }

    pub fn skip_cost(&self, skip: bool) -> u64 {
        u64::from(self.skip.cost(skip))
    }

    /// Кодирует разность MV (обе компоненты, кламп |·| ≤ 2047 — на вызывающем).
    pub fn encode_mvd(&mut self, enc: &mut BoolEncoder, d: Mv) {
        self.mvd_x.encode(enc, d.x);
        self.mvd_y.encode(enc, d.y);
    }

    pub fn decode_mvd(&mut self, dec: &mut BoolDecoder<'_>) -> Mv {
        Mv {
            x: self.mvd_x.decode(dec),
            y: self.mvd_y.decode(dec),
        }
    }

    pub fn mvd_cost(&self, d: Mv) -> u64 {
        self.mvd_x.cost(d.x) + self.mvd_y.cost(d.y)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::predict::NUM_MODES;

    /// Все режимы кодируются и декодируются взаимно-однозначно во всех контекстах.
    #[test]
    fn mode_roundtrip() {
        for ctx in 0..3 {
            let mut enc_model = SyntaxModel::default();
            let mut enc = BoolEncoder::new();
            let modes: Vec<u8> = (0..NUM_MODES as u8).cycle().take(200).collect();
            for &m in &modes {
                enc_model.encode_mode(&mut enc, ctx, m);
            }
            let bytes = enc.finish();
            let mut dec_model = SyntaxModel::default();
            let mut dec = BoolDecoder::new(&bytes);
            for &m in &modes {
                assert_eq!(dec_model.decode_mode(&mut dec, ctx), m);
            }
        }
    }

    /// MVD: roundtrip на характерных и крайних значениях.
    #[test]
    fn mvd_roundtrip() {
        let values: Vec<i32> = vec![
            0, 1, -1, 2, -3, 4, -7, 8, 15, -16, 100, -333, 1024, -2047, 2047,
        ];
        let mut enc_model = SyntaxModel::default();
        let mut enc = BoolEncoder::new();
        for &x in &values {
            for &y in &values {
                enc_model.encode_mvd(&mut enc, Mv { x, y });
            }
        }
        let bytes = enc.finish();
        let mut dec_model = SyntaxModel::default();
        let mut dec = BoolDecoder::new(&bytes);
        for &x in &values {
            for &y in &values {
                assert_eq!(dec_model.decode_mvd(&mut dec), Mv { x, y });
            }
        }
    }

    /// Хрома-режим: все варианты.
    #[test]
    fn chroma_mode_roundtrip() {
        let cms = [
            None,
            Some(MODE_DC),
            Some(MODE_TM),
            Some(MODE_V),
            Some(MODE_H),
        ];
        let mut enc_model = SyntaxModel::default();
        let mut enc = BoolEncoder::new();
        for _ in 0..40 {
            for &cm in &cms {
                enc_model.encode_chroma_mode(&mut enc, cm);
            }
        }
        let bytes = enc.finish();
        let mut dec_model = SyntaxModel::default();
        let mut dec = BoolDecoder::new(&bytes);
        for _ in 0..40 {
            for &cm in &cms {
                assert_eq!(dec_model.decode_chroma_mode(&mut dec), cm);
            }
        }
    }
}
