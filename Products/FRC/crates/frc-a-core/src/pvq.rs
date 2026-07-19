//! PVQ — пирамидное векторное квантование формы полос (FRC-A.md, «Форма»).
//!
//! Форма подвектора — целочисленный вектор `y` с L1-нормой ровно `K`
//! (K импульсов со знаками); декодер нормирует его к единичной норме и
//! масштабирует гейном полосы. Кодовое слово — порядковый номер `y` в
//! лексикографическом перечислении (CWRS), закодированный равномерным
//! символом range coder'а: стоимость известна заранее (`⌈8·log2 V(N,K)⌉`
//! восьмых бита), поэтому rate-контроль формы точный и открытый — без
//! итеративного подбора шага квантования.
//!
//! Широкие полосы делятся рекурсивно пополам с передачей угла θ
//! (распределение энергии между половинами): подвектор кодируется одной
//! книгой только когда её мощность умещается в u64. Целочисленные
//! Q14/Q15-аппроксимации `bitexact_cos`/`bitexact_log2tan` нормативны и
//! совпадают с классическими из CELT/Opus (BSD-2; стандартные полиномы
//! четверти периода) — детерминированы на всех платформах.

use crate::qmath::{cost_e8, pow2_floor_e8};
use crate::rangecoder::{BinDecoder, BinEncoder};

/// Порог деления: подвектор с бюджетом > 512 e8 (64 бита) делится пополам,
/// иначе кодируется одной книгой — порог совпадает с ёмкостью u64-книги
/// (несатурированная мощность всегда представима). Полоса минимальной ширины
/// 8 при капе аллокации β = 64 (ровно 512 e8) кодируется без деления.
const SPLIT_BITS_E8: u32 = 512;

/// Минимальная ширина делимого подвектора (половины не уже 4 бинов).
const SPLIT_MIN_N: usize = 8;

/// Нормативный кап импульсов подвектора (защита таблиц на враждебном входе).
const K_MAX: u32 = 4096;

/// Кодирует форму подвектора `x` (энкодер, нормативный битстрим) в бюджет
/// `b_e8` (1/8 бита) и пишет квантованную ненормированную форму в `recon`
/// (нужна для детекции схлопнувшихся блоков). Возвращает потраченные
/// e8-биты — по построению всегда ≤ `b_e8`.
pub(crate) fn encode_shape(enc: &mut BinEncoder, x: &[f32], recon: &mut [f32], b_e8: u32) -> u32 {
    debug_assert_eq!(x.len(), recon.len());
    let n = x.len();
    if n >= SPLIT_MIN_N && b_e8 > SPLIT_BITS_E8 {
        let h = n / 2;
        let qn = theta_qn(n, b_e8);
        // Выбор θ — решение энкодера (нормативен только символ): угол
        // распределения энергии между половинами, равномерная сетка qn+1.
        let (el, er) = (norm64(&x[..h]), norm64(&x[h..]));
        let itheta = (er.atan2(el) * (2.0 / core::f64::consts::PI) * f64::from(qn)).round() as i64;
        let itheta = itheta.clamp(0, i64::from(qn)) as u32;
        enc.encode_uniform(u64::from(itheta), u64::from(qn) + 1);

        let mut spent = cost_e8(u64::from(qn) + 1);
        let (imid, iside, delta) = theta_params(itheta, qn, n);
        let (b_l, b_r) = split_bits(b_e8 - spent, delta);
        let (xl, xr) = x.split_at(h);
        let (rl, rr) = recon.split_at_mut(h);
        let spent_l = encode_shape(enc, xl, rl, b_l);
        // Остаток левой половины (ступенчатость мощностей книг) переходит
        // правой — обе стороны вычисляют его одинаково.
        spent = spent + spent_l + encode_shape(enc, xr, rr, b_r + (b_l - spent_l));
        scale_q15(rl, imid);
        scale_q15(rr, iside);
        return spent;
    }

    let (k, table) = plan_leaf(n, b_e8);
    if k == 0 {
        recon.fill(0.0);
        return 0;
    }
    let mut y = vec![0i32; n];
    pvq_search(x, k, &mut y);
    let books = table.at(n, k);
    enc.encode_uniform(pvq_index(&y, &table), books);
    write_normalized(&y, recon);
    cost_e8(books)
}

