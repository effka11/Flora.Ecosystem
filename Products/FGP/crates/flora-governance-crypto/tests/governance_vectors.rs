//! Consumer-тесты golden-векторов governance (обязательны по правилам
//! Documents/test-vectors/README.md: вектор без потребителя — невыполненный
//! compliance-пункт; состав набора — FGP-CRYPTO §12).
//!
//! Каждый кейс пересчитывается ядром `flora-governance-crypto` и сверяется
//! бит-в-бит; регенерация файлов:
//! `cargo run -p flora-governance-crypto --example gen_vectors`.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use flora_governance_crypto::fx::{EXP2_TABLE_Q32, Fx, int_sqrt_q32};
use flora_governance_crypto::{
    PROTOCOL_VERSION, bridging, commit_reveal, ds, merkle, sig, sortition, sth, weights,
};
use serde_json::Value;

fn load_vector(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../Documents/test-vectors/governance")
        .join(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "нет вектора {} ({e}); регенерация: cargo run -p flora-governance-crypto --example gen_vectors",
            path.display()
        )
    });
    let value: Value = serde_json::from_str(&text).expect("валидный JSON");
    assert_eq!(
        value["protocolVersion"].as_u64(),
        Some(PROTOCOL_VERSION as u64),
        "{name}: protocolVersion"
    );
    value
}

fn b64d(v: &Value) -> Vec<u8> {
    URL_SAFE_NO_PAD
        .decode(v.as_str().expect("строка base64url"))
        .expect("валидный base64url без padding")
}

fn hash32(v: &Value) -> [u8; 32] {
    b64d(v).try_into().expect("32 байта")
}

fn sig64(v: &Value) -> [u8; 64] {
    b64d(v).try_into().expect("64 байта")
}

fn fx_bits(v: &Value) -> Fx {
    Fx::from_bits(v.as_i64().expect("i64 bits"))
}

fn arr(v: &Value) -> &Vec<Value> {
    v.as_array().expect("массив")
}

fn u32_of(v: &Value) -> u32 {
    u32::try_from(v.as_u64().expect("u64")).expect("u32")
}

// ---------- доменные метки и civic-пайплайн ----------

#[test]
fn ds_tags_match() {
    let v = load_vector("governance-ds-tags-v1.json");
    assert_eq!(v["vectorId"].as_str(), Some("governance_ds_tags_v1"));

    let material = b64d(&v["deriveMaterial"]);
    let tags = arr(&v["tags"]);
    // Реестр зафиксирован байт-в-байт: состав и порядок совпадают с ds::REGISTRY.
    assert_eq!(tags.len(), ds::REGISTRY.len(), "размер реестра");
    for (case, (name, tag)) in tags.iter().zip(ds::REGISTRY) {
        assert_eq!(case["name"].as_str(), Some(*name));
        assert_eq!(case["tag"].as_str(), Some(*tag));
        assert_eq!(
            b64d(&case["tagBytes"]),
            tag.as_bytes(),
            "байты метки {name}"
        );
        assert_eq!(
            hash32(&case["output"]),
            ds::derive(tag, &material),
            "derive({name})"
        );
    }

    let civic = &v["civicPipeline"];
    let sk: [u8; 32] = b64d(&civic["skCivic"]).try_into().unwrap();
    let pk: [u8; 32] = b64d(&civic["pkCivic"]).try_into().unwrap();
    let salt: [u8; 32] = b64d(&civic["saltDev"]).try_into().unwrap();
    assert_eq!(
        hash32(&civic["nullifierKey"]),
        ds::derive_nullifier_key(&sk)
    );
    let commitment = ds::commitment_p1(&pk, &salt);
    assert_eq!(hash32(&civic["commitment"]), commitment);
    assert_eq!(hash32(&civic["civicId"]), ds::civic_id(&commitment));
}

// ---------- фикс-пойнт Q32.32 ----------

