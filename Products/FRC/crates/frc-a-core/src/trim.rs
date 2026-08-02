//! Выбор трима аллокации референсным энкодером (FRC-A.md, «Аллокация»).
//!
//! **Ненормативно**: в битстрим уходит только 3-битный символ трима, декодер
//! не зеркалит это решение. Замеры v0.7 показали, что эвристика по одному
//! спектральному балансу ломает многотоновый контент (тёмный спектр толкает
//! биты к НЧ, редкий ВЧ-тон уходит в noise-fill), поэтому выбор основан на
//! перцептивной модели кадра с оценкой тональности:
//!
//! 1. **Тональность полосы** — отношение пиковой энергии бина к средней,
//!    нормированное шириной: `τ = log2(peak·W/ΣE) / log2(W) ∈ [0, 1]`
//!    (тон → 1, шум → ≲ 0.5 при любой ширине полосы).
//! 2. **Маска полосы** — растекание энергий полос кадра (15 дБ/полосу вверх,
//!    27 вниз) со смещением 18 дБ и полом −90 дБ от пика кадра. Константы
//!    согласованы с NMR-метрикой `frc-a-polygon` — трим оптимизирует тот же
//!    перцептивный прокси, которым меряется кодек.
//! 3. **Модель искажения** кандидата: кодируемая полоса — 6 дБ/бит на
//!    коэффициент (`err = E·2^(−β_e8/4)`); пропущенная — noise-fill с энергией
//!    ошибки `≈ 2E`, взвешенной тональностью (`×(1 + 1.5τ)`): замена тона
//!    шумом слышнее замены шума шумом той же энергии.
//!
//! Выбирается трим с минимальной суммой `err/mask` по полосам; аллокация
//! кандидата считается тем же нормативным `compute_alloc`, что и у декодера.
//! Ограничители (замер полигона: чистый минимум перцептивной модели меняет
//! биты слишком радикально и роняет waveform-метрики на −2…−5 дБ SNR):
//!
//! - **MSE-guard**: кандидат допустим, только если его суммарная энергия
//!   ошибки ≤ 1.15× от нейтрали (сток допуска SNR-регрессии полигона
//!   0.75 дБ) — перцептивный выигрыш не покупается за слышимую потерю
//!   waveform-точности;
//! - **диапазон** кандидатов [2, 6] — страховка от крайних тримов;
//! - **пороги входа/удержания** против нейтрали (триггер Шмитта) и
//!   гистерезис смены между не-нейтральными кандидатами;
//! - **подтверждение серии** (`TrimState`): не-нейтральный трим сигналится
//!   только после `CONFIRM_FRAMES` подряд длинных кадров с тем же
//!   предпочтением; транзиентный кадр сбрасывает счётчик, выход в нейтраль
//!   мгновенный. Замер полигона: стабильные серии решений (white noise,
//!   glockenspiel, near-silence) — источник всех выигрышей, а изолированные
//!   решения на нестационарном материале (речь у границ транзиентов,
//!   аплодисменты) — источник всплесков worst-NMR.

use crate::alloc::{TRIM_NEUTRAL, compute_alloc};
use crate::bands::{NUM_BANDS, band_range};
use crate::transform::FRAME_N;

