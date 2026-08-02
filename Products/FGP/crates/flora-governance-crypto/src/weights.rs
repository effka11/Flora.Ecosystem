//! Consensus-critical формулы FGP §4 на детерминированной Q32.32-арифметике.
//!
//! Формулы FGP на вещественных числах — пояснение семантики; **нормативна**
//! реализация этого модуля, зафиксированная вектором `governance-fgp-weights-v1.json`
//! (FGP-CRYPTO §10: спецификация арифметики — это test vectors). Все кривые
//! нормированы в базис 2; параметры калибровки задаются уже в базисе 2
//! (`beta_log2 = β·ln 2` для веса голоса — FGP §4.3).
//!
//! Инварианты (проверяются property-тестами):
//! - `vote_weight ∈ [1, w_max]`, монотонен по репутации;
//! - `effective_weight ∈ [w, w + c_d]`, монотонен по входящему потоку
//!   (верхняя граница достигается при underflow экспоненты в фикс-пойнте);
//! - затухания ∈ (0, 1] и убывают по `dt`;
//! - `pair_discount ∈ [max(δ_min, 1/2), 1]` — конституционный пол §4.7;
//! - `sample_size(n₀, N) ≤ min(n₀, N)`, монотонен по `N`.

use crate::fx::{Fx, div_rhe_i128, int_sqrt_q32, isqrt_u128};

/// Фактор экспоненциального затухания `2^(−dt/half_life)`.
///
/// Репутация: `R(u,d,t) = Σ q_i · 2^(−(t−t_i)/T_half)`, `T_half = 12 мес` (FGP §4.2);
/// conviction: `γ = 2^(−Δt/τ_half)`, `τ_half = 7 дней` (FGP §4.8).
/// `dt` и `half_life` — в одних единицах; `dt < 0` зажимается в 0,
/// `half_life ≤ 0` даёт полный распад (0).
pub fn decay_factor(dt: Fx, half_life: Fx) -> Fx {
    if half_life <= Fx::ZERO {
        return Fx::ZERO;
    }
    let dt = dt.max(Fx::ZERO);
    (-(dt / half_life)).exp2()
}

/// Значение после затухания: `value · 2^(−dt/half_life)`.
pub fn apply_decay(value: Fx, dt: Fx, half_life: Fx) -> Fx {
    value * decay_factor(dt, half_life)
}

/// Вес голоса в доменной процедуре: `w = min(1 + beta_log2 · log2(1 + R), w_max)` (FGP §4.3).
///
/// Семантически `w = 1 + β·ln(1+R)`; ядро принимает **предсвёрнутый** параметр
/// `beta_log2 = β·ln 2`, чтобы не вносить трансцендентную константу в код.
/// Отрицательная репутация зажимается в 0; результат ∈ `[1, w_max]`.
pub fn vote_weight(reputation: Fx, beta_log2: Fx, w_max: Fx) -> Fx {
    let r = reputation.max(Fx::ZERO);
    // 1 + R ≥ 1 > 0 — log2 определён всегда.
    let log_term = (Fx::ONE + r).log2().unwrap_or(Fx::ZERO);
    (Fx::ONE + beta_log2 * log_term).min(w_max)
}

/// Кап насыщения делегаций домена: `C_d = max(20, 2·√N_d)` (FGP §4.5).
///
/// `n_active` — число активных участников домена; floor до ulp Q32.32.
pub fn delegation_cap(n_active: u64) -> Fx {
    let sqrt_n = int_sqrt_q32(n_active);
    (Fx::TWO * sqrt_n).max(Fx::from_int(20))
}

/// Эффективный вес делегата: `E = w + C_d · (1 − 2^(−I/C_d))` (FGP §4.5).
///
/// `inflow` — входящий делегированный поток `I(v,d) = Σ w(u,d)·α^(h−1)`
/// (суммирование и затухание по глубине — у вызывающего). Насыщение:
/// `E ≤ w + C_d` при любом потоке (граница достигается при underflow
/// экспоненты в фикс-пойнте); отрицательный поток зажимается в 0.
pub fn effective_weight(own_weight: Fx, inflow: Fx, c_d: Fx) -> Fx {
    if c_d <= Fx::ZERO {
        return own_weight;
    }
    let inflow = inflow.max(Fx::ZERO);
    let saturated = Fx::ONE - (-(inflow / c_d)).exp2();
    own_weight + c_d * saturated
}