#[test]
fn fx_q32_match() {
    let v = load_vector("governance-fx-q32-v1.json");
    assert_eq!(v["vectorId"].as_str(), Some("governance_fx_q32_v1"));

    let table = &v["exp2Table"];
    assert_eq!(table["nodes"].as_u64(), Some(257));
    assert_eq!(table["first"].as_u64(), Some(EXP2_TABLE_Q32[0]));
    assert_eq!(table["mid128"].as_u64(), Some(EXP2_TABLE_Q32[128]));
    assert_eq!(table["last"].as_u64(), Some(EXP2_TABLE_Q32[256]));
    let table_bytes: Vec<u8> = EXP2_TABLE_Q32
        .iter()
        .flat_map(|x| x.to_le_bytes())
        .collect();
    assert_eq!(
        hash32(&table["blake3Le64"]),
        *blake3::hash(&table_bytes).as_bytes(),
        "таблица exp2 изменена — это событие класса R3"
    );

    for case in arr(&v["fromRatio"]) {
        let expected = Fx::from_ratio(case["num"].as_i64().unwrap(), case["den"].as_i64().unwrap());
        assert_eq!(expected.to_bits(), case["bits"].as_i64().unwrap());
    }
    for case in arr(&v["mulSaturating"]) {
        let a = fx_bits(&case["aBits"]);
        let b = fx_bits(&case["bBits"]);
        assert_eq!((a * b).to_bits(), case["bits"].as_i64().unwrap());
    }
    for case in arr(&v["divSaturating"]) {
        let a = fx_bits(&case["aBits"]);
        let b = fx_bits(&case["bBits"]);
        assert_eq!((a / b).to_bits(), case["bits"].as_i64().unwrap());
    }
    for case in arr(&v["exp2"]) {
        let x = fx_bits(&case["inputBits"]);
        assert_eq!(x.exp2().to_bits(), case["outputBits"].as_i64().unwrap());
    }
    for case in arr(&v["log2"]) {
        let x = fx_bits(&case["inputBits"]);
        assert_eq!(
            x.log2().map(Fx::to_bits),
            case["outputBits"].as_i64(),
            "log2({x:?})"
        );
    }
    for case in arr(&v["sqrt"]) {
        let x = fx_bits(&case["inputBits"]);
        assert_eq!(x.sqrt().map(Fx::to_bits), case["outputBits"].as_i64());
    }
    for case in arr(&v["intSqrtQ32"]) {
        let n = case["n"].as_u64().unwrap();
        assert_eq!(int_sqrt_q32(n).to_bits(), case["bits"].as_i64().unwrap());
    }

    let sat = &v["saturation"];
    assert_eq!(
        (Fx::MAX + Fx::ONE).to_bits(),
        sat["maxPlusOneBits"].as_i64().unwrap()
    );
    assert_eq!(
        (Fx::MIN - Fx::ONE).to_bits(),
        sat["minMinusOneBits"].as_i64().unwrap()
    );
    assert_eq!((-Fx::MIN).to_bits(), sat["negMinBits"].as_i64().unwrap());
    assert_eq!(Fx::MIN.abs().to_bits(), sat["absMinBits"].as_i64().unwrap());
}

// ---------- Merkle-журнал ----------

fn vector_leaves(v: &Value, n: usize) -> Vec<merkle::Hash> {
    let prefix = v["leafContentPrefix"].as_str().expect("префикс листа");
    (0..n)
        .map(|i| merkle::leaf_hash(format!("{prefix}{i}").as_bytes()))
        .collect()
}

