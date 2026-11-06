//! Слой A/B-ручек reference-кодера (frc-i-v14-plan.md §6.1).
//!
//! Без cargo-feature `tuning-env` любые переменные окружения игнорируются:
//! production-сборки (сервер, wasm, mobile) физически не читают env.
//! С feature чтение происходит один раз через `OnceLock`; для `version <= 13`
//! замороженные константы не переопределяются — ручки линии v14 не текут
//! в прошлые версии. Исключение — исторические `FRC_I_DQ_*`: они действуют
//! на v9+ как раньше (семантика слоя не меняется).

use crate::format::{
    VERSION_ADAPTIVE, VERSION_ASYMMETRIC_AQ, VERSION_HIER_AQ, VERSION_PERCEPTUAL_RD,
    VERSION_RATE_AWARE_RD,
};
use crate::lossy::{CsTuning, DqTuning, RdTuning, TsTuning};
use std::sync::OnceLock;

/// Порог качества, ниже которого включается сабсэмплинг цветоразностей 4:2:0.
const CHROMA420_MAX_QUALITY: u8 = 85;
/// v7.8 threshold rebalanced for scalar qmatrix and calibrated RDOQ.
const CHROMA420_MAX_QUALITY_V7: u8 = 85;
/// Порог качества, ниже которого включается деблокинг (битстрим v4):
/// при сильном квантовании блочность видна, фильтр её маскирует.
/// В env слой отдаётся как «порог»: `quality < DEBLOCK_QMAX`.
const DEBLOCK_QMAX: u8 = 45;

const DQ_STRENGTH_LUMA: f32 = 2.0;
const DQ_STRENGTH_CHROMA: f32 = 0.0;
const DQ_QUADRANT_MIN: bool = false;
const DQ_MAX_UP: i32 = 3;
const DQ_MAX_DOWN: i32 = 4;
const DQ_DEADZONE: f32 = 0.0;
const DQ_STRUCTURE_DISCOUNT: f32 = 0.9;
const DQ_UP_FLOOR: f32 = 4.0;
const DQ_STRENGTH_LUMA_V10: f32 = 2.75;
const DQ_UP_SCALE_V10: f32 = 9.0 / 11.0;
const DQ_REFINE_SCALE_V11: f32 = 1.0;
const DQ_REFINE_MAX_UP_V11: i32 = 2;
const DQ_REFINE_DEADZONE_V11: i32 = 3;
const DQ_REFINE_MAX_DOWN_V11: i32 = 0;
const DQ_REFINE_UP_FLOOR_V11: f32 = 5.0;

/// Замороженные ручки инструмента A (калибровка g26, Kodak/picsum).
/// Кадровое решение: все корни `ts = 1`, если доля корней с
/// `log2(1+activity) ≥ 2.0` не ниже 0.26; иначе все `ts = 0`.
const TS_ENABLE: bool = true;
const TS_QMAX: u8 = 100;
const TS_DQMIN: u8 = 4;
const TS_L0: f32 = 2.0;
const TS_SLOPE: f32 = 1.0;
const TS_MAX: u8 = 1;
const TS_CHROMA: bool = false;
const TS_QMIN: u8 = 0;
const TS_DQMAX: u8 = 7;
const TS_MODE: u8 = 8;
const TS_D0: f32 = 0.02;
const TS_P1: f32 = 1.5;
const TS_P2: f32 = 3.0;
const TS_P3: f32 = 99.0;
const TS_DEAD: u8 = 1;
const TS_G0: f32 = 2.5;
const TS_GF: f32 = 0.26;
const TS_GP: f32 = 1.0;
const TS_TAU: f32 = 0.15;

/// Стартовые ручки инструмента B (этап 3; потребителей до G1 нет).
#[allow(dead_code)]
const CS_ENABLE: bool = true;

