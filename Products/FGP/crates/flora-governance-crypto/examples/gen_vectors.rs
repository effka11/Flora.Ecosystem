//! Генератор golden-векторов криптоядра governance (FGP-CRYPTO §12).
//!
//! Пишет `Documents/test-vectors/governance/*.json`. Детерминирован: повторный запуск
//! перезаписывает файлы идентичным содержимым (правило Documents/test-vectors/README.md).
//!
//! ```bash
//! cargo run -p flora-governance-crypto --example gen_vectors
//! ```

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use flora_governance_crypto::fx::{EXP2_TABLE_Q32, Fx, int_sqrt_q32};
use flora_governance_crypto::{
    PROTOCOL_VERSION, bridging, commit_reveal, ds, merkle, sig, sortition, sth, weights,
};
use serde_json::{Value, json};
use std::path::PathBuf;

fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Детерминированный материал: `len` байт `start, start+1, ...` (mod 256).
fn material(start: u8, len: usize) -> Vec<u8> {
    (0..len).map(|i| start.wrapping_add(i as u8)).collect()
}

fn material32(start: u8) -> [u8; 32] {
    material(start, 32).try_into().expect("32 байта")
}

fn out_dir() -> PathBuf {
    // crate: Products/FGP/crates/flora-governance-crypto → корень репо на 4 уровня выше.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../Documents/test-vectors/governance")
        .canonicalize()
        .expect("Documents/test-vectors/governance должен существовать")
}

fn write(name: &str, value: &Value) {
    let path = out_dir().join(name);
    let mut text = serde_json::to_string_pretty(value).expect("json");
    text.push('\n');
    std::fs::write(&path, text).expect("write");
    println!("written {}", path.display());
}

fn ds_tags_vector() -> Value {
    let mat = material(0x00, 32);
    let derives: Vec<Value> = ds::REGISTRY
        .iter()
        .map(|(name, tag)| {
            json!({
                "name": name,
                "tag": tag,
                "tagBytes": b64(tag.as_bytes()),
                "output": b64(&ds::derive(tag, &mat)),
            })
        })
        .collect();

    let sk_civic: [u8; 32] = material(0xA0, 32).try_into().unwrap();
    let pk_civic: [u8; 32] = material(0xB0, 32).try_into().unwrap();
    let salt_dev: [u8; 32] = material(0xC0, 32).try_into().unwrap();
    let nk = ds::derive_nullifier_key(&sk_civic);
    let commitment = ds::commitment_p1(&pk_civic, &salt_dev);
    let civic_id = ds::civic_id(&commitment);

    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "vectorId": "governance_ds_tags_v1",
        "description": "Реестр доменных меток (байт-в-байт) и BLAKE3 derive_key деривации; civic-пайплайн P1 (FGP-CRYPTO §1.1, §2).",
        "deriveMaterial": b64(&mat),
        "tags": derives,
        "civicPipeline": {
            "skCivic": b64(&sk_civic),
            "nullifierKey": b64(&nk),
            "pkCivic": b64(&pk_civic),
            "saltDev": b64(&salt_dev),
            "commitment": b64(&commitment),
            "civicId": b64(&civic_id),
        },
    })
}

