//! Lossy-линия битстрима v8 (FRC-I.md §11.4).
//!
//! Отличия от замороженного v7 (все нормативные, decoder-visible):
//!
//! 1. **Прямоугольные партиции 2:1.** Узлы 32 и 16 сигналят четверичный
//!    split `WHOLE/QUAD/HORZ/VERT`; HORZ/VERT — два листа 32×16 / 16×32
//!    (или 16×8 / 8×16) с separable DCT/ADST, прямоугольным зигзагом и
//!    квантованием. Листы не делятся дальше: глубина дерева фиксирована
//!    форматом, недоверенный поток не управляет рекурсией (v7.10).
//!    Полигон Kodak smoke-8: −0.51% PSNR BD-rate при гейте анизотропии.
//! 2. **Целочисленный YCoCg** с базовыми шагами квантования плоскостей
//!    Y/Co/Cg = 51/45/38; цвет и матрицы живут в `color.rs`/`dct.rs`,
//!    сюда приходит готовая матрица плоскости.
//!
//! Итог полигона Kodak 24 (full, ladder q30..q95): v8 vs v7.9a
//! **−2.55% PSNR BD-rate** (медиана −2.69%, лучше на 23/24 кадрах),
//! encode q70 ≈ 10.2 Мп/с (v7: 11.8) — бюджет ≥10 Мп/с соблюдён.
//!
//! Раскладка контекстов коэффициентов — как в v7 (позиция × nnz/lvl),
//! **без** conditioning по transform: измеренный на v7.11 резерв
//! −2.36…−2.68% оценённых бит не подтвердился на реальных потоках —
//! дробление адаптивных моделей ×4 разбавило статистику и стоило
//! +2.17% BD-rate на полном Kodak (2-класса — +1.21%); условность удалена.
//! **AC-смещение реконструкции** (δ/64 шага к нулю) также отклонено:
//! δ=10 стоило +1.18%, δ=4 — +0.40% (24/24 и 0/8 соответственно) —
//! bounded trellis уже ставит уровни в RD-оптимум, а смещение середины
//! бина ломает его модель ошибки.
//!
//! Реализация переиспользует замороженные v7-примитивы (`lossy.rs`,
//! `v72.rs`): предикторы, SAD-предотбор, RD-ядро. Всё v8-специфичное —
//! локально в этом модуле.

use super::v72::{
    border4, border32, child_blocks4, child_nodes16, choose_mode4, choose_mode32,
    gather_block4_i32, gather_block32_i32, predict_block4, predict_block32, restore_region8,
    restore_region32, save_region8, save_region32, split_hint8, split_hint32, store_block4,
    store_block32,
};
use super::*;
use crate::dct::{
    ZIGZAG_8X16, ZIGZAG_16X8, ZIGZAG_16X32, ZIGZAG_32X16, forward_tx_8x16, forward_tx_16x8,
    forward_tx_16x32, forward_tx_32x16, forward_tx4, forward_tx32, inverse_tx_8x16,
    inverse_tx_16x8, inverse_tx_16x32, inverse_tx_32x16, inverse_tx4, inverse_tx32,
    quant_matrix_rect, quant_matrix4, quant_matrix32,
};

// --- раскладка контекстов v8 ---------------------------------------------------

/// Четверичный split узла 16×16: WHOLE / QUAD / HORZ / VERT.
const CTX8_SPLIT16: u16 = 0;
/// Мода intra/CfL любого листа.
const CTX8_MODE: u16 = 1;
/// DC-токен любого блока (v7-замер: условность по prev_dc не окупается).
const CTX8_DC: u16 = 2;
/// Четверичный split корня 32×32.
const CTX8_SPLIT32: u16 = 3;
/// Бинарный split узла 8×8: 0 — whole8, 1 — четыре листа 4×4.
const CTX8_SPLIT8: u16 = 4;
/// Transform листа (DCT/ADST по осям).
const CTX8_TX: u16 = 5;
/// Tile-plane CDEF strength (пишется первым символом секции).
pub const CTX8_CDEF: u16 = 6;
/// База RUN-контекстов: 6 позиций × 4 nnz-бакета (как v7).
const CTX8_RUN_BASE: u16 = 7;
/// База LEVEL-контекстов: 6 позиций × 4 бакета пред. уровня.
const CTX8_LEVEL_BASE: u16 = CTX8_RUN_BASE + 24;
/// База бинарных EOB-контекстов: 6 позиций × 4 nnz-бакета.
const CTX8_EOB_BASE: u16 = CTX8_LEVEL_BASE + 24;
/// Общее число контекстов v8.
pub const N_CTX_V8: usize = CTX8_EOB_BASE as usize + 24;

/// Символы четверичного split (нормативны для v8).
const SPLIT4_WHOLE: u8 = 0;
const SPLIT4_QUAD: u8 = 1;
/// Два листа W×(H/2), верхний затем нижний.
const SPLIT4_HORZ: u8 = 2;
/// Два листа (W/2)×H, левый затем правый.
const SPLIT4_VERT: u8 = 3;

/// Родительские группы и виды моделей v8 для иерархического прогрева
/// `ModelBank`: детальные run/level/eob-контексты наследуют статистику
/// родителя своей позиционной зоны (та же схема, что v7).
pub fn ctx_meta_v8() -> (Vec<u8>, Vec<crate::arith::ModelKind>) {
    use crate::arith::ModelKind;
    let mut groups = vec![0u8; N_CTX_V8];
    let mut kinds = vec![ModelKind::Level; N_CTX_V8];
    let mut set = |ctx: u16, group: u8, kind: ModelKind| {
        groups[usize::from(ctx)] = group;
        kinds[usize::from(ctx)] = kind;
    };
    set(CTX8_SPLIT16, 0, ModelKind::Split4);
    set(CTX8_SPLIT32, 0, ModelKind::Split4);
    set(CTX8_MODE, 1, ModelKind::Mode);
    set(CTX8_DC, 2, ModelKind::Dc);
    set(CTX8_SPLIT8, 21, ModelKind::Split);
    set(CTX8_TX, 22, ModelKind::Tx);
    set(CTX8_CDEF, 23, ModelKind::Cdef);
    for cond in 0..4u8 {
        for pos_b in 0..N_POS_BUCKETS {
            set(run_ctx_v8(pos_b, cond), 3 + pos_b, ModelKind::Run);
            set(
                level_ctx_v8(pos_b, cond),
                3 + N_POS_BUCKETS + pos_b,
                ModelKind::Level,
            );
            set(
                eob_ctx_v8(pos_b, cond),
                3 + 2 * N_POS_BUCKETS + pos_b,
                ModelKind::Eob,
            );
        }
    }
    (groups, kinds)
}

#[inline]
fn run_ctx_v8(pos_bucket: u8, nnz_b: u8) -> u16 {
    CTX8_RUN_BASE + u16::from(pos_bucket) + 6 * u16::from(nnz_b)
}

#[inline]
fn level_ctx_v8(pos_bucket: u8, lvl_b: u8) -> u16 {
    CTX8_LEVEL_BASE + u16::from(pos_bucket) + 6 * u16::from(lvl_b)
}

#[inline]
fn eob_ctx_v8(pos_bucket: u8, nnz_b: u8) -> u16 {
    CTX8_EOB_BASE + u16::from(pos_bucket) + 6 * u16::from(nnz_b)
}

// --- реконструкция --------------------------------------------------------------

/// Спектр из квантованных уровней: `level·step` (реконструкция v8 совпадает
/// с v7; AC-смещение к нулю отклонено по полигону — см. заголовок модуля).
fn fill_freq_v8<const LEN: usize>(quantized: &[i32; LEN], qmat: &[u16; LEN]) -> [f32; LEN] {
    let mut freq = [0f32; LEN];
    for i in 0..LEN {
        if quantized[i] != 0 {
            freq[i] = quantized[i] as f32 * f32::from(qmat[i]);
        }
    }
    freq
}

// --- кодирование коэффициентов (обобщено по размеру блока) ----------------------

/// Межблочное состояние контекстов плоскости v8.
#[derive(Default)]
struct CtxV8 {
    /// nnz-бакет предыдущего блока, нормированный к плотности 8×8.
    prev_nnz: u8,
}

/// Раскладка кодирования коэффициентов для размера блока LEN:
/// скан по transform, бакет позиции и нормировка nnz к плотности 8×8.
struct CoeffLayout<const LEN: usize> {
    scan_for_tx: fn(u8) -> &'static [usize; LEN],
    pos_bucket: fn(usize) -> u8,
    nnz_norm: fn(u32) -> u32,
}

#[inline]
fn pos_bucket4_v8(pos: usize) -> u8 {
    pos_bucket8((pos << 2).clamp(1, 63))
}

#[inline]
fn pos_bucket128_v8(pos: usize) -> u8 {
    pos_bucket8((pos >> 1).max(1))
}

#[inline]
fn pos_bucket512_v8(pos: usize) -> u8 {
    pos_bucket8((pos >> 3).max(1))
}

#[inline]
fn pos_bucket1024_v8(pos: usize) -> u8 {
    pos_bucket8((pos >> 4).max(1))
}

fn nnz_x4(nnz: u32) -> u32 {
    nnz.saturating_mul(4)
}
fn nnz_id(nnz: u32) -> u32 {
    nnz
}
fn nnz_div2(nnz: u32) -> u32 {
    nnz / 2
}
fn nnz_div4(nnz: u32) -> u32 {
    nnz / 4
}
fn nnz_div8(nnz: u32) -> u32 {
    nnz / 8
}
fn nnz_div16(nnz: u32) -> u32 {
    nnz / 16
}

fn scan_16x8(_tx: u8) -> &'static [usize; 128] {
    &ZIGZAG_16X8
}
fn scan_8x16(_tx: u8) -> &'static [usize; 128] {
    &ZIGZAG_8X16
}
fn scan_32x16(_tx: u8) -> &'static [usize; 512] {
    &ZIGZAG_32X16
}
fn scan_16x32(_tx: u8) -> &'static [usize; 512] {
    &ZIGZAG_16X32
}