/// Порог `quality <= QMAX` для 4:2:0.
pub(crate) fn chroma420_qmax(version: u8) -> u8 {
    if version >= crate::format::VERSION_FREQ_SHAPE {
        static QMAX: OnceLock<u8> = OnceLock::new();
        return *QMAX.get_or_init(|| read_or("FRC_I_CHROMA420_QMAX", CHROMA420_MAX_QUALITY));
    }
    if version >= VERSION_ADAPTIVE {
        CHROMA420_MAX_QUALITY_V7
    } else {
        CHROMA420_MAX_QUALITY
    }
}

/// Порог `quality < QMAX` для деблокинга (0 — никогда).
pub(crate) fn deblock_qmax(version: u8) -> u8 {
    if version >= crate::format::VERSION_FREQ_SHAPE {
        static QMAX: OnceLock<u8> = OnceLock::new();
        return *QMAX.get_or_init(|| read_or("FRC_I_DEBLOCK_QMAX", DEBLOCK_QMAX));
    }
    if version >= crate::format::VERSION_DEBLOCK {
        DEBLOCK_QMAX
    } else {
        0
    }
}

/// Настройки AQ по версии (v9 — симметричные силы, v10+ — асимметричные,
/// v11+ — refinement уровня 16×16).
pub(crate) fn dq_tunings(version: u8) -> (DqTuning, DqTuning) {
    static TUNINGS: OnceLock<[(DqTuning, DqTuning); 3]> = OnceLock::new();
    let per_version = TUNINGS.get_or_init(|| {
        let base = DqTuning {
            strength: 0.0,
            up_scale: 1.0,
            quadrant_min: read_or("FRC_I_DQ_QMIN", u8::from(DQ_QUADRANT_MIN)) != 0,
            max_up: read_or("FRC_I_DQ_UP", DQ_MAX_UP),
            max_down: read_or("FRC_I_DQ_DOWN", DQ_MAX_DOWN),
            deadzone: read_or("FRC_I_DQ_DZ", DQ_DEADZONE),
            structure_discount: read_or("FRC_I_DQ_SD", DQ_STRUCTURE_DISCOUNT),
            up_floor: read_or("FRC_I_DQ_UPFLOOR", DQ_UP_FLOOR),
            refine_scale: 0.0,
            refine_max_up: read_or("FRC_I_DQ_R16UP", DQ_REFINE_MAX_UP_V11),
            refine_max_down: read_or("FRC_I_DQ_R16DN", DQ_REFINE_MAX_DOWN_V11),
            refine_deadzone: read_or("FRC_I_DQ_R16DZ", DQ_REFINE_DEADZONE_V11),
            refine_up_floor: read_or("FRC_I_DQ_R16FLOOR", DQ_REFINE_UP_FLOOR_V11),
        };
        let luma_v9 = DqTuning {
            strength: read_or("FRC_I_DQ_LUMA", DQ_STRENGTH_LUMA),
            ..base
        };
        let chroma = DqTuning {
            strength: read_or("FRC_I_DQ_CHROMA", DQ_STRENGTH_CHROMA),
            ..base
        };
        let luma_v10 = DqTuning {
            strength: read_or("FRC_I_DQ_LUMA", DQ_STRENGTH_LUMA_V10),
            up_scale: read_or("FRC_I_DQ_UPSCALE", DQ_UP_SCALE_V10),
            ..luma_v9
        };
        let luma_v11 = DqTuning {
            refine_scale: read_or("FRC_I_DQ_R16", DQ_REFINE_SCALE_V11),
            ..luma_v10
        };
        [(luma_v9, chroma), (luma_v10, chroma), (luma_v11, chroma)]
    });
    let idx = if version >= VERSION_HIER_AQ {
        2
    } else {
        usize::from(version >= VERSION_ASYMMETRIC_AQ)
    };
    per_version[idx]
}