fn fx_vector() -> Value {
    let table_bytes: Vec<u8> = EXP2_TABLE_Q32
        .iter()
        .flat_map(|v| v.to_le_bytes())
        .collect();

    let from_ratio: Vec<Value> = [
        (1i64, 1i64),
        (1, 2),
        (3, 2),
        (-3, 2),
        (1, 3),
        (2, 3),
        (-1, 3),
        (37, 100),
        (1, 0),
        (-1, 0),
        (0, 0),
    ]
    .iter()
    .map(|&(num, den)| json!({"num": num, "den": den, "bits": Fx::from_ratio(num, den).to_bits()}))
    .collect();

    let mul: Vec<Value> = [
        (Fx::from_bits(3), Fx::from_ratio(1, 2)),
        (Fx::from_bits(1), Fx::from_ratio(1, 2)),
        (Fx::from_ratio(1, 3), Fx::from_int(3)),
        (Fx::from_int(1 << 20), Fx::from_int(1 << 20)),
        (Fx::from_int(-(1 << 20)), Fx::from_int(1 << 20)),
        (Fx::from_ratio(-7, 2), Fx::from_ratio(5, 4)),
    ]
    .iter()
    .map(|&(a, b)| json!({"aBits": a.to_bits(), "bBits": b.to_bits(), "bits": (a * b).to_bits()}))
    .collect();

    let div: Vec<Value> = [
        (Fx::from_bits(1), Fx::TWO),
        (Fx::from_bits(3), Fx::TWO),
        (Fx::from_bits(-1), Fx::TWO),
        (Fx::from_bits(-3), Fx::TWO),
        (Fx::ONE, Fx::from_int(3)),
        (Fx::from_int(5), Fx::ZERO),
        (Fx::from_int(-5), Fx::ZERO),
        (Fx::ZERO, Fx::ZERO),
    ]
    .iter()
    .map(|&(a, b)| json!({"aBits": a.to_bits(), "bBits": b.to_bits(), "bits": (a / b).to_bits()}))
    .collect();

    let exp2: Vec<Value> = [
        Fx::ZERO,
        Fx::ONE,
        Fx::from_int(10),
        Fx::from_int(-1),
        Fx::from_ratio(1, 2),
        Fx::from_ratio(-1, 2),
        Fx::from_ratio(37, 100),
        Fx::from_int(30),
        Fx::from_int(31),
        Fx::from_int(100),
        Fx::from_int(-40),
        Fx::from_int(-100),
    ]
    .iter()
    .map(|&x| json!({"inputBits": x.to_bits(), "outputBits": x.exp2().to_bits()}))
    .collect();

    let log2: Vec<Value> = [
        Fx::ONE,
        Fx::TWO,
        Fx::from_int(1024),
        Fx::from_ratio(1, 2),
        Fx::from_ratio(3, 2),
        Fx::from_bits(1),
        Fx::MAX,
        Fx::ZERO,
        Fx::from_int(-3),
    ]
    .iter()
    .map(|&x| {
        json!({
            "inputBits": x.to_bits(),
            "outputBits": x.log2().map(Fx::to_bits),
        })
    })
    .collect();

    let sqrt: Vec<Value> = [
        Fx::ZERO,
        Fx::ONE,
        Fx::TWO,
        Fx::from_int(4),
        Fx::from_int(9),
        Fx::from_ratio(1, 4),
        Fx::MAX,
        Fx::from_int(-1),
    ]
    .iter()
    .map(|&x| {
        json!({
            "inputBits": x.to_bits(),
            "outputBits": x.sqrt().map(Fx::to_bits),
        })
    })
    .collect();

    let int_sqrt: Vec<Value> = [0u64, 1, 2, 100, 10_000, 1_000_000, u64::MAX]
        .iter()
        .map(|&n| json!({"n": n, "bits": int_sqrt_q32(n).to_bits()}))
        .collect();

    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "vectorId": "governance_fx_q32_v1",
        "description": "Q32.32: round-half-even, насыщение, exp2/log2/sqrt (FGP-CRYPTO §10). bits — сырое i64-представление; изменение таблицы exp2 = R3.",
        "exp2Table": {
            "nodes": 257,
            "blake3Le64": b64(blake3::hash(&table_bytes).as_bytes()),
            "first": EXP2_TABLE_Q32[0],
            "mid128": EXP2_TABLE_Q32[128],
            "last": EXP2_TABLE_Q32[256],
        },
        "fromRatio": from_ratio,
        "mulSaturating": mul,
        "divSaturating": div,
        "exp2": exp2,
        "log2": log2,
        "sqrt": sqrt,
        "intSqrtQ32": int_sqrt,
        "saturation": {
            "maxPlusOneBits": (Fx::MAX + Fx::ONE).to_bits(),
            "minMinusOneBits": (Fx::MIN - Fx::ONE).to_bits(),
            "negMinBits": (-Fx::MIN).to_bits(),
            "absMinBits": Fx::MIN.abs().to_bits(),
        },
    })
}

fn merkle_leaves(n: usize) -> Vec<merkle::Hash> {
    (0..n)
        .map(|i| merkle::leaf_hash(format!("governance-leaf-{i}").as_bytes()))
        .collect()
}