const LAYOUT4: CoeffLayout<16> = CoeffLayout {
    scan_for_tx: tx_scan4,
    pos_bucket: pos_bucket4_v8,
    nnz_norm: nnz_x4,
};
const LAYOUT8: CoeffLayout<64> = CoeffLayout {
    scan_for_tx: tx_scan8,
    pos_bucket: pos_bucket8,
    nnz_norm: nnz_id,
};
const LAYOUT16: CoeffLayout<256> = CoeffLayout {
    scan_for_tx: tx_scan16,
    pos_bucket: pos_bucket16,
    nnz_norm: nnz_div4,
};
const LAYOUT32: CoeffLayout<1024> = CoeffLayout {
    scan_for_tx: tx_scan32,
    pos_bucket: pos_bucket1024_v8,
    nnz_norm: nnz_div16,
};
const LAYOUT_16X8: CoeffLayout<128> = CoeffLayout {
    scan_for_tx: scan_16x8,
    pos_bucket: pos_bucket128_v8,
    nnz_norm: nnz_div2,
};
const LAYOUT_8X16: CoeffLayout<128> = CoeffLayout {
    scan_for_tx: scan_8x16,
    pos_bucket: pos_bucket128_v8,
    nnz_norm: nnz_div2,
};
const LAYOUT_32X16: CoeffLayout<512> = CoeffLayout {
    scan_for_tx: scan_32x16,
    pos_bucket: pos_bucket512_v8,
    nnz_norm: nnz_div8,
};
const LAYOUT_16X32: CoeffLayout<512> = CoeffLayout {
    scan_for_tx: scan_16x32,
    pos_bucket: pos_bucket512_v8,
    nnz_norm: nnz_div8,
};

/// Кодирует блок (DC-токен + run/level/EOB) в контекстах позиция × nnz/lvl.
fn encode_coeffs_v8<const LEN: usize>(
    quantized: &[i32; LEN],
    tx: u8,
    layout: &CoeffLayout<LEN>,
    st: &mut CtxV8,
    syms: &mut Vec<(u16, u8)>,
    raw: &mut BitWriter,
) {
    let scan = (layout.scan_for_tx)(tx);
    let nnz_b = st.prev_nnz;
    let (sym, bits, n_bits) = tokenize(zigzag(quantized[0]));
    syms.push((CTX8_DC, sym));
    write_raw(raw, bits, n_bits);

    let mut nnz = 0u32;
    let mut prev_mag = 0u32;
    let mut pos = 1usize;
    while pos < LEN {
        let run_start = pos;
        let mut run = 0usize;
        while pos < LEN && quantized[scan[pos]] == 0 {
            run += 1;
            pos += 1;
        }
        let pos_b = (layout.pos_bucket)(run_start);
        if pos == LEN {
            syms.push((eob_ctx_v8(pos_b, nnz_b), 1));
            break;
        }
        syms.push((eob_ctx_v8(pos_b, nnz_b), 0));
        let (rsym, rbits, rn) = tokenize(run as u32);
        syms.push((run_ctx_v8(pos_b, nnz_b), rsym));
        write_raw(raw, rbits, rn);

        let level = quantized[scan[pos]];
        let mag = level.unsigned_abs();
        let (lsym, lbits, ln) = tokenize(mag - 1);
        syms.push((
            level_ctx_v8((layout.pos_bucket)(pos), lvl_bucket(prev_mag)),
            lsym,
        ));
        write_raw(raw, lbits, ln);
        raw.write(u32::from(level < 0), 1);
        prev_mag = mag;
        nnz += 1;
        pos += 1;
    }
    st.prev_nnz = nnz_bucket((layout.nnz_norm)(nnz));
}

/// Декодирует блок; AC пишутся в `freq` нормативным восстановлением v8,
/// DC возвращается токеном (масштабирует вызывающий).
#[allow(clippy::too_many_arguments)]
fn decode_coeffs_v8<const LEN: usize>(
    bank: &mut ModelBank,
    dec: &mut RangeDecoder<'_>,
    raw: &mut BitReader<'_>,
    qmat: &[u16; LEN],
    tx: u8,
    layout: &CoeffLayout<LEN>,
    freq: &mut [f32; LEN],
    st: &mut CtxV8,
) -> Result<i32, DecodeError> {
    freq.fill(0.0);
    let scan = (layout.scan_for_tx)(tx);
    let nnz_b = st.prev_nnz;
    let dc_sym = bank.decode(dec, CTX8_DC)?;
    let dc_token = unzigzag(detokenize(dc_sym, raw)?);

    let mut nnz = 0u32;
    let mut prev_mag = 0u32;
    let mut pos = 1usize;
    while pos < LEN {
        let pos_b = (layout.pos_bucket)(pos);
        if bank.decode(dec, eob_ctx_v8(pos_b, nnz_b))? == 1 {
            break;
        }
        let rsym = bank.decode(dec, run_ctx_v8(pos_b, nnz_b))?;
        let run = detokenize(rsym, raw)? as usize;
        let new_pos = pos
            .checked_add(run)
            .ok_or(DecodeError::Corrupt("v8: run overflow"))?;
        if new_pos >= LEN {
            return Err(DecodeError::Corrupt("v8: позиция AC вне блока"));
        }
        pos = new_pos;
        let lsym = bank.decode(
            dec,
            level_ctx_v8((layout.pos_bucket)(pos), lvl_bucket(prev_mag)),
        )?;
        let mag = detokenize(lsym, raw)?.wrapping_add(1);
        let sign = raw.read(1)?;
        let level = if sign == 1 { -(mag as i32) } else { mag as i32 };
        let index = scan[pos];
        freq[index] = level as f32 * f32::from(qmat[index]);
        prev_mag = mag;
        nnz += 1;
        pos += 1;
    }
    st.prev_nnz = nnz_bucket((layout.nnz_norm)(nnz));
    Ok(dc_token)
}

// --- прямоугольные примитивы ----------------------------------------------------

/// Граница прямоугольного блока W×H: верхняя строка расширена вправо
/// до `AB = W + H` отсчётов (нужно D45), левый столбец высоты H, угол.
/// Недоступные соседи — 128, координаты клампятся (репликация края).
struct BorderRect<const AB: usize, const H: usize> {
    above: [i32; AB],
    left: [i32; H],
    corner: i32,
}

fn border_rect<const W: usize, const H: usize, const AB: usize>(
    recon: &[i16],
    w: usize,
    h: usize,
    px: usize,
    py: usize,
) -> BorderRect<AB, H> {
    debug_assert_eq!(AB, W + H);
    let mut above = [128i32; AB];
    let mut left = [128i32; H];
    let mut corner = 128i32;
    if py > 0 {
        let ay = py - 1;
        for (i, a) in above.iter_mut().enumerate() {
            *a = i32::from(recon[ay * w + (px + i).min(w - 1)]);
        }
    }
    if px > 0 {
        let ax = px - 1;
        for (i, l) in left.iter_mut().enumerate() {
            *l = i32::from(recon[(py + i).min(h - 1) * w + ax]);
        }
    }
    if px > 0 && py > 0 {
        corner = i32::from(recon[(py - 1) * w + px - 1]);
    }
    BorderRect {
        above,
        left,
        corner,
    }
}

/// Intra-предсказание прямоугольного блока — те же семь мод, что у
/// квадратов v7, с весами SMOOTH/DC по фактическим сторонам W и H.
fn predict_rect<const W: usize, const H: usize, const AB: usize, const LEN: usize>(
    b: &BorderRect<AB, H>,
    mode: u8,
) -> [i32; LEN] {
    debug_assert_eq!(LEN, W * H);
    let mut out = [0i32; LEN];
    match mode {
        MODE_V => {
            for y in 0..H {
                out[y * W..y * W + W].copy_from_slice(&b.above[0..W]);
            }
        }
        MODE_H => {
            for y in 0..H {
                out[y * W..y * W + W].copy_from_slice(&[b.left[y]; W]);
            }
        }
        MODE_TM => {
            for y in 0..H {
                for x in 0..W {
                    out[y * W + x] = (b.left[y] + b.above[x] - b.corner).clamp(0, 255);
                }
            }
        }
        MODE_D45 => {
            for y in 0..H {
                for x in 0..W {
                    let s = x + y;
                    let (a0, a1, a2) = (b.above[s], b.above[s + 1], b.above[(s + 2).min(AB - 1)]);
                    out[y * W + x] = (a0 + 2 * a1 + a2 + 2) >> 2;
                }
            }
        }
        MODE_D135 => {
            // Опорный ряд: left[H-1..0], corner, above[0..W] (длина AB+1 ≤ 49).
            let mut line = [0i32; 64];
            for (j, slot) in line[0..H].iter_mut().enumerate() {
                *slot = b.left[H - 1 - j];
            }
            line[H] = b.corner;
            line[H + 1..H + 1 + W].copy_from_slice(&b.above[0..W]);
            for y in 0..H {
                for x in 0..W {
                    let d = H + x - y;
                    out[y * W + x] = (line[d - 1] + 2 * line[d] + line[d + 1] + 2) >> 2;
                }
            }
        }
        MODE_SMOOTH => {
            for y in 0..H {
                for x in 0..W {
                    let vertical = ((H - 1 - y) as i32 * b.above[x]
                        + (y + 1) as i32 * b.left[H - 1]
                        + H as i32 / 2)
                        / H as i32;
                    let horizontal = ((W - 1 - x) as i32 * b.left[y]
                        + (x + 1) as i32 * b.above[W - 1]
                        + W as i32 / 2)
                        / W as i32;
                    out[y * W + x] = (vertical + horizontal + 1) >> 1;
                }
            }
        }
        _ => {
            let sum: i32 = b.above[0..W].iter().sum::<i32>() + b.left.iter().sum::<i32>();
            let dc = (sum + (W + H) as i32 / 2) / (W + H) as i32;
            out.fill(dc);
        }
    }
    out
}

