//! Consumer-тест golden-вектора `personhood-naturalness-v1.json`
//! (обязателен по правилам Documents/test-vectors/README.md).
//!
//! Каждый кейс вектора пересчитывается ядром `fpp-core` / `fpp-crypto`;
//! регенерация файла: `cargo run -p fpp-core --example gen_personhood_vectors`.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use fpp_contracts::{
    AnomalyFlagCount, CeremonyAnomalyFlag, DeviceAttestationClass, DeviceChurnClass,
    DeviceLinkClass, NaturalnessClass, PanelCounters, ReportConsistencyClass, SignalBucket,
    SignalEvidenceClass, SignalMetric,
};
use fpp_core::{device, piecewise, profile, score, streams, temporal};
use serde_json::Value;

fn load_vector() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../Documents/test-vectors/personhood/personhood-naturalness-v1.json");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "нет вектора {} ({e}); регенерация: cargo run -p fpp-core --example gen_personhood_vectors",
            path.display()
        )
    });
    serde_json::from_str(&text).expect("валидный JSON")
}

fn as_u64_vec(v: &Value) -> Vec<u64> {
    v.as_array()
        .expect("массив")
        .iter()
        .map(|x| x.as_u64().expect("u64"))
        .collect()
}

fn opt_u32(v: &Value) -> Option<u32> {
    if v.is_null() {
        None
    } else {
        Some(v.as_u64().expect("u32") as u32)
    }
}

fn class_from_name(name: &str) -> NaturalnessClass {
    NaturalnessClass::ALL
        .iter()
        .copied()
        .find(|c| c.name() == name)
        .unwrap_or_else(|| panic!("неизвестный класс {name}"))
}

fn metric_from_name(name: &str) -> SignalMetric {
    SignalMetric::ALL
        .iter()
        .copied()
        .find(|m| m.name() == name)
        .unwrap_or_else(|| panic!("неизвестная метрика {name}"))
}

fn bucket_from_name(name: &str) -> SignalBucket {
    SignalBucket::ALL
        .iter()
        .copied()
        .find(|b| b.name() == name)
        .unwrap_or_else(|| panic!("неизвестный bucket {name}"))
}

fn evidence_from_name(name: &str) -> SignalEvidenceClass {
    SignalEvidenceClass::ALL
        .iter()
        .copied()
        .find(|e| e.name() == name)
        .unwrap_or_else(|| panic!("неизвестный класс доказательности {name}"))
}

fn attestation_from_name(name: &str) -> DeviceAttestationClass {
    DeviceAttestationClass::ALL
        .iter()
        .copied()
        .find(|a| a.name() == name)
        .unwrap_or_else(|| panic!("неизвестный класс аттестации {name}"))
}

fn consistency_from_name(name: &str) -> ReportConsistencyClass {
    ReportConsistencyClass::ALL
        .iter()
        .copied()
        .find(|c| c.name() == name)
        .unwrap_or_else(|| panic!("неизвестный класс согласованности {name}"))
}

fn opt_bucket(v: &Value) -> Option<SignalBucket> {
    v.as_str().map(bucket_from_name)
}

fn temporal_buckets_from_json(v: &Value) -> profile::TemporalBuckets {
    profile::TemporalBuckets {
        burstiness: opt_bucket(&v["nsT1Burstiness"]),
        rest_share: opt_bucket(&v["nsT2aRestShare"]),
        peak_share: opt_bucket(&v["nsT2bPeakShare"]),
        self_similarity: opt_bucket(&v["nsT2cSelfSimilarity"]),
    }
}

