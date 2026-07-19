//! Consumer-тест golden-вектора `personhood-naturalness-v1.json`
//! (обязателен по правилам Documents/test-vectors/README.md).
//!
//! Каждый кейс вектора пересчитывается ядром `fpp-core` / `fpp-crypto`;
//! регенерация файла: `cargo run -p fpp-core --example gen_personhood_vectors`.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use fpp_contracts::{CeremonyAnomalyFlag, NaturalnessClass};
use fpp_core::{device, piecewise, score, streams, temporal};
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
    match name {
        "natural" => NaturalnessClass::Natural,
        "watch" => NaturalnessClass::Watch,
        "investigate" => NaturalnessClass::Investigate,
        other => panic!("неизвестный класс {other}"),
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
        assert_eq!(format!("{class:?}"), case["class"].as_str().expect("класс"));
    }
    for case in d["churnCases"].as_array().expect("кейсы") {
        let n = case["distinctDevicesEpoch"].as_u64().expect("n") as u32;
        let class = device::device_churn_class(n, mobile, churning);
        assert_eq!(format!("{class:?}"), case["class"].as_str().expect("класс"));
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
