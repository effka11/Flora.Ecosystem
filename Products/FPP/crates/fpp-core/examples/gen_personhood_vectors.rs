//! Генератор golden-векторов метрик натуральности (FPP-SIGNALS §7).
//!
//! Пишет `Documents/test-vectors/personhood/personhood-naturalness-v1.json`.
//! Детерминирован: повторный запуск перезаписывает файл идентичным содержимым
//! (правило Documents/test-vectors/README.md).
//!
//! ```bash
//! cargo run -p fpp-core --example gen_personhood_vectors
//! ```

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use fpp_contracts::{CeremonyAnomalyFlag, NaturalnessClass, SignalEvidenceClass};
use fpp_core::{PROTOCOL_VERSION, device, piecewise, score, streams, temporal};
use serde_json::{Value, json};
use std::path::PathBuf;

fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Детерминированный материал: `len` байт `start, start+1, ...` (mod 256).
fn material(start: u8, len: usize) -> Vec<u8> {
    (0..len).map(|i| start.wrapping_add(i as u8)).collect()
}

fn out_dir() -> PathBuf {
    // crate: Products/FPP/crates/fpp-core → корень репо на 4 уровня выше.
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../Documents/test-vectors/personhood");
    std::fs::create_dir_all(&dir).expect("mkdir personhood");
    dir.canonicalize().expect("канонический путь")
}

fn class_name(class: NaturalnessClass) -> &'static str {
    match class {
        NaturalnessClass::Natural => "natural",
        NaturalnessClass::Watch => "watch",
        NaturalnessClass::Investigate => "investigate",
    }
}

fn burstiness_cases() -> Value {
    let cases: Vec<(&str, Vec<u64>)> = vec![
        ("regular_hourly", vec![3600; 12]),
        ("all_zero_degenerate", vec![0; 8]),
        ("too_few_samples", vec![60, 60, 60]),
        (
            "human_bursty",
            vec![5, 3, 8, 4, 90_000, 6, 2, 7, 86_000, 5, 4, 120_000],
        ),
        (
            "alternating_script",
            vec![60, 7200, 60, 7200, 60, 7200, 60, 7200],
        ),
        (
            "clamped_interval",
            vec![u64::MAX, 60, 60, 60, 60, 60, 60, 60],
        ),
        (
            "poisson_like",
            vec![120, 47, 310, 95, 12, 700, 260, 33, 540, 180, 76, 410],
        ),
    ];
    Value::Array(
        cases
            .into_iter()
            .map(|(name, intervals)| {
                json!({
                    "name": name,
                    "intervalsS": intervals,
                    "permille": temporal::burstiness_permille(&intervals),
                })
            })
            .collect(),
    )
}

fn hist(counts: [u64; 24]) -> temporal::HourHistogram {
    temporal::HourHistogram::new(counts)
}

fn circadian_cases() -> Value {
    let human = hist([
        2, 0, 0, 0, 0, 0, 1, 3, 5, 6, 5, 4, 5, 6, 5, 4, 5, 6, 7, 8, 9, 6, 4, 3,
    ]);
    let human_shifted = hist([
        3, 2, 0, 0, 0, 0, 0, 1, 3, 5, 6, 5, 4, 5, 6, 5, 4, 5, 6, 7, 8, 9, 6, 4,
    ]);
    let uniform = hist([10; 24]);
    let mut spike_counts = [0u64; 24];
    spike_counts[3] = 240;
    let spike = hist(spike_counts);
    let mut sparse_counts = [0u64; 24];
    sparse_counts[0] = 1;
    let sparse = hist(sparse_counts);

    let profiles = json!({
        "human": human.counts.to_vec(),
        "humanShifted": human_shifted.counts.to_vec(),
        "uniform": uniform.counts.to_vec(),
        "spike": spike.counts.to_vec(),
        "sparse": sparse.counts.to_vec(),
    });

    let named = [
        ("human", human),
        ("humanShifted", human_shifted),
        ("uniform", uniform),
        ("spike", spike),
        ("sparse", sparse),
    ];
    let per_profile: Vec<Value> = named
        .iter()
        .map(|(name, h)| {
            json!({
                "profile": name,
                "restSharePermille": h.rest_share_permille(),
                "peakSharePermille": h.peak_share_permille(),
            })
        })
        .collect();

    let similarity_pairs = [
        ("human", "human", human.similarity_permille(&human)),
        (
            "human",
            "humanShifted",
            human.similarity_permille(&human_shifted),
        ),
        ("human", "uniform", human.similarity_permille(&uniform)),
        ("human", "spike", human.similarity_permille(&spike)),
        ("human", "sparse", human.similarity_permille(&sparse)),
    ];
    let similarity: Vec<Value> = similarity_pairs
        .iter()
        .map(|(a, b, s)| json!({"a": a, "b": b, "permille": s}))
        .collect();

    json!({
        "profiles": profiles,
        "metrics": per_profile,
        "similarity": similarity,
    })
}