fn gather_rect_i32<const W: usize, const H: usize, const LEN: usize>(
    buf: &[i16],
    w: usize,
    h: usize,
    px: usize,
    py: usize,
) -> [i32; LEN] {
    debug_assert_eq!(LEN, W * H);
    let mut block = [0i32; LEN];
    for y in 0..H {
        let sy = (py + y).min(h - 1);
        for x in 0..W {
            let sx = (px + x).min(w - 1);
            block[y * W + x] = i32::from(buf[sy * w + sx]);
        }
    }
    block
}

fn store_rect<const W: usize, const H: usize, const LEN: usize>(
    recon: &mut [i16],
    w: usize,
    h: usize,
    px: usize,
    py: usize,
    residual: &[f32; LEN],
    pred: &[i32; LEN],
) {
    for y in 0..H {
        let sy = py + y;
        if sy >= h {
            break;
        }
        for x in 0..W {
            let sx = px + x;
            if sx >= w {
                break;
            }
            let v = (residual[y * W + x] + pred[y * W + x] as f32)
                .round()
                .clamp(0.0, 255.0);
            recon[sy * w + sx] = v as i16;
        }
    }
}

/// Лист дерева v8: мода, transform и квантованные уровни.
struct LeafV8<const LEN: usize> {
    mode: u8,
    tx: u8,
    quantized: [i32; LEN],
}

/// Прямоугольные листы гейтятся: полный RD проходят только 2 моды.
const RD_CANDIDATES_RECT: usize = 2;

/// Выбор моды прямоугольного листа: SAD-предотбор, полный DCT на
/// кандидатах (структурных аналитических спектров для rect нет — листы
/// уже отфильтрованы гейтом анизотропии, объём работы ограничен).
#[allow(clippy::too_many_arguments)]
fn choose_mode_rect<const W: usize, const H: usize, const AB: usize, const LEN: usize>(
    orig: &[i32; LEN],
    b: &BorderRect<AB, H>,
    cfl_luma: Option<&[i32; LEN]>,
    qmat: &[u16; LEN],
    lambda: f32,
    forward: fn(&[f32; LEN], &mut [f32; LEN], u8),
    scan: &'static [usize; LEN],
) -> (u8, [i32; LEN], [i32; LEN], f32) {
    let mut sads: Vec<(u8, u64)> = Vec::with_capacity(usize::from(N_MODES_V7));
    let mut preds = [[0i32; LEN]; N_MODES_V7 as usize];
    for &mode in ENCODE_MODES_V7 {
        let pred = predict_rect::<W, H, AB, LEN>(b, mode);
        let sad: u64 = orig
            .iter()
            .zip(pred.iter())
            .map(|(&o, &p)| u64::from(o.abs_diff(p)))
            .sum();
        preds[usize::from(mode)] = pred;
        sads.push((mode, sad));
    }
    if let Some(luma) = cfl_luma {
        let dc = predict_rect::<W, H, AB, LEN>(b, MODE_DC)[0];
        let mode = cfl_candidate_mode(orig, luma, dc);
        let pred = predict_cfl(luma, dc, mode);
        let sad = orig
            .iter()
            .zip(pred.iter())
            .map(|(&o, &p)| u64::from(o.abs_diff(p)))
            .sum();
        preds[usize::from(mode)] = pred;
        sads.push((mode, sad));
    }
    let candidates = preselect_modes::<RD_CANDIDATES_RECT>(&sads);
    let n_candidates = sads.len().min(RD_CANDIDATES_RECT);

    let mut spatial = [0f32; LEN];
    for i in 0..LEN {
        spatial[i] = orig[i] as f32;
    }
    let mut freq_orig = [0f32; LEN];
    forward(&spatial, &mut freq_orig, TX_DCT_DCT);
    let mut freq_pred = [0f32; LEN];
    let mut freq_res = [0f32; LEN];

    let mut best: Option<(u8, [i32; LEN], [i32; LEN], f32)> = None;
    for &mode in &candidates[..n_candidates] {
        let pred = preds[usize::from(mode)];
        for i in 0..LEN {
            spatial[i] = pred[i] as f32;
        }
        forward(&spatial, &mut freq_pred, TX_DCT_DCT);
        for i in 0..LEN {
            freq_res[i] = freq_orig[i] - freq_pred[i];
        }
        let (quantized, distortion) =
            quantize_freq_tx(&freq_res, qmat, AC_BIAS_V7, squared_quant_error);
        let cost = distortion + lambda * legacy_coeff_cost(&quantized, scan) as f32;
        if best.as_ref().is_none_or(|(_, _, _, old)| cost < *old) {
            best = Some((mode, pred, quantized, cost));
        }
    }
    best.expect("моды всегда есть")
}

/// Transform-поиск прямоугольного листа. Отличие от квадратов: bounded
/// trellis выполняется только для победившего DCT_DCT (v7.10 — trellis
/// на ADST-осях rect-листов не окупал время кодера).
#[allow(clippy::too_many_arguments)]
fn choose_transform_rect<const LEN: usize>(
    orig: &[i32; LEN],
    pred: &[i32; LEN],
    qmat: &[u16; LEN],
    lambda: f32,
    baseline_quantized: [i32; LEN],
    baseline_cost: f32,
    forward: fn(&[f32; LEN], &mut [f32; LEN], u8),
    scan_for_tx: fn(u8) -> &'static [usize; LEN],
) -> (u8, [i32; LEN], f32) {
    let mut residual = [0f32; LEN];
    for i in 0..LEN {
        residual[i] = (orig[i] - pred[i]) as f32;
    }
    let base_rate = legacy_coeff_cost(&baseline_quantized, scan_for_tx(TX_DCT_DCT));
    let base_distortion = baseline_cost - lambda * base_rate as f32;
    // (tx, quantized, полная стоимость, поисковая метрика = distortion).
    let mut best = (
        TX_DCT_DCT,
        baseline_quantized,
        baseline_cost,
        base_distortion,
    );
    let mut freq = [0f32; LEN];
    for &tx in ENCODE_TXS_V7 {
        forward(&residual, &mut freq, tx);
        let (quantized, distortion) =
            quantize_freq_tx(&freq, qmat, AC_BIAS_V7, squared_quant_error);
        if distortion < best.3 {
            let rate = legacy_coeff_cost(&quantized, scan_for_tx(tx)) + tx_rate_extra_bits(tx);
            best = (tx, quantized, distortion + lambda * rate as f32, distortion);
        }
    }
    if best.0 != TX_DCT_DCT {
        return (best.0, best.1, best.2);
    }
    forward(&residual, &mut freq, TX_DCT_DCT);
    let scan = scan_for_tx(TX_DCT_DCT);
    let (quantized, distortion) =
        trellis_rdoq(&freq, qmat, best.1, lambda, scan, squared_quant_error);
    let rate = legacy_coeff_cost(&quantized, scan);
    (TX_DCT_DCT, quantized, distortion + lambda * rate as f32)
}

/// Полная оценка прямоугольного листа: мода → transform → реконструкция
/// нормативным восстановлением v8 (записывает `recon`).
#[allow(clippy::too_many_arguments)]
fn eval_rect_leaf<const W: usize, const H: usize, const AB: usize, const LEN: usize>(
    buf: &[i16],
    recon: &mut [i16],
    cfl_luma: Option<&[i16]>,
    w: usize,
    h: usize,
    px: usize,
    py: usize,
    qmat: &[u16; LEN],
    lambda: f32,
    forward: fn(&[f32; LEN], &mut [f32; LEN], u8),
    inverse: fn(&[f32; LEN], &mut [f32; LEN], u8),
    scan_for_tx: fn(u8) -> &'static [usize; LEN],
) -> (LeafV8<LEN>, f32) {
    let orig = gather_rect_i32::<W, H, LEN>(buf, w, h, px, py);
    let cfl_block = cfl_luma.map(|luma| gather_rect_i32::<W, H, LEN>(luma, w, h, px, py));
    let b = border_rect::<W, H, AB>(recon, w, h, px, py);
    let (mode, pred, quantized, cost) = choose_mode_rect::<W, H, AB, LEN>(
        &orig,
        &b,
        cfl_block.as_ref(),
        qmat,
        lambda,
        forward,
        scan_for_tx(TX_DCT_DCT),
    );
    let (tx, quantized, cost) = choose_transform_rect(
        &orig,
        &pred,
        qmat,
        lambda,
        quantized,
        cost,
        forward,
        scan_for_tx,
    );
    let freq = fill_freq_v8(&quantized, qmat);
    let mut spatial = [0f32; LEN];
    inverse(&freq, &mut spatial, tx);
    store_rect::<W, H, LEN>(recon, w, h, px, py, &spatial, &pred);
    (
        LeafV8 {
            mode,
            tx,
            quantized,
        },
        cost + lambda * (MODE_COST_BITS + TX_COST_BITS) as f32,
    )
}

/// Повторная реконструкция листа из решения кодера (после отката recon
/// к состоянию оценки границы совпадают — результат идентичен eval).
#[allow(clippy::too_many_arguments)]
fn apply_rect_leaf<const W: usize, const H: usize, const AB: usize, const LEN: usize>(
    recon: &mut [i16],
    cfl_luma: Option<&[i16]>,
    w: usize,
    h: usize,
    px: usize,
    py: usize,
    leaf: &LeafV8<LEN>,
    qmat: &[u16; LEN],
    inverse: fn(&[f32; LEN], &mut [f32; LEN], u8),
) {
    let b = border_rect::<W, H, AB>(recon, w, h, px, py);
    let pred = if cfl_alpha_q4(leaf.mode).is_some() {
        let luma =
            gather_rect_i32::<W, H, LEN>(cfl_luma.expect("CfL mode requires luma"), w, h, px, py);
        predict_cfl(
            &luma,
            predict_rect::<W, H, AB, LEN>(&b, MODE_DC)[0],
            leaf.mode,
        )
    } else {
        predict_rect::<W, H, AB, LEN>(&b, leaf.mode)
    };
    let freq = fill_freq_v8(&leaf.quantized, qmat);
    let mut spatial = [0f32; LEN];
    inverse(&freq, &mut spatial, leaf.tx);
    store_rect::<W, H, LEN>(recon, w, h, px, py, &spatial, &pred);
}