fn counters_from_json(v: &Value) -> PanelCounters {
    PanelCounters {
        ceremonies_completed_24m: v["ceremoniesCompleted24m"].as_u64().expect("u32") as u32,
        own_fails_24m: v["ownFails24m"].as_u64().expect("u32") as u32,
        own_no_shows_24m: v["ownNoShows24m"].as_u64().expect("u32") as u32,
        verdict_reliability_permille: opt_u32(&v["verdictReliabilityPermille"]),
        recoveries_12m: v["recoveries12m"].as_u64().expect("u32") as u32,
        anomaly_flags_24m: v["anomalyFlags24m"]
            .as_array()
            .expect("массив")
            .iter()
            .map(|f| AnomalyFlagCount {
                flag: CeremonyAnomalyFlag::ALL
                    .iter()
                    .copied()
                    .find(|x| x.name() == f["flag"].as_str().expect("имя"))
                    .expect("известный флаг"),
                count: f["count"].as_u64().expect("u32") as u32,
            })
            .collect(),
    }
}

#[test]
fn protocol_version_matches() {
    let v = load_vector();
    assert_eq!(
        v["protocolVersion"].as_u64(),
        Some(fpp_core::PROTOCOL_VERSION as u64)
    );
    assert_eq!(v["vectorId"].as_str(), Some("personhood_naturalness_v1"));
}

#[test]
fn burstiness_cases_match() {
    let v = load_vector();
    for case in v["burstiness"].as_array().expect("кейсы") {
        let intervals = as_u64_vec(&case["intervalsS"]);
        let expected = if case["permille"].is_null() {
            None
        } else {
            Some(case["permille"].as_i64().expect("i64") as i32)
        };
        assert_eq!(
            temporal::burstiness_permille(&intervals),
            expected,
            "кейс {}",
            case["name"]
        );
    }
}

#[test]
fn circadian_cases_match() {
    let v = load_vector();
    let profiles = v["circadian"]["profiles"].as_object().expect("профили");
    let get = |name: &str| -> temporal::HourHistogram {
        let counts = as_u64_vec(&profiles[name]);
        temporal::HourHistogram::new(counts.try_into().expect("24 часа"))
    };
    for m in v["circadian"]["metrics"].as_array().expect("метрики") {
        let h = get(m["profile"].as_str().expect("имя"));
        assert_eq!(h.rest_share_permille(), opt_u32(&m["restSharePermille"]));
        assert_eq!(h.peak_share_permille(), opt_u32(&m["peakSharePermille"]));
    }
    for s in v["circadian"]["similarity"].as_array().expect("пары") {
        let a = get(s["a"].as_str().expect("a"));
        let b = get(s["b"].as_str().expect("b"));
        assert_eq!(a.similarity_permille(&b), opt_u32(&s["permille"]));
    }
}

#[test]
fn cusum_case_matches() {
    let v = load_vector();
    let c = &v["cusum"];
    let counts = as_u64_vec(&c["counts"]);
    let reference = c["referenceMilli"].as_u64().expect("k");
    let threshold = c["thresholdMilli"].as_u64().expect("h");
    let alarms: Vec<usize> = c["alarmIndices"]
        .as_array()
        .expect("тревоги")
        .iter()
        .map(|x| x.as_u64().expect("usize") as usize)
        .collect();
    assert_eq!(
        streams::detect_bursts(&counts, reference, threshold),
        alarms
    );
    let mut cusum = streams::Cusum::new(reference, threshold);
    for &x in &counts {
        cusum.step(x);
    }
    assert_eq!(
        cusum.state_milli(),
        c["finalStateMilli"].as_u64().expect("s")
    );
}

#[test]
fn piecewise_curves_match() {
    let v = load_vector();
    let curves = v["piecewise"]["curves"].as_object().expect("кривые");
    let known: [(&str, &[(i64, u32)]); 4] = [
        ("burstiness", score::BURSTINESS_CURVE),
        ("restShare", score::REST_SHARE_CURVE),
        ("peakShare", score::PEAK_SHARE_CURVE),
        ("selfSimilarity", score::SELF_SIMILARITY_CURVE),
    ];
    for (name, curve) in known {
        let section = &curves[name];
        let points: Vec<(i64, u32)> = section["points"]
            .as_array()
            .expect("точки")
            .iter()
            .map(|p| {
                let pair = p.as_array().expect("пара");
                (
                    pair[0].as_i64().expect("x"),
                    pair[1].as_u64().expect("y") as u32,
                )
            })
            .collect();
        assert_eq!(
            points, curve,
            "кривая {name} разошлась со стартовой калибровкой"
        );
        for case in section["cases"].as_array().expect("кейсы") {
            let x = case["x"].as_i64().expect("x");
            let expected = case["permille"].as_u64().expect("‰") as u32;
            assert_eq!(piecewise::eval(curve, x), expected, "{name} @ {x}");
        }
    }
}

