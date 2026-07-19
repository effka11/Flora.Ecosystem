//! Consumer-тесты golden-векторов FEP/LIV (обязательны по правилам
//! Documents/test-vectors/README.md: вектор без потребителя — невыполненный compliance).
//!
//! Каждый кейс пересчитывается ядром `flora-economy-crypto`; регенерация файлов:
//! `cargo run -p flora-economy-crypto --example gen_vectors`.

use flora_economy_crypto::amount::Grains;
use flora_economy_crypto::engine::LedgerState;
use flora_economy_crypto::hash::{Hash32, tagged, to_hex};
use flora_economy_crypto::ledger::LedgerEntry;
use flora_economy_crypto::witness::{HeadCosign, verify_head_cosign};
use flora_economy_crypto::{FEP_PROTOCOL_VERSION, merkle};
use serde_json::Value;

fn load_vector(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../Documents/test-vectors/fep")
        .join(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "нет вектора {} ({e}); регенерация: cargo run -p flora-economy-crypto --example gen_vectors",
            path.display()
        )
    });
    serde_json::from_str(&text).expect("валидный JSON")
}

fn from_hex(s: &str) -> Vec<u8> {
    assert!(s.len().is_multiple_of(2), "чётная длина hex");
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).expect("hex"))
        .collect()
}

fn hash_from_hex(s: &str) -> Hash32 {
    from_hex(s).try_into().expect("32 байта")
}

fn hashes_from_hex(v: &Value) -> Vec<Hash32> {
    v.as_array()
        .expect("массив")
        .iter()
        .map(|h| hash_from_hex(h.as_str().expect("строка")))
        .collect()
}

// ---------- доменные метки ----------

#[test]
fn domain_tags_match() {
    let v = load_vector("fep-domain-tags-v1.json");
    assert_eq!(
        v["protocolVersion"].as_u64(),
        Some(FEP_PROTOCOL_VERSION as u64)
    );
    assert_eq!(v["vectorId"].as_str(), Some("fep_domain_tags_v1"));

    let material = from_hex(v["taggedMaterialHex"].as_str().expect("hex"));
    for tag_case in v["tags"].as_array().expect("массив") {
        let tag = tag_case["tag"].as_str().expect("строка");
        assert_eq!(
            from_hex(tag_case["tagBytesHex"].as_str().expect("hex")),
            tag.as_bytes(),
            "байты метки {tag}"
        );
        assert_eq!(
            to_hex(&tagged(tag, &material)),
            tag_case["sha256TaggedHex"].as_str().expect("hex"),
            "tagged-хеш метки {tag}"
        );
    }
    // Реестр меток зафиксирован: добавление/удаление — правка вектора и класса R3.
    let names: Vec<&str> = v["tags"]
        .as_array()
        .expect("массив")
        .iter()
        .map(|t| t["name"].as_str().expect("строка"))
        .collect();
    assert_eq!(
        names,
        [
            "LEDGER_LEAF",
            "LEDGER_STH",
            "MERKLE_LEAF",
            "MERKLE_NODE",
            "TRANSFER_AUTH",
            "TRUSTLINE_AUTH",
            "CREDIT_TRANSFER_AUTH",
        ]
    );
}

// ---------- канонический формат LIV ----------

#[test]
fn liv_amount_format_and_parse_match() {
    let v = load_vector("fep-liv-amounts-v1.json");
    assert_eq!(v["vectorId"].as_str(), Some("fep_liv_amounts_v1"));
    assert_eq!(v["ticker"].as_str(), Some(flora_economy_crypto::LIV_TICKER));
    assert_eq!(
        v["decimals"].as_u64(),
        Some(flora_economy_crypto::LIV_DECIMALS as u64)
    );
    assert_eq!(
        v["livInGrains"].as_i64(),
        Some(flora_economy_crypto::LIV_IN_GRAINS)
    );

    for case in v["format"].as_array().expect("массив") {
        let grains = Grains(case["grains"].as_i64().expect("i64"));
        let expected = case["liv"].as_str().expect("строка");
        assert_eq!(grains.format_liv(), expected, "format {}", grains.0);
        // Каноническая форма обязана парситься обратно в те же grain.
        assert_eq!(
            Grains::parse_liv(expected),
            Some(grains),
            "roundtrip {expected}"
        );
    }
    for case in v["parse"].as_array().expect("массив") {
        let input = case["input"].as_str().expect("строка");
        let expected = case["grains"].as_i64().map(Grains);
        assert_eq!(Grains::parse_liv(input), expected, "parse {input:?}");
    }
    for case in v["parseRejects"].as_array().expect("массив") {
        let input = case["input"].as_str().expect("строка");
        assert_eq!(Grains::parse_liv(input), None, "must reject {input:?}");
    }
}

