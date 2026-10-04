//! Bridging-скоринг community notes L3 (FGP §6.2) — детерминированная матричная
//! факторизация на Q32.32.
//!
//! Модель (FGP §6.2 L3, класс Community Notes):
//!
//! ```text
//! r̂(u, n) = μ + b_u + b_n + f_u · f_n
//! show(n) ⇔ b_n ≥ τ ∧ оценщиков ≥ 30 ∧ представлено ≥ 2 кластеров мнений
//! ```
//!
//! Латентная ось `f` поглощает поляризацию («нравится своим»), интерсепты
//! регуляризуются **сильнее** факторов — высокая `b_n` («полезность за вычетом
//! полярности») достижима только оценками людей, обычно несогласных друг с другом.
//! Поляризованная нота дешевле объясняется осью `f` и интерсепта не зарабатывает.
//!
//! Consensus-critical требования (FGP-CRYPTO §10, FGP §8.1): вся арифметика —
//! Q32.32 [`Fx`] (float запрещён), **фиксированное число итераций** полного
//! градиентного спуска, **фиксированный порядок обхода** (по возрастанию
//! `(note, rater)`), **фиксированная инициализация из сида окна** (BLAKE3,
//! метка [`ds::BRIDGING_INIT`]). Результат бит-в-бит одинаков на native и wasm32
//! и зафиксирован вектором `governance-bridging-v1.json`; параметры по умолчанию
//! нормативны через вектор (изменение — R2, FGP Приложение A).
//!
//! Границы модуля: ядро считает модель по готовому списку оценок; принадлежность
//! оценщиков кластерам мнений (Polis) и подсчёт покрытия кластеров — данные
//! вызывающего (Governance-модуль), сюда приходят только итоговые счётчики.

use crate::ds;
use crate::fx::Fx;
use crate::merkle::Hash;

/// Оценка ноты оценщиком. Шкала `value` — Q32.32 в `[0, 1]`:
/// `0` — не полезна, `1/2` — отчасти, `1` — полезна.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Rating {
    /// Индекс оценщика в плотной нумерации окна (`0..n_raters`).
    pub rater: u32,
    /// Индекс ноты в плотной нумерации окна (`0..n_notes`).
    pub note: u32,
    /// Оценка в Q32.32.
    pub value: Fx,
}

/// Параметры обучения и показа. Стартовые значения [`BridgingParams::default`]
/// нормативны через вектор; изменение — R2 (FGP Приложение A).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct BridgingParams {
    /// Число итераций полного градиентного спуска (фиксировано — §10).
    pub iterations: u32,
    /// Скорость обучения (Q32.32).
    pub learning_rate: Fx,
    /// L2-регуляризация интерсептов `μ`, `b_u`, `b_n` (сильная — консервативные ноты).
    pub lambda_intercept: Fx,
    /// L2-регуляризация факторов `f_u`, `f_n` (слабая — поляризация уходит в ось).
    pub lambda_factor: Fx,
    /// Порог показа `τ` для `b_n` (FGP §6.2 L3: 0.4).
    pub tau: Fx,
    /// Минимум оценщиков ноты (FGP §6.2 L3: 30).
    pub min_raters: u32,
    /// Минимум представленных кластеров мнений (FGP §6.2 L3: 2).
    pub min_clusters: u32,
}

impl Default for BridgingParams {
    fn default() -> Self {
        BridgingParams {
            iterations: 256,
            learning_rate: Fx::from_ratio(1, 16),
            lambda_intercept: Fx::from_ratio(15, 100),
            lambda_factor: Fx::from_ratio(3, 100),
            tau: Fx::from_ratio(2, 5),
            min_raters: 30,
            min_clusters: 2,
        }
    }
}

/// Обученная модель окна. `note_bias[n]` — bridging-скор ноты `b_n`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct BridgingModel {
    /// Глобальный интерсепт `μ`.
    pub mu: Fx,
    /// Интерсепты оценщиков `b_u`.
    pub rater_bias: Vec<Fx>,
    /// Позиции оценщиков на оси поляризации `f_u`.
    pub rater_factor: Vec<Fx>,
    /// Интерсепты нот `b_n` («полезность за вычетом полярности»).
    pub note_bias: Vec<Fx>,
    /// Позиции нот на оси поляризации `f_n`.
    pub note_factor: Vec<Fx>,
}

/// Детерминированная инициализация фактора из сида окна: BLAKE3-выход
/// (метка `BRIDGING_INIT`) отображается в `[−2⁻⁴, 2⁻⁴]` — симметрия оси ломается
/// одинаково на всех репликах. Смещение модуло-отображения пренебрежимо и
/// детерминированно (это не секрет, а синхронизированный «шум»).
fn init_factor(seed: &Hash, kind: u8, index: u32) -> Fx {
    let mut material = [0u8; 37];
    material[..32].copy_from_slice(seed);
    material[32] = kind;
    material[33..].copy_from_slice(&index.to_le_bytes());
    let h = ds::derive(ds::BRIDGING_INIT, &material);
    let raw = u64::from_le_bytes(h[..8].try_into().expect("8 байт"));
    const SPAN: u64 = (1 << 29) + 1; // [−2²⁸, 2²⁸] в битах Q32.32 = [−1/16, 1/16]
    Fx::from_bits((raw % SPAN) as i64 - (1 << 28))
}