#[test]
fn device_cases_match() {
    let v = load_vector();
    let d = &v["device"];
    let shared = d["defaults"]["sharedMin"].as_u64().expect("shared") as u32;
    let farm = d["defaults"]["farmSuspectMin"].as_u64().expect("farm") as u32;
    let mobile = d["defaults"]["mobileMin"].as_u64().expect("mobile") as u32;
    let churning = d["defaults"]["churningMin"].as_u64().expect("churn") as u32;
    assert_eq!(shared, device::DEFAULT_SHARED_MIN);
    assert_eq!(farm, device::DEFAULT_FARM_SUSPECT_MIN);
    assert_eq!(mobile, device::DEFAULT_MOBILE_MIN);
    assert_eq!(churning, device::DEFAULT_CHURNING_MIN);
    for case in d["linkCases"].as_array().expect("кейсы") {
        let n = case["concurrentCivic"].as_u64().expect("n") as u32;
        let class = device::device_link_class(n, shared, farm);
        assert_eq!(class.name(), case["class"].as_str().expect("класс"));
    }
    for case in d["churnCases"].as_array().expect("кейсы") {
        let n = case["distinctDevicesEpoch"].as_u64().expect("n") as u32;
        let class = device::device_churn_class(n, mobile, churning);
        assert_eq!(class.name(), case["class"].as_str().expect("класс"));
    }
}

#[test]
fn panel_bucket_cases_match() {
    let v = load_vector();
    for section in v["panel"]["buckets"].as_array().expect("метрики") {
        let metric = metric_from_name(section["metric"].as_str().expect("имя"));
        let edges: Vec<i64> = section["edges"]
            .as_array()
            .expect("границы")
            .iter()
            .map(|x| x.as_i64().expect("i64"))
            .collect();
        assert_eq!(
            edges.as_slice(),
            profile::bucket_edges(metric).expect("границы").as_slice(),
            "границы {}",
            metric.name()
        );
        for b in section["buckets"].as_array().expect("bucket'ы") {
            let bucket = bucket_from_name(b["bucket"].as_str().expect("имя"));
            assert_eq!(
                profile::representative(metric, bucket),
                Some(b["representative"].as_i64().expect("i64")),
            );
            assert_eq!(
                profile::naturalness_for_bucket(metric, bucket),
                opt_u32(&b["naturalnessPermille"]),
            );
        }
        for case in section["quantizeCases"].as_array().expect("кейсы") {
            let raw = case["raw"].as_i64().expect("i64");
            let expected = bucket_from_name(case["bucket"].as_str().expect("имя"));
            assert_eq!(
                profile::quantize(metric, raw),
                Some(expected),
                "{} @ {raw}",
                metric.name()
            );
        }
    }
}

#[test]
fn panel_device_naturalness_and_evidence_rules_match() {
    let v = load_vector();
    let p = &v["panel"];
    for case in p["deviceNaturalness"]["link"].as_array().expect("кейсы") {
        let class = DeviceLinkClass::ALL
            .iter()
            .copied()
            .find(|c| c.name() == case["class"].as_str().expect("имя"))
            .expect("известный класс");
        assert_eq!(
            profile::device_link_naturalness(class),
            case["naturalnessPermille"].as_u64().expect("‰") as u32
        );
    }
    for case in p["deviceNaturalness"]["churn"].as_array().expect("кейсы") {
        let class = DeviceChurnClass::ALL
            .iter()
            .copied()
            .find(|c| c.name() == case["class"].as_str().expect("имя"))
            .expect("известный класс");
        assert_eq!(
            profile::device_churn_naturalness(class),
            case["naturalnessPermille"].as_u64().expect("‰") as u32
        );
    }
    for case in p["evidenceRules"]["selfReport"].as_array().expect("кейсы") {
        let att = attestation_from_name(case["attestation"].as_str().expect("имя"));
        assert_eq!(
            profile::self_report_evidence(att).name(),
            case["evidence"].as_str().expect("класс")
        );
    }
    for case in p["evidenceRules"]["deviceObservation"]
        .as_array()
        .expect("кейсы")
    {
        let att = attestation_from_name(case["attestation"].as_str().expect("имя"));
        let exculpatory = case["exculpatory"].as_bool().expect("bool");
        assert_eq!(
            profile::device_observation_evidence(att, exculpatory).name(),
            case["evidence"].as_str().expect("класс")
        );
    }
}