fn merkle_vector() -> Value {
    let n = 13;
    let leaves = merkle_leaves(n);
    let leaf_hashes: Vec<Value> = leaves.iter().map(|h| json!(b64(h))).collect();
    let prefix_roots: Vec<Value> = (1..=n)
        .map(|m| json!({"size": m, "root": b64(&merkle::root(&leaves[..m]))}))
        .collect();

    let inclusion: Vec<Value> = [0usize, 5, 12]
        .iter()
        .map(|&i| {
            let proof = merkle::inclusion_proof(&leaves, i).unwrap();
            json!({
                "leafIndex": i,
                "treeSize": n,
                "leafHash": b64(&leaves[i]),
                "proof": proof.iter().map(|h| b64(h)).collect::<Vec<_>>(),
            })
        })
        .collect();

    let consistency: Vec<Value> = [(6usize, 13usize), (8, 13), (13, 13), (1, 13)]
        .iter()
        .map(|&(m, size)| {
            let proof = merkle::consistency_proof(&leaves[..size], m).unwrap();
            json!({
                "oldSize": m,
                "newSize": size,
                "oldRoot": b64(&merkle::root(&leaves[..m])),
                "newRoot": b64(&merkle::root(&leaves[..size])),
                "proof": proof.iter().map(|h| b64(h)).collect::<Vec<_>>(),
            })
        })
        .collect();

    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "vectorId": "governance_log_merkle_v1",
        "description": "Merkle-журнал CT-класса: BLAKE3-домены flora/log/v1/{leaf,node}, RFC 6962/9162 алгоритмы (FGP-CRYPTO §8). Листья — UTF-8 строки governance-leaf-{i}.",
        "emptyRoot": b64(&merkle::empty_root()),
        "leafContentPrefix": "governance-leaf-",
        "treeSize": n,
        "leafHashes": leaf_hashes,
        "prefixRoots": prefix_roots,
        "inclusionProofs": inclusion,
        "consistencyProofs": consistency,
    })
}

fn merkle_negative_vector() -> Value {
    let n = 13;
    let leaves = merkle_leaves(n);
    let root = merkle::root(&leaves);
    let proof5 = merkle::inclusion_proof(&leaves, 5).unwrap();
    let cons6 = merkle::consistency_proof(&leaves, 6).unwrap();

    let mut tampered_element = proof5.clone();
    tampered_element[0] = merkle::leaf_hash(b"evil");

    let truncated: Vec<merkle::Hash> = proof5[..proof5.len() - 1].to_vec();

    let mut forked = leaves.clone();
    forked[2] = merkle::leaf_hash(b"rewritten history");
    let forked_old = merkle::root(&forked[..6]);

    let enc = |proof: &[merkle::Hash]| proof.iter().map(|h| b64(h)).collect::<Vec<_>>();

    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "vectorId": "governance_log_merkle_negative_v1",
        "description": "Негативы Merkle-журнала: каждая проверка обязана вернуть false (правило README: негативы — отдельным файлом).",
        "root": b64(&root),
        "treeSize": n,
        "inclusionCases": [
            {
                "name": "wrong_index",
                "leafIndex": 6,
                "leafHash": b64(&leaves[5]),
                "proof": enc(&proof5),
                "expectedError": "inclusion_verify_failed"
            },
            {
                "name": "tampered_proof_element",
                "leafIndex": 5,
                "leafHash": b64(&leaves[5]),
                "proof": enc(&tampered_element),
                "expectedError": "inclusion_verify_failed"
            },
            {
                "name": "truncated_proof",
                "leafIndex": 5,
                "leafHash": b64(&leaves[5]),
                "proof": enc(&truncated),
                "expectedError": "inclusion_verify_failed"
            },
            {
                "name": "index_out_of_tree",
                "leafIndex": 13,
                "leafHash": b64(&leaves[5]),
                "proof": enc(&proof5),
                "expectedError": "inclusion_verify_failed"
            }
        ],
        "consistencyCases": [
            {
                "name": "forked_prefix",
                "oldSize": 6,
                "newSize": 13,
                "oldRoot": b64(&forked_old),
                "newRoot": b64(&root),
                "proof": enc(&cons6),
                "expectedError": "consistency_verify_failed"
            },
            {
                "name": "old_size_zero",
                "oldSize": 0,
                "newSize": 13,
                "oldRoot": b64(&merkle::root(&leaves[..6])),
                "newRoot": b64(&root),
                "proof": enc(&cons6),
                "expectedError": "consistency_verify_failed"
            },
            {
                "name": "old_larger_than_new",
                "oldSize": 14,
                "newSize": 13,
                "oldRoot": b64(&merkle::root(&leaves[..6])),
                "newRoot": b64(&root),
                "proof": enc(&cons6),
                "expectedError": "consistency_verify_failed"
            }
        ]
    })
}