// --- гейт анизотропии (свобода кодера) -------------------------------------------

/// Минимальный профильный контраст, при котором rect-кандидат имеет смысл.
const RECT_MIN_PROFILE: f32 = 3.0;
/// Во сколько раз доминирующее направление должно превосходить второе.
const RECT_ANISO_RATIO: f32 = 1.5;

/// Профильная анизотропия квадрата N×N: MAD средних строк против MAD
/// средних столбцов. Направленный rect-кандидат пробуется только при
/// выраженной односторонней структуре — RD-gated shortlist v7.10,
/// удержавший скорость кодера у порога 10 Мп/с.
fn rect_hint<const N: usize, const LEN: usize>(orig: &[i32; LEN]) -> Option<u8> {
    debug_assert_eq!(LEN, N * N);
    let mut row_means = [0i32; N];
    let mut col_sums = [0i32; N];
    for y in 0..N {
        let mut sum = 0i32;
        for x in 0..N {
            let v = orig[y * N + x];
            sum += v;
            col_sums[x] += v;
        }
        row_means[y] = sum / N as i32;
    }
    let mad = |means: &[i32; N]| -> f32 {
        let mean = means.iter().sum::<i32>() / N as i32;
        means.iter().map(|&v| (v - mean).abs()).sum::<i32>() as f32 / N as f32
    };
    let mut col_means = [0i32; N];
    for x in 0..N {
        col_means[x] = col_sums[x] / N as i32;
    }
    // Вертикальная структура (строки различны) → HORZ; горизонтальная → VERT.
    let profile_v = mad(&row_means);
    let profile_h = mad(&col_means);
    if profile_v.max(profile_h) < RECT_MIN_PROFILE {
        return None;
    }
    if profile_v >= RECT_ANISO_RATIO * profile_h {
        Some(SPLIT4_HORZ)
    } else if profile_h >= RECT_ANISO_RATIO * profile_v {
        Some(SPLIT4_VERT)
    } else {
        None
    }
}

// --- матрицы квантования плоскости ------------------------------------------------

/// Все производные матрицы одной плоскости (из 8×8 базы) + лагранжиан.
struct PlaneQmatsV8 {
    q4: [u16; 16],
    q8: [u16; 64],
    q16: [u16; 256],
    q32: [u16; 1024],
    q32x16: [u16; 512],
    q16x32: [u16; 512],
    q16x8: [u16; 128],
    q8x16: [u16; 128],
    lambda: f32,
}

impl PlaneQmatsV8 {
    fn new(qmat8: &[u16; 64]) -> Box<Self> {
        Box::new(Self {
            q4: quant_matrix4(qmat8),
            q8: *qmat8,
            q16: quant_matrix16(qmat8),
            q32: quant_matrix32(qmat8),
            q32x16: quant_matrix_rect::<32, 16, 512>(qmat8),
            q16x32: quant_matrix_rect::<16, 32, 512>(qmat8),
            q16x8: quant_matrix_rect::<16, 8, 128>(qmat8),
            q8x16: quant_matrix_rect::<8, 16, 128>(qmat8),
            lambda: plane_lambda(qmat8),
        })
    }
}

// --- грубые битовые цены сплитов (RD-модель кодера) -------------------------------

/// Цена WHOLE/QUAD-решения четверичного split (prior 4/10).
const SPLIT_COST_BITS_V8: u32 = 1;
/// Цена HORZ/VERT-решения (prior 1/10 — сигнал дороже).
const RECT_COST_BITS_V8: u32 = 3;
/// Компенсация недооценённой цены четырёх DC/мод при split8 (как v7).
const SPLIT8_EXTRA_BITS_V8: u32 = 4;

// --- дерево: листья 4×4 и узлы 8×8 -------------------------------------------------

#[allow(clippy::large_enum_variant)]
enum Node8V8 {
    Whole(LeafV8<64>),
    Split { subs: Vec<LeafV8<16>> },
}

#[allow(clippy::too_many_arguments)]
fn eval_block4_v8(
    buf: &[i16],
    recon: &mut [i16],
    cfl_luma: Option<&[i16]>,
    w: usize,
    h: usize,
    qx: usize,
    qy: usize,
    qm: &PlaneQmatsV8,
) -> (LeafV8<16>, f32) {
    let orig = gather_block4_i32(buf, w, h, qx, qy);
    let cfl_block = cfl_luma.map(|luma| gather_block4_i32(luma, w, h, qx, qy));
    let b = border4(recon, w, h, qx, qy);
    let (mode, pred, quantized, cost) =
        choose_mode4(&orig, &b, cfl_block.as_ref(), &qm.q4, qm.lambda, AC_BIAS_V7);
    let (tx, quantized, cost) = choose_transform(
        &orig,
        &pred,
        &qm.q4,
        qm.lambda,
        AC_BIAS_V7,
        quantized,
        cost,
        forward_tx4,
        tx_scan4,
        squared_quant_error,
    );
    let freq = fill_freq_v8(&quantized, &qm.q4);
    let mut spatial = [0f32; 16];
    inverse_tx4(&freq, &mut spatial, tx);
    store_block4(recon, w, h, qx, qy, &spatial, &pred);
    (
        LeafV8 {
            mode,
            tx,
            quantized,
        },
        cost + qm.lambda * (MODE_COST_BITS + TX_COST_BITS) as f32,
    )
}

#[allow(clippy::too_many_arguments)]
fn reconstruct8_v8(
    recon: &mut [i16],
    w: usize,
    h: usize,
    bx: usize,
    by: usize,
    quantized: &[i32; 64],
    qmat: &[u16; 64],
    tx: u8,
    pred: &[i32; 64],
) {
    let freq = fill_freq_v8(quantized, qmat);
    let mut spatial = [0f32; 64];
    inverse_tx8(&freq, &mut spatial, tx);
    store_block(recon, w, h, bx, by, &spatial, pred);
}

#[allow(clippy::too_many_arguments)]
fn eval_node8_v8(
    buf: &[i16],
    recon: &mut [i16],
    cfl_luma: Option<&[i16]>,
    w: usize,
    h: usize,
    bx: usize,
    by: usize,
    qm: &PlaneQmatsV8,
) -> (Node8V8, f32) {
    let orig = gather_block_i32(buf, w, h, bx, by);
    let hint = split_hint8(&orig);
    let partial = (bx + 1) * 8 > w || (by + 1) * 8 > h;
    let lambda = qm.lambda;

    if !partial && hint == Some(SPLIT_QUAD) {
        let mut subs = Vec::with_capacity(4);
        let mut split_cost = 0f32;
        for (qx, qy) in child_blocks4(bx, by, w, h) {
            let (sub, cost) = eval_block4_v8(buf, recon, cfl_luma, w, h, qx, qy, qm);
            subs.push(sub);
            split_cost += cost;
        }
        return (
            Node8V8::Split { subs },
            split_cost + lambda * (SPLIT_COST_BITS_V8 + SPLIT8_EXTRA_BITS_V8) as f32,
        );
    }

    let b = border(recon, w, h, bx, by);
    let cfl_block = cfl_luma.map(|luma| gather_block_i32(luma, w, h, bx, by));
    let (mode, pred, quantized, whole_base) = choose_mode_v7(
        &orig,
        &b,
        cfl_block.as_ref(),
        &qm.q8,
        lambda,
        mode_limit_v7(cfl_luma.is_some()),
        AC_BIAS_V7,
    );
    let (tx, quantized, whole_base) = choose_transform(
        &orig,
        &pred,
        &qm.q8,
        lambda,
        AC_BIAS_V7,
        quantized,
        whole_base,
        forward_tx8,
        tx_scan8,
        squared_quant_error,
    );
    let whole_cost = whole_base + lambda * (MODE_COST_BITS + TX_COST_BITS) as f32;

    if partial || hint == Some(SPLIT_WHOLE) {
        reconstruct8_v8(recon, w, h, bx, by, &quantized, &qm.q8, tx, &pred);
        return (
            Node8V8::Whole(LeafV8 {
                mode,
                tx,
                quantized,
            }),
            whole_cost + lambda * SPLIT_COST_BITS_V8 as f32,
        );
    }

    let backup = save_region8(recon, w, h, bx, by);
    let mut subs = Vec::with_capacity(4);
    let mut split_cost = 0f32;
    for (qx, qy) in child_blocks4(bx, by, w, h) {
        let (sub, cost) = eval_block4_v8(buf, recon, cfl_luma, w, h, qx, qy, qm);
        subs.push(sub);
        split_cost += cost;
        if split_cost + lambda * SPLIT8_EXTRA_BITS_V8 as f32 > whole_cost {
            break;
        }
    }
    let adjusted_split_cost = split_cost + lambda * SPLIT8_EXTRA_BITS_V8 as f32;

    if whole_cost <= adjusted_split_cost {
        restore_region8(recon, w, h, bx, by, &backup);
        reconstruct8_v8(recon, w, h, bx, by, &quantized, &qm.q8, tx, &pred);
        (
            Node8V8::Whole(LeafV8 {
                mode,
                tx,
                quantized,
            }),
            whole_cost + lambda * SPLIT_COST_BITS_V8 as f32,
        )
    } else {
        (
            Node8V8::Split { subs },
            adjusted_split_cost + lambda * SPLIT_COST_BITS_V8 as f32,
        )
    }
}

// --- дерево: узлы 16×16 ------------------------------------------------------------