#[test]
fn panel_consistency_cases_match() {
    let v = load_vector();
    let c = &v["panel"]["consistency"];
    assert_eq!(
        c["driftingMin"].as_u64().expect("порог") as u8,
        profile::CONSISTENCY_DRIFTING_MIN
    );
    assert_eq!(
        c["contradictoryMin"].as_u64().expect("порог") as u8,
        profile::CONSISTENCY_CONTRADICTORY_MIN
    );
    for case in c["cases"].as_array().expect("кейсы") {
        let server = profile::TemporalBuckets {
            burstiness: Some(bucket_from_name(case["server"].as_str().expect("имя"))),
            ..profile::TemporalBuckets::default()
        };
        let self_reported = profile::TemporalBuckets {
            burstiness: Some(bucket_from_name(
                case["selfReported"].as_str().expect("имя"),
            )),
            ..profile::TemporalBuckets::default()
        };
        assert_eq!(
            profile::report_consistency(&server, &self_reported),
            Some(consistency_from_name(case["class"].as_str().expect("имя")))
        );
    }
}

#[test]
fn panel_assemble_cases_match() {
    let v = load_vector();
    let th = score::ClassThresholds::default();
    for case in v["panel"]["assembleCases"].as_array().expect("кейсы") {
        let name = case["name"].as_str().expect("имя");
        let i = &case["inputs"];
        let inputs = profile::ReportInputs {
            server_temporal: temporal_buckets_from_json(&i["serverTemporal"]),
            self_temporal: temporal_buckets_from_json(&i["selfTemporal"]),
            device_attestation: attestation_from_name(
                i["deviceAttestation"].as_str().expect("имя"),
            ),
            concurrent_civic_on_device: opt_u32(&i["concurrentCivicOnDevice"]),
            distinct_devices_epoch: opt_u32(&i["distinctDevicesEpoch"]),
            previous_class: i["previousClass"].as_str().map(class_from_name),
            counters: counters_from_json(&i["counters"]),
        };
        let report = profile::assemble(&inputs, &th);
        let r = &case["report"];

        assert_eq!(
            report.score_permille,
            opt_u32(&r["scorePermille"]),
            "{name}"
        );
        assert_eq!(
            report.class,
            r["class"].as_str().map(class_from_name),
            "{name}"
        );
        match (&report.evidence_shares, &r["evidenceShares"]) {
            (None, Value::Null) => {}
            (Some(shares), s) => {
                assert_eq!(
                    shares.server_observed_permille,
                    s["serverObservedPermille"].as_u64().expect("‰") as u32
                );
                assert_eq!(
                    shares.device_attested_permille,
                    s["deviceAttestedPermille"].as_u64().expect("‰") as u32
                );
                assert_eq!(
                    shares.self_reported_permille,
                    s["selfReportedPermille"].as_u64().expect("‰") as u32
                );
            }
            other => panic!("{name}: расхождение evidenceShares {other:?}"),
        }
        assert_eq!(
            report.report_consistency,
            r["reportConsistency"].as_str().map(consistency_from_name),
            "{name}"
        );
        assert_eq!(
            report.device_attestation,
            attestation_from_name(r["deviceAttestation"].as_str().expect("имя"))
        );
        assert_eq!(
            report.concurrent_civic_on_device,
            opt_u32(&r["concurrentCivicOnDevice"])
        );
        assert_eq!(
            report.device_link.map(DeviceLinkClass::name),
            r["deviceLink"].as_str()
        );
        assert_eq!(
            report.distinct_devices_epoch,
            opt_u32(&r["distinctDevicesEpoch"])
        );
        assert_eq!(
            report.device_churn.map(DeviceChurnClass::name),
            r["deviceChurn"].as_str()
        );
        assert_eq!(
            report.counters,
            counters_from_json(&r["counters"]),
            "{name}"
        );

        let signals = r["signals"].as_array().expect("строки");
        assert_eq!(report.signals.len(), signals.len(), "{name}");
        for (got, want) in report.signals.iter().zip(signals) {
            assert_eq!(
                got.metric,
                metric_from_name(want["metric"].as_str().expect("имя"))
            );
            assert_eq!(
                got.evidence,
                evidence_from_name(want["evidence"].as_str().expect("класс"))
            );
            assert_eq!(got.bucket, opt_bucket(&want["bucket"]));
            assert_eq!(
                got.naturalness_permille,
                want["naturalnessPermille"].as_u64().expect("‰") as u32
            );
        }
    }
}