// ---------- транскрипт журнала ----------

fn transcript_entries(v: &Value) -> Vec<LedgerEntry> {
    v["steps"]
        .as_array()
        .expect("массив шагов")
        .iter()
        .map(|s| serde_json::from_value(s["entry"].clone()).expect("LedgerEntry из JSON"))
        .collect()
}

#[test]
fn transcript_replays_bit_for_bit() {
    let v = load_vector("fep-ledger-transcript-v1.json");
    assert_eq!(v["vectorId"].as_str(), Some("fep_ledger_transcript_v1"));
    let entries = transcript_entries(&v);
    let steps = v["steps"].as_array().expect("массив");

    // Реплей: хеш каждой записи и head после каждого шага обязаны совпасть с вектором.
    let mut state: Option<LedgerState> = None;
    for (entry, step) in entries.iter().zip(steps) {
        match &mut state {
            None => state = Some(LedgerState::from_genesis(entry).expect("genesis")),
            Some(s) => s.apply(entry).expect("реплей вектора обязан пройти"),
        }
        assert_eq!(
            to_hex(&entry.entry_hash()),
            step["entryHashHex"].as_str().expect("hex"),
            "entry_hash seq={}",
            entry.seq
        );
        let head = &state.as_ref().expect("состояние").head;
        assert_eq!(
            serde_json::to_value(head).expect("json"),
            step["headAfter"],
            "head после seq={}",
            entry.seq
        );
    }
    let state = state.expect("непустой транскрипт");

    // Контрольный снимок финального состояния.
    let fs = &v["finalState"];
    let account = |b: u8| flora_economy_crypto::amount::AccountId([b; 16]);
    assert_eq!(
        state.accounts[&account(0xA1)].balance.0,
        fs["aliceBalanceGrains"].as_i64().expect("i64")
    );
    assert_eq!(
        state.accounts[&account(0xB2)].balance.0,
        fs["bobBalanceGrains"].as_i64().expect("i64")
    );
    assert_eq!(
        state.commons_balance.0,
        fs["commonsBalanceGrains"].as_i64().expect("i64")
    );
    assert_eq!(
        state.total_issued.0,
        fs["totalIssuedGrains"].as_i64().expect("i64")
    );
    assert_eq!(
        state.trustlines[&(account(0xA1), account(0xB2))].position.0,
        fs["trustlinePositionGrains"].as_i64().expect("i64")
    );
}

#[test]
fn transcript_proofs_verify() {
    let v = load_vector("fep-ledger-transcript-v1.json");
    let entries = transcript_entries(&v);
    let leaves: Vec<Hash32> = entries
        .iter()
        .map(|e| merkle::hash_leaf(&e.entry_hash()))
        .collect();
    let root = merkle::merkle_root(&leaves);

    for case in v["inclusionProofs"].as_array().expect("массив") {
        let seq = case["seq"].as_u64().expect("u64") as usize;
        let size = case["treeSize"].as_u64().expect("u64") as usize;
        assert_eq!(size, leaves.len());
        let leaf = hash_from_hex(case["leafHashHex"].as_str().expect("hex"));
        assert_eq!(leaf, leaves[seq], "лист seq={seq}");
        let proof = hashes_from_hex(&case["proofHex"]);
        assert!(
            merkle::verify_inclusion(&leaf, seq, size, &proof, &root),
            "inclusion seq={seq}"
        );
    }

    for case in v["consistencyProofs"].as_array().expect("массив") {
        let old_size = case["oldSize"].as_u64().expect("u64");
        let new_size = case["newSize"].as_u64().expect("u64");
        let old_root = hash_from_hex(case["oldRootHex"].as_str().expect("hex"));
        let new_root = hash_from_hex(case["newRootHex"].as_str().expect("hex"));
        let proof = hashes_from_hex(&case["proofHex"]);
        assert_eq!(
            old_root,
            merkle::merkle_root(&leaves[..old_size as usize]),
            "old_root пересчитан"
        );
        assert!(
            merkle::verify_consistency(old_size, new_size, &old_root, &new_root, &proof),
            "consistency {old_size}→{new_size}"
        );
    }
}