/// Декодирует форму подвектора в `out` (ненормированную; полосу нормирует
/// вызывающий код по своему гейну). Зеркало `encode_shape` — те же деления
/// бюджета и книги; возвращает те же потраченные e8-биты.
pub(crate) fn decode_shape(dec: &mut BinDecoder, out: &mut [f32], b_e8: u32) -> u32 {
    let n = out.len();
    if n >= SPLIT_MIN_N && b_e8 > SPLIT_BITS_E8 {
        let h = n / 2;
        let qn = theta_qn(n, b_e8);
        let itheta = dec.decode_uniform(u64::from(qn) + 1) as u32;

        let mut spent = cost_e8(u64::from(qn) + 1);
        let (imid, iside, delta) = theta_params(itheta, qn, n);
        let (b_l, b_r) = split_bits(b_e8 - spent, delta);
        let (ol, or_) = out.split_at_mut(h);
        let spent_l = decode_shape(dec, ol, b_l);
        spent = spent + spent_l + decode_shape(dec, or_, b_r + (b_l - spent_l));
        scale_q15(ol, imid);
        scale_q15(or_, iside);
        return spent;
    }

    let (k, table) = plan_leaf(n, b_e8);
    if k == 0 {
        out.fill(0.0);
        return 0;
    }
    let books = table.at(n, k);
    let idx = dec.decode_uniform(books);
    let mut y = vec![0i32; n];
    pvq_deindex(idx, k, &table, &mut y);
    write_normalized(&y, out);
    cost_e8(books)
}

/// Лист пишет `y`, нормированный к единичной L2-норме: theta-цепочка выше
/// взвешивает половины гейнами Q15, что требует единичного масштаба листьев.
/// Целые `y` и суммы квадратов точны в f64 (|y| ≤ 4096, N ≤ 176) — результат
/// детерминирован на всех платформах.
fn write_normalized(y: &[i32], out: &mut [f32]) {
    let norm = y
        .iter()
        .map(|&v| f64::from(v) * f64::from(v))
        .sum::<f64>()
        .sqrt();
    debug_assert!(norm > 0.0);
    for (o, &yi) in out.iter_mut().zip(y) {
        *o = (f64::from(yi) / norm) as f32;
    }
}

/// Число шагов сетки θ: `2^clamp(2 + b/(8·N), 2, 7)` — точность угла растёт
/// с плотностью бит на коэффициент (по биту сетки на бит/коэфф), от 4 до
/// 128 шагов.
fn theta_qn(n: usize, b_e8: u32) -> u32 {
    1 << (2 + b_e8 / (8 * n as u32)).min(7)
}

/// Гейны половин (Q15) и смещение дележа бит `delta` (1/8 бита) для угла
/// `itheta` сетки `qn`. Крайние углы вырождают одну половину в точный ноль.
fn theta_params(itheta: u32, qn: u32, n: usize) -> (i32, i32, i32) {
    debug_assert!(itheta <= qn && 16384 % qn == 0);
    let is = (itheta * (16384 / qn)) as i32;
    if is == 0 {
        (32767, 0, -16384)
    } else if is == 16384 {
        (0, 32767, 16384)
    } else {
        let imid = bitexact_cos(is);
        let iside = bitexact_cos(16384 - is);
        let delta = frac_mul16(((n - 1) << 7) as i32, bitexact_log2tan(iside, imid));
        (imid, iside, delta)
    }
}

