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
use flora_governance_crypto::{PROTOCOL_VERSION, ds, merkle, weights};
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
    // crate: Backend/crates/modules/flora-governance-crypto → корень репо на 4 уровня выше.
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

    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "vectorId": "governance_fgp_weights_v1",
        "description": "Consensus-critical формулы FGP §4 на Q32.32 (FGP-CRYPTO §10): затухания, вес голоса, кап и насыщение делегаций, conviction, θ_eff, QV. Эти значения нормативны; вещественные формулы FGP — пояснение.",
        "decayFactor": decay,
        "voteWeight": vote,
        "delegationCap": cap,
        "effectiveWeight": eff,
        "conviction": {
            "gammaBits": gamma.to_bits(),
            "supportBits": support.to_bits(),
            "initialBits": 0,
            "states": conviction_states,
        },
        "thetaEff": theta,
        "qvCost": qv,
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
}