/// Head журнала для STH/sortition-векторов: корень 13 листьев merkle-вектора
/// (кросс-согласованность файлов) + фиксированный момент времени.
fn vector_head() -> sth::TreeHead {
    sth::TreeHead {
        tree_size: 13,
        root: merkle::root(&merkle_leaves(13)),
        timestamp_ms: 1_780_000_000_000,
    }
}

fn witness_seed(i: u8) -> [u8; 32] {
    material32(0x60 + i)
}

fn sth_vector() -> Value {
    let head = vector_head();
    let registry: Vec<Value> = (0..5)
        .map(|i| json!(b64(&sig::public_key(&witness_seed(i)))))
        .collect();
    let cosigns: Vec<Value> = (0..5)
        .map(|i| {
            let cosign = sth::sign_tree_head(&head, &witness_seed(i));
            json!({
                "witnessSeed": b64(&witness_seed(i)),
                "witness": b64(&cosign.signer),
                "signature": b64(&cosign.signature),
            })
        })
        .collect();

    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "vectorId": "governance_log_sth_v1",
        "description": "Signed tree head журнала и витнесс-косайны (FGP-CRYPTO §8): канонические байты tree_size LE64 ‖ root ‖ timestamp_ms LE64, Ed25519 над flora/log/v1/sth ‖ байты, клиентский минимум ≥ 3 валидных косайнов от различных витнессов реестра. P0-формат — множество Ed25519 (FROST — P1).",
        "head": {
            "treeSize": head.tree_size,
            "root": b64(&head.root),
            "timestampMs": head.timestamp_ms,
        },
        "signingBytes": b64(&head.signing_bytes()),
        "minWitnessCosigns": sth::MIN_WITNESS_COSIGNS,
        "witnessRegistry": registry,
        "cosigns": cosigns,
        "validCosignCount": 5,
        "accepted": true,
    })
}

fn sth_negative_vector() -> Value {
    let head = vector_head();
    let enc_cosign = |c: &sth::Cosign| {
        json!({
            "witness": b64(&c.signer),
            "signature": b64(&c.signature),
        })
    };

    // Подпись с испорченным байтом.
    let mut tampered = sth::sign_tree_head(&head, &witness_seed(0));
    tampered.signature[0] ^= 1;

    // Косайн другого head (форк: другой корень).
    let mut forked_head = head;
    forked_head.root = merkle::leaf_hash(b"rewritten history");
    let forked = sth::sign_tree_head(&forked_head, &witness_seed(1));

    // Витнесс вне реестра (реестр в позитивном векторе — сиды 0x60..0x64).
    let unknown = sth::sign_tree_head(&head, &witness_seed(9));

    // Дубль витнесса: три косайна, но подписавших — два.
    let dup = [
        sth::sign_tree_head(&head, &witness_seed(0)),
        sth::sign_tree_head(&head, &witness_seed(0)),
        sth::sign_tree_head(&head, &witness_seed(1)),
    ];

    // Два валидных — ниже клиентского минимума.
    let two = [
        sth::sign_tree_head(&head, &witness_seed(2)),
        sth::sign_tree_head(&head, &witness_seed(3)),
    ];

    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "vectorId": "governance_log_sth_negative_v1",
        "description": "Негативы STH-косайнинга: каждый кейс обязан дать validCosignCount ниже минимума 3 и отказ приёма журнала (правило README: негативы — отдельным файлом). Реестр витнессов — из governance-log-sth-v1.json.",
        "head": {
            "treeSize": head.tree_size,
            "root": b64(&head.root),
            "timestampMs": head.timestamp_ms,
        },
        "cases": [
            {
                "name": "tampered_signature",
                "cosigns": [enc_cosign(&tampered)],
                "expectedValidCount": 0,
                "expectedError": "sth_accept_failed"
            },
            {
                "name": "cosign_of_forked_head",
                "cosigns": [enc_cosign(&forked)],
                "expectedValidCount": 0,
                "expectedError": "sth_accept_failed"
            },
            {
                "name": "witness_outside_registry",
                "cosigns": [enc_cosign(&unknown)],
                "expectedValidCount": 0,
                "expectedError": "sth_accept_failed"
            },
            {
                "name": "duplicate_witness_counts_once",
                "cosigns": dup.iter().map(enc_cosign).collect::<Vec<_>>(),
                "expectedValidCount": 2,
                "expectedError": "sth_accept_failed"
            },
            {
                "name": "two_valid_below_minimum",
                "cosigns": two.iter().map(enc_cosign).collect::<Vec<_>>(),
                "expectedValidCount": 2,
                "expectedError": "sth_accept_failed"
            }
        ]
    })
}