/// Делёж бюджета между половинами: `delta` сдвигает биты к громкой половине
/// (`≈ (N−1)·log2 tan θ`), результат симметричен и не выходит за пределы.
fn split_bits(b_rem: u32, delta: i32) -> (u32, u32) {
    let l = ((i64::from(b_rem) - i64::from(delta)) / 2).clamp(0, i64::from(b_rem)) as u32;
    (l, b_rem - l)
}

/// Q15-умножение с усечением: `(a·b) >> 15` (как FRAC_MUL16 CELT).
fn frac_mul16(a: i32, b: i32) -> i32 {
    (a * b) >> 15
}

/// Косинус четверти периода: вход Q14 `x ∈ [1, 16383]` (доля π/2),
/// выход Q15 `∈ [1, 32767]`. Нормативный целочисленный полином.
fn bitexact_cos(x: i32) -> i32 {
    debug_assert!((1..16384).contains(&x));
    let x2 = (4096 + x * x) >> 13;
    let poly = frac_mul16(x2, -7651 + frac_mul16(x2, 8277 + frac_mul16(-626, x2)));
    1 + (32767 - x2) + poly
}

/// `≈ 2^11 · log2(isin/icos)` для Q15-гейнов половин — нормативная
/// целочисленная аппроксимация для дележа бит.
fn bitexact_log2tan(isin: i32, icos: i32) -> i32 {
    debug_assert!(isin >= 1 && icos >= 1);
    let ls = 32 - (isin as u32).leading_zeros() as i32;
    let lc = 32 - (icos as u32).leading_zeros() as i32;
    let isin = isin << (15 - ls);
    let icos = icos << (15 - lc);
    (ls - lc) * (1 << 11) + frac_mul16(isin, frac_mul16(isin, -2597) + 7932)
        - frac_mul16(icos, frac_mul16(icos, -2597) + 7932)
}

fn scale_q15(v: &mut [f32], q15: i32) {
    let s = q15 as f32 / 32768.0;
    for x in v.iter_mut() {
        *x *= s;
    }
}

fn norm64(v: &[f32]) -> f64 {
    v.iter()
        .map(|&x| f64::from(x) * f64::from(x))
        .sum::<f64>()
        .sqrt()
}

/// Таблица `V(d, j)` — число целочисленных векторов размерности `d` с
/// L1-нормой ровно `j` (знаки учтены): `V(d,j) = V(d−1,j) + V(d,j−1) +
/// V(d−1,j−1)`, `V(d,0) = 1`, `V(0,j>0) = 0`. Насыщение в `u64::MAX`
/// означает «книга не умещается» и отвергается при выборе K.
struct VTable {
    dims: usize,
    /// Строки по числу импульсов: `rows[j·(dims+1) + d]`.
    rows: Vec<u64>,
}

impl VTable {
    fn at(&self, d: usize, j: u32) -> u64 {
        self.rows[j as usize * (self.dims + 1) + d]
    }
}

/// Наибольшее `K ≤ K_MAX`, чья книга `V(n, K)` умещается в бюджет `b_e8`;
/// возвращает K и таблицу до него включительно (для индексации CWRS).
fn plan_leaf(n: usize, b_e8: u32) -> (u32, VTable) {
    let threshold = pow2_floor_e8(b_e8);
    let w = n + 1;
    let mut rows = vec![1u64; w];
    let mut k = 0u32;
    while k < K_MAX {
        let mut cur = vec![0u64; w];
        {
            let prev = &rows[k as usize * w..][..w];
            for d in 1..w {
                cur[d] = cur[d - 1]
                    .saturating_add(prev[d])
                    .saturating_add(prev[d - 1]);
            }
        }
        let v = cur[n];
        if v == u64::MAX || v > threshold {
            break;
        }
        rows.extend_from_slice(&cur);
        k += 1;
    }
    (k, VTable { dims: n, rows })
}