fn cusum_case() -> Value {
    let reference_milli = 5_000u64;
    let threshold_milli = 20_000u64;
    let counts: Vec<u64> = vec![3, 4, 5, 4, 6, 30, 25, 4, 3, 50, 2];
    let alarms = streams::detect_bursts(&counts, reference_milli, threshold_milli);
    let mut cusum = streams::Cusum::new(reference_milli, threshold_milli);
    for &c in &counts {
        cusum.step(c);
    }
    json!({
        "referenceMilli": reference_milli,
        "thresholdMilli": threshold_milli,
        "counts": counts,
        "alarmIndices": alarms,
        "finalStateMilli": cusum.state_milli(),
    })
}

fn curve_json(points: &[(i64, u32)]) -> Value {
    Value::Array(points.iter().map(|&(x, y)| json!([x, y])).collect())
}

fn curve_cases(points: &[(i64, u32)], xs: &[i64]) -> Value {
    Value::Array(
        xs.iter()
            .map(|&x| json!({"x": x, "permille": piecewise::eval(points, x)}))
            .collect(),
    )
}

fn piecewise_section() -> Value {
    let grid: Vec<i64> = vec![
        -1200, -1000, -750, -500, -350, -200, -100, 0, 41, 70, 100, 120, 200, 250, 350, 450, 500,
        600, 700, 800, 900, 930, 1000, 1100,
    ];
    json!({
        "note": "Стартовые калибровочные кривые (R2). Интерполяция — i128, усечение к нулю; вне диапазона — насыщение.",
        "curves": {
            "burstiness": {
                "points": curve_json(score::BURSTINESS_CURVE),
                "cases": curve_cases(score::BURSTINESS_CURVE, &grid),
            },
            "restShare": {
                "points": curve_json(score::REST_SHARE_CURVE),
                "cases": curve_cases(score::REST_SHARE_CURVE, &grid),
            },
            "peakShare": {
                "points": curve_json(score::PEAK_SHARE_CURVE),
                "cases": curve_cases(score::PEAK_SHARE_CURVE, &grid),
            },
            "selfSimilarity": {
                "points": curve_json(score::SELF_SIMILARITY_CURVE),
                "cases": curve_cases(score::SELF_SIMILARITY_CURVE, &grid),
            },
        },
    })
}

fn device_section() -> Value {
    let link: Vec<Value> = [0u32, 1, 2, 3, 4, 10]
        .iter()
        .map(|&n| {
            let class = device::device_link_class(
                n,
                device::DEFAULT_SHARED_MIN,
                device::DEFAULT_FARM_SUSPECT_MIN,
            );
            json!({"concurrentCivic": n, "class": format!("{class:?}")})
        })
        .collect();
    let churn: Vec<Value> = [0u32, 1, 2, 3, 4, 5, 9]
        .iter()
        .map(|&n| {
            let class = device::device_churn_class(
                n,
                device::DEFAULT_MOBILE_MIN,
                device::DEFAULT_CHURNING_MIN,
            );
            json!({"distinctDevicesEpoch": n, "class": format!("{class:?}")})
        })
        .collect();
    json!({
        "defaults": {
            "sharedMin": device::DEFAULT_SHARED_MIN,
            "farmSuspectMin": device::DEFAULT_FARM_SUSPECT_MIN,
            "mobileMin": device::DEFAULT_MOBILE_MIN,
            "churningMin": device::DEFAULT_CHURNING_MIN,
        },
        "linkCases": link,
        "churnCases": churn,
    })
}

