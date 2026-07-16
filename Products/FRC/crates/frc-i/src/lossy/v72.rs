//! Экспериментальное дерево v7.2, предикторы v7.3 и transform v7.4:
//! 32×32 → 16×16 → 8×8 → 4×4.
//!
//! Корень 32×32 либо кодируется одной intra-модой и DCT32, либо раскрывается
//! в четыре независимых узла v5 (16×16 whole / четыре 8×8). Глубина дерева
//! фиксирована форматом, поэтому недоверенный поток не управляет рекурсией.

use super::*;
use crate::dct::{
    ZIGZAG4, ZIGZAG32, fdct4, fdct4_cols, fdct4_const, fdct4_rows, fdct32, fdct32_cols,
    fdct32_const, fdct32_rows, forward_tx4, forward_tx32, inverse_tx4, inverse_tx32, quant_matrix4,
    quant_matrix32,
};

/// Стоимость одного бинарного split-флага в грубой RD-модели.
const SPLIT_COST_BITS: u32 = 1;
/// Компенсация недооценённой цены четырёх DC/мод в грубой RD-модели.
const SPLIT8_EXTRA_BITS: u32 = 4;
/// На малом блоке форсируем 4×4 только при выраженной неоднородности.
const SPLIT8_CONTRAST: f32 = 20.0;
/// DCT32 дорог: после SAD полный RD проходят только две лучшие моды.
const RD_CANDIDATES32: usize = 2;

// Массивы намеренно inline: дерево живёт только до эмиссии одного корня,
// а heap-аллокация на каждый узел заметна в encode-профиле.
#[allow(clippy::large_enum_variant)]
enum Node16 {
    Whole {
        mode: u8,
        tx: u8,
        quantized: [i32; 256],
    },
    Split {
        nodes: Vec<Node8>,
    },
}

#[allow(clippy::large_enum_variant)]
enum Node8 {
    Whole(SubBlock),
    Split { subs: Vec<SubBlock4> },
}

struct SubBlock4 {
    mode: u8,
    tx: u8,
    quantized: [i32; 16],
}

fn child_nodes16(rx: usize, ry: usize, w: usize, h: usize) -> impl Iterator<Item = (usize, usize)> {
    (0..4).filter_map(move |i| {
        let (sbx, sby) = (rx * 2 + i % 2, ry * 2 + i / 2);
        (sbx * 16 < w && sby * 16 < h).then_some((sbx, sby))
    })
}

fn gather_block32_i32(buf: &[i16], w: usize, h: usize, rx: usize, ry: usize) -> [i32; 1024] {
    let mut block = [0i32; 1024];
    for y in 0..32 {
        let sy = (ry * 32 + y).min(h - 1);
        for x in 0..32 {
            let sx = (rx * 32 + x).min(w - 1);
            block[y * 32 + x] = i32::from(buf[sy * w + sx]);
        }
    }
    block
}

fn block_activity32(block: &[i32; 1024]) -> f32 {
    let mean = block.iter().sum::<i32>() / 1024;
    let mad: i32 = block.iter().map(|&v| (v - mean).abs()).sum();
    mad as f32 / 1024.0
}

fn quadrant_activity32(block: &[i32; 1024], q: usize) -> f32 {
    let (x0, y0) = ((q % 2) * 16, (q / 2) * 16);
    let mut sum = 0i32;
    for y in 0..16 {
        for x in 0..16 {
            sum += block[(y0 + y) * 32 + x0 + x];
        }
    }
    let mean = sum / 256;
    let mut mad = 0i32;
    for y in 0..16 {
        for x in 0..16 {
            mad += (block[(y0 + y) * 32 + x0 + x] - mean).abs();
        }
    }
    mad as f32 / 256.0
}

/// Безопасные быстрые решения. Пограничные случаи проходят полный RD.
fn split_hint32(orig: &[i32; 1024]) -> Option<u8> {
    let mut min_a = f32::INFINITY;
    let mut max_a = 0f32;
    for q in 0..4 {
        let a = quadrant_activity32(orig, q);
        min_a = min_a.min(a);
        max_a = max_a.max(a);
    }
    if max_a <= AQ_ACT_LO && block_activity32(orig) <= AQ_ACT_LO {
        return Some(SPLIT_WHOLE);
    }
    if max_a - min_a >= SPLIT_CONTRAST {
        return Some(SPLIT_QUAD);
    }
    None
}

fn child_blocks4(bx: usize, by: usize, w: usize, h: usize) -> impl Iterator<Item = (usize, usize)> {
    (0..4).filter_map(move |i| {
        let (qx, qy) = (bx * 2 + i % 2, by * 2 + i / 2);
        (qx * 4 < w && qy * 4 < h).then_some((qx, qy))
    })
}

fn gather_block4_i32(buf: &[i16], w: usize, h: usize, qx: usize, qy: usize) -> [i32; 16] {
    let mut block = [0i32; 16];
    for y in 0..4 {
        let sy = (qy * 4 + y).min(h - 1);
        for x in 0..4 {
            let sx = (qx * 4 + x).min(w - 1);
            block[y * 4 + x] = i32::from(buf[sy * w + sx]);
        }
    }
    block
}

fn block_activity4(block: &[i32; 16]) -> f32 {
    let mean = block.iter().sum::<i32>() / 16;
    let mad: i32 = block.iter().map(|&v| (v - mean).abs()).sum();
    mad as f32 / 16.0
}

fn quadrant_activity8(block: &[i32; 64], q: usize) -> f32 {
    let (x0, y0) = ((q % 2) * 4, (q / 2) * 4);
    let mut sum = 0i32;
    for y in 0..4 {
        for x in 0..4 {
            sum += block[(y0 + y) * 8 + x0 + x];
        }
    }
    let mean = sum / 16;
    let mut mad = 0i32;
    for y in 0..4 {
        for x in 0..4 {
            mad += (block[(y0 + y) * 8 + x0 + x] - mean).abs();
        }
    }
    mad as f32 / 16.0
}

fn split_hint8(orig: &[i32; 64]) -> Option<u8> {
    let mut min_a = f32::INFINITY;
    let mut max_a = 0f32;
    for q in 0..4 {
        let a = quadrant_activity8(orig, q);
        min_a = min_a.min(a);
        max_a = max_a.max(a);
    }
    if max_a <= AQ_ACT_LO && block_activity(orig) <= AQ_ACT_LO {
        return Some(SPLIT_WHOLE);
    }
    if max_a - min_a >= SPLIT8_CONTRAST {
        return Some(SPLIT_QUAD);
    }
    None
}

struct Border4 {
    above: [i32; 8],
    left: [i32; 4],
    corner: i32,
}

fn border4(recon: &[i16], w: usize, h: usize, qx: usize, qy: usize) -> Border4 {
    let (px, py) = (qx * 4, qy * 4);
    let mut above = [128i32; 8];
    let mut left = [128i32; 4];
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
    Border4 {
        above,
        left,
        corner,
    }
}