/// Смещение порога маскирования от энергии маскера, дБ (= NMR полигона).
const MASK_OFFSET_DB: f64 = 18.0;
/// Спад растекания маскирования вверх по частоте, дБ/полосу (= NMR полигона).
const SPREAD_UP_DB: f64 = 15.0;
/// Спад растекания вниз по частоте, дБ/полосу (= NMR полигона).
const SPREAD_DOWN_DB: f64 = 27.0;
/// Пол маскирования относительно пиковой энергии полосы кадра: −90 дБ.
const ATH_REL: f64 = 1e-9;
/// Энергия ошибки noise-fill относительно энергии полосы (некоррелированный
/// шум той же энергии: E[|x − n|²] = 2E).
const NOISE_FILL_ERR: f64 = 2.0;
/// Вес тональности в штрафе noise-fill: тональная полоса (τ = 1) в 2.5 раза
/// (+4 дБ) слышнее шумовой той же энергии. Вес умеренный: он защищает тоны
/// от noise-fill (слышимые «птички»), но большие значения уводят модель от
/// NMR-прокси, который тональность не взвешивает.
const TONAL_NF_WEIGHT: f64 = 1.5;
/// Диапазон кандидатов трима: крайние значения (±0.6 бит/коэфф на краях
/// спектра за шаг) не окупаются — страховка от ошибок модели.
const TRIM_CANDIDATES: core::ops::RangeInclusive<u8> = 2..=6;
/// MSE-guard: суммарная энергия ошибки кандидата не выше 1.15× от нейтрали
/// (≈ −0.6 дБ SNR кадра — внутри допуска регрессий полигона 0.75 дБ).
const MSE_CAP: f64 = 1.15;
/// Порог входа: уход от нейтрали только при выигрыше модели ≥ 10% —
/// пограничные решения чаще расходятся с фактическим NMR, чем окупаются.
const ENTER_MARGIN: f64 = 0.90;
/// Порог удержания принятого трима против нейтрали ≥ 7% (мягче входа —
/// триггер Шмитта против мерцания на границе). Не-нейтральный трим обязан
/// оправдываться против нейтрали каждый кадр — «дожитие» устаревшего
/// решения на кадрах со слабым выигрышем даёт всплески worst-NMR.
const STAY_MARGIN: f64 = 0.93;
/// Гистерезис между не-нейтральными кандидатами: смена при выигрыше ≥ 3%.
const SWITCH_MARGIN: f64 = 0.97;
/// Кадров подряд с одинаковым не-нейтральным предпочтением до его принятия.
/// Изолированные решения (1–2 кадра) на нестационарном материале чаще
/// расходятся с фактическим NMR, чем окупаются; стабильные серии — выигрывают.
const CONFIRM_FRAMES: u32 = 3;
/// Порог цифровой тишины кадра: пиковая энергия полосы ниже — решение
/// не пересчитывается (модель вырождена, β всюду 0).
const SILENCE_E: f64 = 1e-18;

/// Состояние выбора трима между кадрами: принятый трим + счётчик
/// подтверждения нового не-нейтрального предпочтения.
#[derive(Debug, Clone)]
pub(crate) struct TrimState {
    /// Принятый (сигналящийся) трим.
    current: u8,
    /// Предпочтение, набирающее подтверждение.
    pref: u8,
    /// Длина серии кадров подряд с предпочтением `pref`.
    streak: u32,
}

impl TrimState {
    pub(crate) fn new() -> Self {
        Self {
            current: TRIM_NEUTRAL as u8,
            pref: TRIM_NEUTRAL as u8,
            streak: 0,
        }
    }

    /// Принятый трим (сигналится в кадрах, где решение не пересчитывается).
    pub(crate) fn current(&self) -> u8 {
        self.current
    }

    /// Транзиентный кадр: серия длинных кадров прервана, подтверждение
    /// начинается заново. Принятый трим не трогаем — он проверяется порогом
    /// удержания в каждом длинном кадре.
    pub(crate) fn interrupt(&mut self) {
        self.pref = self.current;
        self.streak = 0;
    }

    /// Продвижение машины подтверждения: `want` — предпочтение кадра после
    /// порогов/гистерезиса, `current_ok` — оправдан ли текущий трим против
    /// нейтрали в этом кадре. Не-нейтральное предпочтение принимается после
    /// `CONFIRM_FRAMES` подряд; выход в нейтраль — мгновенный.
    fn advance(&mut self, want: u8, current_ok: bool) -> u8 {
        let neutral = TRIM_NEUTRAL as u8;
        if want == self.current {
            self.pref = want;
            self.streak = 0;
            return self.current;
        }
        if want == neutral {
            self.pref = neutral;
            self.streak = 0;
            self.current = neutral;
            return neutral;
        }
        if self.streak > 0 && want == self.pref {
            self.streak += 1;
        } else {
            self.pref = want;
            self.streak = 1;
        }
        if self.streak >= CONFIRM_FRAMES {
            self.current = want;
            self.streak = 0;
            return want;
        }
        // Пока предпочтение не подтверждено: держим текущий трим, если он
        // ещё оправдан, иначе откатываемся в нейтраль.
        if !current_ok {
            self.current = neutral;
        }
        self.current
    }
}