/// Порядковый номер вектора в перечислении CWRS. Нормативный порядок значений
/// каждой позиции: `0, +1, −1, +2, −2, …`; вклад позиции — суммарная мощность
/// книг всех значений, идущих раньше фактического.
fn pvq_index(y: &[i32], v: &VTable) -> u64 {
    let n = y.len();
    let mut k: u32 = y.iter().map(|a| a.unsigned_abs()).sum();
    let mut idx = 0u64;
    for (pos, &val) in y.iter().enumerate() {
        let r = n - 1 - pos;
        let a = val.unsigned_abs();
        if a > 0 {
            idx += v.at(r, k);
            for i in 1..a {
                idx += 2 * v.at(r, k - i);
            }
            if val < 0 {
                idx += v.at(r, k - a);
            }
            k -= a;
        }
    }
    idx
}

/// Восстановление вектора по номеру — зеркало `pvq_index`.
fn pvq_deindex(mut idx: u64, mut k: u32, v: &VTable, out: &mut [i32]) {
    let n = out.len();
    for (pos, slot) in out.iter_mut().enumerate() {
        let r = n - 1 - pos;
        let c0 = v.at(r, k);
        if idx < c0 {
            *slot = 0;
            continue;
        }
        idx -= c0;
        let mut a = 1u32;
        loop {
            let c = v.at(r, k - a);
            if idx < c {
                *slot = a as i32;
                k -= a;
                break;
            }
            idx -= c;
            if idx < c {
                *slot = -(a as i32);
                k -= a;
                break;
            }
            idx -= c;
            a += 1;
        }
    }
    debug_assert_eq!(k, 0, "индекс не исчерпал импульсы");
}

