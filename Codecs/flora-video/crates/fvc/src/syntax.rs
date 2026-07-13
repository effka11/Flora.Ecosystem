//! Синтаксическая модель кадра: вероятности разбиения и режимов + модель
//! коэффициентов. Сбрасывается на каждом кадре (кадры v0.1 независимы).
//!
//! Дерево режима (7 режимов):
//! `directional?` → нет: `dc?` → DC | `tm?` → TM | PLANAR
//!              → да: `diag?` → нет: `h?` → H | V
//!                             → да: `d135?` → D135 | D45

use crate::ec::{BoolDecoder, BoolEncoder, Prob};
use crate::predict::{
    MODE_D45, MODE_D135, MODE_DC, MODE_H, MODE_PLANAR, MODE_TM, MODE_V, is_directional,
};
use crate::tokens::CoeffModel;

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
    /// Флаг «трансформ вдвое мельче» по размеру листа (8/16/32/64).
    pub tx_split: [Prob; 4],
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
            tx_split: [Prob::new(20_000); 4],
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
}