fn predict_block4(b: &Border4, mode: u8) -> [i32; 16] {
    let mut out = [0i32; 16];
    match mode {
        MODE_V => {
            for y in 0..4 {
                out[y * 4..y * 4 + 4].copy_from_slice(&b.above[0..4]);
            }
        }
        MODE_H => {
            for y in 0..4 {
                out[y * 4..y * 4 + 4].copy_from_slice(&[b.left[y]; 4]);
            }
        }
        MODE_TM => {
            for y in 0..4 {
                for x in 0..4 {
                    out[y * 4 + x] = (b.left[y] + b.above[x] - b.corner).clamp(0, 255);
                }
            }
        }
        MODE_D45 => {
            for y in 0..4 {
                for x in 0..4 {
                    let s = x + y;
                    let (a0, a1, a2) = (b.above[s], b.above[s + 1], b.above[(s + 2).min(7)]);
                    out[y * 4 + x] = (a0 + 2 * a1 + a2 + 2) >> 2;
                }
            }
        }
        MODE_D135 => {
            let mut line = [0i32; 9];
            for (j, slot) in line[0..4].iter_mut().enumerate() {
                *slot = b.left[3 - j];
            }
            line[4] = b.corner;
            line[5..9].copy_from_slice(&b.above[0..4]);
            for y in 0..4 {
                for x in 0..4 {
                    let d = 4 + x - y;
                    out[y * 4 + x] = (line[d - 1] + 2 * line[d] + line[d + 1] + 2) >> 2;
                }
            }
        }
        MODE_SMOOTH => {
            for y in 0..4 {
                for x in 0..4 {
                    out[y * 4 + x] = smooth_sample(&b.above, &b.left, x, y);
                }
            }
        }
        _ => {
            let sum: i32 = b.above[0..4].iter().sum::<i32>() + b.left.iter().sum::<i32>();
            let dc = (sum + 4) >> 3;
            out.fill(dc);
        }
    }
    out
}

fn quantize_freq4(freq: &[f32; 16], qmat4: &[u16; 16], ac_bias: f32) -> ([i32; 16], f32) {
    let mut quantized = [0i32; 16];
    let mut distortion = 0f32;
    for (i, q) in quantized.iter_mut().enumerate() {
        let step = f32::from(qmat4[i]);
        let t = freq[i] / step;
        let bias = if i == 0 { 0.5 } else { ac_bias };
        let magnitude = (t.abs() + bias).floor() as i32;
        *q = if t < 0.0 { -magnitude } else { magnitude };
        let err = freq[i] - *q as f32 * step;
        distortion += err * err;
    }
    (quantized, distortion)
}