fn score_section() -> Value {
    let combine_cases = vec![
        ("typical_mix", vec![(950u32, 3u32), (700, 2), (400, 1)]),
        ("single_server_signal", vec![(120, 3)]),
        ("clamped_overrange", vec![(5000, 1)]),
        ("weightless", vec![(500, 0)]),
        ("empty", vec![]),
    ];
    let combine: Vec<Value> = combine_cases
        .into_iter()
        .map(|(name, pairs)| {
            let readings: Vec<score::SignalReading> = pairs
                .iter()
                .map(|&(v, w)| score::SignalReading {
                    naturalness_permille: v,
                    weight: w,
                })
                .collect();
            json!({
                "name": name,
                "readings": pairs.iter().map(|&(v, w)| json!({"permille": v, "weight": w})).collect::<Vec<_>>(),
                "permille": score::combine(&readings),
            })
        })
        .collect();

    let th = score::ClassThresholds::default();
    let scores = [
        0u32, 200, 299, 300, 330, 349, 350, 399, 400, 549, 550, 560, 599, 600, 640, 650, 700, 1000,
    ];
    let prevs: [Option<NaturalnessClass>; 4] = [
        None,
        Some(NaturalnessClass::Natural),
        Some(NaturalnessClass::Watch),
        Some(NaturalnessClass::Investigate),
    ];
    let mut classify_cases = Vec::new();
    for prev in prevs {
        for &s in &scores {
            classify_cases.push(json!({
                "score": s,
                "previous": prev.map(class_name),
                "class": class_name(score::classify(s, prev, &th)),
            }));
        }
    }

    json!({
        "evidenceWeights": {
            "serverObserved": score::evidence_weight(SignalEvidenceClass::ServerObserved),
            "deviceAttested": score::evidence_weight(SignalEvidenceClass::DeviceAttested),
            "selfReported": score::evidence_weight(SignalEvidenceClass::SelfReported),
        },
        "thresholds": {
            "watchBelow": th.watch_below,
            "investigateBelow": th.investigate_below,
            "hysteresis": th.hysteresis,
        },
        "combineCases": combine,
        "classifyCases": classify_cases,
    })
}

fn device_tag_section() -> Value {
    let pk_device: [u8; 32] = material(0xD0, 32).try_into().unwrap();
    let epoch_id: [u8; 16] = material(0xE0, 16).try_into().unwrap();
    let epoch_next: [u8; 16] = material(0xF0, 16).try_into().unwrap();
    json!({
        "note": "BLAKE3 derive_key(flora/device/v1/tag, pkDevice || epochId) — fpp-crypto::device_tag_epoch.",
        "pkDevice": b64(&pk_device),
        "epochId": b64(&epoch_id),
        "tag": b64(&fpp_crypto::device_tag_epoch(&pk_device, &epoch_id)),
        "epochIdNext": b64(&epoch_next),
        "tagNext": b64(&fpp_crypto::device_tag_epoch(&pk_device, &epoch_next)),
    })
}

fn anomaly_flags_section() -> Value {
    Value::Array(
        CeremonyAnomalyFlag::ALL
            .iter()
            .map(|f| json!({"name": f.name(), "code": f.code()}))
            .collect(),
    )
}

fn main() {
    let vector = json!({
        "protocolVersion": PROTOCOL_VERSION,
        "vectorId": "personhood_naturalness_v1",
        "description": "Метрики натуральности NS (FPP-SIGNALS): burstiness, суточный профиль, CUSUM, калибровочные кривые, девайс-классы, свод/классификация с гистерезисом, эпохальный тег устройства, реестр enum-флагов церемоний. Целочисленная арифметика: усечение к нулю, isqrt — floor.",
        "burstiness": burstiness_cases(),
        "circadian": circadian_cases(),
        "cusum": cusum_case(),
        "piecewise": piecewise_section(),
        "device": device_section(),
        "score": score_section(),
        "deviceTag": device_tag_section(),
        "ceremonyAnomalyFlags": anomaly_flags_section(),
    });

    let path = out_dir().join("personhood-naturalness-v1.json");
    let mut text = serde_json::to_string_pretty(&vector).expect("json");
    text.push('\n');
    std::fs::write(&path, text).expect("write");
    println!("written {}", path.display());
}