#[test]
fn log_merkle_match() {
    let v = load_vector("governance-log-merkle-v1.json");
    assert_eq!(v["vectorId"].as_str(), Some("governance_log_merkle_v1"));
    assert_eq!(hash32(&v["emptyRoot"]), merkle::empty_root());

    let n = v["treeSize"].as_u64().unwrap() as usize;
    let leaves = vector_leaves(&v, n);
    for (leaf, expected) in leaves.iter().zip(arr(&v["leafHashes"])) {
        assert_eq!(*leaf, hash32(expected));
    }
    for case in arr(&v["prefixRoots"]) {
        let m = case["size"].as_u64().unwrap() as usize;
        assert_eq!(merkle::root(&leaves[..m]), hash32(&case["root"]));
    }
    for case in arr(&v["inclusionProofs"]) {
        let index = case["leafIndex"].as_u64().unwrap() as usize;
        let proof: Vec<merkle::Hash> = arr(&case["proof"]).iter().map(hash32).collect();
        assert_eq!(
            merkle::inclusion_proof(&leaves, index).unwrap(),
            proof,
            "inclusion {index}: пруф пересчитывается"
        );
        assert!(merkle::verify_inclusion(
            &merkle::root(&leaves),
            n as u64,
            index as u64,
            &hash32(&case["leafHash"]),
            &proof,
        ));
    }
    for case in arr(&v["consistencyProofs"]) {
        let old_size = case["oldSize"].as_u64().unwrap() as usize;
        let proof: Vec<merkle::Hash> = arr(&case["proof"]).iter().map(hash32).collect();
        assert_eq!(merkle::consistency_proof(&leaves, old_size).unwrap(), proof);
        assert!(merkle::verify_consistency(
            old_size as u64,
            n as u64,
            &hash32(&case["oldRoot"]),
            &hash32(&case["newRoot"]),
            &proof,
        ));
    }
}

#[test]
fn log_merkle_negatives_rejected() {
    let v = load_vector("governance-log-merkle-negative-v1.json");
    let root = hash32(&v["root"]);
    let n = v["treeSize"].as_u64().unwrap();
    for case in arr(&v["inclusionCases"]) {
        let proof: Vec<merkle::Hash> = arr(&case["proof"]).iter().map(hash32).collect();
        assert!(
            !merkle::verify_inclusion(
                &root,
                n,
                case["leafIndex"].as_u64().unwrap(),
                &hash32(&case["leafHash"]),
                &proof,
            ),
            "негатив {} обязан отвергаться",
            case["name"]
        );
    }
    for case in arr(&v["consistencyCases"]) {
        let proof: Vec<merkle::Hash> = arr(&case["proof"]).iter().map(hash32).collect();
        assert!(
            !merkle::verify_consistency(
                case["oldSize"].as_u64().unwrap(),
                case["newSize"].as_u64().unwrap(),
                &hash32(&case["oldRoot"]),
                &hash32(&case["newRoot"]),
                &proof,
            ),
            "негатив {} обязан отвергаться",
            case["name"]
        );
    }
}

// ---------- формулы весов ----------

