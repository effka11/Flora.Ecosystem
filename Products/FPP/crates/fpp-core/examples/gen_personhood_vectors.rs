//! Генератор golden-векторов метрик натуральности (FPP-SIGNALS §7).
//!
//! Пишет `Documents/test-vectors/personhood/personhood-naturalness-v1.json`
//! (позитив) и `personhood-naturalness-negative-v1.json` (обязательные отказы —
//! отдельным файлом по правилам Documents/test-vectors/README.md).
//! Детерминирован: повторный запуск перезаписывает файлы идентичным содержимым.
//!
//! ```bash
//! cargo run -p fpp-core --example gen_personhood_vectors
//! ```

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use fpp_contracts::{
    AnomalyFlagCount, CeremonyAnomalyFlag, DeviceAttestationClass, DeviceChurnClass,
    DeviceLinkClass, NaturalnessClass, NaturalnessPanelReport, PanelCounters, PersonhoodLevel,
    ReportConsistencyClass, ReportedBucket, SignalBucket, SignalEvidenceClass, SignalMetric,
};
use fpp_core::{PROTOCOL_VERSION, device, epoch, piecewise, profile, score, streams, temporal};
use serde_json::{Value, json};
use std::path::PathBuf;

/// Genesis примерной инсталляции для эпохальных кейсов: 2025-01-01T00:00:00Z.
const EPOCH_GENESIS_S: u64 = 1_735_689_600;

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
            json!({"concurrentCivic": n, "class": class.name()})
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
            json!({"distinctDevicesEpoch": n, "class": class.name()})
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
                "previous": prev.map(NaturalnessClass::name),
                "class": score::classify(s, prev, &th).name(),
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

fn temporal_buckets_json(buckets: &profile::TemporalBuckets) -> Value {
    let entry = |b: Option<SignalBucket>| b.map(|x| Value::from(x.name())).unwrap_or(Value::Null);
    json!({
        "nsT1Burstiness": entry(buckets.burstiness),
        "nsT2aRestShare": entry(buckets.rest_share),
        "nsT2bPeakShare": entry(buckets.peak_share),
        "nsT2cSelfSimilarity": entry(buckets.self_similarity),
    })
}

fn counters_json(counters: &PanelCounters) -> Value {
    json!({
        "ceremoniesCompleted24m": counters.ceremonies_completed_24m,
        "ownFails24m": counters.own_fails_24m,
        "ownNoShows24m": counters.own_no_shows_24m,
        "verdictReliabilityPermille": counters.verdict_reliability_permille,
        "recoveries12m": counters.recoveries_12m,
        "anomalyFlags24m": counters
            .anomaly_flags_24m
            .iter()
            .map(|c| json!({"flag": c.flag.name(), "count": c.count}))
            .collect::<Vec<_>>(),
    })
}

fn report_json(report: &NaturalnessPanelReport) -> Value {
    json!({
        "scorePermille": report.score_permille,
        "class": report.class.map(NaturalnessClass::name),
        "evidenceShares": report.evidence_shares.map(|s| json!({
            "serverObservedPermille": s.server_observed_permille,
            "deviceAttestedPermille": s.device_attested_permille,
            "selfReportedPermille": s.self_reported_permille,
        })),
        "signals": report.signals.iter().map(|s| json!({
            "metric": s.metric.name(),
            "evidence": s.evidence.name(),
            "bucket": s.bucket.map(SignalBucket::name),
            "naturalnessPermille": s.naturalness_permille,
        })).collect::<Vec<_>>(),
        "reportConsistency": report.report_consistency.map(|c| c.name()),
        "deviceAttestation": report.device_attestation.name(),
        "concurrentCivicOnDevice": report.concurrent_civic_on_device,
        "deviceLink": report.device_link.map(DeviceLinkClass::name),
        "distinctDevicesEpoch": report.distinct_devices_epoch,
        "deviceChurn": report.device_churn.map(DeviceChurnClass::name),
        "counters": counters_json(&report.counters),
    })
}

