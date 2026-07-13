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
//! - затухания ∈ (0, 1] и убывают по `dt`.

use crate::fx::{Fx, int_sqrt_q32};

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
}