/// Среднее градиента по числу наблюдений (точная сумма уже в `acc`).
fn mean(acc: Fx, count: u32) -> Fx {
    if count == 0 {
        return Fx::ZERO;
    }
    acc / Fx::from_int(count as i32)
}

/// Обучить модель окна на списке оценок.
///
/// Оценки с индексами вне `n_raters`/`n_notes` отбрасываются (детерминированно);
/// валидация принадлежности оценок окну — забота вызывающего. Сущности без
/// оценок остаются на инициализационных значениях (`b = 0`, `f` — из сида) и
/// порога показа не достигают.
pub fn fit(
    n_raters: u32,
    n_notes: u32,
    ratings: &[Rating],
    window_seed: &Hash,
    params: &BridgingParams,
) -> BridgingModel {
    let nr = n_raters as usize;
    let nn = n_notes as usize;

    // Фиксированный порядок обхода: по возрастанию (note, rater) — §10.
    let mut data: Vec<Rating> = ratings
        .iter()
        .copied()
        .filter(|r| r.rater < n_raters && r.note < n_notes)
        .collect();
    data.sort_unstable_by_key(|r| (r.note, r.rater));

    let mut rater_count = vec![0u32; nr];
    let mut note_count = vec![0u32; nn];
    for r in &data {
        rater_count[r.rater as usize] += 1;
        note_count[r.note as usize] += 1;
    }
    let total = data.len() as u32;

    let mut model = BridgingModel {
        mu: Fx::ZERO,
        rater_bias: vec![Fx::ZERO; nr],
        rater_factor: (0..n_raters)
            .map(|i| init_factor(window_seed, b'r', i))
            .collect(),
        note_bias: vec![Fx::ZERO; nn],
        note_factor: (0..n_notes)
            .map(|i| init_factor(window_seed, b'n', i))
            .collect(),
    };

    let lr = params.learning_rate;
    for _ in 0..params.iterations {
        let mut g_mu = Fx::ZERO;
        let mut g_rb = vec![Fx::ZERO; nr];
        let mut g_rf = vec![Fx::ZERO; nr];
        let mut g_nb = vec![Fx::ZERO; nn];
        let mut g_nf = vec![Fx::ZERO; nn];

        for r in &data {
            let u = r.rater as usize;
            let n = r.note as usize;
            let predicted = model.mu
                + model.rater_bias[u]
                + model.note_bias[n]
                + model.rater_factor[u] * model.note_factor[n];
            let e = r.value - predicted;
            g_mu = g_mu + e;
            g_rb[u] = g_rb[u] + e;
            g_nb[n] = g_nb[n] + e;
            g_rf[u] = g_rf[u] + e * model.note_factor[n];
            g_nf[n] = g_nf[n] + e * model.rater_factor[u];
        }

        // Синхронное обновление: все градиенты посчитаны от старых параметров.
        model.mu = model.mu + lr * (mean(g_mu, total) - params.lambda_intercept * model.mu);
        for u in 0..nr {
            if rater_count[u] == 0 {
                continue;
            }
            model.rater_bias[u] = model.rater_bias[u]
                + lr * (mean(g_rb[u], rater_count[u])
                    - params.lambda_intercept * model.rater_bias[u]);
            model.rater_factor[u] = model.rater_factor[u]
                + lr * (mean(g_rf[u], rater_count[u])
                    - params.lambda_factor * model.rater_factor[u]);
        }
        for n in 0..nn {
            if note_count[n] == 0 {
                continue;
            }
            model.note_bias[n] = model.note_bias[n]
                + lr * (mean(g_nb[n], note_count[n])
                    - params.lambda_intercept * model.note_bias[n]);
            model.note_factor[n] = model.note_factor[n]
                + lr * (mean(g_nf[n], note_count[n]) - params.lambda_factor * model.note_factor[n]);
        }
    }

    model
}