/// RD-калибровка блочного слоя по версии. Ручки `FRC_I_RD_*` действуют
/// только на v14+; v12/v13 остаются замороженными.
pub(crate) fn rd_tuning(version: u8) -> RdTuning {
    if version < VERSION_PERCEPTUAL_RD {
        return RdTuning::LEGACY;
    }
    if version < VERSION_RATE_AWARE_RD {
        return RdTuning::V12;
    }
    if version < crate::format::VERSION_FREQ_SHAPE {
        return RdTuning::V13;
    }
    static V14: OnceLock<RdTuning> = OnceLock::new();
    *V14.get_or_init(|| RdTuning {
        lambda_scale: read_or("FRC_I_RD_LAMBDA", RdTuning::V13.lambda_scale),
        ac_bias: read_or("FRC_I_RD_ACBIAS", RdTuning::V13.ac_bias),
        split8_scale: read_or("FRC_I_RD_SPLIT8", RdTuning::V13.split8_scale),
        tx_search_scale: read_or("FRC_I_RD_TXSEARCH", RdTuning::V13.tx_search_scale),
        rd_candidates: read_candidates("FRC_I_RD_CAND", RdTuning::V13.rd_candidates),
    })
}

/// Эвристика выбора индекса частотной формы (v14, §4.1). Поля — свобода
/// кодера; `chroma` по умолчанию выключен.
pub(crate) fn ts_tuning(version: u8, luma: bool) -> TsTuning {
    if version < crate::format::VERSION_FREQ_SHAPE {
        return TsTuning::DISABLED;
    }
    static TS: OnceLock<[TsTuning; 2]> = OnceLock::new();
    TS.get_or_init(|| {
        let enabled = read_or("FRC_I_TS_ENABLE", u8::from(TS_ENABLE)) != 0;
        let chroma = read_or("FRC_I_TS_CHROMA", u8::from(TS_CHROMA)) != 0;
        let base = TsTuning {
            enable: enabled,
            qmax: read_or("FRC_I_TS_QMAX", TS_QMAX),
            dqmin: read_or("FRC_I_TS_DQMIN", TS_DQMIN),
            l0: read_or("FRC_I_TS_L0", TS_L0),
            slope: read_or("FRC_I_TS_SLOPE", TS_SLOPE),
            max: read_or("FRC_I_TS_MAX", TS_MAX).min(3),
            chroma,
            qmin: read_or("FRC_I_TS_QMIN", TS_QMIN),
            dqmax: read_or("FRC_I_TS_DQMAX", TS_DQMAX),
            mode: read_or("FRC_I_TS_MODE", TS_MODE),
            d0: read_or("FRC_I_TS_D0", TS_D0),
            p1: read_or("FRC_I_TS_P1", TS_P1),
            p2: read_or("FRC_I_TS_P2", TS_P2),
            p3: read_or("FRC_I_TS_P3", TS_P3),
            dead: read_or("FRC_I_TS_DEAD", TS_DEAD).min(3),
            dqmap: read_list8("FRC_I_TS_DQMAP", [0; 8]),
            q2: read_or("FRC_I_TS_Q2", 80u8),
            q1: read_or("FRC_I_TS_Q1", 80u8),
            lambda_tilt: read_or("FRC_I_TS_LAMBDA", 1u8) != 0,
            g0: read_or("FRC_I_TS_G0", TS_G0),
            gf: read_or("FRC_I_TS_GF", TS_GF),
            gp: read_or("FRC_I_TS_GP", TS_GP),
            tau: read_or("FRC_I_TS_TAU", TS_TAU),
        };
        [
            base,
            TsTuning {
                enable: enabled && chroma,
                ..base
            },
        ]
    })[usize::from(!luma)]
}

/// Инструмент B (этап 3): per-root уточнение силы CDEF. До G1 потребителей
/// нет; слой читает ручки, чтобы свипы могли стартовать без правок кода.
#[allow(dead_code)]
pub(crate) fn cs_tuning(version: u8) -> CsTuning {
    if version < crate::format::VERSION_FREQ_SHAPE {
        return CsTuning::DISABLED;
    }
    CsTuning {
        enable: read_or("FRC_I_CS_ENABLE", u8::from(CS_ENABLE)) != 0,
    }
}

#[cfg(feature = "tuning-env")]
fn read_or<T: std::str::FromStr>(name: &str, default: T) -> T {
    std::env::var(name)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}

#[cfg(not(feature = "tuning-env"))]
fn read_or<T>(_name: &str, default: T) -> T {
    default
}