/// Тональность полосы: `log2(peak·W/ΣE)/log2(W)`, кламп в [0, 1].
/// Тон концентрирует энергию в одном бине (peak·W/ΣE → W, τ → 1); у шума
/// отношение растёт лишь логарифмически с шириной (τ ≲ 0.5).
fn band_tonality(bins: &[f32]) -> f64 {
    let mut peak = 0f64;
    let mut sum = 0f64;
    for &v in bins {
        let e = f64::from(v) * f64::from(v);
        sum += e;
        peak = peak.max(e);
    }
    if sum <= 0.0 {
        return 0.0;
    }
    let w = bins.len() as f64;
    ((peak * w / sum).log2() / w.log2()).clamp(0.0, 1.0)
}

/// Маски полос плоскости: максимум растекания энергий кадра и пола ATH.
/// Зеркалит `SpectralPair::nmr` полигона (та же геометрия склонов).
fn plane_masks(energy: &[f64; NUM_BANDS], ath: f64) -> [f64; NUM_BANDS] {
    let att_up: Vec<f64> = (0..NUM_BANDS)
        .map(|d| 10f64.powf(-(MASK_OFFSET_DB + SPREAD_UP_DB * d as f64) / 10.0))
        .collect();
    let att_down: Vec<f64> = (0..NUM_BANDS)
        .map(|d| 10f64.powf(-(MASK_OFFSET_DB + SPREAD_DOWN_DB * d as f64) / 10.0))
        .collect();
    let mut masks = [ath; NUM_BANDS];
    for (b, m) in masks.iter_mut().enumerate() {
        for (j, &e) in energy.iter().enumerate() {
            let att = if j <= b {
                att_up[b - j]
            } else {
                att_down[j - b]
            };
            *m = m.max(e * att);
        }
    }
    masks
}

/// Модельное искажение кадра при данной аллокации: перцептивное Σ err/mask
/// и суммарная энергия ошибки (MSE-guard) по полосам. Тональность взвешивает
/// только перцептивный терм — MSE остаётся честной энергией ошибки.
fn model_distortion(
    energy: &[f64],
    tonality: &[f64],
    masks: &[f64],
    beta: &[u8],
    planes: usize,
) -> (f64, f64) {
    let mut d = 0f64;
    let mut mse = 0f64;
    for i in 0..planes * NUM_BANDS {
        let err = if beta[i] > 0 {
            // 6 дБ/бит на коэффициент: β_e8/8 бит → 2^(−β_e8/4) по энергии.
            energy[i] * (-(f64::from(beta[i])) / 4.0).exp2()
        } else {
            energy[i] * NOISE_FILL_ERR
        };
        let weight = if beta[i] > 0 {
            1.0
        } else {
            1.0 + TONAL_NF_WEIGHT * tonality[i]
        };
        d += err * weight / masks[i];
        mse += err;
    }
    (d, mse)
}

