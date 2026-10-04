//! Quality-gates полигона: пороги по объективным метрикам на курируемом
//! подмножестве корпуса. Пороги выставлены с запасом ~25–35% от замеров
//! эталонной реализации — ловят регрессии кодека, не флейкая на шуме
//! платформенных float-различий.
//!
//! Обновление порогов после осознанного улучшения кодека:
//! `cargo run --release -p frc-a-polygon -- run` и перенос новых значений
//! с тем же запасом.

use std::sync::OnceLock;

use frc_a_polygon::corpus::{self, CorpusItem};
use frc_a_polygon::runner::{self, EncoderVariant};

fn corpus_cache() -> &'static [CorpusItem] {
    static CORPUS: OnceLock<Vec<CorpusItem>> = OnceLock::new();
    CORPUS.get_or_init(corpus::full_corpus)
}

fn item(name: &str) -> &'static CorpusItem {
    corpus_cache()
        .iter()
        .find(|i| i.name == name)
        .unwrap_or_else(|| panic!("нет кейса {name}"))
}

struct Gate {
    item: &'static str,
    kbps: u32,
    min_seg_snr: Option<f64>,
    max_nmr: Option<f64>,
    max_band_lsd: Option<f64>,
    max_pre_echo: Option<f64>,
    max_ild_err: Option<f64>,
    max_abs_side_drift: Option<f64>,
}

const fn gate(item: &'static str, kbps: u32) -> Gate {
    Gate {
        item,
        kbps,
        min_seg_snr: None,
        max_nmr: None,
        max_band_lsd: None,
        max_pre_echo: None,
        max_ild_err: None,
        max_abs_side_drift: None,
    }
}

/// Пороги: замер v0.6 (2026-07) с запасом. Комментарий — замеренное значение.
fn gates() -> Vec<Gate> {
    vec![
        // Речь — главный сценарий Flora (E2E-голосовые).
        Gate {
            min_seg_snr: Some(30.0),   // 35.1
            max_nmr: Some(21.0),       // 17.5
            max_band_lsd: Some(1.1),   // 0.69
            max_pre_echo: Some(-35.0), // −45.6
            ..gate("speech_male_48k", 48)
        },
        Gate {
            min_seg_snr: Some(15.0), // 19.7
            max_nmr: Some(27.0),     // 23.2
            ..gate("speech_female_48k", 24)
        },
        Gate {
            min_seg_snr: Some(30.0), // 35.1
            max_nmr: Some(18.0),     // 13.9
            ..gate("speech_male_44k1", 48)
        },
        // Транзиенты: pre-echo обязан оставаться глубоко под атакой.
        Gate {
            max_pre_echo: Some(-45.0), // −55.7
            min_seg_snr: Some(7.0),    // 10.7
            ..gate("castanets_48k", 48)
        },
        Gate {
            max_pre_echo: Some(-50.0), // −62.5
            min_seg_snr: Some(15.0),   // 20.5
            ..gate("castanets_48k", 96)
        },
        Gate {
            max_band_lsd: Some(1.2), // 0.84
            max_nmr: Some(16.0),     // 12.3
            ..gate("applause_48k", 96)
        },
        Gate {
            min_seg_snr: Some(23.0), // 28.9
            max_nmr: Some(24.0),     // 19.8
            ..gate("harpsichord_48k", 96)
        },
        Gate {
            min_seg_snr: Some(20.0), // 25.9
            ..gate("glockenspiel_48k", 48)
        },
        // Музыка.
        Gate {
            max_nmr: Some(8.0),      // 3.4
            max_band_lsd: Some(0.2), // 0.04
            ..gate("pad_chord_48k", 48)
        },
        Gate {
            min_seg_snr: Some(36.0), // 41.8
            ..gate("edm_48k", 48)
        },
        Gate {
            max_nmr: Some(17.0),     // 14.0
            min_seg_snr: Some(24.0), // 28.1
            ..gate("legacy_mix_48k", 96)
        },
        // Шумовые: сохранение энергий полос, не waveform.
        Gate {
            max_band_lsd: Some(1.4), // 1.02
            ..gate("white_noise_48k", 96)
        },
        // Стерео: образ не должен схлопываться.
        Gate {
            max_nmr: Some(9.0),            // 5.0
            max_ild_err: Some(0.6),        // 0.03
            max_abs_side_drift: Some(1.0), // 0.02
            ..gate("stereo_wide_pad_48k", 96)
        },
        Gate {
            max_ild_err: Some(3.6),        // 2.6
            max_abs_side_drift: Some(2.5), // 0.9
            ..gate("stereo_panned_clicks_48k", 96)
        },
        // Край: почти тишина не должна раздуваться.
        Gate {
            min_seg_snr: Some(18.0), // 22.9
            ..gate("near_silence_48k", 48)
        },
        Gate {
            max_nmr: Some(18.0), // 14.7
            ..gate("stress_dense_48k", 96)
        },
    ]
}