#[test]
fn transcript_cosigns_verify() {
    let v = load_vector("fep-ledger-transcript-v1.json");
    let entries = transcript_entries(&v);

    // Головы по ходу реплея — чтобы сверить, что косайны подписывают реальную историю.
    let mut heads = Vec::new();
    let mut state: Option<LedgerState> = None;
    for entry in &entries {
        match &mut state {
            None => state = Some(LedgerState::from_genesis(entry).expect("genesis")),
            Some(s) => s.apply(entry).expect("реплей валиден"),
        }
        heads.push(state.as_ref().expect("состояние").head.clone());
    }

    let witness_key = from_hex(v["witnessPublicKeyHex"].as_str().expect("hex"));
    for case in v["cosigns"].as_array().expect("массив") {
        let cosign: HeadCosign =
            serde_json::from_value(case["cosign"].clone()).expect("HeadCosign из JSON");
        verify_head_cosign(&cosign).expect("подпись витнесса валидна");
        assert_eq!(cosign.witness.as_slice(), witness_key, "ключ витнесса");
        assert_eq!(
            cosign.head.canonical_bytes(),
            from_hex(case["sthCanonicalBytesHex"].as_str().expect("hex")),
            "канонические байты STH"
        );
        let in_history = heads.iter().any(|h| h == &cosign.head);
        assert!(in_history, "косайн подписывает head из нашей истории");
    }
}

// ---------- негативы ----------

#[test]
fn negative_replay_cases_fail_as_specified() {
    let v = load_vector("fep-ledger-negative-v1.json");
    assert_eq!(v["vectorId"].as_str(), Some("fep_ledger_negative_v1"));

    for case in v["replayCases"].as_array().expect("массив") {
        let name = case["name"].as_str().expect("строка");
        let entries: Vec<LedgerEntry> =
            serde_json::from_value(case["entries"].clone()).expect("цепочка из JSON");
        let err =
            LedgerState::replay(&entries).expect_err(&format!("кейс {name} обязан быть отвергнут"));
        let expected = case["expectedError"].as_str().expect("строка");
        let matches = match expected {
            "invalid_signature" => {
                matches!(err, flora_economy_crypto::EconomyError::InvalidSignature)
            }
            "replay_diverged" => matches!(
                err,
                flora_economy_crypto::EconomyError::ReplayDiverged { .. }
            ),
            other => panic!("неизвестный expectedError {other}"),
        };
        assert!(matches, "кейс {name}: ожидали {expected}, получили {err:?}");
    }

    for case in v["consistencyCases"].as_array().expect("массив") {
        let old_size = case["oldSize"].as_u64().expect("u64");
        let new_size = case["newSize"].as_u64().expect("u64");
        let old_root = hash_from_hex(case["oldRootHex"].as_str().expect("hex"));
        let new_root = hash_from_hex(case["newRootHex"].as_str().expect("hex"));
        let proof = hashes_from_hex(&case["proofHex"]);
        assert!(
            !merkle::verify_consistency(old_size, new_size, &old_root, &new_root, &proof),
            "кейс {} обязан не пройти",
            case["name"]
        );
    }

    for case in v["cosignCases"].as_array().expect("массив") {
        let cosign: HeadCosign =
            serde_json::from_value(case["cosign"].clone()).expect("HeadCosign из JSON");
        assert!(
            verify_head_cosign(&cosign).is_err(),
            "кейс {} обязан не пройти",
            case["name"]
        );
    }
}