fn choose_mode4(
    orig: &[i32; 16],
    b: &Border4,
    cfl_luma: Option<&[i32; 16]>,
    qmat4: &[u16; 16],
    lambda: f32,
    ac_bias: f32,
) -> (u8, [i32; 16], [i32; 16], f32) {
    let mut spatial = [0f32; 16];
    for i in 0..16 {
        spatial[i] = orig[i] as f32;
    }
    let mut freq_orig = [0f32; 16];
    fdct4(&spatial, &mut freq_orig);
    let mut freq_pred = [0f32; 16];
    let mut freq_res = [0f32; 16];

    let mut sads = Vec::with_capacity(N_MODES_V7 as usize);
    let mut preds = [[0i32; 16]; N_MODES_V7 as usize];
    for &mode in ENCODE_MODES_V7 {
        let pred = predict_block4(b, mode);
        let sad: u64 = orig
            .iter()
            .zip(pred.iter())
            .map(|(&o, &p)| u64::from(o.abs_diff(p)))
            .sum();
        preds[usize::from(mode)] = pred;
        sads.push((mode, sad));
    }
    if let Some(luma) = cfl_luma {
        let dc = predict_block4(b, MODE_DC)[0];
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
    let candidates = preselect_modes::<RD_CANDIDATES>(&sads);

    let mut best: Option<(u8, [i32; 16], [i32; 16], f32)> = None;
    for &mode in &candidates {
        let pred = preds[usize::from(mode)];
        match mode {
            MODE_DC => fdct4_const(pred[0] as f32, &mut freq_pred),
            MODE_V => {
                let row = [
                    pred[0] as f32,
                    pred[1] as f32,
                    pred[2] as f32,
                    pred[3] as f32,
                ];
                fdct4_rows(&row, &mut freq_pred);
            }
            MODE_H => {
                let col = [
                    pred[0] as f32,
                    pred[4] as f32,
                    pred[8] as f32,
                    pred[12] as f32,
                ];
                fdct4_cols(&col, &mut freq_pred);
            }
            _ => {
                for i in 0..16 {
                    spatial[i] = pred[i] as f32;
                }
                fdct4(&spatial, &mut freq_pred);
            }
        }
        for i in 0..16 {
            freq_res[i] = freq_orig[i] - freq_pred[i];
        }
        let (quantized, distortion) = quantize_freq4(&freq_res, qmat4, ac_bias);
        let cost = distortion + lambda * legacy_coeff_cost(&quantized, &ZIGZAG4) as f32;
        if best.as_ref().is_none_or(|(_, _, _, old)| cost < *old) {
            best = Some((mode, pred, quantized, cost));
        }
    }
    best.expect("моды всегда есть")
}

fn store_block4(
    recon: &mut [i16],
    w: usize,
    h: usize,
    qx: usize,
    qy: usize,
    residual: &[f32; 16],
    pred: &[i32; 16],
) {
    for y in 0..4 {
        let sy = qy * 4 + y;
        if sy >= h {
            break;
        }
        for x in 0..4 {
            let sx = qx * 4 + x;
            if sx >= w {
                break;
            }
            let v = (residual[y * 4 + x] + pred[y * 4 + x] as f32)
                .round()
                .clamp(0.0, 255.0);
            recon[sy * w + sx] = v as i16;
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn eval_block4(
    buf: &[i16],
    recon: &mut [i16],
    cfl_luma: Option<&[i16]>,
    w: usize,
    h: usize,
    qx: usize,
    qy: usize,
    qmat4: &[u16; 16],
    lambda: f32,
) -> (SubBlock4, f32) {
    let orig = gather_block4_i32(buf, w, h, qx, qy);
    let cfl_block = cfl_luma.map(|luma| gather_block4_i32(luma, w, h, qx, qy));
    let b = border4(recon, w, h, qx, qy);
    let ac_bias = adaptive_ac_bias(block_activity4(&orig));
    let (mode, pred, quantized, cost) =
        choose_mode4(&orig, &b, cfl_block.as_ref(), qmat4, lambda, ac_bias);
    let (tx, quantized, cost) = choose_transform(
        &orig,
        &pred,
        qmat4,
        lambda,
        ac_bias,
        quantized,
        cost,
        forward_tx4,
        tx_scan4,
    );
    let mut freq = [0f32; 16];
    let mut spatial = [0f32; 16];
    for i in 0..16 {
        freq[i] = quantized[i] as f32 * f32::from(qmat4[i]);
    }
    inverse_tx4(&freq, &mut spatial, tx);
    store_block4(recon, w, h, qx, qy, &spatial, &pred);
    (
        SubBlock4 {
            mode,
            tx,
            quantized,
        },
        cost + lambda * (MODE_COST_BITS + TX_COST_BITS) as f32,
    )
}

fn save_region8(recon: &[i16], w: usize, h: usize, bx: usize, by: usize) -> [i16; 64] {
    let mut out = [0i16; 64];
    for y in 0..8 {
        let sy = by * 8 + y;
        if sy >= h {
            break;
        }
        for x in 0..8 {
            let sx = bx * 8 + x;
            if sx >= w {
                break;
            }
            out[y * 8 + x] = recon[sy * w + sx];
        }
    }
    out
}

fn restore_region8(recon: &mut [i16], w: usize, h: usize, bx: usize, by: usize, saved: &[i16; 64]) {
    for y in 0..8 {
        let sy = by * 8 + y;
        if sy >= h {
            break;
        }
        for x in 0..8 {
            let sx = bx * 8 + x;
            if sx >= w {
                break;
            }
            recon[sy * w + sx] = saved[y * 8 + x];
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn reconstruct8(
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
    let mut freq = [0f32; 64];
    let mut spatial = [0f32; 64];
    for i in 0..64 {
        freq[i] = quantized[i] as f32 * f32::from(qmat[i]);
    }
    inverse_tx8(&freq, &mut spatial, tx);
    store_block(recon, w, h, bx, by, &spatial, pred);
}

#[allow(clippy::too_many_arguments)]
fn eval_node8(
    buf: &[i16],
    recon: &mut [i16],
    cfl_luma: Option<&[i16]>,
    w: usize,
    h: usize,
    bx: usize,
    by: usize,
    qmat: &[u16; 64],
    qmat4: &[u16; 16],
    lambda: f32,
) -> (Node8, f32) {
    let orig = gather_block_i32(buf, w, h, bx, by);
    let hint = split_hint8(&orig);
    let partial = (bx + 1) * 8 > w || (by + 1) * 8 > h;

    if !partial && hint == Some(SPLIT_QUAD) {
        let mut subs = Vec::with_capacity(4);
        let mut split_cost = 0f32;
        for (qx, qy) in child_blocks4(bx, by, w, h) {
            let (sub, cost) = eval_block4(buf, recon, cfl_luma, w, h, qx, qy, qmat4, lambda);
            subs.push(sub);
            split_cost += cost;
        }
        return (
            Node8::Split { subs },
            split_cost + lambda * (SPLIT_COST_BITS + SPLIT8_EXTRA_BITS) as f32,
        );
    }

    let b = border(recon, w, h, bx, by);
    let cfl_block = cfl_luma.map(|luma| gather_block_i32(luma, w, h, bx, by));
    let ac_bias = adaptive_ac_bias(block_activity(&orig));
    let (mode, pred, quantized, whole_base) = choose_mode_v7(
        &orig,
        &b,
        cfl_block.as_ref(),
        qmat,
        lambda,
        mode_limit_v7(cfl_luma.is_some()),
        ac_bias,
    );
    let (tx, quantized, whole_base) = choose_transform(
        &orig,
        &pred,
        qmat,
        lambda,
        ac_bias,
        quantized,
        whole_base,
        forward_tx8,
        tx_scan8,
    );
    let whole_cost = whole_base + lambda * (MODE_COST_BITS + TX_COST_BITS) as f32;

    if partial || hint == Some(SPLIT_WHOLE) {
        reconstruct8(recon, w, h, bx, by, &quantized, qmat, tx, &pred);
        return (
            Node8::Whole(SubBlock {
                mode,
                tx,
                quantized,
            }),
            whole_cost + lambda * SPLIT_COST_BITS as f32,
        );
    }

    let backup = save_region8(recon, w, h, bx, by);
    let mut subs = Vec::with_capacity(4);
    let mut split_cost = 0f32;
    for (qx, qy) in child_blocks4(bx, by, w, h) {
        let (sub, cost) = eval_block4(buf, recon, cfl_luma, w, h, qx, qy, qmat4, lambda);
        subs.push(sub);
        split_cost += cost;
        if split_cost + lambda * SPLIT8_EXTRA_BITS as f32 > whole_cost {
            break;
        }
    }
    let adjusted_split_cost = split_cost + lambda * SPLIT8_EXTRA_BITS as f32;

    if whole_cost <= adjusted_split_cost {
        restore_region8(recon, w, h, bx, by, &backup);
        reconstruct8(recon, w, h, bx, by, &quantized, qmat, tx, &pred);
        (
            Node8::Whole(SubBlock {
                mode,
                tx,
                quantized,
            }),
            whole_cost + lambda * SPLIT_COST_BITS as f32,
        )
    } else {
        (
            Node8::Split { subs },
            adjusted_split_cost + lambda * SPLIT_COST_BITS as f32,
        )
    }
}

struct Border32 {
    above: [i32; 64],
    left: [i32; 32],
    corner: i32,
}

fn border32(recon: &[i16], w: usize, h: usize, rx: usize, ry: usize) -> Border32 {
    let (px, py) = (rx * 32, ry * 32);
    let mut above = [128i32; 64];
    let mut left = [128i32; 32];
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
    Border32 {
        above,
        left,
        corner,
    }
}

fn predict_block32(b: &Border32, mode: u8) -> [i32; 1024] {
    let mut out = [0i32; 1024];
    match mode {
        MODE_V => {
            for y in 0..32 {
                out[y * 32..y * 32 + 32].copy_from_slice(&b.above[0..32]);
            }
        }
        MODE_H => {
            for y in 0..32 {
                out[y * 32..y * 32 + 32].copy_from_slice(&[b.left[y]; 32]);
            }
        }
        MODE_TM => {
            for y in 0..32 {
                for x in 0..32 {
                    out[y * 32 + x] = (b.left[y] + b.above[x] - b.corner).clamp(0, 255);
                }
            }
        }
        MODE_D45 => {
            for y in 0..32 {
                for x in 0..32 {
                    let s = x + y;
                    let (a0, a1, a2) = (b.above[s], b.above[s + 1], b.above[(s + 2).min(63)]);
                    out[y * 32 + x] = (a0 + 2 * a1 + a2 + 2) >> 2;
                }
            }
        }
        MODE_D135 => {
            let mut line = [0i32; 65];
            for (j, slot) in line[0..32].iter_mut().enumerate() {
                *slot = b.left[31 - j];
            }
            line[32] = b.corner;
            line[33..65].copy_from_slice(&b.above[0..32]);
            for y in 0..32 {
                for x in 0..32 {
                    let d = 32 + x - y;
                    out[y * 32 + x] = (line[d - 1] + 2 * line[d] + line[d + 1] + 2) >> 2;
                }
            }
        }
        MODE_SMOOTH => {
            for y in 0..32 {
                for x in 0..32 {
                    out[y * 32 + x] = smooth_sample(&b.above, &b.left, x, y);
                }
            }
        }
        _ => {
            let sum = b.above[0..32].iter().sum::<i32>() + b.left.iter().sum::<i32>();
            let dc = (sum + 32) >> 6;
            out.fill(dc);
        }
    }
    out
}

fn quantize_freq32(freq: &[f32; 1024], qmat32: &[u16; 1024], ac_bias: f32) -> ([i32; 1024], f32) {
    let mut quantized = [0i32; 1024];
    let mut distortion = 0f32;
    for (i, q) in quantized.iter_mut().enumerate() {
        let step = f32::from(qmat32[i]);
        let t = freq[i] / step;
        let bias = if i == 0 { 0.5 } else { ac_bias };
        let magnitude = (t.abs() + bias).floor() as i32;
        *q = if t < 0.0 { -magnitude } else { magnitude };
        let err = freq[i] - *q as f32 * step;
        distortion += err * err;
    }
    (quantized, distortion)
}

type Mode32Result = (u8, Box<[i32; 1024]>, Box<[i32; 1024]>, f32);

fn choose_mode32(
    orig: &[i32; 1024],
    b: &Border32,
    cfl_luma: Option<&[i32; 1024]>,
    qmat32: &[u16; 1024],
    lambda: f32,
    ac_bias: f32,
) -> Mode32Result {
    let mut spatial = [0f32; 1024];
    for i in 0..1024 {
        spatial[i] = orig[i] as f32;
    }
    let mut freq_orig = [0f32; 1024];
    fdct32(&spatial, &mut freq_orig);
    let mut freq_pred = [0f32; 1024];
    let mut freq_res = [0f32; 1024];

    let mut sads: Vec<(u8, u64)> = Vec::with_capacity(N_MODES_V7 as usize);
    for &mode in ENCODE_MODES_V7 {
        let pred = predict_block32(b, mode);
        let sad: u64 = orig
            .iter()
            .zip(pred.iter())
            .map(|(&o, &p)| u64::from(o.abs_diff(p)))
            .sum();
        sads.push((mode, sad));
    }
    if let Some(luma) = cfl_luma {
        let dc = predict_block32(b, MODE_DC)[0];
        let mode = cfl_candidate_mode(orig, luma, dc);
        let pred = predict_cfl(luma, dc, mode);
        let sad = orig
            .iter()
            .zip(pred.iter())
            .map(|(&o, &p)| u64::from(o.abs_diff(p)))
            .sum();
        sads.push((mode, sad));
    }
    let candidates = preselect_modes::<RD_CANDIDATES32>(&sads);

    let mut best: Option<Mode32Result> = None;
    for &mode in &candidates {
        let pred = if cfl_alpha_q4(mode).is_some() {
            predict_cfl(
                cfl_luma.expect("CfL candidate requires luma"),
                predict_block32(b, MODE_DC)[0],
                mode,
            )
        } else {
            predict_block32(b, mode)
        };
        match mode {
            MODE_DC => fdct32_const(pred[0] as f32, &mut freq_pred),
            MODE_V => {
                let mut row = [0f32; 32];
                for (i, r) in row.iter_mut().enumerate() {
                    *r = pred[i] as f32;
                }
                fdct32_rows(&row, &mut freq_pred);
            }
            MODE_H => {
                let mut col = [0f32; 32];
                for (j, c) in col.iter_mut().enumerate() {
                    *c = pred[j * 32] as f32;
                }
                fdct32_cols(&col, &mut freq_pred);
            }
            _ => {
                for i in 0..1024 {
                    spatial[i] = pred[i] as f32;
                }
                fdct32(&spatial, &mut freq_pred);
            }
        }
        for i in 0..1024 {
            freq_res[i] = freq_orig[i] - freq_pred[i];
        }
        let (quantized, distortion) = quantize_freq32(&freq_res, qmat32, ac_bias);
        let cost = distortion + lambda * legacy_coeff_cost(&quantized, &ZIGZAG32) as f32;
        let better = best.as_ref().is_none_or(|(_, _, _, old)| cost < *old);
        if better {
            best = Some((mode, Box::new(pred), Box::new(quantized), cost));
        }
    }
    best.expect("моды всегда есть")
}

fn store_block32(
    recon: &mut [i16],
    w: usize,
    h: usize,
    rx: usize,
    ry: usize,
    residual: &[f32; 1024],
    pred: &[i32; 1024],
) {
    for y in 0..32 {
        let sy = ry * 32 + y;
        if sy >= h {
            break;
        }
        for x in 0..32 {
            let sx = rx * 32 + x;
            if sx >= w {
                break;
            }
            let v = (residual[y * 32 + x] + pred[y * 32 + x] as f32)
                .round()
                .clamp(0.0, 255.0);
            recon[sy * w + sx] = v as i16;
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn reconstruct32(
    recon: &mut [i16],
    w: usize,
    h: usize,
    rx: usize,
    ry: usize,
    quantized: &[i32; 1024],
    qmat32: &[u16; 1024],
    tx: u8,
    pred: &[i32; 1024],
) {
    let mut freq = [0f32; 1024];
    let mut spatial = [0f32; 1024];
    for i in 0..1024 {
        freq[i] = quantized[i] as f32 * f32::from(qmat32[i]);
    }
    inverse_tx32(&freq, &mut spatial, tx);
    store_block32(recon, w, h, rx, ry, &spatial, pred);
}

fn save_region32(recon: &[i16], w: usize, h: usize, rx: usize, ry: usize) -> [i16; 1024] {
    let mut out = [0i16; 1024];
    for y in 0..32 {
        let sy = ry * 32 + y;
        if sy >= h {
            break;
        }
        for x in 0..32 {
            let sx = rx * 32 + x;
            if sx >= w {
                break;
            }
            out[y * 32 + x] = recon[sy * w + sx];
        }
    }
    out
}

fn restore_region32(
    recon: &mut [i16],
    w: usize,
    h: usize,
    rx: usize,
    ry: usize,
    saved: &[i16; 1024],
) {
    for y in 0..32 {
        let sy = ry * 32 + y;
        if sy >= h {
            break;
        }
        for x in 0..32 {
            let sx = rx * 32 + x;
            if sx >= w {
                break;
            }
            recon[sy * w + sx] = saved[y * 32 + x];
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn reconstruct16(
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
    let mut freq = [0f32; 256];
    let mut spatial = [0f32; 256];
    for i in 0..256 {
        freq[i] = quantized[i] as f32 * f32::from(qmat16[i]);
    }
    inverse_tx16(&freq, &mut spatial, tx);
    store_block16(recon, w, h, sbx, sby, &spatial, pred);
}

#[allow(clippy::too_many_arguments)]
fn eval_node16(
    buf: &[i16],
    recon: &mut [i16],
    cfl_luma: Option<&[i16]>,
    w: usize,
    h: usize,
    sbx: usize,
    sby: usize,
    qmat: &[u16; 64],
    qmat4: &[u16; 16],
    qmat16: &[u16; 256],
    lambda: f32,
) -> (Node16, f32) {
    let orig16 = gather_block16_i32(buf, w, h, sbx, sby);
    let hint = split_hint(&orig16);

    let eval_whole = |recon: &mut [i16]| {
        let ac_bias = adaptive_ac_bias(block_activity16(&orig16));
        let b = border16(recon, w, h, sbx, sby);
        let cfl_block = cfl_luma.map(|luma| gather_block16_i32(luma, w, h, sbx, sby));
        let (mode, pred, quantized, cost) = choose_mode16_v7(
            &orig16,
            &b,
            cfl_block.as_ref(),
            qmat16,
            lambda,
            mode_limit_v7(cfl_luma.is_some()),
            ac_bias,
        );
        let (tx, quantized, cost) = choose_transform(
            &orig16,
            &pred,
            qmat16,
            lambda,
            ac_bias,
            quantized,
            cost,
            forward_tx16,
            tx_scan16,
        );
        (mode, tx, pred, quantized, cost)
    };

    if hint == Some(SPLIT_WHOLE) {
        let (mode, tx, pred, quantized, cost) = eval_whole(recon);
        reconstruct16(recon, w, h, sbx, sby, &quantized, qmat16, tx, &pred);
        return (
            Node16::Whole {
                mode,
                tx,
                quantized,
            },
            cost + lambda * (MODE_COST_BITS + TX_COST_BITS + SPLIT_COST_BITS) as f32,
        );
    }

    if hint == Some(SPLIT_QUAD) {
        let mut nodes = Vec::with_capacity(4);
        let mut cost = 0f32;
        for (bx, by) in sub_blocks(sbx, sby, w, h) {
            let (node, node_cost) =
                eval_node8(buf, recon, cfl_luma, w, h, bx, by, qmat, qmat4, lambda);
            nodes.push(node);
            cost += node_cost;
        }
        return (
            Node16::Split { nodes },
            cost + lambda * SPLIT_COST_BITS as f32,
        );
    }

    let (mode, tx, pred, quantized, whole_cost) = eval_whole(recon);
    let whole_cost = whole_cost + lambda * (MODE_COST_BITS + TX_COST_BITS) as f32;
    let backup = save_region16(recon, w, h, sbx, sby);
    let mut nodes = Vec::with_capacity(4);
    let mut split_cost = 0f32;
    for (bx, by) in sub_blocks(sbx, sby, w, h) {
        let (node, node_cost) = eval_node8(buf, recon, cfl_luma, w, h, bx, by, qmat, qmat4, lambda);
        nodes.push(node);
        split_cost += node_cost;
        if split_cost > whole_cost {
            break;
        }
    }

    if whole_cost <= split_cost {
        restore_region16(recon, w, h, sbx, sby, &backup);
        reconstruct16(recon, w, h, sbx, sby, &quantized, qmat16, tx, &pred);
        (
            Node16::Whole {
                mode,
                tx,
                quantized,
            },
            whole_cost + lambda * SPLIT_COST_BITS as f32,
        )
    } else {
        (
            Node16::Split { nodes },
            split_cost + lambda * SPLIT_COST_BITS as f32,
        )
    }
}

fn emit_node8(node: &Node8, st: &mut CtxV7, syms: &mut Vec<(u8, u8)>, raw: &mut BitWriter) {
    match node {
        Node8::Whole(sub) => {
            syms.push((CTX7_SPLIT8, SPLIT_WHOLE));
            syms.push((CTX7_MODE, sub.mode));
            syms.push((CTX7_TX, sub.tx));
            encode_coeffs_v7(&sub.quantized, sub.quantized[0], sub.tx, st, syms, raw);
        }
        Node8::Split { subs } => {
            syms.push((CTX7_SPLIT8, SPLIT_QUAD));
            for sub in subs {
                syms.push((CTX7_MODE, sub.mode));
                syms.push((CTX7_TX, sub.tx));
                encode_coeffs4_v7(&sub.quantized, sub.tx, st, syms, raw);
            }
        }
    }
}

fn emit_node16(node: &Node16, st: &mut CtxV7, syms: &mut Vec<(u8, u8)>, raw: &mut BitWriter) {
    match node {
        Node16::Whole {
            mode,
            tx,
            quantized,
        } => {
            syms.push((CTX7_SPLIT, SPLIT_WHOLE));
            syms.push((CTX7_MODE, *mode));
            syms.push((CTX7_TX, *tx));
            encode_coeffs16_v7(quantized, *tx, st, syms, raw);
        }
        Node16::Split { nodes } => {
            syms.push((CTX7_SPLIT, SPLIT_QUAD));
            for node in nodes {
                emit_node8(node, st, syms, raw);
            }
        }
    }
}

#[inline]
fn pos_bucket4(pos: usize) -> u8 {
    pos_bucket8((pos << 2).clamp(1, 63))
}

fn encode_coeffs4_v7(
    quantized: &[i32; 16],
    tx: u8,
    st: &mut CtxV7,
    syms: &mut Vec<(u8, u8)>,
    raw: &mut BitWriter,
) {
    let scan = tx_scan4(tx);
    let nnz_b = st.prev_nnz;
    let (sym, bits, n_bits) = tokenize(zigzag(quantized[0]));
    syms.push((dc_ctx_v7(st.prev_dc), sym));
    write_raw(raw, bits, n_bits);
    st.prev_dc = quantized[0].unsigned_abs();

    let mut nnz = 0u32;
    let mut prev_mag = 0u32;
    let mut pos = 1usize;
    while pos < 16 {
        let run_start = pos;
        let mut run = 0usize;
        while pos < 16 && quantized[scan[pos]] == 0 {
            run += 1;
            pos += 1;
        }
        let pos_b = pos_bucket4(run_start);
        if pos == 16 {
            syms.push((eob_ctx_v7(pos_b, nnz_b), 1));
            break;
        }
        syms.push((eob_ctx_v7(pos_b, nnz_b), 0));
        let (rsym, rbits, rn) = tokenize(run as u32);
        syms.push((run_ctx_v7(pos_b, nnz_b), rsym));
        write_raw(raw, rbits, rn);

        let level = quantized[scan[pos]];
        let mag = level.unsigned_abs();
        let (lsym, lbits, ln) = tokenize(mag - 1);
        syms.push((level_ctx_v7(pos_bucket4(pos), lvl_bucket(prev_mag)), lsym));
        write_raw(raw, lbits, ln);
        raw.write(u32::from(level < 0), 1);
        prev_mag = mag;
        nnz += 1;
        pos += 1;
    }
    st.prev_nnz = nnz_bucket(nnz.saturating_mul(4));
}

#[inline]
fn pos_bucket32(pos: usize) -> u8 {
    pos_bucket8((pos >> 4).max(1))
}

fn encode_coeffs32_v7(
    quantized: &[i32; 1024],
    tx: u8,
    st: &mut CtxV7,
    syms: &mut Vec<(u8, u8)>,
    raw: &mut BitWriter,
) {
    let scan = tx_scan32(tx);
    let nnz_b = st.prev_nnz;
    let (sym, bits, n_bits) = tokenize(zigzag(quantized[0]));
    syms.push((dc_ctx_v7(st.prev_dc), sym));
    write_raw(raw, bits, n_bits);
    st.prev_dc = quantized[0].unsigned_abs();

    let mut nnz = 0u32;
    let mut prev_mag = 0u32;
    let mut pos = 1usize;
    while pos < 1024 {
        let run_start = pos;
        let mut run = 0usize;
        while pos < 1024 && quantized[scan[pos]] == 0 {
            run += 1;
            pos += 1;
        }
        let pos_b = pos_bucket32(run_start);
        if pos == 1024 {
            syms.push((eob_ctx_v7(pos_b, nnz_b), 1));
            break;
        }
        syms.push((eob_ctx_v7(pos_b, nnz_b), 0));
        let (rsym, rbits, rn) = tokenize(run as u32);
        syms.push((run_ctx_v7(pos_b, nnz_b), rsym));
        write_raw(raw, rbits, rn);

        let level = quantized[scan[pos]];
        let mag = level.unsigned_abs();
        let (lsym, lbits, ln) = tokenize(mag - 1);
        syms.push((level_ctx_v7(pos_bucket32(pos), lvl_bucket(prev_mag)), lsym));
        write_raw(raw, lbits, ln);
        raw.write(u32::from(level < 0), 1);
        prev_mag = mag;
        nnz += 1;
        pos += 1;
    }
    st.prev_nnz = nnz_bucket(nnz / 16);
}

pub(super) fn encode_tile_plane(
    buf: &[i16],
    cfl_luma: Option<&[i16]>,
    w: usize,
    h: usize,
    qmat: &[u16; 64],
    syms: &mut Vec<(u8, u8)>,
    raw: &mut BitWriter,
) -> Vec<i16> {
    debug_assert_eq!(buf.len(), w * h);
    debug_assert!(cfl_luma.is_none_or(|luma| luma.len() == w * h));
    let root_cols = w.div_ceil(32);
    let root_rows = h.div_ceil(32);
    let qmat4 = quant_matrix4(qmat);
    let qmat16 = quant_matrix16(qmat);
    let qmat32 = quant_matrix32(qmat);
    let lambda = plane_lambda(qmat);
    let mut recon = vec![0i16; w * h];
    let mut st = CtxV7::default();

    for ry in 0..root_rows {
        for rx in 0..root_cols {
            // Неполный корень всегда раскрывается: сравнение DCT32 с меньшим
            // числом дочерних узлов на реплицированном краю было бы смещено.
            let partial = (rx + 1) * 32 > w || (ry + 1) * 32 > h;
            if partial {
                syms.push((CTX7_SPLIT32, SPLIT_QUAD));
                for (sbx, sby) in child_nodes16(rx, ry, w, h) {
                    let (node, _) = eval_node16(
                        buf, &mut recon, cfl_luma, w, h, sbx, sby, qmat, &qmat4, &qmat16, lambda,
                    );
                    emit_node16(&node, &mut st, syms, raw);
                }
                continue;
            }

            let orig32 = gather_block32_i32(buf, w, h, rx, ry);
            let hint = split_hint32(&orig32);
            if hint == Some(SPLIT_QUAD) {
                syms.push((CTX7_SPLIT32, SPLIT_QUAD));
                for (sbx, sby) in child_nodes16(rx, ry, w, h) {
                    let (node, _) = eval_node16(
                        buf, &mut recon, cfl_luma, w, h, sbx, sby, qmat, &qmat4, &qmat16, lambda,
                    );
                    emit_node16(&node, &mut st, syms, raw);
                }
                continue;
            }

            let ac_bias = adaptive_ac_bias(block_activity32(&orig32));
            let b32 = border32(&recon, w, h, rx, ry);
            let cfl_block = cfl_luma.map(|luma| gather_block32_i32(luma, w, h, rx, ry));
            let (mode32, pred32, quant32, cost32) =
                choose_mode32(&orig32, &b32, cfl_block.as_ref(), &qmat32, lambda, ac_bias);
            let (tx32, quant32, cost32) = choose_transform(
                &orig32,
                pred32.as_ref(),
                &qmat32,
                lambda,
                ac_bias,
                *quant32,
                cost32,
                forward_tx32,
                tx_scan32,
            );

            if hint == Some(SPLIT_WHOLE) {
                reconstruct32(&mut recon, w, h, rx, ry, &quant32, &qmat32, tx32, &pred32);
                syms.push((CTX7_SPLIT32, SPLIT_WHOLE));
                syms.push((CTX7_MODE, mode32));
                syms.push((CTX7_TX, tx32));
                encode_coeffs32_v7(&quant32, tx32, &mut st, syms, raw);
                continue;
            }

            let whole_cost = cost32 + lambda * (MODE_COST_BITS + TX_COST_BITS) as f32;
            let backup = save_region32(&recon, w, h, rx, ry);
            let mut nodes = Vec::with_capacity(4);
            let mut split_cost = 0f32;
            for (sbx, sby) in child_nodes16(rx, ry, w, h) {
                let (node, cost) = eval_node16(
                    buf, &mut recon, cfl_luma, w, h, sbx, sby, qmat, &qmat4, &qmat16, lambda,
                );
                nodes.push(node);
                split_cost += cost;
                if split_cost > whole_cost {
                    break;
                }
            }

            if whole_cost <= split_cost {
                restore_region32(&mut recon, w, h, rx, ry, &backup);
                reconstruct32(&mut recon, w, h, rx, ry, &quant32, &qmat32, tx32, &pred32);
                syms.push((CTX7_SPLIT32, SPLIT_WHOLE));
                syms.push((CTX7_MODE, mode32));
                syms.push((CTX7_TX, tx32));
                encode_coeffs32_v7(&quant32, tx32, &mut st, syms, raw);
            } else {
                syms.push((CTX7_SPLIT32, SPLIT_QUAD));
                for node in &nodes {
                    emit_node16(node, &mut st, syms, raw);
                }
            }
        }
    }
    recon
}

fn decode_coeffs4_v7(
    bank: &mut ModelBank,
    dec: &mut RangeDecoder<'_>,
    raw: &mut BitReader<'_>,
    qmat4: &[u16; 16],
    scan: &[usize; 16],
    freq: &mut [f32; 16],
    st: &mut CtxV7,
) -> Result<i32, DecodeError> {
    freq.fill(0.0);
    let nnz_b = st.prev_nnz;
    let dc_sym = bank.decode(dec, dc_ctx_v7(st.prev_dc))?;
    let dc_token = unzigzag(detokenize(dc_sym, raw)?);
    st.prev_dc = dc_token.unsigned_abs();

    let mut nnz = 0u32;
    let mut prev_mag = 0u32;
    let mut pos = 1usize;
    while pos < 16 {
        let pos_b = pos_bucket4(pos);
        if bank.decode(dec, eob_ctx_v7(pos_b, nnz_b))? == 1 {
            break;
        }
        let rsym = bank.decode(dec, run_ctx_v7(pos_b, nnz_b))?;
        let run = detokenize(rsym, raw)? as usize;
        let new_pos = pos
            .checked_add(run)
            .ok_or(DecodeError::Corrupt("dct4: run overflow"))?;
        if new_pos >= 16 {
            return Err(DecodeError::Corrupt("dct4: позиция AC вне блока"));
        }
        pos = new_pos;
        let lsym = bank.decode(dec, level_ctx_v7(pos_bucket4(pos), lvl_bucket(prev_mag)))?;
        let mag = detokenize(lsym, raw)?.wrapping_add(1);
        let sign = raw.read(1)?;
        let level = if sign == 1 { -(mag as i32) } else { mag as i32 };
        let index = scan[pos];
        freq[index] = level as f32 * f32::from(qmat4[index]);
        prev_mag = mag;
        nnz += 1;
        pos += 1;
    }
    st.prev_nnz = nnz_bucket(nnz.saturating_mul(4));
    Ok(dc_token)
}

fn decode_coeffs32_v7(
    bank: &mut ModelBank,
    dec: &mut RangeDecoder<'_>,
    raw: &mut BitReader<'_>,
    qmat32: &[u16; 1024],
    scan: &[usize; 1024],
    freq: &mut [f32; 1024],
    st: &mut CtxV7,
) -> Result<i32, DecodeError> {
    freq.fill(0.0);
    let nnz_b = st.prev_nnz;
    let dc_sym = bank.decode(dec, dc_ctx_v7(st.prev_dc))?;
    let dc_token = unzigzag(detokenize(dc_sym, raw)?);
    st.prev_dc = dc_token.unsigned_abs();

    let mut nnz = 0u32;
    let mut prev_mag = 0u32;
    let mut pos = 1usize;
    while pos < 1024 {
        let pos_b = pos_bucket32(pos);
        if bank.decode(dec, eob_ctx_v7(pos_b, nnz_b))? == 1 {
            break;
        }
        let rsym = bank.decode(dec, run_ctx_v7(pos_b, nnz_b))?;
        let run = detokenize(rsym, raw)? as usize;
        let new_pos = pos
            .checked_add(run)
            .ok_or(DecodeError::Corrupt("dct32: run overflow"))?;
        if new_pos >= 1024 {
            return Err(DecodeError::Corrupt("dct32: позиция AC вне блока"));
        }
        pos = new_pos;
        let lsym = bank.decode(dec, level_ctx_v7(pos_bucket32(pos), lvl_bucket(prev_mag)))?;
        let mag = detokenize(lsym, raw)?.wrapping_add(1);
        let sign = raw.read(1)?;
        let level = if sign == 1 { -(mag as i32) } else { mag as i32 };
        let index = scan[pos];
        freq[index] = level as f32 * f32::from(qmat32[index]);
        prev_mag = mag;
        nnz += 1;
        pos += 1;
    }
    st.prev_nnz = nnz_bucket(nnz / 16);
    Ok(dc_token)
}

#[allow(clippy::too_many_arguments)]
fn decode_node8(
    bank: &mut ModelBank,
    dec: &mut RangeDecoder<'_>,
    raw: &mut BitReader<'_>,
    recon: &mut [i16],
    cfl_luma: Option<&[i16]>,
    w: usize,
    h: usize,
    bx: usize,
    by: usize,
    qmat: &[u16; 64],
    qmat4: &[u16; 16],
    st: &mut CtxV7,
) -> Result<(), DecodeError> {
    match bank.decode(dec, CTX7_SPLIT8)? {
        SPLIT_WHOLE => {
            let mode = bank.decode(dec, CTX7_MODE)?;
            if mode >= mode_limit_v7(cfl_luma.is_some()) {
                return Err(DecodeError::Corrupt("dct8: неизвестная мода предикции"));
            }
            let tx = bank.decode(dec, CTX7_TX)?;
            if tx >= N_TX_V7 {
                return Err(DecodeError::Corrupt("dct8: неизвестный transform"));
            }
            let b = border(recon, w, h, bx, by);
            let pred = if cfl_alpha_q4(mode).is_some() {
                let luma =
                    gather_block_i32(cfl_luma.expect("CfL mode requires luma"), w, h, bx, by);
                predict_cfl(&luma, predict_block(&b, MODE_DC)[0], mode)
            } else {
                predict_block(&b, mode)
            };
            let mut freq = [0f32; 64];
            let mut spatial = [0f32; 64];
            let dc = decode_coeffs_v7(bank, dec, raw, qmat, tx_scan8(tx), &mut freq, st)?;
            freq[0] = dc as f32 * f32::from(qmat[0]);
            inverse_tx8(&freq, &mut spatial, tx);
            store_block(recon, w, h, bx, by, &spatial, &pred);
        }
        SPLIT_QUAD => {
            let mut freq = [0f32; 16];
            let mut spatial = [0f32; 16];
            for (qx, qy) in child_blocks4(bx, by, w, h) {
                let mode = bank.decode(dec, CTX7_MODE)?;
                if mode >= mode_limit_v7(cfl_luma.is_some()) {
                    return Err(DecodeError::Corrupt("dct4: неизвестная мода предикции"));
                }
                let tx = bank.decode(dec, CTX7_TX)?;
                if tx >= N_TX_V7 {
                    return Err(DecodeError::Corrupt("dct4: неизвестный transform"));
                }
                let b = border4(recon, w, h, qx, qy);
                let pred = if cfl_alpha_q4(mode).is_some() {
                    let luma =
                        gather_block4_i32(cfl_luma.expect("CfL mode requires luma"), w, h, qx, qy);
                    predict_cfl(&luma, predict_block4(&b, MODE_DC)[0], mode)
                } else {
                    predict_block4(&b, mode)
                };
                let dc = decode_coeffs4_v7(bank, dec, raw, qmat4, tx_scan4(tx), &mut freq, st)?;
                freq[0] = dc as f32 * f32::from(qmat4[0]);
                inverse_tx4(&freq, &mut spatial, tx);
                store_block4(recon, w, h, qx, qy, &spatial, &pred);
            }
        }
        _ => return Err(DecodeError::Corrupt("dct8: неизвестное split-решение")),
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn decode_node16(
    bank: &mut ModelBank,
    dec: &mut RangeDecoder<'_>,
    raw: &mut BitReader<'_>,
    recon: &mut [i16],
    cfl_luma: Option<&[i16]>,
    w: usize,
    h: usize,
    sbx: usize,
    sby: usize,
    qmat: &[u16; 64],
    qmat4: &[u16; 16],
    qmat16: &[u16; 256],
    st: &mut CtxV7,
) -> Result<(), DecodeError> {
    match bank.decode(dec, CTX7_SPLIT)? {
        SPLIT_WHOLE => {
            let mode = bank.decode(dec, CTX7_MODE)?;
            if mode >= mode_limit_v7(cfl_luma.is_some()) {
                return Err(DecodeError::Corrupt("dct16: неизвестная мода предикции"));
            }
            let tx = bank.decode(dec, CTX7_TX)?;
            if tx >= N_TX_V7 {
                return Err(DecodeError::Corrupt("dct16: неизвестный transform"));
            }
            let b = border16(recon, w, h, sbx, sby);
            let pred = if cfl_alpha_q4(mode).is_some() {
                let luma =
                    gather_block16_i32(cfl_luma.expect("CfL mode requires luma"), w, h, sbx, sby);
                predict_cfl(&luma, predict_block16(&b, MODE_DC)[0], mode)
            } else {
                predict_block16(&b, mode)
            };
            let mut freq = [0f32; 256];
            let mut spatial = [0f32; 256];
            let dc = decode_coeffs16_v7(bank, dec, raw, qmat16, tx_scan16(tx), &mut freq, st)?;
            freq[0] = dc as f32 * f32::from(qmat16[0]);
            inverse_tx16(&freq, &mut spatial, tx);
            store_block16(recon, w, h, sbx, sby, &spatial, &pred);
        }
        SPLIT_QUAD => {
            for (bx, by) in sub_blocks(sbx, sby, w, h) {
                decode_node8(
                    bank, dec, raw, recon, cfl_luma, w, h, bx, by, qmat, qmat4, st,
                )?;
            }
        }
        _ => return Err(DecodeError::Corrupt("dct16: неизвестное split-решение")),
    }
    Ok(())
}

pub(super) fn decode_tile_plane(
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
    let root_cols = w.div_ceil(32);
    let root_rows = h.div_ceil(32);
    let qmat4 = quant_matrix4(qmat);
    let qmat16 = quant_matrix16(qmat);
    let qmat32 = quant_matrix32(qmat);
    let mut recon = vec![0i16; w * h];
    let mut st = CtxV7::default();
    let mut freq32 = Box::new([0f32; 1024]);
    let mut spatial32 = Box::new([0f32; 1024]);

    for ry in 0..root_rows {
        for rx in 0..root_cols {
            match bank.decode(dec, CTX7_SPLIT32)? {
                SPLIT_WHOLE => {
                    let mode = bank.decode(dec, CTX7_MODE)?;
                    if mode >= mode_limit_v7(cfl_luma.is_some()) {
                        return Err(DecodeError::Corrupt("dct32: неизвестная мода предикции"));
                    }
                    let tx = bank.decode(dec, CTX7_TX)?;
                    if tx >= N_TX_V7 {
                        return Err(DecodeError::Corrupt("dct32: неизвестный transform"));
                    }
                    let b = border32(&recon, w, h, rx, ry);
                    let pred = if cfl_alpha_q4(mode).is_some() {
                        let luma = gather_block32_i32(
                            cfl_luma.expect("CfL mode requires luma"),
                            w,
                            h,
                            rx,
                            ry,
                        );
                        predict_cfl(&luma, predict_block32(&b, MODE_DC)[0], mode)
                    } else {
                        predict_block32(&b, mode)
                    };
                    let dc = decode_coeffs32_v7(
                        bank,
                        dec,
                        raw,
                        &qmat32,
                        tx_scan32(tx),
                        &mut freq32,
                        &mut st,
                    )?;
                    freq32[0] = dc as f32 * f32::from(qmat32[0]);
                    inverse_tx32(&freq32, &mut spatial32, tx);
                    store_block32(&mut recon, w, h, rx, ry, &spatial32, &pred);
                }
                SPLIT_QUAD => {
                    for (sbx, sby) in child_nodes16(rx, ry, w, h) {
                        decode_node16(
                            bank, dec, raw, &mut recon, cfl_luma, w, h, sbx, sby, qmat, &qmat4,
                            &qmat16, &mut st,
                        )?;
                    }
                }
                _ => return Err(DecodeError::Corrupt("dct32: неизвестное split-решение")),
            }
        }
    }
    Ok(recon)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::arith::RangeEncoder;
    use crate::dct::{BASE_CHROMA, BASE_LUMA, quant_matrix};

    #[test]
    fn smooth_predictor_is_integer_exact_at_4_and_32() {
        let b4 = Border4 {
            above: [0; 8],
            left: [255; 4],
            corner: 127,
        };
        let p4 = predict_block4(&b4, MODE_SMOOTH);
        assert_eq!([p4[0], p4[3], p4[12], p4[15]], [128, 32, 223, 128]);

        let b32 = Border32 {
            above: [0; 64],
            left: [255; 32],
            corner: 127,
        };
        let p32 = predict_block32(&b32, MODE_SMOOTH);
        assert_eq!([p32[0], p32[31], p32[992], p32[1023]], [128, 4, 251, 128]);
    }

    #[test]
    fn cfl_predictor_is_signed_and_rd_selectable() {
        let luma = core::array::from_fn::<_, 16, _>(|i| i as i32);
        let positive = predict_cfl(&luma, 128, 13);
        let negative = predict_cfl(&luma, 128, 8);
        assert_eq!([positive[0], positive[15]], [126, 130]);
        assert_eq!([negative[0], negative[15]], [130, 126]);

        let border = Border4 {
            above: [128; 8],
            left: [128; 4],
            corner: 128,
        };
        let qmat = quant_matrix(&BASE_LUMA, 90);
        let qmat4 = quant_matrix4(&qmat);
        let (mode, _, _, _) = choose_mode4(
            &positive,
            &border,
            Some(&luma),
            &qmat4,
            plane_lambda(&qmat),
            AC_BIAS,
        );
        assert_eq!(mode, 13);
    }

    #[test]
    fn cfl_plane_decoder_matches_encoder_reconstruction() {
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
        let qmat = quant_matrix(&BASE_CHROMA, 75);
        let mut syms = Vec::new();
        let mut raw = BitWriter::new();
        let expected = encode_tile_plane(&chroma, Some(&luma), w, h, &qmat, &mut syms, &mut raw);

        let (groups, kinds) = ctx_meta_v7();
        let mut enc_bank = ModelBank::new(groups.clone(), kinds.clone());
        let mut enc = RangeEncoder::new();
        for &(ctx, sym) in &syms {
            enc_bank.encode(&mut enc, ctx, sym);
        }
        let tokens = enc.finish();
        let raw = raw.finish();

        let mut dec_bank = ModelBank::new(groups, kinds);
        let mut dec = RangeDecoder::new(&tokens).unwrap();
        let mut raw = BitReader::new(&raw);
        let actual =
            decode_tile_plane(&mut dec_bank, &mut dec, &mut raw, w, h, Some(&luma), &qmat).unwrap();
        assert_eq!(actual, expected);
        assert_eq!(dec.consumed(), tokens.len());
        assert_eq!(raw.unread_bytes(), 0);
    }

    #[test]
    fn flat_root_uses_whole32() {
        let (w, h) = (64, 64);
        let buf = vec![140i16; w * h];
        let qmat = quant_matrix(&BASE_LUMA, 75);
        let mut syms = Vec::new();
        let mut raw = BitWriter::new();
        encode_tile_plane(&buf, None, w, h, &qmat, &mut syms, &mut raw);
        assert_eq!(syms.first(), Some(&(CTX7_SPLIT32, SPLIT_WHOLE)));
    }

    #[test]
    fn heterogeneous_root_uses_split32() {
        let (w, h) = (32, 32);
        let mut buf = vec![128i16; w * h];
        for y in 0..16 {
            for x in 0..16 {
                buf[y * w + x] = if (x + y).is_multiple_of(2) { 0 } else { 255 };
            }
        }
        let orig = gather_block32_i32(&buf, w, h, 0, 0);
        assert_eq!(split_hint32(&orig), Some(SPLIT_QUAD));

        let qmat = quant_matrix(&BASE_LUMA, 75);
        let mut syms = Vec::new();
        let mut raw = BitWriter::new();
        encode_tile_plane(&buf, None, w, h, &qmat, &mut syms, &mut raw);
        assert_eq!(syms.first(), Some(&(CTX7_SPLIT32, SPLIT_QUAD)));
    }

    #[test]
    fn node8_reaches_both_leaf_sizes() {
        let (w, h) = (8, 8);
        let qmat = quant_matrix(&BASE_LUMA, 75);
        let qmat4 = quant_matrix4(&qmat);
        let lambda = plane_lambda(&qmat);

        let flat = vec![140i16; w * h];
        let mut recon = vec![0i16; w * h];
        let (node, _) = eval_node8(&flat, &mut recon, None, w, h, 0, 0, &qmat, &qmat4, lambda);
        assert!(matches!(node, Node8::Whole(_)));

        let mut heterogeneous = vec![128i16; w * h];
        for y in 0..4 {
            for x in 0..4 {
                heterogeneous[y * w + x] = if (x + y).is_multiple_of(2) { 0 } else { 255 };
            }
        }
        let orig = gather_block_i32(&heterogeneous, w, h, 0, 0);
        assert_eq!(split_hint8(&orig), Some(SPLIT_QUAD));
        recon.fill(0);
        let (node, _) = eval_node8(
            &heterogeneous,
            &mut recon,
            None,
            w,
            h,
            0,
            0,
            &qmat,
            &qmat4,
            lambda,
        );
        assert!(matches!(node, Node8::Split { .. }));
    }
}