/// Поиск K импульсов, максимизирующих корреляцию с целевой формой
/// (ненормативно — решение энкодера): грубая проекция floor'ом, затем жадное
/// добавление по одному импульсу в позицию с наибольшим приростом
/// `(corr + |x_i|)² / (E + 2·y_i + 1)`.
fn pvq_search(x: &[f32], k: u32, y: &mut [i32]) {
    let n = x.len();
    debug_assert_eq!(y.len(), n);
    y.fill(0);
    if k == 0 {
        return;
    }
    let ax: Vec<f64> = x.iter().map(|&v| f64::from(v.abs())).collect();
    let l1: f64 = ax.iter().sum();
    if l1 <= 1e-30 {
        // Цифровая тишина: детерминированное вырожденное слово.
        y[0] = k as i32;
        return;
    }
    let mut placed = 0u32;
    let mut corr = 0f64;
    let mut energy = 0f64;
    if k > 1 {
        let scale = f64::from(k) / l1;
        for (yi, &a) in y.iter_mut().zip(&ax) {
            let p = (a * scale).floor() as i64 as i32;
            *yi = p;
            placed += p as u32;
            corr += f64::from(p) * a;
            energy += f64::from(p) * f64::from(p);
        }
    }
    for _ in placed..k {
        let mut best = 0usize;
        let mut best_gain = f64::MIN;
        for (i, &a) in ax.iter().enumerate() {
            let c = corr + a;
            let e = energy + 2.0 * f64::from(y[i]) + 1.0;
            let gain = c * c / e;
            if gain > best_gain {
                best_gain = gain;
                best = i;
            }
        }
        corr += ax[best];
        energy += 2.0 * f64::from(y[best]) + 1.0;
        y[best] += 1;
    }
    for (yi, &xi) in y.iter_mut().zip(x) {
        if xi < 0.0 {
            *yi = -*yi;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn xorshift(state: &mut u32) -> f32 {
        *state ^= *state << 13;
        *state ^= *state >> 17;
        *state ^= *state << 5;
        (*state as f32 / 2f32.powi(31)) - 1.0
    }

    /// Прямой пересчёт V(n,k) перебором всех векторов.
    fn count_vectors(n: usize, k: u32) -> u64 {
        if n == 0 {
            return u64::from(k == 0);
        }
        let mut total = 0;
        for v in -(k as i64)..=(k as i64) {
            total += count_vectors(n - 1, k - v.unsigned_abs() as u32);
        }
        total
    }

    #[test]
    fn v_table_matches_brute_force() {
        let (_, table) = plan_leaf(5, 400);
        for d in 0..=5usize {
            for j in 0..=6u32 {
                if (j as usize) * (table.dims + 1) + d < table.rows.len() {
                    assert_eq!(table.at(d, j), count_vectors(d, j), "V({d},{j})");
                }
            }
        }
    }

    #[test]
    fn index_roundtrip_is_exhaustive_and_bijective() {
        for (n, k) in [(1usize, 3u32), (2, 3), (3, 4), (4, 2), (5, 3)] {
            let (kmax, table) = plan_leaf(n, 448);
            assert!(kmax >= k, "n={n}: kmax={kmax} < {k}");
            let books = table.at(n, k);
            let mut seen = vec![false; books as usize];
            let mut y = vec![0i32; n];
            for idx in 0..books {
                pvq_deindex(idx, k, &table, &mut y);
                let l1: u32 = y.iter().map(|a| a.unsigned_abs()).sum();
                assert_eq!(l1, k, "n={n} k={k} idx={idx}: {y:?}");
                assert_eq!(pvq_index(&y, &table), idx, "n={n} k={k}: {y:?}");
                assert!(!seen[idx as usize]);
                seen[idx as usize] = true;
            }
        }
    }

    #[test]
    fn plan_leaf_respects_budget_and_grows_with_bits() {
        let mut prev_k = 0;
        for b in [0u32, 8, 16, 64, 128, 256, 448] {
            let (k, table) = plan_leaf(8, b);
            assert!(k >= prev_k, "b={b}: K не монотонен");
            prev_k = k;
            if k > 0 {
                assert!(cost_e8(table.at(8, k)) <= b, "b={b}: книга дороже бюджета");
            }
        }
        // 1 бит/коэфф (β=8) всегда даёт хотя бы один импульс — инвариант «полоса
        // с β > 0 не бывает пустой».
        for n in [4usize, 8, 16, 32, 96, 176] {
            let (k, _) = plan_leaf(n, 8 * n as u32);
            assert!(k >= 1, "n={n}: K=0 при 1 бит/коэфф");
        }
    }

    #[test]
    fn search_places_exactly_k_pulses_with_signs() {
        let mut state = 0x9E37_79B9u32;
        for n in [1usize, 4, 16, 33] {
            for k in [1u32, 2, 7, 40] {
                let x: Vec<f32> = (0..n).map(|_| xorshift(&mut state)).collect();
                let mut y = vec![0i32; n];
                pvq_search(&x, k, &mut y);
                let l1: u32 = y.iter().map(|a| a.unsigned_abs()).sum();
                assert_eq!(l1, k, "n={n} k={k}");
                for (yi, xi) in y.iter().zip(&x) {
                    assert!(*yi == 0 || (*yi > 0) == (*xi >= 0.0), "sign mismatch");
                }
            }
        }
        // Вся энергия в одном бине — все импульсы туда же.
        let mut y = vec![0i32; 8];
        let mut x = vec![0f32; 8];
        x[3] = -0.7;
        pvq_search(&x, 5, &mut y);
        assert_eq!(y[3], -5);
    }

    #[test]
    fn shape_roundtrip_including_splits() {
        let mut state = 0x51AB_2026u32;
        for &(n, b) in &[
            (4usize, 100u32),
            (8, 200),
            (8, 448),
            (16, 600),
            (32, 1200),
            (96, 3000),
            (176, 8000),
            (176, 11264),
        ] {
            let x: Vec<f32> = (0..n).map(|_| xorshift(&mut state)).collect();
            let mut recon = vec![0f32; n];
            let mut enc = BinEncoder::new();
            let spent_enc = encode_shape(&mut enc, &x, &mut recon, b);
            assert!(spent_enc <= b, "n={n} b={b}: spent {spent_enc}");
            let stream = enc.finish();
            assert!(
                stream.len() as u32 * 8 * 8 <= b + 40 * 8 + 8 * 8,
                "n={n} b={b}: поток {} байт при бюджете {b} e8",
                stream.len()
            );

            let mut dec = BinDecoder::new(&stream);
            let mut out = vec![0f32; n];
            let spent_dec = decode_shape(&mut dec, &mut out, b);
            assert!(!dec.overrun(), "n={n} b={b}");
            assert_eq!(spent_enc, spent_dec, "n={n} b={b}: рассинхрон учёта");
            assert_eq!(recon, out, "n={n} b={b}: формы не совпали");
            if b >= 8 * n as u32 {
                assert!(
                    out.iter().any(|&v| v != 0.0),
                    "n={n} b={b}: форма пуста при β ≥ 1 бит/коэфф"
                );
            }
        }
    }

    /// Качество квантования растёт с бюджетом (корреляция decoded/target).
    #[test]
    fn shape_quality_improves_with_bits() {
        let n = 96usize;
        let mut state = 0xABCD_0001u32;
        let x: Vec<f32> = (0..n).map(|_| xorshift(&mut state)).collect();
        let mut prev_corr = -1.0f64;
        for b in [8 * 96u32, 16 * 96, 32 * 96, 64 * 96] {
            let mut recon = vec![0f32; n];
            let mut enc = BinEncoder::new();
            encode_shape(&mut enc, &x, &mut recon, b);
            let nx = norm64(&x);
            let nr = norm64(&recon);
            let dot: f64 = x
                .iter()
                .zip(&recon)
                .map(|(&a, &b)| f64::from(a) * f64::from(b))
                .sum();
            let corr = dot / (nx * nr);
            assert!(
                corr > prev_corr - 0.01,
                "b={b}: корреляция упала ({corr:.4} после {prev_corr:.4})"
            );
            prev_corr = corr;
        }
        assert!(prev_corr > 0.95, "64 e8/coeff должно давать corr > 0.95");
    }

    #[test]
    fn theta_helpers_are_sane() {
        // Домен фактических вызовов: is = itheta·(16384/qn), qn ≤ 128 →
        // is ∈ [128, 16256]. cos убывает, крайние значения близки к 1 и 0.
        assert!(bitexact_cos(128) > 32700);
        assert!(bitexact_cos(16256) < 500);
        let mut prev = i32::MAX;
        for x in (128..=16256).step_by(37) {
            let c = bitexact_cos(x);
            assert!((1..=32767).contains(&c), "cos({x}) = {c}");
            assert!(c <= prev, "cos не монотонен в {x}");
            prev = c;
        }
        // log2tan антисимметричен и растёт с отношением сторон.
        assert_eq!(bitexact_log2tan(100, 100), 0);
        assert!(bitexact_log2tan(200, 100) > 0);
        assert_eq!(bitexact_log2tan(200, 100), -bitexact_log2tan(100, 200),);
        // 2^11·log2(2) = 2048 с точностью аппроксимации.
        let one_octave = bitexact_log2tan(200, 100);
        assert!(
            (one_octave - 2048).abs() < 16,
            "log2tan(2:1) = {one_octave}"
        );
    }

    /// Уголовая сетка: у крайних θ одна половина — точный ноль.
    #[test]
    fn extreme_theta_zeroes_one_half() {
        let n = 16usize;
        let b = 800u32;
        let mut x = vec![0f32; n];
        for v in x.iter_mut().take(n / 2) {
            *v = 0.5; // вся энергия слева
        }
        let mut recon = vec![0f32; n];
        let mut enc = BinEncoder::new();
        encode_shape(&mut enc, &x, &mut recon, b);
        assert!(recon[..n / 2].iter().any(|&v| v != 0.0));
        assert!(recon[n / 2..].iter().all(|&v| v == 0.0));
    }
}