fn panel_section() -> Value {
    // Квантование: границы, репрезентативные точки, натуральность bucket'ов.
    let quantize_grid: Vec<i64> = vec![
        -1000, -601, -600, -400, -201, -200, 0, 25, 41, 60, 74, 75, 90, 120, 149, 150, 199, 200,
        219, 220, 250, 259, 260, 399, 400, 549, 550, 599, 600, 849, 850, 900, 949, 950, 1000,
    ];
    let buckets: Vec<Value> = profile::TEMPORAL_METRICS
        .iter()
        .map(|&metric| {
            let cases: Vec<Value> = quantize_grid
                .iter()
                .map(|&raw| {
                    let bucket = profile::quantize(metric, raw).expect("темпоральная метрика");
                    json!({"raw": raw, "bucket": bucket.name()})
                })
                .collect();
            let naturalness: Vec<Value> = SignalBucket::ALL
                .iter()
                .map(|&b| {
                    json!({
                        "bucket": b.name(),
                        "representative": profile::representative(metric, b),
                        "naturalnessPermille": profile::naturalness_for_bucket(metric, b),
                    })
                })
                .collect();
            json!({
                "metric": metric.name(),
                "edges": profile::bucket_edges(metric).expect("границы").to_vec(),
                "buckets": naturalness,
                "quantizeCases": cases,
            })
        })
        .collect();

    let device_naturalness = json!({
        "link": DeviceLinkClass::ALL.iter().map(|&c| json!({
            "class": c.name(),
            "naturalnessPermille": profile::device_link_naturalness(c),
        })).collect::<Vec<_>>(),
        "churn": DeviceChurnClass::ALL.iter().map(|&c| json!({
            "class": c.name(),
            "naturalnessPermille": profile::device_churn_naturalness(c),
        })).collect::<Vec<_>>(),
    });

    let evidence_rules = json!({
        "selfReport": DeviceAttestationClass::ALL.iter().map(|&att| json!({
            "attestation": att.name(),
            "evidence": profile::self_report_evidence(att).name(),
        })).collect::<Vec<_>>(),
        "deviceObservation": DeviceAttestationClass::ALL.iter().flat_map(|&att| {
            [false, true].map(|exculpatory| json!({
                "attestation": att.name(),
                "exculpatory": exculpatory,
                "evidence": profile::device_observation_evidence(att, exculpatory).name(),
            }))
        }).collect::<Vec<_>>(),
    });

    let consistency_cases: Vec<Value> = SignalBucket::ALL
        .iter()
        .flat_map(|&a| {
            SignalBucket::ALL.iter().map(move |&b| {
                let server = profile::TemporalBuckets {
                    burstiness: Some(a),
                    ..profile::TemporalBuckets::default()
                };
                let self_reported = profile::TemporalBuckets {
                    burstiness: Some(b),
                    ..profile::TemporalBuckets::default()
                };
                let class = profile::report_consistency(&server, &self_reported)
                    .expect("обе стороны наблюдают");
                json!({"server": a.name(), "selfReported": b.name(), "class": class.name()})
            })
        })
        .collect();

    let assemble_cases = assemble_cases();

    json!({
        "note": "Bucket-профиль (FPP-SIGNALS §3) и отчёт панели (§4.1): квантование — первый i с raw < edges[i], иначе 4; натуральность bucket'а — кривая в репрезентативной точке; девайс-веса асимметричны (инкриминирующее — A, экскульпирующее — по NS-D1).",
        "buckets": buckets,
        "deviceNaturalness": device_naturalness,
        "evidenceRules": evidence_rules,
        "consistency": {
            "driftingMin": profile::CONSISTENCY_DRIFTING_MIN,
            "contradictoryMin": profile::CONSISTENCY_CONTRADICTORY_MIN,
            "cases": consistency_cases,
        },
        "assembleCases": assemble_cases,
    })
}

fn assemble_inputs_json(inputs: &profile::ReportInputs) -> Value {
    json!({
        "serverTemporal": temporal_buckets_json(&inputs.server_temporal),
        "selfTemporal": temporal_buckets_json(&inputs.self_temporal),
        "deviceAttestation": inputs.device_attestation.name(),
        "concurrentCivicOnDevice": inputs.concurrent_civic_on_device,
        "distinctDevicesEpoch": inputs.distinct_devices_epoch,
        "previousClass": inputs.previous_class.map(NaturalnessClass::name),
        "counters": counters_json(&inputs.counters),
    })
}