/// Шаг conviction-агрегата: `y' = γ·y + support` (FGP §4.8).
///
/// `gamma` — фактор затухания шага (`decay_factor(Δt, τ_half)`);
/// `support` — свежая сумма `Σ E(u,d)·s_u` за шаг.
pub fn conviction_step(y: Fx, gamma: Fx, support: Fx) -> Fx {
    y * gamma + support
}

/// Эффективный порог conviction: `θ_eff = θ_base / (1 + η·q̂)` (FGP §4.8).
///
/// `q_hat` — оценка качества предложения, зажимается в `[0, 1]`.
pub fn theta_eff(theta_base: Fx, eta: Fx, q_hat: Fx) -> Fx {
    let q = q_hat.max(Fx::ZERO).min(Fx::ONE);
    theta_base / (Fx::ONE + eta * q)
}

/// Квадратичная стоимость голоса силой `v`: `v²` кредитов (FGP §4.4).
pub fn qv_cost(votes: u32) -> u64 {
    (votes as u64) * (votes as u64)
}

/// Максимальная сила голоса при бюджете `B`: `⌊√B⌋` (FGP §4.4: `√B = 10` при `B = 100`).
pub fn max_vote_strength(budget: u64) -> u32 {
    // isqrt(u64) < 2³² — в u32 помещается всегда.
    isqrt_u128(budget as u128) as u32
}

/// Размер сэмплированной выборки с конечной поправкой популяции (FGP §5.6):
/// `n(N) = ⌈n₀ / (1 + (n₀−1)/N)⌉ = ⌈n₀·N / (N + n₀ − 1)⌉`.
///
/// `n0` — базовый размер (R2: 385, R3: 1068); `population` — размер реестра.
/// Свойства: `n ≤ min(n₀, N)`, монотонен по `N`, `n → n₀` при `N → ∞`.
pub fn sample_size(n0: u32, population: u64) -> u32 {
    if n0 == 0 || population == 0 {
        return 0;
    }
    let num = (n0 as u128) * (population as u128);
    let den = population as u128 + n0 as u128 - 1;
    (num.div_ceil(den)) as u32
}

/// Оценка панели `q_i = clamp(trimmed_mean_20%(оценки), 0, q_max)` (FGP §4.2).
///
/// Оценки сортируются, по `⌊len/5⌋` отбрасывается с каждого края (при панели
/// K = 5 — ровно по одной), среднее остатка — round-half-even. Пустой список → 0.
/// Порядок входа не влияет — функция сортирует сама (детерминизм §10).
pub fn panel_score(scores: &[Fx], q_max: Fx) -> Fx {
    if scores.is_empty() {
        return Fx::ZERO;
    }
    let mut sorted = scores.to_vec();
    sorted.sort_unstable();
    let trim = sorted.len() / 5;
    let kept = &sorted[trim..sorted.len() - trim];
    // Сумма битов точна в i128; деление — round-half-even.
    let sum: i128 = kept.iter().map(|s| s.to_bits() as i128).sum();
    let mean = Fx::from_bits(div_rhe_i128(sum, kept.len() as i128) as i64);
    mean.max(Fx::ZERO).min(q_max)
}

/// Вклад одной делегации в поток `I`: `w · α^(h−1)`; `h` вне `[1, max_depth]` → 0
/// (FGP §4.5: `α = 0.8`, глубина ≤ 2 — непрозрачные пирамиды исключены конструктивно).
pub fn delegation_contribution(weight: Fx, depth: u32, alpha: Fx, max_depth: u32) -> Fx {
    if depth == 0 || depth > max_depth {
        return Fx::ZERO;
    }
    let mut contribution = weight.max(Fx::ZERO);
    for _ in 1..depth {
        contribution = contribution * alpha;
    }
    contribution
}

