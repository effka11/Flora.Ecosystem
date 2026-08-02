//! Consumer-тесты golden-векторов `personhood-naturalness-v1.json` (позитив)
//! и `personhood-naturalness-negative-v1.json` (обязательные отказы) —
//! обязательны по правилам Documents/test-vectors/README.md.
//!
//! Каждый кейс вектора пересчитывается ядром `fpp-core` / `fpp-crypto`;
//! регенерация файлов: `cargo run -p fpp-core --example gen_personhood_vectors`.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use fpp_contracts::{
    AnomalyFlagCount, CeremonyAnomalyFlag, DeviceAttestationClass, DeviceChurnClass,
    DeviceLinkClass, NaturalnessClass, PanelCounters, PersonhoodLevel, ReportConsistencyClass,
    ReportedBucket, SignalBucket, SignalEvidenceClass, SignalMetric,
};
use fpp_core::{device, epoch, piecewise, profile, score, streams, temporal};
use serde_json::Value;

fn load_json(file: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../Documents/test-vectors/personhood")
        .join(file);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "нет вектора {} ({e}); регенерация: cargo run -p fpp-core --example gen_personhood_vectors",
            path.display()
        )
    });
    serde_json::from_str(&text).expect("валидный JSON")
}

fn load_vector() -> Value {
    load_json("personhood-naturalness-v1.json")
}

fn load_negative() -> Value {
    load_json("personhood-naturalness-negative-v1.json")
}

fn b64d(v: &Value) -> Vec<u8> {
    URL_SAFE_NO_PAD
        .decode(v.as_str().expect("b64"))
        .expect("валидный base64url")
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
    let pk: [u8; 32] = b64d(&d["pkDevice"]).try_into().expect("32 байта");
    let epoch_id: [u8; 16] = b64d(&d["epochId"]).try_into().expect("16 байт");
    let epoch_next: [u8; 16] = b64d(&d["epochIdNext"]).try_into().expect("16 байт");
    assert_eq!(
        fpp_crypto::device_tag_epoch(&pk, &epoch_id).to_vec(),
        b64d(&d["tag"])
    );
    assert_eq!(
        fpp_crypto::device_tag_epoch(&pk, &epoch_next).to_vec(),
        b64d(&d["tagNext"])
    );
}

#[test]
fn registries_match() {
    let v = load_vector();
    let r = &v["registries"];
    macro_rules! check {
        ($key:literal, $ty:ty) => {{
            let entries = r[$key].as_array().expect($key);
            assert_eq!(entries.len(), <$ty>::ALL.len(), $key);
            for (entry, item) in entries.iter().zip(<$ty>::ALL) {
                assert_eq!(entry["name"].as_str(), Some(item.name()), $key);
                assert_eq!(entry["code"].as_u64(), Some(item.code() as u64), $key);
                assert_eq!(<$ty>::from_code(item.code()), Some(*item), $key);
            }
        }};
    }
    check!("personhoodLevel", PersonhoodLevel);
    check!("signalEvidenceClass", SignalEvidenceClass);
    check!("naturalnessClass", NaturalnessClass);
    check!("deviceAttestationClass", DeviceAttestationClass);
    check!("deviceLinkClass", DeviceLinkClass);
    check!("deviceChurnClass", DeviceChurnClass);
    check!("reportConsistencyClass", ReportConsistencyClass);
    check!("signalMetric", SignalMetric);
    check!("signalBucket", SignalBucket);
    check!("ceremonyAnomalyFlag", CeremonyAnomalyFlag);

    let names = |key: &str| -> Vec<String> {
        r[key]
            .as_array()
            .expect("имена")
            .iter()
            .map(|x| x.as_str().expect("имя").to_string())
            .collect()
    };
    assert_eq!(
        names("epochReportError"),
        [
            profile::EpochReportError::NonTemporalMetric,
            profile::EpochReportError::DuplicateMetric,
            profile::EpochReportError::OutOfOrder,
        ]
        .map(|e| e.name().to_string())
    );
    assert_eq!(
        names("curveError"),
        [
            piecewise::CurveError::Empty,
            piecewise::CurveError::YAbovePermille,
            piecewise::CurveError::NonIncreasingX,
        ]
        .map(|e| e.name().to_string())
    );
}

#[test]
fn epoch_cases_match() {
    let v = load_vector();
    let e = &v["epoch"];
    let len = e["epochLenS"].as_u64().expect("len");
    assert_eq!(len, epoch::EPOCH_LEN_S);
    for case in e["indexCases"].as_array().expect("кейсы") {
        assert_eq!(
            epoch::epoch_index_at(
                case["unixS"].as_u64().expect("unix"),
                case["genesisUnixS"].as_u64().expect("genesis"),
                case["epochLenS"].as_u64().expect("len"),
            ),
            case["epochIndex"].as_u64(),
            "кейс {}",
            case["name"]
        );
    }
    for case in e["startCases"].as_array().expect("кейсы") {
        assert_eq!(
            epoch::epoch_start_s(
                case["genesisUnixS"].as_u64().expect("genesis"),
                case["epochIndex"].as_u64().expect("index"),
                len,
            ),
            case["startUnixS"].as_u64()
        );
    }
    for case in e["idCases"].as_array().expect("кейсы") {
        assert_eq!(
            epoch::epoch_id_bytes(
                case["genesisUnixS"].as_u64().expect("genesis"),
                case["epochIndex"].as_u64().expect("index"),
            )
            .to_vec(),
            b64d(&case["epochId"])
        );
    }
    for case in e["deviceTagForEpoch"].as_array().expect("кейсы") {
        let id = epoch::epoch_id_bytes(
            case["genesisUnixS"].as_u64().expect("genesis"),
            case["epochIndex"].as_u64().expect("index"),
        );
        assert_eq!(id.to_vec(), b64d(&case["epochId"]));
        let pk: [u8; 32] = b64d(&case["pkDevice"]).try_into().expect("32 байта");
        assert_eq!(
            fpp_crypto::device_tag_epoch(&pk, &id).to_vec(),
            b64d(&case["tag"])
        );
    }
}

