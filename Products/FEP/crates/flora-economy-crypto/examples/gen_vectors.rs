//! Генератор golden-векторов ядра FEP/LIV (правила: Documents/test-vectors/README.md).
//!
//! Пишет `Documents/test-vectors/fep/*.json`. Детерминирован: фиксированные seed'ы,
//! метки времени и nonce — повторный запуск перезаписывает файлы идентичным содержимым.
//!
//! Байтовые поля — **hex lowercase** (не base64): это родная кодировка контракта FEP
//! (JSONL-журнал и HTTP API сериализуют хеши/ключи/подписи hex'ом через `hexser`),
//! и векторы обязаны совпадать с ним байт-в-байт.
//!
//! ```bash
//! cargo run -p flora-economy-crypto --example gen_vectors
//! ```

use flora_economy_crypto::amount::{AccountId, Grains, Timestamp};
use flora_economy_crypto::engine::LedgerState;
use flora_economy_crypto::hash::{Hash32, tagged, to_hex};
use flora_economy_crypto::ledger::{
    EntryBody, LedgerEntry, credit_transfer_signing_bytes, transfer_signing_bytes,
    trustline_signing_bytes,
};
use flora_economy_crypto::params::Parameters;
use flora_economy_crypto::sig::{public_key, sign};
use flora_economy_crypto::witness::cosign_head;
use flora_economy_crypto::{FEP_PROTOCOL_VERSION, domain, merkle};
use serde_json::{Value, json};
use std::path::PathBuf;

const ALICE_SEED: [u8; 32] = [0x11; 32];
const BOB_SEED: [u8; 32] = [0x22; 32];
const WITNESS_SEED: [u8; 32] = [0x77; 32];

const GENESIS_AT: i64 = 1_700_000_000_000;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

fn alice() -> AccountId {
    AccountId([0xA1; 16])
}

fn bob() -> AccountId {
    AccountId([0xB2; 16])
}

fn out_dir() -> PathBuf {
    // crate: Products/FEP/crates/flora-economy-crypto → корень репо на 4 уровня выше.
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../Documents/test-vectors/fep")
}

fn write(name: &str, value: &Value) {
    let path = out_dir().join(name);
    let mut text = serde_json::to_string_pretty(value).expect("json");
    text.push('\n');
    std::fs::write(&path, text).expect("write");
    println!("written {}", path.display());
}