/// Выбор трима кадра: перебор всех сигнализируемых значений по минимуму
/// модельного искажения. `coeffs` — спектр плоскостей кодирования (M/S),
/// `q` — coarse-энергии, `alloc_budget` — бюджет аллокации формы в битах
/// (тот же, что уйдёт в `compute_alloc`), `state` — межкадровое состояние
/// (подтверждение серии, гистерезис). Вызывается только для длинных кадров:
/// в транзиентных тональность в интерливинг-домене смазана короткими блоками.
pub(crate) fn choose_trim(
    coeffs: &[f32],
    q: &[i32],
    planes: usize,
    alloc_budget: u64,
    state: &mut TrimState,
) -> u8 {
    debug_assert_eq!(coeffs.len(), planes * FRAME_N);
    debug_assert_eq!(q.len(), planes * NUM_BANDS);

    let mut energy = vec![0f64; planes * NUM_BANDS];
    let mut tonality = vec![0f64; planes * NUM_BANDS];
    for p in 0..planes {
        let plane = &coeffs[p * FRAME_N..][..FRAME_N];
        for b in 0..NUM_BANDS {
            let bins = &plane[band_range(b)];
            let e: f64 = bins.iter().map(|&v| f64::from(v) * f64::from(v)).sum();
            energy[p * NUM_BANDS + b] = e;
            tonality[p * NUM_BANDS + b] = band_tonality(bins);
        }
    }
    let peak = energy.iter().copied().fold(0f64, f64::max);
    if peak <= SILENCE_E {
        return state.current();
    }

    let ath = peak * ATH_REL;
    let mut masks = vec![0f64; planes * NUM_BANDS];
    for p in 0..planes {
        let mut pe = [0f64; NUM_BANDS];
        pe.copy_from_slice(&energy[p * NUM_BANDS..][..NUM_BANDS]);
        masks[p * NUM_BANDS..][..NUM_BANDS].copy_from_slice(&plane_masks(&pe, ath));
    }

    let neutral = TRIM_NEUTRAL as u8;
    let cur = state.current();
    let evaluate = |trim: u8| -> (f64, f64) {
        let beta = compute_alloc(q, planes, alloc_budget, trim);
        model_distortion(&energy, &tonality, &masks, &beta, planes)
    };
    let (d_neutral, mse_neutral) = evaluate(neutral);
    let mse_cap = mse_neutral * MSE_CAP;

    // Лучший допустимый кандидат: минимум перцептивной модели среди тримов
    // с энергией ошибки в пределах MSE-guard (нейтраль допустима всегда).
    let mut best = neutral;
    let mut d_best = d_neutral;
    let mut d_cur = if cur == neutral { d_neutral } else { f64::MAX };
    for t in TRIM_CANDIDATES {
        if t == neutral {
            continue;
        }
        let (d, mse) = evaluate(t);
        if mse > mse_cap {
            continue;
        }
        if t == cur {
            d_cur = d;
        }
        if d < d_best {
            best = t;
            d_best = d;
        }
    }
    // Текущий трим обязан оправдываться против нейтрали каждый кадр порогом
    // удержания — «дожитие» устаревшего решения даёт всплески worst-NMR.
    let current_ok = cur == neutral || d_cur < d_neutral * STAY_MARGIN;

    // Предпочтение кадра: лучший кандидат с порогом входа против нейтрали
    // и гистерезисом смены против ещё оправданного текущего трима.
    let mut want = if best != neutral && d_best < d_neutral * ENTER_MARGIN {
        best
    } else {
        neutral
    };
    if want != cur && cur != neutral && current_ok && d_best >= d_cur * SWITCH_MARGIN {
        want = cur;
    }
    state.advance(want, current_ok)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::energy::analyze_plane;

    /// xorshift32 — детерминированный шум тестов.
    fn noise(state: &mut u32) -> f32 {
        *state ^= *state << 13;
        *state ^= *state >> 17;
        *state ^= *state << 5;
        (*state as f32 / 2f32.powi(31)) - 1.0
    }

    fn analyze(coeffs: &[f32]) -> Vec<i32> {
        let mut q = vec![0i32; NUM_BANDS];
        let mut fine = vec![0u8; NUM_BANDS];
        let mut gains = vec![0f32; NUM_BANDS];
        analyze_plane(coeffs, &mut q, &mut fine, &mut gains);
        q
    }

    #[test]
    fn tonality_separates_tone_from_noise() {
        for b in [0usize, 8, 15, 20] {
            let w = band_range(b).len();
            let mut tone = vec![0f32; w];
            tone[w / 2] = 0.7;
            assert!(
                band_tonality(&tone) > 0.95,
                "band {b}: тон {}",
                band_tonality(&tone)
            );
            let mut state = 0xC0FF_EE00u32 ^ b as u32;
            let noisy: Vec<f32> = (0..w).map(|_| 0.5 * noise(&mut state)).collect();
            assert!(
                band_tonality(&noisy) < 0.72,
                "band {b}: шум {}",
                band_tonality(&noisy)
            );
        }
        assert_eq!(band_tonality(&[0.0; 8]), 0.0);
    }

    /// Guard-кейс v0.7: тёмный кадр (громкий НЧ-шум) + одинокий тихий ВЧ-тон.
    /// Балансовая эвристика толкала биты к НЧ и роняла тон в noise-fill;
    /// модель с тональностью обязана не опускать трим ниже нейтрали —
    /// ни в первом кадре, ни после подтверждения серии.
    #[test]
    fn lone_hf_tone_is_not_starved() {
        let mut coeffs = vec![0f32; FRAME_N];
        let mut state = 0x51EE_C401u32;
        for b in 0..12 {
            for i in band_range(b) {
                coeffs[i] = 0.5 * noise(&mut state);
            }
        }
        // Тон на −30 дБ от НЧ-шума, в предпоследней полосе.
        let hf = band_range(19);
        coeffs[hf.start + hf.len() / 2] = 0.015;
        let q = analyze(&coeffs);
        for budget in [200u64, 400, 800] {
            let mut st = TrimState::new();
            for i in 0..CONFIRM_FRAMES + 2 {
                let trim = choose_trim(&coeffs, &q, 1, budget, &mut st);
                assert!(
                    trim >= TRIM_NEUTRAL as u8,
                    "budget {budget}, кадр {i}: trim {trim} голодит ВЧ-тон"
                );
            }
        }
    }

    /// Решение детерминировано и сходится: на неизменном кадре трим перестаёт
    /// меняться после подтверждения серии.
    #[test]
    fn decision_is_deterministic_and_stable() {
        let mut coeffs = vec![0f32; FRAME_N];
        let mut state = 0xBEEF_0001u32;
        for v in coeffs.iter_mut().take(624) {
            *v = 0.3 * noise(&mut state);
        }
        let q = analyze(&coeffs);
        let run = || {
            let mut st = TrimState::new();
            (0..CONFIRM_FRAMES + 3)
                .map(|_| choose_trim(&coeffs, &q, 1, 600, &mut st))
                .collect::<Vec<_>>()
        };
        let a = run();
        assert_eq!(a, run(), "решение недетерминировано");
        let tail = &a[CONFIRM_FRAMES as usize..];
        assert!(
            tail.windows(2).all(|w| w[0] == w[1]),
            "стабильный кадр не должен менять трим после подтверждения: {a:?}"
        );
    }

    /// Цифровая тишина не трогает решение (модель вырождена).
    #[test]
    fn silence_keeps_previous_trim() {
        let coeffs = vec![0f32; FRAME_N];
        let q = analyze(&coeffs);
        for prev in 0..8u8 {
            let mut st = TrimState {
                current: prev,
                pref: prev,
                streak: 0,
            };
            assert_eq!(choose_trim(&coeffs, &q, 1, 600, &mut st), prev);
        }
    }

    /// Машина подтверждения: изолированные предпочтения отфильтрованы, серия
    /// из CONFIRM_FRAMES принимается, выход в нейтраль мгновенный, транзиент
    /// сбрасывает серию.
    #[test]
    fn confirmation_state_machine() {
        let neutral = TRIM_NEUTRAL as u8;

        // Изолированное предпочтение (1–2 кадра) не принимается.
        let mut st = TrimState::new();
        assert_eq!(st.advance(6, true), neutral);
        assert_eq!(st.advance(neutral, true), neutral);
        assert_eq!(st.advance(6, true), neutral);
        assert_eq!(st.advance(6, true), neutral);
        assert_eq!(st.advance(neutral, true), neutral);

        // Серия из CONFIRM_FRAMES подряд — принимается.
        let mut st = TrimState::new();
        for i in 0..CONFIRM_FRAMES - 1 {
            assert_eq!(st.advance(6, true), neutral, "кадр {i}");
        }
        assert_eq!(st.advance(6, true), 6);
        // Выход в нейтраль — мгновенный.
        assert_eq!(st.advance(neutral, true), neutral);

        // Транзиент посреди серии сбрасывает подтверждение.
        let mut st = TrimState::new();
        for _ in 0..CONFIRM_FRAMES - 1 {
            st.advance(2, true);
        }
        st.interrupt();
        for i in 0..CONFIRM_FRAMES - 1 {
            assert_eq!(st.advance(2, true), neutral, "кадр {i} после транзиента");
        }
        assert_eq!(st.advance(2, true), 2);

        // Потерявший оправдание текущий трим откатывается в нейтраль,
        // даже пока новое предпочтение не подтверждено.
        let mut st = TrimState::new();
        for _ in 0..CONFIRM_FRAMES {
            st.advance(6, true);
        }
        assert_eq!(st.current(), 6);
        assert_eq!(st.advance(2, false), neutral);
    }
}