#[test]
fn score_cases_match() {
    let v = load_vector();
    let s = &v["score"];
    let th = score::ClassThresholds {
        watch_below: s["thresholds"]["watchBelow"].as_u64().expect("w") as u32,
        investigate_below: s["thresholds"]["investigateBelow"].as_u64().expect("i") as u32,
        hysteresis: s["thresholds"]["hysteresis"].as_u64().expect("h") as u32,
    };
    assert_eq!(th, score::ClassThresholds::default());
    for case in s["combineCases"].as_array().expect("кейсы") {
        let readings: Vec<score::SignalReading> = case["readings"]
            .as_array()
            .expect("readings")
            .iter()
            .map(|r| score::SignalReading {
                naturalness_permille: r["permille"].as_u64().expect("v") as u32,
                weight: r["weight"].as_u64().expect("w") as u32,
            })
            .collect();
        assert_eq!(
            score::combine(&readings),
            opt_u32(&case["permille"]),
            "combine {}",
            case["name"]
        );
    }
    for case in s["classifyCases"].as_array().expect("кейсы") {
        let sc = case["score"].as_u64().expect("score") as u32;
        let prev = case["previous"].as_str().map(class_from_name);
        let expected = class_from_name(case["class"].as_str().expect("класс"));
        assert_eq!(
            score::classify(sc, prev, &th),
            expected,
            "score={sc} prev={prev:?}"
        );
    }
}

#[test]
fn device_tag_matches() {
    let v = load_vector();
    let d = &v["deviceTag"];
    let decode = |key: &str| -> Vec<u8> {
        URL_SAFE_NO_PAD
            .decode(d[key].as_str().expect("b64"))
            .expect("валидный base64url")
    };
    let pk: [u8; 32] = decode("pkDevice").try_into().expect("32 байта");
    let epoch: [u8; 16] = decode("epochId").try_into().expect("16 байт");
    let epoch_next: [u8; 16] = decode("epochIdNext").try_into().expect("16 байт");
    assert_eq!(
        fpp_crypto::device_tag_epoch(&pk, &epoch).to_vec(),
        decode("tag")
    );
    assert_eq!(
        fpp_crypto::device_tag_epoch(&pk, &epoch_next).to_vec(),
        decode("tagNext")
    );
}

#[test]
fn anomaly_flag_registry_matches() {
    let v = load_vector();
    let flags = v["ceremonyAnomalyFlags"].as_array().expect("реестр");
    assert_eq!(flags.len(), CeremonyAnomalyFlag::ALL.len());
    for (entry, flag) in flags.iter().zip(CeremonyAnomalyFlag::ALL) {
        assert_eq!(entry["name"].as_str(), Some(flag.name()));
        assert_eq!(entry["code"].as_u64(), Some(flag.code() as u64));
        assert_eq!(
            CeremonyAnomalyFlag::from_code(entry["code"].as_u64().unwrap() as u8),
            Some(*flag)
        );
    }
}