/// Входящий делегированный поток `I(v, d) = Σ w(u, d) · α^(h−1)` (FGP §4.5).
///
/// `edges` — пары (вес делегирующего, глубина звена); суммирование в порядке
/// слайса (нормативно: по возрастанию id делегирующего — §10).
pub fn delegation_inflow(edges: &[(Fx, u32)], alpha: Fx, max_depth: u32) -> Fx {
    let mut inflow = Fx::ZERO;
    for &(weight, depth) in edges {
        inflow = inflow + delegation_contribution(weight, depth, alpha, max_depth);
    }
    inflow
}

/// Историческая ко-направленность пары: `joint/total ∈ [0, 1]` (FGP §4.7).
///
/// `joint` — окна, где пара голосовала со-направленно, `total` — общие окна;
/// `total = 0` → 0 (нет истории — нет дисконта).
pub fn co_direction(joint: u64, total: u64) -> Fx {
    if total == 0 {
        return Fx::ZERO;
    }
    Fx::from_ratio(joint.min(total) as i64, total as i64)
}

/// Конституционный пол дисконта: `δ ≥ 0.5` (FGP §4.7, Приложение A; сам пол — R2,
/// но не ниже 1/2 — органические сообщества единомышленников почти не задеваются).
pub fn discount_floor(configured: Fx) -> Fx {
    configured.max(Fx::from_ratio(1, 2)).min(Fx::ONE)
}

/// Корреляционный дисконт пары (FGP §4.7, по мотивам pairwise-bounded QF):
/// `δ(c) = clamp(1 − slope · max(0, c − threshold), max(δ_min, 1/2), 1)`.
///
/// Ниже `threshold` дисконта нет (`δ = 1`); выше — линейное сжатие до пола.
/// Методология оценки `c` и параметры — R2; сама кривая зафиксирована вектором.
pub fn pair_discount(correlation: Fx, threshold: Fx, slope: Fx, floor: Fx) -> Fx {
    let c = correlation.max(Fx::ZERO).min(Fx::ONE);
    let excess = (c - threshold).max(Fx::ZERO);
    (Fx::ONE - slope * excess)
        .max(discount_floor(floor))
        .min(Fx::ONE)
}