fn assemble_cases() -> Value {
    let th = score::ClassThresholds::default();

    // Живой пользователь на аттестованном мобильном устройстве.
    let organic_mobile = profile::ReportInputs {
        server_temporal: profile::TemporalBuckets {
            burstiness: Some(SignalBucket::High),
            ..profile::TemporalBuckets::default()
        },
        self_temporal: profile::TemporalBuckets {
            burstiness: Some(SignalBucket::High),
            rest_share: Some(SignalBucket::VeryLow),
            peak_share: Some(SignalBucket::Medium),
            self_similarity: Some(SignalBucket::Medium),
        },
        device_attestation: DeviceAttestationClass::HardwareBacked,
        concurrent_civic_on_device: Some(1),
        distinct_devices_epoch: Some(2),
        previous_class: Some(NaturalnessClass::Natural),
        counters: PanelCounters {
            ceremonies_completed_24m: 4,
            own_fails_24m: 0,
            own_no_shows_24m: 0,
            verdict_reliability_permille: Some(950),
            recoveries_12m: 0,
            anomaly_flags_24m: vec![],
        },
    };

    // Новичок с web-клиента: единственный самоотчётный сигнал, нейтральное отсутствие.
    let web_newcomer = profile::ReportInputs {
        self_temporal: profile::TemporalBuckets {
            burstiness: Some(SignalBucket::Medium),
            ..profile::TemporalBuckets::default()
        },
        ..profile::ReportInputs::default()
    };

    // Подозрение на ферму/аренду: сервер видит машинную регулярность, самоотчёт
    // противоречит, 6 личностей на девайсе, 7 девайсов за эпоху, флаги латентности.
    let rental_farm_suspect = profile::ReportInputs {
        server_temporal: profile::TemporalBuckets {
            burstiness: Some(SignalBucket::VeryLow),
            ..profile::TemporalBuckets::default()
        },
        self_temporal: profile::TemporalBuckets {
            burstiness: Some(SignalBucket::High),
            self_similarity: Some(SignalBucket::VeryHigh),
            ..profile::TemporalBuckets::default()
        },
        device_attestation: DeviceAttestationClass::Unattested,
        concurrent_civic_on_device: Some(6),
        distinct_devices_epoch: Some(7),
        previous_class: Some(NaturalnessClass::Watch),
        counters: PanelCounters {
            ceremonies_completed_24m: 3,
            own_fails_24m: 3,
            own_no_shows_24m: 2,
            verdict_reliability_permille: Some(300),
            recoveries_12m: 2,
            anomaly_flags_24m: vec![
                AnomalyFlagCount {
                    flag: CeremonyAnomalyFlag::LatencySuspect,
                    count: 2,
                },
                AnomalyFlagCount {
                    flag: CeremonyAnomalyFlag::AudioVideoDesync,
                    count: 1,
                },
            ],
        },
    };

    let cases = [
        ("organic_mobile", organic_mobile),
        ("web_newcomer", web_newcomer),
        ("rental_farm_suspect", rental_farm_suspect),
    ];
    Value::Array(
        cases
            .iter()
            .map(|(name, inputs)| {
                json!({
                    "name": name,
                    "inputs": assemble_inputs_json(inputs),
                    "report": report_json(&profile::assemble(inputs, &th)),
                })
            })
            .collect(),
    )
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

fn registries_section() -> Value {
    macro_rules! coded {
        ($ty:ty) => {
            Value::Array(
                <$ty>::ALL
                    .iter()
                    .map(|&v| json!({"name": v.name(), "code": v.code()}))
                    .collect(),
            )
        };
    }
    let epoch_report_errors: Vec<&str> = [
        profile::EpochReportError::NonTemporalMetric,
        profile::EpochReportError::DuplicateMetric,
        profile::EpochReportError::OutOfOrder,
    ]
    .iter()
    .map(|e| e.name())
    .collect();
    let curve_errors: Vec<&str> = [
        piecewise::CurveError::Empty,
        piecewise::CurveError::YAbovePermille,
        piecewise::CurveError::NonIncreasingX,
    ]
    .iter()
    .map(|e| e.name())
    .collect();
    json!({
        "note": "Wire-стабильные коды реестров fpp-contracts. В реестрах классов код 0 зарезервирован («не задано») и не выдаётся; PersonhoodLevel и SignalBucket — порядковые шкалы, 0 значим. Имена ошибок — стабильные идентификаторы журналов и негативных векторов (кодов у них нет).",
        "personhoodLevel": coded!(PersonhoodLevel),
        "signalEvidenceClass": coded!(SignalEvidenceClass),
        "naturalnessClass": coded!(NaturalnessClass),
        "deviceAttestationClass": coded!(DeviceAttestationClass),
        "deviceLinkClass": coded!(DeviceLinkClass),
        "deviceChurnClass": coded!(DeviceChurnClass),
        "reportConsistencyClass": coded!(ReportConsistencyClass),
        "signalMetric": coded!(SignalMetric),
        "signalBucket": coded!(SignalBucket),
        "ceremonyAnomalyFlag": coded!(CeremonyAnomalyFlag),
        "epochReportError": epoch_report_errors,
        "curveError": curve_errors,
    })
}

fn epoch_section() -> Value {
    let len = epoch::EPOCH_LEN_S;
    let index_inputs: Vec<(&str, u64, u64, u64)> = vec![
        ("at_genesis", EPOCH_GENESIS_S, EPOCH_GENESIS_S, len),
        ("before_genesis", EPOCH_GENESIS_S - 1, EPOCH_GENESIS_S, len),
        (
            "last_second_of_epoch0",
            EPOCH_GENESIS_S + len - 1,
            EPOCH_GENESIS_S,
            len,
        ),
        (
            "first_second_of_epoch1",
            EPOCH_GENESIS_S + len,
            EPOCH_GENESIS_S,
            len,
        ),
        (
            "mid_epoch5",
            EPOCH_GENESIS_S + 5 * len + 7,
            EPOCH_GENESIS_S,
            len,
        ),
        (
            "degenerate_len_rejected",
            EPOCH_GENESIS_S,
            EPOCH_GENESIS_S,
            0,
        ),
    ];
    let index_cases: Vec<Value> = index_inputs
        .into_iter()
        .map(|(name, unix_s, genesis, epoch_len)| {
            json!({
                "name": name,
                "unixS": unix_s,
                "genesisUnixS": genesis,
                "epochLenS": epoch_len,
                "epochIndex": epoch::epoch_index_at(unix_s, genesis, epoch_len),
            })
        })
        .collect();

    let start_cases: Vec<Value> = [0u64, 1, 7]
        .iter()
        .map(|&index| {
            json!({
                "genesisUnixS": EPOCH_GENESIS_S,
                "epochIndex": index,
                "startUnixS": epoch::epoch_start_s(EPOCH_GENESIS_S, index, len),
            })
        })
        .collect();

    let id_cases: Vec<Value> = [
        (EPOCH_GENESIS_S, 0u64),
        (EPOCH_GENESIS_S, 3),
        (EPOCH_GENESIS_S + 1, 3),
    ]
    .iter()
    .map(|&(genesis, index)| {
        json!({
            "genesisUnixS": genesis,
            "epochIndex": index,
            "epochId": b64(&epoch::epoch_id_bytes(genesis, index)),
        })
    })
    .collect();

    let pk_device: [u8; 32] = material(0xA0, 32).try_into().unwrap();
    let tag_for_epoch: Vec<Value> = [3u64, 4]
        .iter()
        .map(|&index| {
            let id = epoch::epoch_id_bytes(EPOCH_GENESIS_S, index);
            json!({
                "genesisUnixS": EPOCH_GENESIS_S,
                "epochIndex": index,
                "epochId": b64(&id),
                "pkDevice": b64(&pk_device),
                "tag": b64(&fpp_crypto::device_tag_epoch(&pk_device, &id)),
            })
        })
        .collect();

    json!({
        "note": "Каноническая эпоха NS: index = floor((unix − genesis) / len), до genesis и при len = 0 — null; epochId (16 байт) = LE64(genesisUnixS) || LE64(epochIndex). Девайс-тег эпохи — device_tag_epoch(pkDevice, epochId).",
        "epochLenS": len,
        "indexCases": index_cases,
        "startCases": start_cases,
        "idCases": id_cases,
        "deviceTagForEpoch": tag_for_epoch,
    })
}

fn reported_buckets_json(rows: &[ReportedBucket]) -> Value {
    Value::Array(
        rows.iter()
            .map(|r| {
                json!({
                    "metric": r.metric.name(),
                    "metricCode": r.metric.code(),
                    "bucket": r.bucket.name(),
                    "bucketCode": r.bucket.code(),
                })
            })
            .collect(),
    )
}

/// Кейс отчёта эпохи: (имя, индекс эпохи, burstiness, restShare, peakShare, selfSimilarity).
type RawEpochCase = (
    &'static str,
    u64,
    Option<i32>,
    Option<u32>,
    Option<u32>,
    Option<u32>,
);

fn epoch_report_section() -> Value {
    // Сырые значения — выходы fpp-core::temporal на устройстве (промилле).
    let raw_cases: Vec<RawEpochCase> = vec![
        ("full_profile", 3, Some(413), Some(10), Some(120), Some(700)),
        ("partial_no_history", 4, Some(-650), None, Some(260), None),
        ("empty_fresh_device", 0, None, None, None, None),
    ];
    let pk_device: [u8; 32] = material(0xA0, 32).try_into().unwrap();

    let cases: Vec<Value> = raw_cases
        .into_iter()
        .map(|(name, epoch_index, burst, rest, peak, sim)| {
            let buckets = profile::TemporalBuckets::quantize_raw(burst, rest, peak, sim);
            let report = fpp_contracts::NaturalnessEpochReport {
                epoch_index,
                device_tag: fpp_crypto::device_tag_epoch(
                    &pk_device,
                    &epoch::epoch_id_bytes(EPOCH_GENESIS_S, epoch_index),
                ),
                temporal_buckets: buckets.to_report_buckets(),
            };
            let unpacked = profile::temporal_from_report(&report.temporal_buckets)
                .expect("канонический отчёт валиден");
            assert_eq!(unpacked, buckets, "roundtrip отчёта эпохи");
            json!({
                "name": name,
                "raw": {
                    "burstinessPermille": burst,
                    "restSharePermille": rest,
                    "peakSharePermille": peak,
                    "selfSimilarityPermille": sim,
                },
                "genesisUnixS": EPOCH_GENESIS_S,
                "pkDevice": b64(&pk_device),
                "report": {
                    "epochIndex": report.epoch_index,
                    "deviceTag": b64(&report.device_tag),
                    "temporalBuckets": reported_buckets_json(&report.temporal_buckets),
                },
                "unpackedProfile": temporal_buckets_json(&unpacked),
            })
        })
        .collect();

    json!({
        "note": "Клиентский путь отчёта эпохи (FPP-SIGNALS §3, §7): сырые метрики → quantize_raw → канонические строки (metricCode строго растёт, отсутствие метрики — просто нет строки) + эпохальный девайс-тег. Сервер распаковывает temporal_from_report; сырые значения не покидают устройство.",
        "cases": cases,
    })
}

fn write_vector(path: &std::path::Path, vector: &Value) {
    let mut text = serde_json::to_string_pretty(vector).expect("json");
    text.push('\n');
    std::fs::write(path, text).expect("write");
    println!("written {}", path.display());
}

fn negative_vector() -> Value {
    let row = |metric: SignalMetric, bucket: SignalBucket| {
        json!({
            "metric": metric.name(),
            "metricCode": metric.code(),
            "bucket": bucket.name(),
            "bucketCode": bucket.code(),
        })
    };
    let reject_inputs: Vec<(&str, Vec<Value>, profile::EpochReportError)> = vec![
        (
            "device_link_self_report",
            vec![row(SignalMetric::DeviceLinkD2, SignalBucket::VeryLow)],
            profile::EpochReportError::NonTemporalMetric,
        ),
        (
            "device_churn_after_valid_row",
            vec![
                row(SignalMetric::BurstinessT1, SignalBucket::High),
                row(SignalMetric::DeviceChurnD3, SignalBucket::Medium),
            ],
            profile::EpochReportError::NonTemporalMetric,
        ),
        (
            "duplicate_metric",
            vec![
                row(SignalMetric::BurstinessT1, SignalBucket::High),
                row(SignalMetric::BurstinessT1, SignalBucket::High),
            ],
            profile::EpochReportError::DuplicateMetric,
        ),
        (
            "duplicate_after_valid_rows",
            vec![
                row(SignalMetric::BurstinessT1, SignalBucket::High),
                row(SignalMetric::RestShareT2a, SignalBucket::Low),
                row(SignalMetric::RestShareT2a, SignalBucket::Low),
            ],
            profile::EpochReportError::DuplicateMetric,
        ),
        (
            "out_of_order",
            vec![
                row(SignalMetric::PeakShareT2b, SignalBucket::Medium),
                row(SignalMetric::BurstinessT1, SignalBucket::High),
            ],
            profile::EpochReportError::OutOfOrder,
        ),
    ];
    let epoch_report_rejects: Vec<Value> = reject_inputs
        .into_iter()
        .map(|(name, rows, expected)| {
            json!({
                "name": name,
                "temporalBuckets": rows,
                "expectedError": expected.name(),
            })
        })
        .collect();

    // Коды вне реестров: from_code обязан вернуть отказ, а не «ближайшее» значение.
    let unknown_wire_codes = json!({
        "personhoodLevel": [4, 255],
        "signalEvidenceClass": [0, 4, 255],
        "naturalnessClass": [0, 4, 255],
        "deviceAttestationClass": [0, 4, 255],
        "deviceLinkClass": [0, 4, 255],
        "deviceChurnClass": [0, 4, 255],
        "reportConsistencyClass": [0, 4, 255],
        "signalMetric": [0, 7, 255],
        "signalBucket": [5, 255],
        "ceremonyAnomalyFlag": [0, 9, 255],
    });
    assert!(PersonhoodLevel::from_code(4).is_none());
    assert!(SignalEvidenceClass::from_code(0).is_none());
    assert!(NaturalnessClass::from_code(4).is_none());
    assert!(DeviceAttestationClass::from_code(255).is_none());
    assert!(DeviceLinkClass::from_code(4).is_none());
    assert!(DeviceChurnClass::from_code(4).is_none());
    assert!(ReportConsistencyClass::from_code(0).is_none());
    assert!(SignalMetric::from_code(7).is_none());
    assert!(SignalBucket::from_code(5).is_none());
    assert!(CeremonyAnomalyFlag::from_code(9).is_none());

    type CurveRejectCase = (&'static str, Vec<(i64, u32)>, piecewise::CurveError);
    let curve_inputs: Vec<CurveRejectCase> = vec![
        ("empty_curve", vec![], piecewise::CurveError::Empty),
        (
            "y_above_permille",
            vec![(0, 1001), (10, 0)],
            piecewise::CurveError::YAbovePermille,
        ),
        (
            "duplicate_x",
            vec![(0, 100), (0, 200)],
            piecewise::CurveError::NonIncreasingX,
        ),
        (
            "decreasing_x",
            vec![(10, 100), (0, 200)],
            piecewise::CurveError::NonIncreasingX,
        ),
    ];
    let curve_rejects: Vec<Value> = curve_inputs
        .into_iter()
        .map(|(name, points, expected)| {
            assert_eq!(piecewise::validate(&points), Err(expected));
            json!({
                "name": name,
                "points": curve_json(&points),
                "expectedError": expected.name(),
            })
        })
        .collect();

    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "vectorId": "personhood_naturalness_negative_v1",
        "description": "Обязательные отказы NS-слоя (FPP-SIGNALS §7): форма самоотчёта эпохи (temporal_from_report), неизвестные wire-коды реестров (from_code → отказ), невалидные калибровочные кривые (piecewise::validate). Совместимая реализация обязана отклонить каждый кейс с указанной ошибкой.",
        "epochReportRejects": epoch_report_rejects,
        "unknownWireCodes": unknown_wire_codes,
        "curveRejects": curve_rejects,
    })
}

fn main() {
    let vector = json!({
        "protocolVersion": PROTOCOL_VERSION,
        "vectorId": "personhood_naturalness_v1",
        "description": "Метрики натуральности NS (FPP-SIGNALS): burstiness, суточный профиль, CUSUM, калибровочные кривые, девайс-классы, свод/классификация с гистерезисом, bucket-профиль и отчёт следственной панели (квантование, веса девайс-наблюдений, согласованность A↔C, assemble), каноническая эпоха и эпохальный тег устройства, отчёт эпохи клиента, wire-реестры. Целочисленная арифметика: усечение к нулю, isqrt — floor.",
        "registries": registries_section(),
        "burstiness": burstiness_cases(),
        "circadian": circadian_cases(),
        "cusum": cusum_case(),
        "piecewise": piecewise_section(),
        "device": device_section(),
        "score": score_section(),
        "panel": panel_section(),
        "epoch": epoch_section(),
        "deviceTag": device_tag_section(),
        "epochReport": epoch_report_section(),
    });

    let dir = out_dir();
    write_vector(&dir.join("personhood-naturalness-v1.json"), &vector);
    write_vector(
        &dir.join("personhood-naturalness-negative-v1.json"),
        &negative_vector(),
    );
}