#[test]
fn fgp_weights_match() {
    let v = load_vector("governance-fgp-weights-v1.json");
    assert_eq!(v["vectorId"].as_str(), Some("governance_fgp_weights_v1"));

    for case in arr(&v["decayFactor"]) {
        let got = weights::decay_factor(fx_bits(&case["dtBits"]), fx_bits(&case["halfLifeBits"]));
        assert_eq!(got.to_bits(), case["bits"].as_i64().unwrap());
    }
    for case in arr(&v["voteWeight"]) {
        let got = weights::vote_weight(
            fx_bits(&case["reputationBits"]),
            fx_bits(&case["betaLog2Bits"]),
            fx_bits(&case["wMaxBits"]),
        );
        assert_eq!(got.to_bits(), case["bits"].as_i64().unwrap());
    }
    for case in arr(&v["delegationCap"]) {
        let got = weights::delegation_cap(case["nActive"].as_u64().unwrap());
        assert_eq!(got.to_bits(), case["bits"].as_i64().unwrap());
    }
    for case in arr(&v["effectiveWeight"]) {
        let got = weights::effective_weight(
            fx_bits(&case["ownWeightBits"]),
            fx_bits(&case["inflowBits"]),
            fx_bits(&case["cDBits"]),
        );
        assert_eq!(got.to_bits(), case["bits"].as_i64().unwrap());
    }
    for case in arr(&v["delegationInflow"]) {
        let edges: Vec<(Fx, u32)> = arr(&case["edges"])
            .iter()
            .map(|e| (fx_bits(&e["weightBits"]), u32_of(&e["depth"])))
            .collect();
        let got = weights::delegation_inflow(
            &edges,
            fx_bits(&case["alphaBits"]),
            u32_of(&case["maxDepth"]),
        );
        assert_eq!(got.to_bits(), case["bits"].as_i64().unwrap());
    }

    let conviction = &v["conviction"];
    let gamma = fx_bits(&conviction["gammaBits"]);
    let support = fx_bits(&conviction["supportBits"]);
    let mut y = Fx::from_bits(conviction["initialBits"].as_i64().unwrap());
    let mut step = 0u64;
    for state in arr(&conviction["states"]) {
        let target = state["step"].as_u64().unwrap();
        while step < target {
            y = weights::conviction_step(y, gamma, support);
            step += 1;
        }
        assert_eq!(y.to_bits(), state["bits"].as_i64().unwrap(), "шаг {target}");
    }

    for case in arr(&v["thetaEff"]) {
        let got = weights::theta_eff(
            fx_bits(&case["thetaBaseBits"]),
            fx_bits(&case["etaBits"]),
            fx_bits(&case["qHatBits"]),
        );
        assert_eq!(got.to_bits(), case["bits"].as_i64().unwrap());
    }
    for case in arr(&v["qvCost"]) {
        let got = weights::qv_cost(u32_of(&case["votes"]));
        assert_eq!(got, case["cost"].as_u64().unwrap());
    }
    for case in arr(&v["maxVoteStrength"]) {
        let got = weights::max_vote_strength(case["budget"].as_u64().unwrap());
        assert_eq!(got as u64, case["maxStrength"].as_u64().unwrap());
    }
    for case in arr(&v["sampleSize"]) {
        let got = weights::sample_size(u32_of(&case["n0"]), case["population"].as_u64().unwrap());
        assert_eq!(got as u64, case["size"].as_u64().unwrap());
    }
    for case in arr(&v["panelScore"]) {
        let scores: Vec<Fx> = arr(&case["scoresBits"]).iter().map(fx_bits).collect();
        let got = weights::panel_score(&scores, fx_bits(&case["qMaxBits"]));
        assert_eq!(got.to_bits(), case["bits"].as_i64().unwrap());
    }
    for case in arr(&v["coDirection"]) {
        let got = weights::co_direction(
            case["joint"].as_u64().unwrap(),
            case["total"].as_u64().unwrap(),
        );
        assert_eq!(got.to_bits(), case["bits"].as_i64().unwrap());
    }
    for case in arr(&v["pairDiscount"]) {
        let got = weights::pair_discount(
            fx_bits(&case["correlationBits"]),
            fx_bits(&case["thresholdBits"]),
            fx_bits(&case["slopeBits"]),
            fx_bits(&case["floorBits"]),
        );
        assert_eq!(got.to_bits(), case["bits"].as_i64().unwrap());
    }
    for case in arr(&v["discountedTotal"]) {
        let w: Vec<Fx> = arr(&case["weightsBits"]).iter().map(fx_bits).collect();
        let pairs: Vec<(u32, u32, Fx)> = arr(&case["pairs"])
            .iter()
            .map(|p| (u32_of(&p["i"]), u32_of(&p["j"]), fx_bits(&p["deltaBits"])))
            .collect();
        let got = weights::discounted_total(&w, &pairs);
        assert_eq!(got.to_bits(), case["bits"].as_i64().unwrap());
    }
}

// ---------- STH и витнесс-косайны ----------

fn head_of(v: &Value) -> sth::TreeHead {
    sth::TreeHead {
        tree_size: v["treeSize"].as_u64().unwrap(),
        root: hash32(&v["root"]),
        timestamp_ms: v["timestampMs"].as_u64().unwrap(),
    }
}