/// Суммарный вес окна с попарным дисконтом (FGP §4.7):
/// `Σ w_i − Σ_{(i,j)} (1 − δ_ij) · min(w_i, w_j)`, не ниже нуля.
///
/// `pairs` — тройки `(i, j, δ)` в порядке возрастания `(i, j)` (нормативный
/// порядок §10); `δ` дополнительно зажимается полом. Пары с `i == j` или
/// индексами вне `weights` пропускаются (валидация — на границе модуля).
/// Механически скоординированный блок сжимается суперлинейно с размером
/// (пар — k(k−1)/2); индекс коллузии = срезанная доля — tripwire FGP §7.2.
pub fn discounted_total(weights: &[Fx], pairs: &[(u32, u32, Fx)]) -> Fx {
    let mut total = Fx::ZERO;
    for &w in weights {
        total = total + w.max(Fx::ZERO);
    }
    for &(i, j, delta) in pairs {
        let (i, j) = (i as usize, j as usize);
        if i == j || i >= weights.len() || j >= weights.len() {
            continue;
        }
        let delta = discount_floor(delta.max(Fx::ZERO));
        let overlap = weights[i].max(Fx::ZERO).min(weights[j].max(Fx::ZERO));
        total = total - (Fx::ONE - delta) * overlap;
    }
    total.max(Fx::ZERO)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fx(int: i32) -> Fx {
        Fx::from_int(int)
    }

    fn approx_eq(a: Fx, b: Fx, tol_bits: i64) -> bool {
        (a.to_bits() - b.to_bits()).abs() <= tol_bits
    }

    /// Допуск 2⁻²⁰ ≈ 1e-6 — на два порядка жёстче любых калибровочных нужд.
    const TOL: i64 = 1 << 12;

    #[test]
    fn decay_halves_at_half_life() {
        assert_eq!(decay_factor(Fx::ZERO, fx(12)), Fx::ONE);
        assert_eq!(decay_factor(fx(12), fx(12)), Fx::from_ratio(1, 2));
        assert_eq!(decay_factor(fx(36), fx(12)), Fx::from_ratio(1, 8));
        assert_eq!(decay_factor(fx(-5), fx(12)), Fx::ONE);
        assert_eq!(decay_factor(fx(5), Fx::ZERO), Fx::ZERO);
        // Монотонность по dt.
        let mut prev = Fx::MAX;
        for dt in 0..40 {
            let f = decay_factor(fx(dt), fx(12));
            assert!(f < prev || (dt == 0 && f == Fx::ONE));
            assert!(f > Fx::ZERO && f <= Fx::ONE);
            prev = f;
        }
    }

    #[test]
    fn vote_weight_bounds_and_monotonicity() {
        let beta = Fx::ONE; // β·ln2 = 1
        let w_max = fx(8);
        assert_eq!(vote_weight(Fx::ZERO, beta, w_max), Fx::ONE);
        assert_eq!(vote_weight(fx(-7), beta, w_max), Fx::ONE);
        // R=1 → 1 + log2(2) = 2.
        assert!(approx_eq(vote_weight(fx(1), beta, w_max), fx(2), TOL));
        // R=127 → 1 + 7 = 8 = w_max ровно на границе.
        assert!(approx_eq(vote_weight(fx(127), beta, w_max), fx(8), TOL));
        // Кит без предела висит на капе.
        assert_eq!(vote_weight(fx(1_000_000), beta, w_max), w_max);
        let mut prev = Fx::ZERO;
        for r in 0..200 {
            let w = vote_weight(fx(r), beta, w_max);
            assert!(w >= prev && w >= Fx::ONE && w <= w_max);
            prev = w;
        }
    }

    #[test]
    fn delegation_cap_floor_is_20() {
        assert_eq!(delegation_cap(0), fx(20));
        assert_eq!(delegation_cap(100), fx(20));
        assert_eq!(delegation_cap(10_000), fx(200));
        assert_eq!(delegation_cap(1_000_000), fx(2000));
        assert!(delegation_cap(101) > fx(20));
    }

    #[test]
    fn effective_weight_saturates_below_w_plus_cap() {
        let w = fx(8);
        let c_d = fx(20);
        assert_eq!(effective_weight(w, Fx::ZERO, c_d), w);
        // I = C_d → w + C_d/2.
        assert!(approx_eq(effective_weight(w, fx(20), c_d), fx(18), TOL));
        // Асимптота: даже гигантский поток не пробивает w + C_d
        // (граница достигается ровно — underflow экспоненты, см. док функции).
        let e = effective_weight(w, fx(1_000_000), c_d);
        assert!(e <= w + c_d && e > fx(27));
        // До underflow (умеренный поток) граница строгая.
        let e_mid = effective_weight(w, fx(200), c_d);
        assert!(e_mid < w + c_d);
        // Монотонность по потоку.
        let mut prev = Fx::ZERO;
        for i in 0..100 {
            let e = effective_weight(w, fx(i * 5), c_d);
            assert!(e >= prev);
            prev = e;
        }
        assert_eq!(effective_weight(w, fx(5), Fx::ZERO), w);
    }

    #[test]
    fn conviction_converges_to_support_over_one_minus_gamma() {
        // Стационар: y* = s / (1 − γ); γ = 2^(−1/7).
        let gamma = decay_factor(fx(1), fx(7));
        let support = fx(10);
        let mut y = Fx::ZERO;
        for _ in 0..300 {
            y = conviction_step(y, gamma, support);
        }
        let expected = support / (Fx::ONE - gamma);
        assert!(
            approx_eq(y, expected, TOL * 16),
            "y={y:?} expected={expected:?}"
        );
    }

    #[test]
    fn theta_eff_halves_at_full_quality() {
        let base = fx(100);
        assert_eq!(theta_eff(base, Fx::ONE, Fx::ZERO), base);
        assert!(approx_eq(theta_eff(base, Fx::ONE, Fx::ONE), fx(50), TOL));
        // q̂ зажимается в [0, 1].
        assert_eq!(
            theta_eff(base, Fx::ONE, fx(5)),
            theta_eff(base, Fx::ONE, Fx::ONE)
        );
        assert_eq!(
            theta_eff(base, Fx::ONE, fx(-5)),
            theta_eff(base, Fx::ONE, Fx::ZERO)
        );
    }

    #[test]
    fn qv_cost_is_quadratic() {
        assert_eq!(qv_cost(0), 0);
        assert_eq!(qv_cost(1), 1);
        assert_eq!(qv_cost(5), 25);
        assert_eq!(qv_cost(10), 100);
    }

    #[test]
    fn max_vote_strength_is_floor_sqrt() {
        assert_eq!(max_vote_strength(0), 0);
        assert_eq!(max_vote_strength(1), 1);
        assert_eq!(max_vote_strength(99), 9);
        assert_eq!(max_vote_strength(100), 10);
        assert_eq!(max_vote_strength(101), 10);
        assert_eq!(max_vote_strength(u64::MAX), u32::MAX);
    }

    #[test]
    fn sample_size_finite_population_correction() {
        // N → ∞: полный n₀; N мал — почти вся популяция; границы FGP §5.6.
        assert_eq!(sample_size(385, 1_000_000_000), 385);
        assert_eq!(sample_size(385, 385), 193);
        assert_eq!(sample_size(385, 100), 80);
        assert_eq!(sample_size(385, 1), 1);
        assert_eq!(sample_size(385, 0), 0);
        assert_eq!(sample_size(0, 1000), 0);
        // ⌈1068·10000 / (10000 + 1068 − 1)⌉ = ⌈965.03⌉ = 966.
        assert_eq!(sample_size(1068, 10_000), 966);
        // Монотонность по N и границы n ≤ min(n₀, N).
        let mut prev = 0;
        for n in [1u64, 10, 100, 385, 1000, 10_000, 1_000_000] {
            let s = sample_size(385, n);
            assert!(s >= prev && s as u64 <= n && s <= 385);
            prev = s;
        }
    }

    #[test]
    fn panel_score_trims_outliers_and_clamps() {
        let q_max = fx(10);
        // K=5: усечение по одному с каждого края (FGP §4.2, панель K=5).
        let scores = [fx(3), fx(100), fx(4), fx(5), fx(0)];
        // Остаются 3, 4, 5 → среднее 4: выброс 100 не тянет оценку.
        assert_eq!(panel_score(&scores, q_max), fx(4));
        // Порядок входа не важен.
        let shuffled = [fx(100), fx(0), fx(5), fx(3), fx(4)];
        assert_eq!(panel_score(&shuffled, q_max), fx(4));
        // Кламп сверху и снизу.
        assert_eq!(panel_score(&[fx(50); 5], q_max), q_max);
        assert_eq!(panel_score(&[fx(-3); 5], q_max), Fx::ZERO);
        // Малые панели: без усечения; пустая — ноль.
        assert_eq!(panel_score(&[fx(2), fx(4)], q_max), fx(3));
        assert_eq!(panel_score(&[], q_max), Fx::ZERO);
    }

    #[test]
    fn delegation_inflow_decays_by_depth() {
        let alpha = Fx::from_ratio(4, 5); // 0.8 (1 ulp вверх в Q32.32)
        assert_eq!(delegation_contribution(fx(5), 1, alpha, 2), fx(5));
        assert!(approx_eq(
            delegation_contribution(fx(5), 2, alpha, 2),
            fx(4),
            2
        ));
        // Глубже max_depth и нулевая глубина — не учитываются.
        assert_eq!(delegation_contribution(fx(5), 3, alpha, 2), Fx::ZERO);
        assert_eq!(delegation_contribution(fx(5), 0, alpha, 2), Fx::ZERO);
        // Отрицательный вес зажимается.
        assert_eq!(delegation_contribution(fx(-5), 1, alpha, 2), Fx::ZERO);

        let inflow = delegation_inflow(&[(fx(5), 1), (fx(5), 2), (fx(5), 3)], alpha, 2);
        assert!(approx_eq(inflow, fx(9), 2));
        assert_eq!(delegation_inflow(&[], alpha, 2), Fx::ZERO);
    }

    #[test]
    fn co_direction_ratio() {
        assert_eq!(co_direction(0, 0), Fx::ZERO);
        assert_eq!(co_direction(0, 10), Fx::ZERO);
        assert_eq!(co_direction(5, 10), Fx::from_ratio(1, 2));
        assert_eq!(co_direction(10, 10), Fx::ONE);
        // joint > total зажимается (мусор на входе не делает δ > 1).
        assert_eq!(co_direction(20, 10), Fx::ONE);
    }

    #[test]
    fn pair_discount_curve_and_constitutional_floor() {
        let threshold = Fx::from_ratio(7, 10); // c₀ = 0.7
        let slope = fx(2);
        let floor = Fx::from_ratio(1, 2);
        // Ниже порога дисконта нет.
        assert_eq!(
            pair_discount(Fx::from_ratio(1, 2), threshold, slope, floor),
            Fx::ONE
        );
        assert_eq!(pair_discount(threshold, threshold, slope, floor), Fx::ONE);
        // Выше — линейное сжатие: c = 0.8 → 1 − 2·0.1 = 0.8.
        assert!(approx_eq(
            pair_discount(Fx::from_ratio(4, 5), threshold, slope, floor),
            Fx::from_ratio(4, 5),
            TOL
        ));
        // Полная корреляция упирается в пол.
        assert_eq!(pair_discount(Fx::ONE, threshold, slope, floor), floor);
        // Пол ниже 1/2 не опускается даже при таком параметре (конституция §4.7).
        assert_eq!(
            pair_discount(Fx::ONE, threshold, slope, Fx::from_ratio(1, 10)),
            Fx::from_ratio(1, 2)
        );
        // Кламп мусорного входа.
        assert_eq!(pair_discount(fx(5), threshold, slope, floor), floor);
        assert_eq!(pair_discount(fx(-5), threshold, slope, floor), Fx::ONE);
    }

    #[test]
    fn discounted_total_squeezes_blocs_not_organics() {
        let weights = [fx(4), fx(6), fx(2)];
        // Без пар — простая сумма.
        assert_eq!(discounted_total(&weights, &[]), fx(12));
        // Органическая пара (δ близка к 1) почти не задета.
        let organic = [(0u32, 1u32, Fx::from_ratio(19, 20))];
        assert_eq!(
            discounted_total(&weights, &organic),
            fx(12) - Fx::from_ratio(1, 20) * fx(4)
        );
        // Механический блок на полу δ = 1/2: срез min по каждой паре.
        let bloc = [
            (0u32, 1u32, Fx::from_ratio(1, 2)),
            (0u32, 2u32, Fx::from_ratio(1, 2)),
            (1u32, 2u32, Fx::from_ratio(1, 2)),
        ];
        // 12 − (2 + 1 + 1) = 8.
        assert_eq!(discounted_total(&weights, &bloc), fx(8));
        // δ ниже пола зажимается: тот же результат при δ = 0.
        let bloc_zero: Vec<(u32, u32, Fx)> =
            bloc.iter().map(|&(i, j, _)| (i, j, Fx::ZERO)).collect();
        assert_eq!(discounted_total(&weights, &bloc_zero), fx(8));
        // Невалидные пары пропускаются; итог не уходит ниже нуля.
        let junk = [(0u32, 0u32, Fx::ZERO), (0u32, 9u32, Fx::ZERO)];
        assert_eq!(discounted_total(&weights, &junk), fx(12));
        let tiny = [fx(1), fx(1)];
        let crush = [(0u32, 1u32, Fx::ZERO); 4];
        assert_eq!(discounted_total(&tiny, &crush), Fx::ZERO);
    }
}