fn hex_bytes(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------- 1. Доменные метки ----------

fn domain_tags_vector() -> Value {
    let material: Vec<u8> = (0u8..32).collect();
    let tags = [
        ("LEDGER_LEAF", domain::LEDGER_LEAF),
        ("LEDGER_STH", domain::LEDGER_STH),
        ("MERKLE_LEAF", domain::MERKLE_LEAF),
        ("MERKLE_NODE", domain::MERKLE_NODE),
        ("TRANSFER_AUTH", domain::TRANSFER_AUTH),
        ("TRUSTLINE_AUTH", domain::TRUSTLINE_AUTH),
        ("CREDIT_TRANSFER_AUTH", domain::CREDIT_TRANSFER_AUTH),
    ];
    let entries: Vec<Value> = tags
        .iter()
        .map(|(name, tag)| {
            json!({
                "name": name,
                "tag": tag,
                "tagBytesHex": hex_bytes(tag.as_bytes()),
                "sha256TaggedHex": to_hex(&tagged(tag, &material)),
            })
        })
        .collect();
    json!({
        "protocolVersion": FEP_PROTOCOL_VERSION,
        "vectorId": "fep_domain_tags_v1",
        "description": "Реестр доменных меток FEP (байт-в-байт, FEP.md §9.2) и SHA-256 tagged-хеши над материалом 0x00..0x1f. Изменение метки — изменение класса R3.",
        "encoding": "hex",
        "taggedMaterialHex": hex_bytes(&material),
        "tags": entries,
    })
}

// ---------- 2. Канонический формат сумм LIV ----------

fn liv_amounts_vector() -> Value {
    let format_cases: Vec<Value> = [
        0i64,
        1,
        -1,
        999_999,
        1_000_000,
        1_500_000,
        123_456_789,
        -42_000_000,
        i64::MAX,
        i64::MIN,
    ]
    .iter()
    .map(|&grains| {
        json!({
            "grains": grains,
            "liv": Grains(grains).format_liv(),
        })
    })
    .collect();

    let parse_cases: Vec<Value> = [
        "5",
        "5.1",
        ".5",
        "-0.000001",
        "0.000000",
        "9223372036854.775807",
    ]
    .iter()
    .map(|&input| {
        json!({
            "input": input,
            "grains": Grains::parse_liv(input).map(|g| g.0),
        })
    })
    .collect();

    let parse_rejects: Vec<Value> = [
        "",
        "-",
        ".",
        "-.",
        "1,5",
        "1.2345678",
        "1e6",
        " 1",
        "1 ",
        "+1",
        "--1",
        "0x10",
        "9223372036855",
    ]
    .iter()
    .map(|&input| json!({ "input": input, "expectedError": "parse_rejected" }))
    .collect();

    json!({
        "protocolVersion": FEP_PROTOCOL_VERSION,
        "vectorId": "fep_liv_amounts_v1",
        "description": "Канонический формат сумм LIV (Documents/fep/LIV.md §2.2): 1 liv = 10^6 grain, ровно 6 знаков дроби, точка-разделитель, без локалей/экспонент/разделителей групп.",
        "ticker": flora_economy_crypto::LIV_TICKER,
        "decimals": flora_economy_crypto::LIV_DECIMALS,
        "livInGrains": flora_economy_crypto::LIV_IN_GRAINS,
        "format": format_cases,
        "parse": parse_cases,
        "parseRejects": parse_rejects,
    })
}

// ---------- 3. Транскрипт журнала ----------

/// Детерминированная история: genesis, два аккаунта, UBI, перевод, линия доверия,
/// путевой кредит, демерредж (сутки спустя), расход казны. Все подписи — Ed25519
/// с фиксированными seed'ами; все `at` — константы.
fn build_transcript() -> (Vec<LedgerEntry>, Vec<Value>, LedgerState) {
    let mut entries: Vec<LedgerEntry> = Vec::new();
    let mut steps: Vec<Value> = Vec::new();
    let mut state: Option<LedgerState> = None;

    let mut push = |body: EntryBody, at: i64, state: &mut Option<LedgerState>, aux: Value| {
        let (seq, prev_hash) = match state {
            None => (0, [0u8; 32]),
            Some(s) => (s.head.size, s.head.last_entry_hash),
        };
        let entry = LedgerEntry {
            seq,
            at: Timestamp(at),
            prev_hash,
            body,
        };
        match state {
            None => *state = Some(LedgerState::from_genesis(&entry).expect("genesis")),
            Some(s) => s.apply(&entry).expect("вектор обязан быть валидным"),
        }
        let head = &state.as_ref().expect("состояние построено").head;
        steps.push(json!({
            "entry": serde_json::to_value(&entry).expect("json"),
            "entryHashHex": to_hex(&entry.entry_hash()),
            "headAfter": serde_json::to_value(head).expect("json"),
            "aux": aux,
        }));
        entries.push(entry);
    };

    // 0: genesis.
    push(
        EntryBody::Genesis {
            protocol_version: FEP_PROTOCOL_VERSION,
            params: Parameters::genesis(),
        },
        GENESIS_AT,
        &mut state,
        Value::Null,
    );

    // 1–2: аккаунты Алисы и Боба.
    push(
        EntryBody::AccountOpened {
            account: alice(),
            owner_key: public_key(&ALICE_SEED),
        },
        GENESIS_AT + 1_000,
        &mut state,
        json!({ "ownerSeedHex": hex_bytes(&ALICE_SEED) }),
    );
    push(
        EntryBody::AccountOpened {
            account: bob(),
            owner_key: public_key(&BOB_SEED),
        },
        GENESIS_AT + 2_000,
        &mut state,
        json!({ "ownerSeedHex": hex_bytes(&BOB_SEED) }),
    );

    // 3: UBI Алисе (эпоха 0, 1000 liv по genesis-параметрам).
    push(
        EntryBody::UbiIssued {
            account: alice(),
            from_epoch: 0,
            to_epoch: 0,
            amount: Parameters::genesis().ubi_per_epoch,
        },
        GENESIS_AT + 3_000,
        &mut state,
        Value::Null,
    );

    // 4: подписанный перевод Алиса → Боб, 250 liv.
    let amount = Grains(250 * flora_economy_crypto::LIV_IN_GRAINS);
    let nonce = [0x07u8; 16];
    let payload = transfer_signing_bytes(&alice(), &bob(), amount, &nonce);
    let signature = sign(domain::TRANSFER_AUTH, &payload, &ALICE_SEED);
    push(
        EntryBody::Transfer {
            from: alice(),
            to: bob(),
            amount,
            nonce,
            signature,
        },
        GENESIS_AT + 4_000,
        &mut state,
        json!({
            "signingPayloadHex": hex_bytes(&payload),
            "domainTag": domain::TRANSFER_AUTH,
        }),
    );

    // 5: линия доверия Алиса↔Боб (100 liv в обе стороны; alice < bob по байтам — пара канонична).
    let limit = Grains(100 * flora_economy_crypto::LIV_IN_GRAINS);
    let tl_payload = trustline_signing_bytes(&alice(), &bob(), limit, limit);
    push(
        EntryBody::TrustlineSet {
            lo: alice(),
            hi: bob(),
            limit_lo_to_hi: limit,
            limit_hi_to_lo: limit,
            signature_lo: sign(domain::TRUSTLINE_AUTH, &tl_payload, &ALICE_SEED),
            signature_hi: sign(domain::TRUSTLINE_AUTH, &tl_payload, &BOB_SEED),
        },
        GENESIS_AT + 5_000,
        &mut state,
        json!({
            "signingPayloadHex": hex_bytes(&tl_payload),
            "domainTag": domain::TRUSTLINE_AUTH,
        }),
    );

    // 6: платёж по линии доверия Алиса → Боб, 40 liv.
    let credit_amount = Grains(40 * flora_economy_crypto::LIV_IN_GRAINS);
    let credit_nonce = [0x08u8; 16];
    let path = vec![alice(), bob()];
    let credit_payload = credit_transfer_signing_bytes(&path, credit_amount, &credit_nonce);
    push(
        EntryBody::CreditTransfer {
            path: path.clone(),
            amount: credit_amount,
            nonce: credit_nonce,
            signature: sign(domain::CREDIT_TRANSFER_AUTH, &credit_payload, &ALICE_SEED),
        },
        GENESIS_AT + 6_000,
        &mut state,
        json!({
            "signingPayloadHex": hex_bytes(&credit_payload),
            "domainTag": domain::CREDIT_TRANSFER_AUTH,
        }),
    );

    // 7–8: демерредж спустя сутки (порядок BTreeMap: alice < bob). Ожидаемые суммы
    // пересчитываются ядром — генератор просто фиксирует их в записи.
    let sweep_at = GENESIS_AT + DAY_MS + 10_000;
    for account in [alice(), bob()] {
        let s = state.as_ref().expect("состояние построено");
        let acc = s.accounts.get(&account).expect("аккаунт есть");
        let periods = flora_economy_crypto::demurrage::full_periods(
            acc.demurrage_applied_at,
            Timestamp(sweep_at),
            s.params.demurrage_period_ms,
        );
        let outcome =
            flora_economy_crypto::demurrage::apply_demurrage(acc.balance, periods, &s.params);
        push(
            EntryBody::DemurrageCharged {
                account,
                periods,
                amount: outcome.to_commons,
            },
            sweep_at,
            &mut state,
            Value::Null,
        );
    }

    // 9: расход казны по ратифицированной категории.
    push(
        EntryBody::CommonsSpend {
            to: alice(),
            amount: Grains(100),
            policy_ref: "budget-v1/infrastructure".into(),
        },
        GENESIS_AT + DAY_MS + 20_000,
        &mut state,
        Value::Null,
    );

    let state = state.expect("состояние построено");
    (entries, steps, state)
}

fn transcript_vector() -> Value {
    let (entries, steps, state) = build_transcript();
    let n = entries.len();
    let leaves: Vec<Hash32> = state
        .entry_hashes
        .iter()
        .map(|h| merkle::hash_leaf(h))
        .collect();

    // Inclusion-доказательства против финального head.
    let inclusion: Vec<Value> = [0usize, 3, n - 1]
        .iter()
        .map(|&i| {
            let proof = merkle::inclusion_proof(&leaves, i).expect("proof");
            json!({
                "seq": i,
                "treeSize": n,
                "leafHashHex": to_hex(&leaves[i]),
                "proofHex": proof.iter().map(to_hex).collect::<Vec<_>>(),
            })
        })
        .collect();

    // Consistency-доказательства (журнал только дописывается).
    let consistency: Vec<Value> = [(1usize, n), (4, n), (n, n)]
        .iter()
        .map(|&(m, size)| {
            let proof = merkle::consistency_proof(&leaves[..size], m).expect("proof");
            json!({
                "oldSize": m,
                "newSize": size,
                "oldRootHex": to_hex(&merkle::merkle_root(&leaves[..m])),
                "newRootHex": to_hex(&merkle::merkle_root(&leaves[..size])),
                "proofHex": proof.iter().map(to_hex).collect::<Vec<_>>(),
            })
        })
        .collect();

    // Витнесс-косайны: промежуточный head (после seq 3) и финальный.
    let mut replay_state: Option<LedgerState> = None;
    let mut head_after_3 = None;
    for entry in &entries {
        match &mut replay_state {
            None => replay_state = Some(LedgerState::from_genesis(entry).expect("genesis")),
            Some(s) => s.apply(entry).expect("реплей валиден"),
        }
        if entry.seq == 3 {
            head_after_3 = Some(replay_state.as_ref().expect("состояние").head.clone());
        }
    }
    let head_after_3 = head_after_3.expect("head после seq 3");
    let cosigns: Vec<Value> = [&head_after_3, &state.head]
        .iter()
        .map(|head| {
            let cosign = cosign_head(head, &WITNESS_SEED);
            json!({
                "cosign": serde_json::to_value(&cosign).expect("json"),
                "sthCanonicalBytesHex": hex_bytes(&head.canonical_bytes()),
                "domainTag": domain::LEDGER_STH,
            })
        })
        .collect();

    // Контрольный снимок финального состояния (реплей обязан дать ровно это).
    let final_state = json!({
        "aliceBalanceGrains": state.accounts[&alice()].balance.0,
        "bobBalanceGrains": state.accounts[&bob()].balance.0,
        "commonsBalanceGrains": state.commons_balance.0,
        "totalIssuedGrains": state.total_issued.0,
        "trustlinePositionGrains": state.trustlines[&(alice(), bob())].position.0,
    });

    json!({
        "protocolVersion": FEP_PROTOCOL_VERSION,
        "vectorId": "fep_ledger_transcript_v1",
        "description": "Полный транскрипт журнала FEP: genesis → аккаунты → UBI → подписанный перевод → линия доверия → путевой кредит → демерредж (сутки) → расход казны. Каждый шаг: запись (canonical JSON формата JSONL-журнала), её хеш, head после применения. Плюс inclusion/consistency-доказательства и витнесс-косайны (LIV.md §4–5). Реплей любым клиентом обязан дать headAfter и finalState бит-в-бит.",
        "encoding": "hex",
        "seeds": {
            "aliceHex": hex_bytes(&ALICE_SEED),
            "bobHex": hex_bytes(&BOB_SEED),
            "witnessHex": hex_bytes(&WITNESS_SEED),
        },
        "witnessPublicKeyHex": hex_bytes(&public_key(&WITNESS_SEED)),
        "steps": steps,
        "inclusionProofs": inclusion,
        "consistencyProofs": consistency,
        "cosigns": cosigns,
        "finalState": final_state,
    })
}

// ---------- 4. Негативы ----------

fn negative_vector() -> Value {
    // База: genesis + аккаунт Алисы (валидный префикс для порчи).
    let genesis = LedgerEntry {
        seq: 0,
        at: Timestamp(GENESIS_AT),
        prev_hash: [0u8; 32],
        body: EntryBody::Genesis {
            protocol_version: FEP_PROTOCOL_VERSION,
            params: Parameters::genesis(),
        },
    };
    let mut state = LedgerState::from_genesis(&genesis).expect("genesis");
    let open_alice = LedgerEntry {
        seq: 1,
        at: Timestamp(GENESIS_AT + 1_000),
        prev_hash: state.head.last_entry_hash,
        body: EntryBody::AccountOpened {
            account: alice(),
            owner_key: public_key(&ALICE_SEED),
        },
    };
    state.apply(&open_alice).expect("валидный префикс");
    let open_bob = LedgerEntry {
        seq: 2,
        at: Timestamp(GENESIS_AT + 2_000),
        prev_hash: state.head.last_entry_hash,
        body: EntryBody::AccountOpened {
            account: bob(),
            owner_key: public_key(&BOB_SEED),
        },
    };
    state.apply(&open_bob).expect("валидный префикс");
    let base = vec![genesis.clone(), open_alice.clone(), open_bob.clone()];
    let enc = |chain: &[LedgerEntry]| serde_json::to_value(chain).expect("json");

    // Кейс 1: перевод с нулевой подписью — реплей обязан упасть на верификации Ed25519.
    let nonce = [0x0Au8; 16];
    let mut bad_sig_chain = base.clone();
    bad_sig_chain.push(LedgerEntry {
        seq: 3,
        at: Timestamp(GENESIS_AT + 3_000),
        prev_hash: state.head.last_entry_hash,
        body: EntryBody::Transfer {
            from: alice(),
            to: bob(),
            amount: Grains(1),
            nonce,
            signature: [0u8; 64],
        },
    });

    // Кейс 2: разорванная хеш-цепочка (prev_hash из воздуха).
    let mut broken_chain = base.clone();
    broken_chain.push(LedgerEntry {
        seq: 3,
        at: Timestamp(GENESIS_AT + 3_000),
        prev_hash: [0xEE; 32],
        body: EntryBody::UbiIssued {
            account: alice(),
            from_epoch: 0,
            to_epoch: 0,
            amount: Parameters::genesis().ubi_per_epoch,
        },
    });

    // Кейс 3: UBI с завышенной суммой — движок пересчитает и отклонит.
    let mut inflated_ubi = base.clone();
    inflated_ubi.push(LedgerEntry {
        seq: 3,
        at: Timestamp(GENESIS_AT + 3_000),
        prev_hash: state.head.last_entry_hash,
        body: EntryBody::UbiIssued {
            account: alice(),
            from_epoch: 0,
            to_epoch: 0,
            amount: Grains(Parameters::genesis().ubi_per_epoch.0 + 1),
        },
    });

    // Кейс 4: форк consistency — oldRoot от переписанной истории не проходит проверку
    // против настоящего пути.
    let (_entries, _, final_state) = build_transcript();
    let leaves: Vec<Hash32> = final_state
        .entry_hashes
        .iter()
        .map(|h| merkle::hash_leaf(h))
        .collect();
    let real_proof = merkle::consistency_proof(&leaves, 4).expect("proof");
    let mut forked_leaves = leaves.clone();
    forked_leaves[2] = merkle::hash_leaf(&[0xEF; 32]);
    let forked_old_root = merkle::merkle_root(&forked_leaves[..4]);

    // Кейс 5: косайн с испорченной подписью.
    let mut bad_cosign = cosign_head(&final_state.head, &WITNESS_SEED);
    bad_cosign.signature[0] ^= 1;

    json!({
        "protocolVersion": FEP_PROTOCOL_VERSION,
        "vectorId": "fep_ledger_negative_v1",
        "description": "Негативы журнала FEP: каждая цепочка обязана быть отвергнута реплеем с указанной ошибкой; consistency-форк и порченный косайн обязаны не пройти верификацию (правило README: негативы — отдельным файлом).",
        "encoding": "hex",
        "replayCases": [
            {
                "name": "transfer_bad_signature",
                "entries": enc(&bad_sig_chain),
                "expectedError": "invalid_signature"
            },
            {
                "name": "broken_hash_chain",
                "entries": enc(&broken_chain),
                "expectedError": "replay_diverged"
            },
            {
                "name": "inflated_ubi_amount",
                "entries": enc(&inflated_ubi),
                "expectedError": "replay_diverged"
            }
        ],
        "consistencyCases": [
            {
                "name": "forked_prefix",
                "oldSize": 4,
                "newSize": leaves.len(),
                "oldRootHex": to_hex(&forked_old_root),
                "newRootHex": to_hex(&merkle::merkle_root(&leaves)),
                "proofHex": real_proof.iter().map(to_hex).collect::<Vec<_>>(),
                "expectedError": "consistency_verify_failed"
            }
        ],
        "cosignCases": [
            {
                "name": "tampered_signature",
                "cosign": serde_json::to_value(&bad_cosign).expect("json"),
                "expectedError": "invalid_signature"
            }
        ]
    })
}

fn main() {
    std::fs::create_dir_all(out_dir()).expect("mkdir");
    write("fep-domain-tags-v1.json", &domain_tags_vector());
    write("fep-liv-amounts-v1.json", &liv_amounts_vector());
    write("fep-ledger-transcript-v1.json", &transcript_vector());
    write("fep-ledger-negative-v1.json", &negative_vector());
}