#[allow(clippy::large_enum_variant)]
enum Node16V8 {
    Whole {
        mode: u8,
        tx: u8,
        quantized: [i32; 256],
    },
    /// direction ∈ {SPLIT4_HORZ, SPLIT4_VERT}; листы в нормативном порядке.
    Rect {
        direction: u8,
        leaves: Box<[LeafV8<128>; 2]>,
    },
    Quad {
        nodes: Vec<Node8V8>,
    },
}

#[allow(clippy::too_many_arguments)]
fn reconstruct16_v8(
    recon: &mut [i16],
    w: usize,
    h: usize,
    sbx: usize,
    sby: usize,
    quantized: &[i32; 256],
    qmat16: &[u16; 256],
    tx: u8,
    pred: &[i32; 256],
) {
    let freq = fill_freq_v8(quantized, qmat16);
    let mut spatial = [0f32; 256];
    inverse_tx16(&freq, &mut spatial, tx);
    store_block16(recon, w, h, sbx, sby, &spatial, pred);
}

/// Оценивает пару rect-листов узла 16 (пишет recon; вызывающий откатывает).
#[allow(clippy::too_many_arguments)]
fn eval_rect_pair16(
    buf: &[i16],
    recon: &mut [i16],
    cfl_luma: Option<&[i16]>,
    w: usize,
    h: usize,
    sbx: usize,
    sby: usize,
    direction: u8,
    qm: &PlaneQmatsV8,
) -> (Box<[LeafV8<128>; 2]>, f32) {
    let (px, py) = (sbx * 16, sby * 16);
    let (first, second) = if direction == SPLIT4_HORZ {
        let (a, ca) = eval_rect_leaf::<16, 8, 24, 128>(
            buf,
            recon,
            cfl_luma,
            w,
            h,
            px,
            py,
            &qm.q16x8,
            qm.lambda,
            forward_tx_16x8,
            inverse_tx_16x8,
            scan_16x8,
        );
        let (b, cb) = eval_rect_leaf::<16, 8, 24, 128>(
            buf,
            recon,
            cfl_luma,
            w,
            h,
            px,
            py + 8,
            &qm.q16x8,
            qm.lambda,
            forward_tx_16x8,
            inverse_tx_16x8,
            scan_16x8,
        );
        ((a, ca), (b, cb))
    } else {
        let (a, ca) = eval_rect_leaf::<8, 16, 24, 128>(
            buf,
            recon,
            cfl_luma,
            w,
            h,
            px,
            py,
            &qm.q8x16,
            qm.lambda,
            forward_tx_8x16,
            inverse_tx_8x16,
            scan_8x16,
        );
        let (b, cb) = eval_rect_leaf::<8, 16, 24, 128>(
            buf,
            recon,
            cfl_luma,
            w,
            h,
            px + 8,
            py,
            &qm.q8x16,
            qm.lambda,
            forward_tx_8x16,
            inverse_tx_8x16,
            scan_8x16,
        );
        ((a, ca), (b, cb))
    };
    let cost = first.1 + second.1;
    (Box::new([first.0, second.0]), cost)
}