#[test]
fn log_sth_match() {
    let v = load_vector("governance-log-sth-v1.json");
    assert_eq!(v["vectorId"].as_str(), Some("governance_log_sth_v1"));
    assert_eq!(
        v["minWitnessCosigns"].as_u64(),
        Some(sth::MIN_WITNESS_COSIGNS as u64)
    );

    let head = head_of(&v["head"]);
    assert_eq!(b64d(&v["signingBytes"]), head.signing_bytes());

    // Head согласован с merkle-вектором: тот же корень 13 листьев.
    let merkle_vec = load_vector("governance-log-merkle-v1.json");
    let leaves = vector_leaves(&merkle_vec, head.tree_size as usize);
    assert_eq!(
        head.root,
        merkle::root(&leaves),
        "кросс-согласованность файлов"
    );

    let registry: Vec<sig::PublicKey> = arr(&v["witnessRegistry"]).iter().map(hash32).collect();
    let mut cosigns = Vec::new();
    for case in arr(&v["cosigns"]) {
        let seed: [u8; 32] = b64d(&case["witnessSeed"]).try_into().unwrap();
        let recomputed = sth::sign_tree_head(&head, &seed);
        assert_eq!(recomputed.signer, hash32(&case["witness"]));
        assert_eq!(
            recomputed.signature,
            sig64(&case["signature"]),
            "детерминизм Ed25519"
        );
        assert!(sth::verify_tree_head(&head, &recomputed));
        cosigns.push(recomputed);
    }
    assert_eq!(
        sth::count_valid_cosigns(&head, &cosigns, &registry) as u64,
        v["validCosignCount"].as_u64().unwrap()
    );
    assert_eq!(
        sth::accept_tree_head(&head, &cosigns, &registry, sth::MIN_WITNESS_COSIGNS),
        v["accepted"].as_bool().unwrap()
    );
}

#[test]
fn log_sth_negatives_rejected() {
    let v = load_vector("governance-log-sth-negative-v1.json");
    let positive = load_vector("governance-log-sth-v1.json");
    let registry: Vec<sig::PublicKey> = arr(&positive["witnessRegistry"])
        .iter()
        .map(hash32)
        .collect();
    let head = head_of(&v["head"]);

    for case in arr(&v["cases"]) {
        let cosigns: Vec<sth::Cosign> = arr(&case["cosigns"])
            .iter()
            .map(|c| sth::Cosign {
                signer: hash32(&c["witness"]),
                signature: sig64(&c["signature"]),
            })
            .collect();
        assert_eq!(
            sth::count_valid_cosigns(&head, &cosigns, &registry) as u64,
            case["expectedValidCount"].as_u64().unwrap(),
            "кейс {}",
            case["name"]
        );
        assert!(
            !sth::accept_tree_head(&head, &cosigns, &registry, sth::MIN_WITNESS_COSIGNS),
            "негатив {} обязан отвергаться",
            case["name"]
        );
    }
}

// ---------- публичные жеребьёвки ----------

#[test]
fn sortition_match() {
    let v = load_vector("governance-sortition-v1.json");
    assert_eq!(v["vectorId"].as_str(), Some("governance_sortition_v1"));

    let sth_bytes = b64d(&v["sthSigningBytes"]);
    let anchor = b64d(&v["externalAnchor"]);
    let seed = sortition::window_seed(&sth_bytes, &anchor);
    assert_eq!(seed, hash32(&v["windowSeed"]));

    let mut members: Vec<[u8; 32]> = Vec::new();
    for case in arr(&v["members"]) {
        let member = hash32(&case["member"]);
        assert_eq!(
            sortition::member_rank(&seed, &member),
            hash32(&case["rank"]),
            "ранг участника {}",
            case["index"]
        );
        members.push(member);
    }

    let expected_k5: Vec<u32> = arr(&v["draw"]["k5"]).iter().map(u32_of).collect();
    assert_eq!(sortition::draw(&seed, &members, 5), expected_k5);
    let expected_full: Vec<u32> = arr(&v["draw"]["fullPermutation"])
        .iter()
        .map(u32_of)
        .collect();
    assert_eq!(
        sortition::draw(&seed, &members, members.len()),
        expected_full
    );

    for ctx in arr(&v["contexts"]) {
        let label = ctx["label"].as_str().unwrap().as_bytes();
        let ctx_seed = sortition::context_seed(&seed, label);
        assert_eq!(ctx_seed, hash32(&ctx["seed"]));
        let expected: Vec<u32> = arr(&ctx["draw5"]).iter().map(u32_of).collect();
        assert_eq!(sortition::draw(&ctx_seed, &members, 5), expected);
    }
}