/// Список RD-кандидатов: `"4,3,2"`; невалидный список — значение по умолчанию.
#[cfg(feature = "tuning-env")]
fn read_candidates(name: &str, default: [u8; 3]) -> [u8; 3] {
    let Some(raw) = std::env::var(name).ok() else {
        return default;
    };
    let mut out = default;
    let mut count = 0usize;
    for part in raw.split(',') {
        let Ok(value) = part.trim().parse::<u8>() else {
            return default;
        };
        if count == out.len() {
            return default;
        }
        out[count] = value;
        count += 1;
    }
    if count != out.len() {
        return default;
    }
    out
}

#[cfg(not(feature = "tuning-env"))]
fn read_candidates(_name: &str, default: [u8; 3]) -> [u8; 3] {
    default
}

/// Список из восьми `u8` (`"1,1,1,1,1,0,0,0"`); невалидный — значение по умолчанию.
#[cfg(feature = "tuning-env")]
fn read_list8(name: &str, default: [u8; 8]) -> [u8; 8] {
    let Some(raw) = std::env::var(name).ok() else {
        return default;
    };
    // Разделитель `,` или `;` (стороны полигона разделяют ручки запятой).
    let values: Option<Vec<u8>> = raw
        .split([',', ';'])
        .map(|v| v.trim().parse().ok())
        .collect();
    match values {
        Some(v) if v.len() == 8 => core::array::from_fn(|i| v[i].min(3)),
        _ => default,
    }
}

#[cfg(not(feature = "tuning-env"))]
fn read_list8(_name: &str, default: [u8; 8]) -> [u8; 8] {
    default
}

/// Имена всех переменных окружения, которые читает линия v14 (плюс
/// исторические `FRC_I_DQ_*`). CLI под feature `tuning-env` сверяет с этим
/// реестром все переменные с префиксом `FRC_I_` и завершает процесс ошибкой
/// на опечатке.
#[cfg(feature = "tuning-env")]
pub fn tuning_env_registry() -> &'static [&'static str] {
    &[
        "FRC_I_CHROMA420_QMAX",
        "FRC_I_DEBLOCK_QMAX",
        "FRC_I_DQ_LUMA",
        "FRC_I_DQ_CHROMA",
        "FRC_I_DQ_QMIN",
        "FRC_I_DQ_UP",
        "FRC_I_DQ_DOWN",
        "FRC_I_DQ_DZ",
        "FRC_I_DQ_SD",
        "FRC_I_DQ_UPFLOOR",
        "FRC_I_DQ_UPSCALE",
        "FRC_I_DQ_R16",
        "FRC_I_DQ_R16UP",
        "FRC_I_DQ_R16DN",
        "FRC_I_DQ_R16DZ",
        "FRC_I_DQ_R16FLOOR",
        "FRC_I_RD_LAMBDA",
        "FRC_I_RD_ACBIAS",
        "FRC_I_RD_SPLIT8",
        "FRC_I_RD_TXSEARCH",
        "FRC_I_RD_CAND",
        "FRC_I_TS_ENABLE",
        "FRC_I_TS_QMAX",
        "FRC_I_TS_DQMIN",
        "FRC_I_TS_L0",
        "FRC_I_TS_SLOPE",
        "FRC_I_TS_MAX",
        "FRC_I_TS_CHROMA",
        "FRC_I_TS_QMIN",
        "FRC_I_TS_DQMAX",
        "FRC_I_TS_MODE",
        "FRC_I_TS_D0",
        "FRC_I_TS_P1",
        "FRC_I_TS_P2",
        "FRC_I_TS_P3",
        "FRC_I_TS_DEAD",
        "FRC_I_TS_DQMAP",
        "FRC_I_TS_Q2",
        "FRC_I_TS_Q1",
        "FRC_I_TS_LAMBDA",
        "FRC_I_TS_G0",
        "FRC_I_TS_GF",
        "FRC_I_TS_GP",
        "FRC_I_TS_TAU",
        "FRC_I_TS_TABLE",
        "FRC_I_CS_ENABLE",
        "FRC_I_CS_CAND",
    ]
}