/// Правило показа ноты (FGP §6.2 L3): `b_n ≥ τ` **и** оценщиков ≥ минимума **и**
/// представлено ≥ минимума кластеров мнений. Недобор любого условия — нота не
/// показывается (fail-safe: отсутствие ноты, а не слабая нота).
///
/// `cluster_count` — число кластеров мнений среди оценщиков ноты (владелец
/// кластеризации — Governance-модуль, Polis-профили).
pub fn show_note(
    note_bias: Fx,
    rater_count: u32,
    cluster_count: u32,
    params: &BridgingParams,
) -> bool {
    note_bias >= params.tau
        && rater_count >= params.min_raters
        && cluster_count >= params.min_clusters
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sortition;

    const CLUSTER: u32 = 20; // оценщики 0..20 — кластер A, 20..40 — кластер B
    const N_RATERS: u32 = 2 * CLUSTER;

    fn seed() -> Hash {
        sortition::window_seed(b"bridging-test-sth", b"anchor")
    }

    /// Три ноты: консенсусно-полезная, поляризованная, консенсусно-бесполезная.
    fn scenario() -> Vec<Rating> {
        let mut ratings = Vec::new();
        for u in 0..N_RATERS {
            let in_a = u < CLUSTER;
            ratings.push(Rating {
                rater: u,
                note: 0,
                value: Fx::ONE,
            });
            ratings.push(Rating {
                rater: u,
                note: 1,
                value: if in_a { Fx::ONE } else { Fx::ZERO },
            });
            ratings.push(Rating {
                rater: u,
                note: 2,
                value: Fx::ZERO,
            });
        }
        ratings
    }

    #[test]
    fn bridging_property_separates_consensus_from_polarization() {
        let params = BridgingParams::default();
        let model = fit(N_RATERS, 3, &scenario(), &seed(), &params);

        // Консенсусная нота зарабатывает интерсепт выше порога.
        assert!(
            model.note_bias[0] >= params.tau,
            "consensus b_n = {:?}",
            model.note_bias[0]
        );
        // Поляризованная — большинства в 50 % не хватает: полярность уходит в ось f.
        assert!(
            model.note_bias[1] < params.tau,
            "polarized b_n = {:?}",
            model.note_bias[1]
        );
        // Консенсусно-бесполезная — отрицательный интерсепт.
        assert!(model.note_bias[2] < Fx::ZERO);

        // Ось поляризации: кластеры по разные стороны, нота 1 выражена на оси.
        let a = model.rater_factor[0];
        let b = model.rater_factor[CLUSTER as usize];
        let n1 = model.note_factor[1];
        assert!(a * n1 > Fx::ZERO, "кластер A тянет ноту 1 вверх");
        assert!(b * n1 < Fx::ZERO, "кластер B тянет ноту 1 вниз");
        // Поляризованная нота выражена на оси минимум вдвое сильнее консенсусных
        // (их остаточная нагрузка −a·β/(λ_f+a²) законна, но заметно меньше).
        assert!(n1.abs() > model.note_factor[0].abs() * Fx::TWO);
        assert!(n1.abs() > model.note_factor[2].abs() * Fx::TWO);
    }

    #[test]
    fn fit_is_deterministic() {
        let params = BridgingParams::default();
        let a = fit(N_RATERS, 3, &scenario(), &seed(), &params);
        let b = fit(N_RATERS, 3, &scenario(), &seed(), &params);
        assert_eq!(a, b);
        // Порядок входного списка не влияет: обход фиксирован сортировкой.
        let mut reversed = scenario();
        reversed.reverse();
        assert_eq!(fit(N_RATERS, 3, &reversed, &seed(), &params), a);
    }

    #[test]
    fn different_seed_changes_axis_not_verdicts() {
        let params = BridgingParams::default();
        let other_seed = sortition::window_seed(b"other-sth", b"anchor");
        let m1 = fit(N_RATERS, 3, &scenario(), &seed(), &params);
        let m2 = fit(N_RATERS, 3, &scenario(), &other_seed, &params);
        // Вердикты показа совпадают; сами оси могут отличаться (знак произволен).
        for n in 0..3usize {
            assert_eq!(
                m1.note_bias[n] >= params.tau,
                m2.note_bias[n] >= params.tau,
                "нота {n}"
            );
        }
    }

    #[test]
    fn show_rule_enforces_all_three_conditions() {
        let params = BridgingParams::default();
        let good = Fx::from_ratio(1, 2); // b_n = 0.5 ≥ τ
        assert!(show_note(good, 40, 2, &params));
        assert!(!show_note(good, 29, 2, &params), "мало оценщиков");
        assert!(!show_note(good, 40, 1, &params), "один кластер");
        assert!(!show_note(Fx::from_ratio(1, 3), 40, 2, &params), "ниже τ");
    }

    #[test]
    fn invalid_indices_are_dropped_and_empty_is_total() {
        let params = BridgingParams::default();
        let empty = fit(4, 2, &[], &seed(), &params);
        assert_eq!(empty.mu, Fx::ZERO);
        assert!(empty.note_bias.iter().all(|&b| b == Fx::ZERO));

        let stray = [Rating {
            rater: 99,
            note: 0,
            value: Fx::ONE,
        }];
        let model = fit(4, 2, &stray, &seed(), &params);
        assert_eq!(model.note_bias[0], Fx::ZERO);
    }
}