fn sortition_vector() -> Value {
    let head = vector_head();
    let anchor = material(0xE0, 32);
    let seed = sortition::window_seed(&head.signing_bytes(), &anchor);
    let members: Vec<[u8; 32]> = (0..20)
        .map(|i| ds::derive(ds::CIVIC_COMMIT, format!("sortition-member-{i}").as_bytes()))
        .collect();

    let ranks: Vec<Value> = members
        .iter()
        .enumerate()
        .map(|(i, m)| {
            json!({
                "index": i,
                "member": b64(m),
                "rank": b64(&sortition::member_rank(&seed, m)),
            })
        })
        .collect();

    let contexts: Vec<Value> = [&b"panel"[..], &b"attestors"[..]]
        .iter()
        .map(|label| {
            let ctx = sortition::context_seed(&seed, label);
            json!({
                "label": String::from_utf8_lossy(label),
                "seed": b64(&ctx),
                "draw5": sortition::draw(&ctx, &members, 5),
            })
        })
        .collect();

    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "vectorId": "governance_sortition_v1",
        "description": "Публичные жеребьёвки P0 (FGP-CRYPTO §6): сид окна из (STH, внешний якорь) с длино-префиксом, суб-сиды контекстов, ранги flora/sortition/v1/rank, выборка k наименьших (rank, index) — пересчитываема любым. STH — из governance-log-sth-v1.json.",
        "sthSigningBytes": b64(&head.signing_bytes()),
        "externalAnchor": b64(&anchor),
        "windowSeed": b64(&seed),
        "members": ranks,
        "draw": {
            "k5": sortition::draw(&seed, &members, 5),
            "fullPermutation": sortition::draw(&seed, &members, 20),
        },
        "contexts": contexts,
    })
}

fn commit_reveal_vector() -> Value {
    let cases: Vec<Value> = [
        (material32(0x70), b"vote:for".to_vec()),
        (material32(0x71), b"vote:against".to_vec()),
        (material32(0x70), Vec::new()),
        (material32(0x72), material(0x10, 64)),
    ]
    .iter()
    .map(|(nonce, payload)| {
        json!({
            "nonce": b64(nonce),
            "payload": b64(payload),
            "commitment": b64(&commit_reveal::commit(nonce, payload)),
        })
    })
    .collect();

    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "vectorId": "governance_commit_reveal_v1",
        "description": "Commit-reveal скрытых агрегатов (FGP §3.4, профиль P0): commitment = derive(flora/commit-reveal/v1/commit, nonce ‖ payload); раскрытие проверяется пересчётом.",
        "cases": cases,
    })
}

fn commit_reveal_negative_vector() -> Value {
    let nonce = material32(0x70);
    let commitment = commit_reveal::commit(&nonce, b"vote:for");
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "vectorId": "governance_commit_reveal_negative_v1",
        "description": "Негативы commit-reveal: подмена payload или nonce обязана давать отказ verify_reveal.",
        "commitment": b64(&commitment),
        "cases": [
            {
                "name": "wrong_payload",
                "nonce": b64(&nonce),
                "payload": b64(b"vote:against"),
                "expectedError": "commit_reveal_mismatch"
            },
            {
                "name": "wrong_nonce",
                "nonce": b64(&material32(0x71)),
                "payload": b64(b"vote:for"),
                "expectedError": "commit_reveal_mismatch"
            }
        ]
    })
}

/// Синтетическая популяция bridging-вектора: 40 оценщиков (кластеры A = 0..20,
/// B = 20..40), ноты: 0 — консенсусно-полезная, 1 — поляризованная,
/// 2 — консенсусно-бесполезная, 3 — «отчасти полезная» с недобором оценщиков.
fn bridging_scenario() -> Vec<bridging::Rating> {
    let mut ratings = Vec::new();
    for u in 0..40u32 {
        let in_a = u < 20;
        ratings.push(bridging::Rating {
            rater: u,
            note: 0,
            value: Fx::ONE,
        });
        ratings.push(bridging::Rating {
            rater: u,
            note: 1,
            value: if in_a { Fx::ONE } else { Fx::ZERO },
        });
        ratings.push(bridging::Rating {
            rater: u,
            note: 2,
            value: Fx::ZERO,
        });
        // Нота 3: по 10 оценщиков из каждого кластера, «отчасти полезна».
        if u % 20 < 10 {
            ratings.push(bridging::Rating {
                rater: u,
                note: 3,
                value: Fx::from_ratio(1, 2),
            });
        }
    }
    ratings
}