/// «Не дотягивает до минимума», NaN — тоже провал (метрика обязана существовать).
fn fails_min(v: f64, min: f64) -> bool {
    v.is_nan() || v < min
}

/// «Превышает максимум», NaN — тоже провал.
fn fails_max(v: f64, max: f64) -> bool {
    v.is_nan() || v > max
}

#[test]
fn quality_gates_hold() {
    let mut failures = Vec::new();
    for g in gates() {
        let r = runner::run_case(item(g.item), g.kbps, EncoderVariant::default());
        let q = &r.quality;
        let mut fail = |what: &str, detail: String| {
            failures.push(format!("{} @{}k: {what}: {detail}", g.item, g.kbps));
        };
        if let Some(min) = g.min_seg_snr
            && fails_min(q.seg_snr_db, min)
        {
            fail(
                "seg-SNR ниже порога",
                format!("{:.1} < {min}", q.seg_snr_db),
            );
        }
        if let Some(max) = g.max_nmr
            && fails_max(q.nmr_db, max)
        {
            fail("NMR выше порога", format!("{:.1} > {max}", q.nmr_db));
        }
        if let Some(max) = g.max_band_lsd
            && fails_max(q.band_lsd_db, max)
        {
            fail(
                "band-LSD выше порога",
                format!("{:.2} > {max}", q.band_lsd_db),
            );
        }
        if let Some(max) = g.max_pre_echo {
            match q.pre_echo_db {
                Some(v) if v <= max => {}
                Some(v) => fail("pre-echo выше порога", format!("{v:.1} > {max}")),
                None => fail("pre-echo", "атаки не найдены в эталоне".into()),
            }
        }
        if let Some(max) = g.max_ild_err
            && fails_max(q.stereo_ild_err_db.unwrap_or(0.0), max)
        {
            fail(
                "ILD-ошибка выше порога",
                format!("{:.2} > {max}", q.stereo_ild_err_db.unwrap()),
            );
        }
        if let Some(max) = g.max_abs_side_drift
            && fails_max(q.side_drift_db.unwrap_or(0.0).abs(), max)
        {
            fail(
                "side-дрейф выше порога",
                format!("{:.2} > {max}", q.side_drift_db.unwrap()),
            );
        }
        // Дисциплина битрейта — для всех гейтов: не больше цели +5% +1 kbps.
        let cap = f64::from(g.kbps) * 1.05 + 1.0;
        if r.actual_kbps > cap {
            fail(
                "битрейт выше цели",
                format!("{:.1} > {cap:.1}", r.actual_kbps),
            );
        }
    }
    assert!(
        failures.is_empty(),
        "quality-gates провалены:\n{}",
        failures.join("\n")
    );
}

/// Кодек детерминирован на всём корпусе: два прогона дают идентичные пакеты
/// и идентичный декод (ловит недетерминизм HashMap/потоков/незеркальных путей).
#[test]
fn full_corpus_transcode_is_deterministic() {
    for item in corpus_cache() {
        let (dec_a, packets_a, _, _) = runner::transcode(item, 48_000, EncoderVariant::default());
        let (dec_b, packets_b, _, _) = runner::transcode(item, 48_000, EncoderVariant::default());
        assert_eq!(
            packets_a, packets_b,
            "{}: пакеты недетерминированы",
            item.name
        );
        assert_eq!(dec_a, dec_b, "{}: декод недетерминирован", item.name);
    }
}

/// Транзиентный режим не должен быть выключен эвристиками на явных атаках,
/// а его доля на стационарном материале — оставаться низкой.
#[test]
fn transient_shares_are_plausible() {
    let castanets = runner::run_case(item("castanets_48k"), 96, EncoderVariant::default());
    assert!(
        castanets.transient_share > 0.02,
        "кастаньеты должны давать транзиентные кадры: {}",
        castanets.transient_share
    );
    let pad = runner::run_case(item("pad_chord_48k"), 96, EncoderVariant::default());
    assert!(
        pad.transient_share < 0.05,
        "пэд не должен быть транзиентным: {}",
        pad.transient_share
    );
}