fn reported_rows_from_json(v: &Value) -> Vec<ReportedBucket> {
    v.as_array()
        .expect("строки")
        .iter()
        .map(|r| {
            let metric = SignalMetric::from_code(r["metricCode"].as_u64().expect("код") as u8)
                .expect("известная метрика");
            let bucket = SignalBucket::from_code(r["bucketCode"].as_u64().expect("код") as u8)
                .expect("известный bucket");
            assert_eq!(r["metric"].as_str(), Some(metric.name()));
            assert_eq!(r["bucket"].as_str(), Some(bucket.name()));
            ReportedBucket { metric, bucket }
        })
        .collect()
}

#[test]
fn epoch_report_cases_match() {
    let v = load_vector();
    for case in v["epochReport"]["cases"].as_array().expect("кейсы") {
        let name = case["name"].as_str().expect("имя");
        let raw = &case["raw"];
        let buckets = profile::TemporalBuckets::quantize_raw(
            raw["burstinessPermille"].as_i64().map(|x| x as i32),
            opt_u32(&raw["restSharePermille"]),
            opt_u32(&raw["peakSharePermille"]),
            opt_u32(&raw["selfSimilarityPermille"]),
        );
        let rows = buckets.to_report_buckets();
        assert_eq!(
            rows,
            reported_rows_from_json(&case["report"]["temporalBuckets"]),
            "{name}: строки отчёта"
        );
        assert_eq!(
            profile::temporal_from_report(&rows),
            Ok(buckets),
            "{name}: сервер принимает канонический отчёт"
        );
        assert_eq!(
            temporal_buckets_from_json(&case["unpackedProfile"]),
            buckets,
            "{name}: распакованный профиль"
        );

        let pk: [u8; 32] = b64d(&case["pkDevice"]).try_into().expect("32 байта");
        let id = epoch::epoch_id_bytes(
            case["genesisUnixS"].as_u64().expect("genesis"),
            case["report"]["epochIndex"].as_u64().expect("index"),
        );
        assert_eq!(
            fpp_crypto::device_tag_epoch(&pk, &id).to_vec(),
            b64d(&case["report"]["deviceTag"]),
            "{name}: девайс-тег"
        );
    }
}

#[test]
fn negative_vector_header_matches() {
    let v = load_negative();
    assert_eq!(
        v["protocolVersion"].as_u64(),
        Some(fpp_core::PROTOCOL_VERSION as u64)
    );
    assert_eq!(
        v["vectorId"].as_str(),
        Some("personhood_naturalness_negative_v1")
    );
}

#[test]
fn negative_epoch_report_rejects() {
    let v = load_negative();
    for case in v["epochReportRejects"].as_array().expect("кейсы") {
        let rows = reported_rows_from_json(&case["temporalBuckets"]);
        let err =
            profile::temporal_from_report(&rows).expect_err(case["name"].as_str().expect("имя"));
        assert_eq!(
            Some(err.name()),
            case["expectedError"].as_str(),
            "кейс {}",
            case["name"]
        );
    }
}

#[test]
fn negative_unknown_wire_codes_are_rejected() {
    let v = load_negative();
    let codes = |key: &str| -> Vec<u8> {
        v["unknownWireCodes"][key]
            .as_array()
            .expect("коды")
            .iter()
            .map(|x| x.as_u64().expect("код") as u8)
            .collect()
    };
    macro_rules! check {
        ($key:literal, $ty:ty) => {
            for code in codes($key) {
                assert_eq!(<$ty>::from_code(code), None, "{} код {code}", $key);
            }
        };
    }
    check!("personhoodLevel", PersonhoodLevel);
    check!("signalEvidenceClass", SignalEvidenceClass);
    check!("naturalnessClass", NaturalnessClass);
    check!("deviceAttestationClass", DeviceAttestationClass);
    check!("deviceLinkClass", DeviceLinkClass);
    check!("deviceChurnClass", DeviceChurnClass);
    check!("reportConsistencyClass", ReportConsistencyClass);
    check!("signalMetric", SignalMetric);
    check!("signalBucket", SignalBucket);
    check!("ceremonyAnomalyFlag", CeremonyAnomalyFlag);
}

#[test]
fn negative_curve_rejects() {
    let v = load_negative();
    for case in v["curveRejects"].as_array().expect("кейсы") {
        let points: Vec<(i64, u32)> = case["points"]
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
        let err = piecewise::validate(&points).expect_err(case["name"].as_str().expect("имя"));
        assert_eq!(
            Some(err.name()),
            case["expectedError"].as_str(),
            "кейс {}",
            case["name"]
        );
    }
}