/// Повторная реконструкция rect-пары узла 16 из решения кодера.
#[allow(clippy::too_many_arguments)]
fn apply_rect_pair16(
    recon: &mut [i16],
    cfl_luma: Option<&[i16]>,
    w: usize,
    h: usize,
    sbx: usize,
    sby: usize,
    direction: u8,
    leaves: &[LeafV8<128>; 2],
    qm: &PlaneQmatsV8,
) {
    let (px, py) = (sbx * 16, sby * 16);
    if direction == SPLIT4_HORZ {
        apply_rect_leaf::<16, 8, 24, 128>(
            recon,
            cfl_luma,
            w,
            h,
            px,
            py,
            &leaves[0],
            &qm.q16x8,
            inverse_tx_16x8,
        );
        apply_rect_leaf::<16, 8, 24, 128>(
            recon,
            cfl_luma,
            w,
            h,
            px,
            py + 8,
            &leaves[1],
            &qm.q16x8,
            inverse_tx_16x8,
        );
    } else {
        apply_rect_leaf::<8, 16, 24, 128>(
            recon,
            cfl_luma,
            w,
            h,
            px,
            py,
            &leaves[0],
            &qm.q8x16,
            inverse_tx_8x16,
        );
        apply_rect_leaf::<8, 16, 24, 128>(
            recon,
            cfl_luma,
            w,
            h,
            px + 8,
            py,
            &leaves[1],
            &qm.q8x16,
            inverse_tx_8x16,
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn eval_node16_v8(
    buf: &[i16],
    recon: &mut [i16],
    cfl_luma: Option<&[i16]>,
    w: usize,
    h: usize,
    sbx: usize,
    sby: usize,
    qm: &PlaneQmatsV8,
) -> (Node16V8, f32) {
    let orig16 = gather_block16_i32(buf, w, h, sbx, sby);
    let hint = split_hint(&orig16);
    let partial = (sbx + 1) * 16 > w || (sby + 1) * 16 > h;
    let lambda = qm.lambda;

    let eval_whole = |recon: &mut [i16]| {
        let b = border16(recon, w, h, sbx, sby);
        let cfl_block = cfl_luma.map(|luma| gather_block16_i32(luma, w, h, sbx, sby));
        let (mode, pred, quantized, cost) = choose_mode16_v7(
            &orig16,
            &b,
            cfl_block.as_ref(),
            &qm.q16,
            lambda,
            mode_limit_v7(cfl_luma.is_some()),
            AC_BIAS_V7,
        );
        let (tx, quantized, cost) = choose_transform(
            &orig16,
            &pred,
            &qm.q16,
            lambda,
            AC_BIAS_V7,
            quantized,
            cost,
            forward_tx16,
            tx_scan16,
            squared_quant_error,
        );
        (mode, tx, pred, quantized, cost)
    };

    if hint == Some(SPLIT_WHOLE) {
        let (mode, tx, pred, quantized, cost) = eval_whole(recon);
        reconstruct16_v8(recon, w, h, sbx, sby, &quantized, &qm.q16, tx, &pred);
        return (
            Node16V8::Whole {
                mode,
                tx,
                quantized,
            },
            cost + lambda * (MODE_COST_BITS + TX_COST_BITS + SPLIT_COST_BITS_V8) as f32,
        );
    }

    if hint == Some(SPLIT_QUAD) {
        let mut nodes = Vec::with_capacity(4);
        let mut cost = 0f32;
        for (bx, by) in sub_blocks(sbx, sby, w, h) {
            let (node, node_cost) = eval_node8_v8(buf, recon, cfl_luma, w, h, bx, by, qm);
            nodes.push(node);
            cost += node_cost;
        }
        return (
            Node16V8::Quad { nodes },
            cost + lambda * SPLIT_COST_BITS_V8 as f32,
        );
    }

    let (mode, tx, pred, quantized, whole_base) = eval_whole(recon);
    let whole_cost =
        whole_base + lambda * (MODE_COST_BITS + TX_COST_BITS + SPLIT_COST_BITS_V8) as f32;
    let backup = save_region16(recon, w, h, sbx, sby);

    // Направленный rect-кандидат: только при выраженной анизотропии и
    // только полностью лежащий в изображении узел.
    let mut rect: Option<(u8, Box<[LeafV8<128>; 2]>)> = None;
    let mut rect_cost = f32::INFINITY;
    if !partial && let Some(direction) = rect_hint::<16, 256>(&orig16) {
        let (leaves, cost) = eval_rect_pair16(buf, recon, cfl_luma, w, h, sbx, sby, direction, qm);
        restore_region16(recon, w, h, sbx, sby, &backup);
        rect_cost = cost + lambda * RECT_COST_BITS_V8 as f32;
        rect = Some((direction, leaves));
    }

    let cap = whole_cost.min(rect_cost);
    let mut nodes = Vec::with_capacity(4);
    let mut split_cost = 0f32;
    let mut split_complete = true;
    for (bx, by) in sub_blocks(sbx, sby, w, h) {
        let (node, node_cost) = eval_node8_v8(buf, recon, cfl_luma, w, h, bx, by, qm);
        nodes.push(node);
        split_cost += node_cost;
        if split_cost > cap {
            split_complete = false;
            break;
        }
    }
    let quad_cost = split_cost + lambda * SPLIT_COST_BITS_V8 as f32;

    if split_complete && quad_cost < cap {
        return (Node16V8::Quad { nodes }, quad_cost);
    }
    restore_region16(recon, w, h, sbx, sby, &backup);
    if let Some((direction, leaves)) = rect
        && rect_cost < whole_cost
    {
        apply_rect_pair16(recon, cfl_luma, w, h, sbx, sby, direction, &leaves, qm);
        return (Node16V8::Rect { direction, leaves }, rect_cost);
    }
    reconstruct16_v8(recon, w, h, sbx, sby, &quantized, &qm.q16, tx, &pred);
    (
        Node16V8::Whole {
            mode,
            tx,
            quantized,
        },
        whole_cost,
    )
}

// --- эмиссия символов --------------------------------------------------------------

fn emit_node8_v8(node: &Node8V8, st: &mut CtxV8, syms: &mut Vec<(u16, u8)>, raw: &mut BitWriter) {
    match node {
        Node8V8::Whole(leaf) => {
            syms.push((CTX8_SPLIT8, SPLIT_WHOLE));
            syms.push((CTX8_MODE, leaf.mode));
            syms.push((CTX8_TX, leaf.tx));
            encode_coeffs_v8(&leaf.quantized, leaf.tx, &LAYOUT8, st, syms, raw);
        }
        Node8V8::Split { subs } => {
            syms.push((CTX8_SPLIT8, SPLIT_QUAD));
            for sub in subs {
                syms.push((CTX8_MODE, sub.mode));
                syms.push((CTX8_TX, sub.tx));
                encode_coeffs_v8(&sub.quantized, sub.tx, &LAYOUT4, st, syms, raw);
            }
        }
    }
}

fn emit_node16_v8(node: &Node16V8, st: &mut CtxV8, syms: &mut Vec<(u16, u8)>, raw: &mut BitWriter) {
    match node {
        Node16V8::Whole {
            mode,
            tx,
            quantized,
        } => {
            syms.push((CTX8_SPLIT16, SPLIT4_WHOLE));
            syms.push((CTX8_MODE, *mode));
            syms.push((CTX8_TX, *tx));
            encode_coeffs_v8(quantized, *tx, &LAYOUT16, st, syms, raw);
        }
        Node16V8::Rect { direction, leaves } => {
            syms.push((CTX8_SPLIT16, *direction));
            let layout = if *direction == SPLIT4_HORZ {
                &LAYOUT_16X8
            } else {
                &LAYOUT_8X16
            };
            for leaf in leaves.iter() {
                syms.push((CTX8_MODE, leaf.mode));
                syms.push((CTX8_TX, leaf.tx));
                encode_coeffs_v8(&leaf.quantized, leaf.tx, layout, st, syms, raw);
            }
        }
        Node16V8::Quad { nodes } => {
            syms.push((CTX8_SPLIT16, SPLIT4_QUAD));
            for node in nodes {
                emit_node8_v8(node, st, syms, raw);
            }
        }
    }
}

// --- кодер плоскости ----------------------------------------------------------------

/// Кодирует дерево тайл-плоскости битстрима v8. `qmat` — 8×8 база
/// плоскости (Y/Co/Cg различаются). Возвращает реконструкцию для CfL/CDEF.
pub fn encode_tile_plane_v8(
    buf: &[i16],
    cfl_luma: Option<&[i16]>,
    w: usize,
    h: usize,
    qmat: &[u16; 64],
    syms: &mut Vec<(u16, u8)>,
    raw: &mut BitWriter,
) -> Vec<i16> {
    debug_assert_eq!(buf.len(), w * h);
    debug_assert!(cfl_luma.is_none_or(|luma| luma.len() == w * h));
    let qm = PlaneQmatsV8::new(qmat);
    let lambda = qm.lambda;
    let root_cols = w.div_ceil(32);
    let root_rows = h.div_ceil(32);
    let mut recon = vec![0i16; w * h];
    let mut st = CtxV8::default();

    for ry in 0..root_rows {
        for rx in 0..root_cols {
            // Неполный корень всегда раскрывается (как v7): сравнение
            // DCT32 на реплицированном краю было бы смещено.
            let partial = (rx + 1) * 32 > w || (ry + 1) * 32 > h;
            let quad_children = |recon: &mut Vec<i16>,
                                 st: &mut CtxV8,
                                 syms: &mut Vec<(u16, u8)>,
                                 raw: &mut BitWriter| {
                syms.push((CTX8_SPLIT32, SPLIT4_QUAD));
                for (sbx, sby) in child_nodes16(rx, ry, w, h) {
                    let (node, _) = eval_node16_v8(buf, recon, cfl_luma, w, h, sbx, sby, &qm);
                    emit_node16_v8(&node, st, syms, raw);
                }
            };
            if partial {
                quad_children(&mut recon, &mut st, syms, raw);
                continue;
            }

            let orig32 = gather_block32_i32(buf, w, h, rx, ry);
            let hint = split_hint32(&orig32);
            if hint == Some(SPLIT_QUAD) {
                quad_children(&mut recon, &mut st, syms, raw);
                continue;
            }

            let b32 = border32(&recon, w, h, rx, ry);
            let cfl_block = cfl_luma.map(|luma| gather_block32_i32(luma, w, h, rx, ry));
            let (mode32, pred32, quant32, cost32) = choose_mode32(
                &orig32,
                &b32,
                cfl_block.as_ref(),
                &qm.q32,
                lambda,
                AC_BIAS_V7,
            );
            let (tx32, quant32, cost32) = choose_transform(
                &orig32,
                pred32.as_ref(),
                &qm.q32,
                lambda,
                AC_BIAS_V7,
                *quant32,
                cost32,
                forward_tx32,
                tx_scan32,
                squared_quant_error,
            );
            let emit_whole32 = |quant32: &[i32; 1024],
                                st: &mut CtxV8,
                                syms: &mut Vec<(u16, u8)>,
                                raw: &mut BitWriter| {
                syms.push((CTX8_SPLIT32, SPLIT4_WHOLE));
                syms.push((CTX8_MODE, mode32));
                syms.push((CTX8_TX, tx32));
                encode_coeffs_v8(quant32, tx32, &LAYOUT32, st, syms, raw);
            };
            let reconstruct32 = |recon: &mut Vec<i16>, quant32: &[i32; 1024]| {
                let freq = fill_freq_v8(quant32, &qm.q32);
                let mut spatial = Box::new([0f32; 1024]);
                inverse_tx32(&freq, &mut spatial, tx32);
                store_block32(recon, w, h, rx, ry, &spatial, &pred32);
            };

            if hint == Some(SPLIT_WHOLE) {
                reconstruct32(&mut recon, &quant32);
                emit_whole32(&quant32, &mut st, syms, raw);
                continue;
            }

            let whole_cost =
                cost32 + lambda * (MODE_COST_BITS + TX_COST_BITS + SPLIT_COST_BITS_V8) as f32;
            let backup = save_region32(&recon, w, h, rx, ry);

            let mut rect: Option<(u8, Box<[LeafV8<512>; 2]>)> = None;
            let mut rect_cost = f32::INFINITY;
            if let Some(direction) = rect_hint::<32, 1024>(&orig32) {
                let (px, py) = (rx * 32, ry * 32);
                let (leaves, cost) = if direction == SPLIT4_HORZ {
                    let (a, ca) = eval_rect_leaf::<32, 16, 48, 512>(
                        buf,
                        &mut recon,
                        cfl_luma,
                        w,
                        h,
                        px,
                        py,
                        &qm.q32x16,
                        lambda,
                        forward_tx_32x16,
                        inverse_tx_32x16,
                        scan_32x16,
                    );
                    let (b, cb) = eval_rect_leaf::<32, 16, 48, 512>(
                        buf,
                        &mut recon,
                        cfl_luma,
                        w,
                        h,
                        px,
                        py + 16,
                        &qm.q32x16,
                        lambda,
                        forward_tx_32x16,
                        inverse_tx_32x16,
                        scan_32x16,
                    );
                    (Box::new([a, b]), ca + cb)
                } else {
                    let (a, ca) = eval_rect_leaf::<16, 32, 48, 512>(
                        buf,
                        &mut recon,
                        cfl_luma,
                        w,
                        h,
                        px,
                        py,
                        &qm.q16x32,
                        lambda,
                        forward_tx_16x32,
                        inverse_tx_16x32,
                        scan_16x32,
                    );
                    let (b, cb) = eval_rect_leaf::<16, 32, 48, 512>(
                        buf,
                        &mut recon,
                        cfl_luma,
                        w,
                        h,
                        px + 16,
                        py,
                        &qm.q16x32,
                        lambda,
                        forward_tx_16x32,
                        inverse_tx_16x32,
                        scan_16x32,
                    );
                    (Box::new([a, b]), ca + cb)
                };
                restore_region32(&mut recon, w, h, rx, ry, &backup);
                rect_cost = cost + lambda * RECT_COST_BITS_V8 as f32;
                rect = Some((direction, leaves));
            }

            let cap = whole_cost.min(rect_cost);
            let mut nodes = Vec::with_capacity(4);
            let mut split_cost = 0f32;
            let mut split_complete = true;
            for (sbx, sby) in child_nodes16(rx, ry, w, h) {
                let (node, cost) = eval_node16_v8(buf, &mut recon, cfl_luma, w, h, sbx, sby, &qm);
                nodes.push(node);
                split_cost += cost;
                if split_cost > cap {
                    split_complete = false;
                    break;
                }
            }
            let quad_cost = split_cost + lambda * SPLIT_COST_BITS_V8 as f32;

            if split_complete && quad_cost < cap {
                syms.push((CTX8_SPLIT32, SPLIT4_QUAD));
                for node in &nodes {
                    emit_node16_v8(node, &mut st, syms, raw);
                }
                continue;
            }
            restore_region32(&mut recon, w, h, rx, ry, &backup);
            if let Some((direction, leaves)) = rect
                && rect_cost < whole_cost
            {
                let (px, py) = (rx * 32, ry * 32);
                syms.push((CTX8_SPLIT32, direction));
                if direction == SPLIT4_HORZ {
                    for (i, leaf) in leaves.iter().enumerate() {
                        apply_rect_leaf::<32, 16, 48, 512>(
                            &mut recon,
                            cfl_luma,
                            w,
                            h,
                            px,
                            py + i * 16,
                            leaf,
                            &qm.q32x16,
                            inverse_tx_32x16,
                        );
                        syms.push((CTX8_MODE, leaf.mode));
                        syms.push((CTX8_TX, leaf.tx));
                        encode_coeffs_v8(
                            &leaf.quantized,
                            leaf.tx,
                            &LAYOUT_32X16,
                            &mut st,
                            syms,
                            raw,
                        );
                    }
                } else {
                    for (i, leaf) in leaves.iter().enumerate() {
                        apply_rect_leaf::<16, 32, 48, 512>(
                            &mut recon,
                            cfl_luma,
                            w,
                            h,
                            px + i * 16,
                            py,
                            leaf,
                            &qm.q16x32,
                            inverse_tx_16x32,
                        );
                        syms.push((CTX8_MODE, leaf.mode));
                        syms.push((CTX8_TX, leaf.tx));
                        encode_coeffs_v8(
                            &leaf.quantized,
                            leaf.tx,
                            &LAYOUT_16X32,
                            &mut st,
                            syms,
                            raw,
                        );
                    }
                }
                continue;
            }
            reconstruct32(&mut recon, &quant32);
            emit_whole32(&quant32, &mut st, syms, raw);
        }
    }
    recon
}

// --- декодер ------------------------------------------------------------------------

/// Декодирует лист square-размера LEN (mode + tx + коэффициенты) и
/// восстанавливает блок. `store` пишет пиксели по origin блока.
#[allow(clippy::too_many_arguments)]
fn decode_square_leaf_v8<const LEN: usize>(
    bank: &mut ModelBank,
    dec: &mut RangeDecoder<'_>,
    raw: &mut BitReader<'_>,
    st: &mut CtxV8,
    layout: &CoeffLayout<LEN>,
    qmat: &[u16; LEN],
    cfl: Option<&[i32; LEN]>,
    predict: &dyn Fn(u8) -> [i32; LEN],
    inverse: fn(&[f32; LEN], &mut [f32; LEN], u8),
) -> Result<([f32; LEN], [i32; LEN]), DecodeError> {
    let mode = bank.decode(dec, CTX8_MODE)?;
    if mode >= mode_limit_v7(cfl.is_some()) {
        return Err(DecodeError::Corrupt("v8: неизвестная мода предикции"));
    }
    let tx = bank.decode(dec, CTX8_TX)?;
    if tx >= N_TX_V7 {
        return Err(DecodeError::Corrupt("v8: неизвестный transform"));
    }
    let pred = if cfl_alpha_q4(mode).is_some() {
        let luma = cfl.expect("CfL проверен выше");
        predict_cfl(luma, predict(MODE_DC)[0], mode)
    } else {
        predict(mode)
    };
    let mut freq = [0f32; LEN];
    let dc = decode_coeffs_v8(bank, dec, raw, qmat, tx, layout, &mut freq, st)?;
    freq[0] = dc as f32 * f32::from(qmat[0]);
    let mut spatial = [0f32; LEN];
    inverse(&freq, &mut spatial, tx);
    Ok((spatial, pred))
}

/// Декодирует rect-лист и восстанавливает его в recon.
#[allow(clippy::too_many_arguments)]
fn decode_rect_leaf_v8<const W: usize, const H: usize, const AB: usize, const LEN: usize>(
    bank: &mut ModelBank,
    dec: &mut RangeDecoder<'_>,
    raw: &mut BitReader<'_>,
    recon: &mut [i16],
    cfl_luma: Option<&[i16]>,
    w: usize,
    h: usize,
    px: usize,
    py: usize,
    qmat: &[u16; LEN],
    layout: &CoeffLayout<LEN>,
    inverse: fn(&[f32; LEN], &mut [f32; LEN], u8),
    st: &mut CtxV8,
) -> Result<(), DecodeError> {
    let mode = bank.decode(dec, CTX8_MODE)?;
    if mode >= mode_limit_v7(cfl_luma.is_some()) {
        return Err(DecodeError::Corrupt("v8 rect: неизвестная мода предикции"));
    }
    let tx = bank.decode(dec, CTX8_TX)?;
    if tx >= N_TX_V7 {
        return Err(DecodeError::Corrupt("v8 rect: неизвестный transform"));
    }
    let b = border_rect::<W, H, AB>(recon, w, h, px, py);
    let pred = if cfl_alpha_q4(mode).is_some() {
        let luma = gather_rect_i32::<W, H, LEN>(cfl_luma.expect("CfL проверен выше"), w, h, px, py);
        predict_cfl(&luma, predict_rect::<W, H, AB, LEN>(&b, MODE_DC)[0], mode)
    } else {
        predict_rect::<W, H, AB, LEN>(&b, mode)
    };
    let mut freq = [0f32; LEN];
    let dc = decode_coeffs_v8(bank, dec, raw, qmat, tx, layout, &mut freq, st)?;
    freq[0] = dc as f32 * f32::from(qmat[0]);
    let mut spatial = [0f32; LEN];
    inverse(&freq, &mut spatial, tx);
    store_rect::<W, H, LEN>(recon, w, h, px, py, &spatial, &pred);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn decode_node8_v8(
    bank: &mut ModelBank,
    dec: &mut RangeDecoder<'_>,
    raw: &mut BitReader<'_>,
    recon: &mut [i16],
    cfl_luma: Option<&[i16]>,
    w: usize,
    h: usize,
    bx: usize,
    by: usize,
    qm: &PlaneQmatsV8,
    st: &mut CtxV8,
) -> Result<(), DecodeError> {
    match bank.decode(dec, CTX8_SPLIT8)? {
        SPLIT_WHOLE => {
            let b = border(recon, w, h, bx, by);
            let cfl = cfl_luma.map(|luma| gather_block_i32(luma, w, h, bx, by));
            let (spatial, pred) = decode_square_leaf_v8(
                bank,
                dec,
                raw,
                st,
                &LAYOUT8,
                &qm.q8,
                cfl.as_ref(),
                &|mode| predict_block(&b, mode),
                inverse_tx8,
            )?;
            store_block(recon, w, h, bx, by, &spatial, &pred);
        }
        SPLIT_QUAD => {
            for (qx, qy) in child_blocks4(bx, by, w, h) {
                let b = border4(recon, w, h, qx, qy);
                let cfl = cfl_luma.map(|luma| gather_block4_i32(luma, w, h, qx, qy));
                let (spatial, pred) = decode_square_leaf_v8(
                    bank,
                    dec,
                    raw,
                    st,
                    &LAYOUT4,
                    &qm.q4,
                    cfl.as_ref(),
                    &|mode| predict_block4(&b, mode),
                    inverse_tx4,
                )?;
                store_block4(recon, w, h, qx, qy, &spatial, &pred);
            }
        }
        _ => return Err(DecodeError::Corrupt("v8: неизвестное split8-решение")),
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn decode_node16_v8(
    bank: &mut ModelBank,
    dec: &mut RangeDecoder<'_>,
    raw: &mut BitReader<'_>,
    recon: &mut [i16],
    cfl_luma: Option<&[i16]>,
    w: usize,
    h: usize,
    sbx: usize,
    sby: usize,
    qm: &PlaneQmatsV8,
    st: &mut CtxV8,
) -> Result<(), DecodeError> {
    let (px, py) = (sbx * 16, sby * 16);
    let split = bank.decode(dec, CTX8_SPLIT16)?;
    // Rect-листы нормативно допустимы только на узлах, целиком лежащих
    // в плоскости: у частичного узла второй лист может выйти за границу.
    if (split == SPLIT4_HORZ || split == SPLIT4_VERT) && (px + 16 > w || py + 16 > h) {
        return Err(DecodeError::Corrupt("v8: rect-split на частичном узле 16"));
    }
    match split {
        SPLIT4_WHOLE => {
            let b = border16(recon, w, h, sbx, sby);
            let cfl = cfl_luma.map(|luma| gather_block16_i32(luma, w, h, sbx, sby));
            let (spatial, pred) = decode_square_leaf_v8(
                bank,
                dec,
                raw,
                st,
                &LAYOUT16,
                &qm.q16,
                cfl.as_ref(),
                &|mode| predict_block16(&b, mode),
                inverse_tx16,
            )?;
            store_block16(recon, w, h, sbx, sby, &spatial, &pred);
        }
        SPLIT4_QUAD => {
            for (bx, by) in sub_blocks(sbx, sby, w, h) {
                decode_node8_v8(bank, dec, raw, recon, cfl_luma, w, h, bx, by, qm, st)?;
            }
        }
        SPLIT4_HORZ => {
            for i in 0..2 {
                decode_rect_leaf_v8::<16, 8, 24, 128>(
                    bank,
                    dec,
                    raw,
                    recon,
                    cfl_luma,
                    w,
                    h,
                    px,
                    py + i * 8,
                    &qm.q16x8,
                    &LAYOUT_16X8,
                    inverse_tx_16x8,
                    st,
                )?;
            }
        }
        SPLIT4_VERT => {
            for i in 0..2 {
                decode_rect_leaf_v8::<8, 16, 24, 128>(
                    bank,
                    dec,
                    raw,
                    recon,
                    cfl_luma,
                    w,
                    h,
                    px + i * 8,
                    py,
                    &qm.q8x16,
                    &LAYOUT_8X16,
                    inverse_tx_8x16,
                    st,
                )?;
            }
        }
        _ => return Err(DecodeError::Corrupt("v8: неизвестное split16-решение")),
    }
    Ok(())
}

/// Декодирует дерево тайл-плоскости битстрима v8.
pub fn decode_tile_plane_v8(
    bank: &mut ModelBank,
    dec: &mut RangeDecoder<'_>,
    raw: &mut BitReader<'_>,
    w: usize,
    h: usize,
    cfl_luma: Option<&[i16]>,
    qmat: &[u16; 64],
) -> Result<Vec<i16>, DecodeError> {
    if cfl_luma.is_some_and(|luma| luma.len() != w * h) {
        return Err(DecodeError::Corrupt("CfL: неверный размер luma"));
    }
    let qm = PlaneQmatsV8::new(qmat);
    let root_cols = w.div_ceil(32);
    let root_rows = h.div_ceil(32);
    let mut recon = vec![0i16; w * h];
    let mut st = CtxV8::default();
    let mut freq32 = Box::new([0f32; 1024]);
    let mut spatial32 = Box::new([0f32; 1024]);

    for ry in 0..root_rows {
        for rx in 0..root_cols {
            let (px, py) = (rx * 32, ry * 32);
            let split = bank.decode(dec, CTX8_SPLIT32)?;
            // Как и у узла 16: rect только на полностью лежащих в плоскости
            // корнях (иначе второй лист выходит за границу recon).
            if (split == SPLIT4_HORZ || split == SPLIT4_VERT) && (px + 32 > w || py + 32 > h) {
                return Err(DecodeError::Corrupt("v8: rect-split на частичном корне"));
            }
            match split {
                SPLIT4_WHOLE => {
                    let mode = bank.decode(dec, CTX8_MODE)?;
                    if mode >= mode_limit_v7(cfl_luma.is_some()) {
                        return Err(DecodeError::Corrupt("v8: неизвестная мода предикции"));
                    }
                    let tx = bank.decode(dec, CTX8_TX)?;
                    if tx >= N_TX_V7 {
                        return Err(DecodeError::Corrupt("v8: неизвестный transform"));
                    }
                    let b = border32(&recon, w, h, rx, ry);
                    let pred = if cfl_alpha_q4(mode).is_some() {
                        let luma =
                            gather_block32_i32(cfl_luma.expect("CfL проверен выше"), w, h, rx, ry);
                        predict_cfl(&luma, predict_block32(&b, MODE_DC)[0], mode)
                    } else {
                        predict_block32(&b, mode)
                    };
                    let dc = decode_coeffs_v8(
                        bank,
                        dec,
                        raw,
                        &qm.q32,
                        tx,
                        &LAYOUT32,
                        &mut freq32,
                        &mut st,
                    )?;
                    freq32[0] = dc as f32 * f32::from(qm.q32[0]);
                    inverse_tx32(&freq32, &mut spatial32, tx);
                    store_block32(&mut recon, w, h, rx, ry, &spatial32, &pred);
                }
                SPLIT4_QUAD => {
                    for (sbx, sby) in child_nodes16(rx, ry, w, h) {
                        decode_node16_v8(
                            bank, dec, raw, &mut recon, cfl_luma, w, h, sbx, sby, &qm, &mut st,
                        )?;
                    }
                }
                SPLIT4_HORZ => {
                    for i in 0..2 {
                        decode_rect_leaf_v8::<32, 16, 48, 512>(
                            bank,
                            dec,
                            raw,
                            &mut recon,
                            cfl_luma,
                            w,
                            h,
                            px,
                            py + i * 16,
                            &qm.q32x16,
                            &LAYOUT_32X16,
                            inverse_tx_32x16,
                            &mut st,
                        )?;
                    }
                }
                SPLIT4_VERT => {
                    for i in 0..2 {
                        decode_rect_leaf_v8::<16, 32, 48, 512>(
                            bank,
                            dec,
                            raw,
                            &mut recon,
                            cfl_luma,
                            w,
                            h,
                            px + i * 16,
                            py,
                            &qm.q16x32,
                            &LAYOUT_16X32,
                            inverse_tx_16x32,
                            &mut st,
                        )?;
                    }
                }
                _ => return Err(DecodeError::Corrupt("v8: неизвестное split32-решение")),
            }
        }
    }
    Ok(recon)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::arith::RangeEncoder;
    use crate::dct::{BASE_CO_V8, BASE_Y_V8, quant_matrix};

    fn roundtrip_plane(
        buf: &[i16],
        cfl_luma: Option<&[i16]>,
        w: usize,
        h: usize,
        qmat: &[u16; 64],
    ) -> (Vec<i16>, Vec<(u16, u8)>) {
        let mut syms = Vec::new();
        let mut raw = BitWriter::new();
        let expected = encode_tile_plane_v8(buf, cfl_luma, w, h, qmat, &mut syms, &mut raw);

        let (groups, kinds) = ctx_meta_v8();
        let mut enc_bank = ModelBank::new(groups.clone(), kinds.clone());
        let mut enc = RangeEncoder::new();
        for &(ctx, sym) in &syms {
            enc_bank.encode(&mut enc, ctx, sym);
        }
        let tokens = enc.finish();
        let raw_bytes = raw.finish();

        let mut dec_bank = ModelBank::new(groups, kinds);
        let mut dec = RangeDecoder::new(&tokens).unwrap();
        let mut raw_reader = BitReader::new(&raw_bytes);
        let actual = decode_tile_plane_v8(
            &mut dec_bank,
            &mut dec,
            &mut raw_reader,
            w,
            h,
            cfl_luma,
            qmat,
        )
        .unwrap();
        assert_eq!(actual, expected, "recon кодера и декодера разошлись");
        assert_eq!(dec.consumed(), tokens.len());
        assert_eq!(raw_reader.unread_bytes(), 0);
        (expected, syms)
    }

    /// Детерминированный источник с горизонтальной полосой (анизотропия).
    fn striped_source(w: usize, h: usize) -> Vec<i16> {
        (0..w * h)
            .map(|i| {
                let (x, y) = (i % w, i / w);
                let band = if (y / 8) % 2 == 0 { 40 } else { 200 };
                (band + (x as i32 % 7) - 3).clamp(0, 255) as i16
            })
            .collect()
    }

    #[test]
    fn v8_plane_roundtrips_all_tree_shapes() {
        // Смесь: плоская зона (whole32), шахматный квадрант (quad до 4×4),
        // горизонтальные полосы (rect-кандидаты) и неполные края.
        let (w, h) = (97, 61);
        let mut buf = striped_source(w, h);
        for y in 0..16 {
            for x in 0..16 {
                buf[y * w + x] = if (x + y) % 2 == 0 { 0 } else { 255 };
            }
        }
        let qmat = quant_matrix(&BASE_Y_V8, 75);
        roundtrip_plane(&buf, None, w, h, &qmat);
    }

    #[test]
    fn v8_flat_root_uses_whole32() {
        let (w, h) = (64, 64);
        let buf = vec![140i16; w * h];
        let qmat = quant_matrix(&BASE_Y_V8, 75);
        let (_, syms) = roundtrip_plane(&buf, None, w, h, &qmat);
        assert_eq!(syms.first(), Some(&(CTX8_SPLIT32, SPLIT4_WHOLE)));
    }

    #[test]
    fn v8_horizontal_bands_emit_rect_leaves() {
        // Верх/низ узла резко различны и внутренне гладки: HORZ обязан
        // пройти гейт и выиграть RD хотя бы в одном узле.
        let (w, h) = (32, 32);
        let buf: Vec<i16> = (0..w * h)
            .map(|i| if (i / w) < 16 { 60 } else { 190 })
            .collect();
        let orig = gather_block32_i32(&buf, w, h, 0, 0);
        assert_eq!(rect_hint::<32, 1024>(&orig), Some(SPLIT4_HORZ));
        let qmat = quant_matrix(&BASE_Y_V8, 75);
        let (_, syms) = roundtrip_plane(&buf, None, w, h, &qmat);
        let used_rect = syms.iter().any(|&(ctx, sym)| {
            (ctx == CTX8_SPLIT32 || ctx == CTX8_SPLIT16)
                && (sym == SPLIT4_HORZ || sym == SPLIT4_VERT)
        });
        assert!(used_rect, "rect-лист не использован: {:?}", &syms[..4]);
    }

    #[test]
    fn v8_cfl_chroma_roundtrips() {
        let (w, h) = (37, 29);
        let luma: Vec<i16> = (0..w * h)
            .map(|i| ((i % w * 7 + i / w * 5) & 255) as i16)
            .collect();
        let chroma: Vec<i16> = luma
            .iter()
            .enumerate()
            .map(|(i, &y)| {
                (128 + (i32::from(y) - 128) / 4 + (i % 3) as i32 - 1).clamp(0, 255) as i16
            })
            .collect();
        let qmat = quant_matrix(&BASE_CO_V8, 75);
        roundtrip_plane(&chroma, Some(&luma), w, h, &qmat);
    }

    #[test]
    fn v8_reconstruction_is_plain_level_times_step() {
        // AC-смещение к нулю отклонено полигоном: реконструкция v8 = v7.
        let qmat = [38u16; 16];
        let mut quantized = [0i32; 16];
        quantized[0] = 2;
        quantized[5] = -3;
        let freq = fill_freq_v8(&quantized, &qmat);
        assert_eq!(freq[0], 76.0);
        assert_eq!(freq[5], -114.0);
        assert!(
            freq.iter()
                .enumerate()
                .all(|(i, &f)| f == 0.0 || i == 0 || i == 5)
        );
        assert_eq!(squared_quant_error(2.0 * 38.0, 38.0, 0, 2), 0.0);
    }

    #[test]
    fn v8_ctx_meta_is_dense_and_typed() {
        use crate::arith::ModelKind;
        let (groups, kinds) = ctx_meta_v8();
        assert_eq!(groups.len(), N_CTX_V8);
        assert_eq!(kinds.len(), N_CTX_V8);
        // Все группы одного вида (инвариант прогрева ModelBank).
        let n_groups = usize::from(*groups.iter().max().unwrap()) + 1;
        for g in 0..n_groups {
            let members: Vec<ModelKind> = groups
                .iter()
                .zip(kinds.iter())
                .filter(|&(&gg, _)| usize::from(gg) == g)
                .map(|(_, &k)| k)
                .collect();
            assert!(!members.is_empty(), "пустая группа {g}");
            assert!(
                members.iter().all(|&k| k == members[0]),
                "группа {g} смешивает алфавиты"
            );
        }
        // Контексты run/level/eob не пересекаются и лежат в диапазоне.
        assert_eq!(run_ctx_v8(0, 0), CTX8_RUN_BASE);
        assert_eq!(run_ctx_v8(5, 3), CTX8_LEVEL_BASE - 1);
        assert_eq!(level_ctx_v8(0, 0), CTX8_LEVEL_BASE);
        assert_eq!(level_ctx_v8(5, 3), CTX8_EOB_BASE - 1);
        assert_eq!(eob_ctx_v8(0, 0), CTX8_EOB_BASE);
        assert_eq!(usize::from(eob_ctx_v8(5, 3)), N_CTX_V8 - 1);
    }

    #[test]
    fn v8_chroma_planes_use_distinct_steps() {
        let (qy, qco, qcg) = crate::dct::quant_matrices_v8(75);
        assert_ne!(qy, qco);
        assert_ne!(qco, qcg);
        // Одна и та же плоскость кодируется/декодируется своей матрицей.
        let (w, h) = (48, 33);
        let buf = striped_source(w, h);
        roundtrip_plane(&buf, None, w, h, &qcg);
    }
}