// ---------- commit-reveal ----------

#[test]
fn commit_reveal_match() {
    let v = load_vector("governance-commit-reveal-v1.json");
    assert_eq!(v["vectorId"].as_str(), Some("governance_commit_reveal_v1"));
    for case in arr(&v["cases"]) {
        let nonce: [u8; 32] = b64d(&case["nonce"]).try_into().unwrap();
        let payload = b64d(&case["payload"]);
        let commitment = hash32(&case["commitment"]);
        assert_eq!(commit_reveal::commit(&nonce, &payload), commitment);
        assert!(commit_reveal::verify_reveal(&commitment, &nonce, &payload));
    }
}

#[test]
fn commit_reveal_negatives_rejected() {
    let v = load_vector("governance-commit-reveal-negative-v1.json");
    let commitment = hash32(&v["commitment"]);
    for case in arr(&v["cases"]) {
        let nonce: [u8; 32] = b64d(&case["nonce"]).try_into().unwrap();
        let payload = b64d(&case["payload"]);
        assert!(
            !commit_reveal::verify_reveal(&commitment, &nonce, &payload),
            "негатив {} обязан отвергаться",
            case["name"]
        );
    }
}

// ---------- bridging-скоринг ----------

#[test]
fn bridging_match() {
    let v = load_vector("governance-bridging-v1.json");
    assert_eq!(v["vectorId"].as_str(), Some("governance_bridging_v1"));

    let p = &v["params"];
    let params = bridging::BridgingParams {
        iterations: u32_of(&p["iterations"]),
        learning_rate: fx_bits(&p["learningRateBits"]),
        lambda_intercept: fx_bits(&p["lambdaInterceptBits"]),
        lambda_factor: fx_bits(&p["lambdaFactorBits"]),
        tau: fx_bits(&p["tauBits"]),
        min_raters: u32_of(&p["minRaters"]),
        min_clusters: u32_of(&p["minClusters"]),
    };
    // Файл фиксирует нормативные параметры по умолчанию (изменение — R2).
    assert_eq!(params, bridging::BridgingParams::default());

    let ratings: Vec<bridging::Rating> = arr(&v["ratings"])
        .iter()
        .map(|r| bridging::Rating {
            rater: u32_of(&r["rater"]),
            note: u32_of(&r["note"]),
            value: fx_bits(&r["valueBits"]),
        })
        .collect();
    let seed = hash32(&v["windowSeed"]);
    let model = bridging::fit(
        u32_of(&v["nRaters"]),
        u32_of(&v["nNotes"]),
        &ratings,
        &seed,
        &params,
    );

    assert_eq!(model.mu.to_bits(), v["model"]["muBits"].as_i64().unwrap());
    let rater_bias: Vec<i64> = arr(&v["model"]["raterBiasBits"])
        .iter()
        .map(|b| b.as_i64().unwrap())
        .collect();
    assert_eq!(
        model
            .rater_bias
            .iter()
            .map(|b| b.to_bits())
            .collect::<Vec<_>>(),
        rater_bias
    );
    let rater_factor: Vec<i64> = arr(&v["model"]["raterFactorBits"])
        .iter()
        .map(|b| b.as_i64().unwrap())
        .collect();
    assert_eq!(
        model
            .rater_factor
            .iter()
            .map(|f| f.to_bits())
            .collect::<Vec<_>>(),
        rater_factor
    );

    for note in arr(&v["notes"]) {
        let n = note["note"].as_u64().unwrap() as usize;
        assert_eq!(
            model.note_bias[n].to_bits(),
            note["biasBits"].as_i64().unwrap(),
            "b_n ноты {n}"
        );
        assert_eq!(
            model.note_factor[n].to_bits(),
            note["factorBits"].as_i64().unwrap(),
            "f_n ноты {n}"
        );
        let show = bridging::show_note(
            model.note_bias[n],
            u32_of(&note["raterCount"]),
            u32_of(&note["clusterCount"]),
            &params,
        );
        assert_eq!(show, note["show"].as_bool().unwrap(), "показ ноты {n}");
    }
}