fn bridging_vector() -> Value {
    let params = bridging::BridgingParams::default();
    let seed = sortition::window_seed(b"bridging-vector-sth", b"bridging-vector-anchor");
    let ratings = bridging_scenario();
    let model = bridging::fit(40, 4, &ratings, &seed, &params);

    let ratings_json: Vec<Value> = ratings
        .iter()
        .map(|r| json!({"rater": r.rater, "note": r.note, "valueBits": r.value.to_bits()}))
        .collect();

    // (оценщики, кластеры) по нотам — входы правила показа (владелец кластеризации —
    // Governance-модуль; здесь — синтетика сценария).
    let note_stats = [(40u32, 2u32), (40, 2), (40, 2), (20, 2)];
    let notes: Vec<Value> = (0..4usize)
        .map(|n| {
            let (raters, clusters) = note_stats[n];
            json!({
                "note": n,
                "biasBits": model.note_bias[n].to_bits(),
                "factorBits": model.note_factor[n].to_bits(),
                "raterCount": raters,
                "clusterCount": clusters,
                "show": bridging::show_note(model.note_bias[n], raters, clusters, &params),
            })
        })
        .collect();

    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "vectorId": "governance_bridging_v1",
        "description": "Bridging-скоринг L3 (FGP §6.2, FGP-CRYPTO §10): детерминированная матричная факторизация r̂ = μ + b_u + b_n + f_u·f_n на Q32.32 — фиксированные итерации, порядок обхода (note, rater), инициализация факторов из сида (flora/bridging/v1/init). Параметры нормативны; показ ⇔ b_n ≥ τ ∧ оценщиков ≥ 30 ∧ кластеров ≥ 2.",
        "params": {
            "iterations": params.iterations,
            "learningRateBits": params.learning_rate.to_bits(),
            "lambdaInterceptBits": params.lambda_intercept.to_bits(),
            "lambdaFactorBits": params.lambda_factor.to_bits(),
            "tauBits": params.tau.to_bits(),
            "minRaters": params.min_raters,
            "minClusters": params.min_clusters,
        },
        "windowSeed": b64(&seed),
        "nRaters": 40,
        "nNotes": 4,
        "ratings": ratings_json,
        "model": {
            "muBits": model.mu.to_bits(),
            "raterBiasBits": model.rater_bias.iter().map(|b| b.to_bits()).collect::<Vec<_>>(),
            "raterFactorBits": model.rater_factor.iter().map(|f| f.to_bits()).collect::<Vec<_>>(),
        },
        "notes": notes,
    })
}

fn weights_vector() -> Value {
    let decay: Vec<Value> = [
        (Fx::ZERO, Fx::from_int(12)),
        (Fx::from_int(12), Fx::from_int(12)),
        (Fx::from_int(36), Fx::from_int(12)),
        (Fx::from_int(-5), Fx::from_int(12)),
        (Fx::from_int(5), Fx::ZERO),
        (Fx::from_int(1), Fx::from_int(7)),
        (Fx::from_ratio(7, 2), Fx::from_int(7)),
    ]
    .iter()
    .map(|&(dt, hl)| {
        json!({
            "dtBits": dt.to_bits(),
            "halfLifeBits": hl.to_bits(),
            "bits": weights::decay_factor(dt, hl).to_bits(),
        })
    })
    .collect();

    let beta = Fx::ONE;
    let w_max = Fx::from_int(8);
    let vote: Vec<Value> = [0i64, 1, 5, 127, 1_000_000, -7]
        .iter()
        .map(|&r| {
            let rep = Fx::from_int(r as i32);
            json!({
                "reputationBits": rep.to_bits(),
                "betaLog2Bits": beta.to_bits(),
                "wMaxBits": w_max.to_bits(),
                "bits": weights::vote_weight(rep, beta, w_max).to_bits(),
            })
        })
        .collect();

    let cap: Vec<Value> = [0u64, 100, 101, 10_000, 1_000_000]
        .iter()
        .map(|&n| json!({"nActive": n, "bits": weights::delegation_cap(n).to_bits()}))
        .collect();

    let w8 = Fx::from_int(8);
    let cd20 = Fx::from_int(20);
    let eff: Vec<Value> = [0i32, 5, 20, 200, 1_000_000]
        .iter()
        .map(|&i| {
            let inflow = Fx::from_int(i);
            json!({
                "ownWeightBits": w8.to_bits(),
                "inflowBits": inflow.to_bits(),
                "cDBits": cd20.to_bits(),
                "bits": weights::effective_weight(w8, inflow, cd20).to_bits(),
            })
        })
        .collect();

    // Conviction: γ = 2^(−1/7), support = 10, y₀ = 0 — состояния после шагов 1, 10, 100.
    let gamma = weights::decay_factor(Fx::from_int(1), Fx::from_int(7));
    let support = Fx::from_int(10);
    let mut y = Fx::ZERO;
    let mut conviction_states = Vec::new();
    for step in 1..=100u32 {
        y = weights::conviction_step(y, gamma, support);
        if step == 1 || step == 10 || step == 100 {
            conviction_states.push(json!({"step": step, "bits": y.to_bits()}));
        }
    }

    let theta: Vec<Value> = [
        (Fx::from_int(100), Fx::ONE, Fx::ZERO),
        (Fx::from_int(100), Fx::ONE, Fx::ONE),
        (Fx::from_int(100), Fx::ONE, Fx::from_ratio(1, 2)),
        (Fx::from_int(100), Fx::ONE, Fx::from_int(5)),
        (Fx::from_int(100), Fx::ONE, Fx::from_int(-5)),
    ]
    .iter()
    .map(|&(base, eta, q)| {
        json!({
            "thetaBaseBits": base.to_bits(),
            "etaBits": eta.to_bits(),
            "qHatBits": q.to_bits(),
            "bits": weights::theta_eff(base, eta, q).to_bits(),
        })
    })
    .collect();

    let qv: Vec<Value> = [0u32, 1, 5, 10]
        .iter()
        .map(|&v| json!({"votes": v, "cost": weights::qv_cost(v)}))
        .collect();

    let strength: Vec<Value> = [0u64, 1, 99, 100, 101, u64::MAX]
        .iter()
        .map(|&b| json!({"budget": b, "maxStrength": weights::max_vote_strength(b)}))
        .collect();

    let samples: Vec<Value> = [
        (385u32, 1_000_000_000u64),
        (385, 385),
        (385, 100),
        (385, 1),
        (385, 0),
        (1068, 10_000),
        (1068, 1_000_000),
    ]
    .iter()
    .map(|&(n0, population)| {
        json!({"n0": n0, "population": population, "size": weights::sample_size(n0, population)})
    })
    .collect();

    let q_max = Fx::from_int(10);
    let panel: Vec<Value> = [
        vec![
            Fx::from_int(3),
            Fx::from_int(100),
            Fx::from_int(4),
            Fx::from_int(5),
            Fx::ZERO,
        ],
        vec![Fx::from_int(50); 5],
        vec![Fx::from_int(-3); 5],
        vec![Fx::from_int(2), Fx::from_int(4)],
        vec![],
    ]
    .iter()
    .map(|scores| {
        json!({
            "scoresBits": scores.iter().map(|s| s.to_bits()).collect::<Vec<_>>(),
            "qMaxBits": q_max.to_bits(),
            "bits": weights::panel_score(scores, q_max).to_bits(),
        })
    })
    .collect();

    let alpha = Fx::from_ratio(4, 5);
    let inflow_cases: Vec<Value> = [
        vec![(Fx::from_int(5), 1u32)],
        vec![(Fx::from_int(5), 2)],
        vec![
            (Fx::from_int(5), 1),
            (Fx::from_int(5), 2),
            (Fx::from_int(5), 3),
        ],
        vec![(Fx::from_int(-5), 1), (Fx::from_int(3), 0)],
    ]
    .iter()
    .map(|edges| {
        json!({
            "edges": edges
                .iter()
                .map(|(w, h)| json!({"weightBits": w.to_bits(), "depth": h}))
                .collect::<Vec<_>>(),
            "alphaBits": alpha.to_bits(),
            "maxDepth": 2,
            "bits": weights::delegation_inflow(edges, alpha, 2).to_bits(),
        })
    })
    .collect();

    let threshold = Fx::from_ratio(7, 10);
    let slope = Fx::from_int(2);
    let floor = Fx::from_ratio(1, 2);
    let discount: Vec<Value> = [
        Fx::ZERO,
        Fx::from_ratio(1, 2),
        threshold,
        Fx::from_ratio(4, 5),
        Fx::ONE,
        Fx::from_int(5),
        Fx::from_int(-5),
    ]
    .iter()
    .map(|&c| {
        json!({
            "correlationBits": c.to_bits(),
            "thresholdBits": threshold.to_bits(),
            "slopeBits": slope.to_bits(),
            "floorBits": floor.to_bits(),
            "bits": weights::pair_discount(c, threshold, slope, floor).to_bits(),
        })
    })
    .collect();

    let bloc_weights = [Fx::from_int(4), Fx::from_int(6), Fx::from_int(2)];
    let bloc_pairs = [
        (0u32, 1u32, Fx::from_ratio(1, 2)),
        (0, 2, Fx::from_ratio(1, 2)),
        (1, 2, Fx::from_ratio(1, 2)),
    ];
    let organic_pairs = [(0u32, 1u32, Fx::from_ratio(19, 20))];
    let discounted: Vec<Value> = [
        (&bloc_weights[..], &[][..]),
        (&bloc_weights[..], &organic_pairs[..]),
        (&bloc_weights[..], &bloc_pairs[..]),
    ]
    .iter()
    .map(|&(w, pairs)| {
        json!({
            "weightsBits": w.iter().map(|x| x.to_bits()).collect::<Vec<_>>(),
            "pairs": pairs
                .iter()
                .map(|(i, j, d)| json!({"i": i, "j": j, "deltaBits": d.to_bits()}))
                .collect::<Vec<_>>(),
            "bits": weights::discounted_total(w, pairs).to_bits(),
        })
    })
    .collect();

    let co_dir: Vec<Value> = [(0u64, 0u64), (0, 10), (5, 10), (10, 10), (20, 10)]
        .iter()
        .map(|&(joint, total)| {
            json!({
                "joint": joint,
                "total": total,
                "bits": weights::co_direction(joint, total).to_bits(),
            })
        })
        .collect();

    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "vectorId": "governance_fgp_weights_v1",
        "description": "Consensus-critical формулы FGP §4/§5.6 на Q32.32 (FGP-CRYPTO §10): затухания, вес голоса, кап и насыщение делегаций, вклады потока I, conviction, θ_eff, QV и √B, размер выборки (FPC), панельное q_i (trimmed mean 20%), корреляционный дисконт §4.7. Эти значения нормативны; вещественные формулы FGP — пояснение.",
        "decayFactor": decay,
        "voteWeight": vote,
        "delegationCap": cap,
        "effectiveWeight": eff,
        "delegationInflow": inflow_cases,
        "conviction": {
            "gammaBits": gamma.to_bits(),
            "supportBits": support.to_bits(),
            "initialBits": 0,
            "states": conviction_states,
        },
        "thetaEff": theta,
        "qvCost": qv,
        "maxVoteStrength": strength,
        "sampleSize": samples,
        "panelScore": panel,
        "coDirection": co_dir,
        "pairDiscount": discount,
        "discountedTotal": discounted,
    })
}

fn main() {
    std::fs::create_dir_all(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../Documents/test-vectors/governance"),
    )
    .expect("mkdir");
    write("governance-ds-tags-v1.json", &ds_tags_vector());
    write("governance-fx-q32-v1.json", &fx_vector());
    write("governance-log-merkle-v1.json", &merkle_vector());
    write(
        "governance-log-merkle-negative-v1.json",
        &merkle_negative_vector(),
    );
    write("governance-fgp-weights-v1.json", &weights_vector());
    write("governance-log-sth-v1.json", &sth_vector());
    write(
        "governance-log-sth-negative-v1.json",
        &sth_negative_vector(),
    );
    write("governance-sortition-v1.json", &sortition_vector());
    write("governance-commit-reveal-v1.json", &commit_reveal_vector());
    write(
        "governance-commit-reveal-negative-v1.json",
        &commit_reveal_negative_vector(),
    );
    write("governance-bridging-v1.json", &bridging_vector());
}
