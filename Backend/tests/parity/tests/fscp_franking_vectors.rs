//! Consumer golden-вектора franking-v1.json (docs/fscp/franking.md §5) на RustCrypto:
//! commitInput → HMAC-SHA-256 frankTag → receiptPayload → Ed25519-квитанция →
//! полный verify-путь жюри + негативы с задекларированными причинами.
//!
//! Серверная часть franking (подпись квитанций) при активации v1.1 будет жить на Rust —
//! этот тест заранее доказывает байт-совместимость примитивов с эталоном
//! (python-генератор ↔ TS `franking.ts` ↔ Rust).
//!
//! Регенерация: python docs/test-vectors/_gen_fscp_franking_v1.py

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use flora_parity::{load_json, repo_root};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

fn vector() -> serde_json::Value {
    let path = repo_root()
        .join("docs")
        .join("test-vectors")
        .join("franking-v1.json");
    load_json(&path).expect(
        "нет franking-v1.json — регенерация: python docs/test-vectors/_gen_fscp_franking_v1.py",
    )
}

fn b64u(s: &str) -> Vec<u8> {
    URL_SAFE_NO_PAD.decode(s).expect("base64url без padding")
}

fn s_of<'a>(v: &'a serde_json::Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or_else(|| panic!("нет поля {key}"))
}

/// franking.md §4.1: контекст + base64url(SHA-256(plaintext)).
fn commit_input(uu: &serde_json::Value, created_at: &str, plaintext_utf8: &[u8]) -> String {
    [
        "flora.fscp.franking.v1",
        &s_of(uu, "conversationUuid").to_lowercase(),
        &s_of(uu, "messageUuid").to_lowercase(),
        &s_of(uu, "senderUserUuid").to_lowercase(),
        &s_of(uu, "senderDeviceUuid").to_lowercase(),
        &s_of(uu, "receiverUserUuid").to_lowercase(),
        created_at,
        &URL_SAFE_NO_PAD.encode(Sha256::digest(plaintext_utf8)),
    ]
    .join(" | ")
}

/// franking.md §4.3.
fn receipt_payload(
    frank_tag_b64u: &str,
    uu: &serde_json::Value,
    server_received_at: &str,
) -> String {
    [
        "flora.fscp.franking-receipt.v1",
        frank_tag_b64u,
        &s_of(uu, "messageUuid").to_lowercase(),
        &s_of(uu, "conversationUuid").to_lowercase(),
        &s_of(uu, "senderUserUuid").to_lowercase(),
        &s_of(uu, "receiverUserUuid").to_lowercase(),
        server_received_at,
    ]
    .join(" | ")
}

fn frank_tag(franking_key: &[u8], commit_input_utf8: &str) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(franking_key).expect("ключ HMAC");
    mac.update(commit_input_utf8.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

/// Кортеж жалобы, как его раскрывает получатель жюри (franking.md §4.4).
struct Complaint<'a> {
    uuids: &'a serde_json::Value,
    created_at: &'a str,
    plaintext_utf8: &'a [u8],
    franking_key: &'a [u8],
    claimed_tag: &'a [u8],
    server_received_at: &'a str,
    receipt_signature: &'a [u8],
}

/// Полный verify-путь жюри: пересборка commitInput и receiptPayload из кортежа —
/// расхождение метаданных ловится HMAC'ом или подписью, не сравнением полей.
fn jury_verify(c: &Complaint<'_>, server_pk: &VerifyingKey) -> Result<(), &'static str> {
    let ci = commit_input(c.uuids, c.created_at, c.plaintext_utf8);
    if frank_tag(c.franking_key, &ci) != c.claimed_tag {
        return Err("commit-mismatch");
    }
    let rp = receipt_payload(
        &URL_SAFE_NO_PAD.encode(c.claimed_tag),
        c.uuids,
        c.server_received_at,
    );
    let sig_bytes: [u8; 64] = c
        .receipt_signature
        .try_into()
        .map_err(|_| "receipt-signature-invalid")?;
    server_pk
        .verify(rp.as_bytes(), &Signature::from_bytes(&sig_bytes))
        .map_err(|_| "receipt-signature-invalid")
}

#[test]
fn commit_input_tag_and_receipt_payload_match_golden() {
    let v = vector();
    let plaintext = s_of(&v, "plaintextUtf8").as_bytes();

    let ci = commit_input(&v["uuids"], s_of(&v, "createdAt"), plaintext);
    assert_eq!(ci, s_of(&v, "commitInputUtf8"), "commitInput байт-в-байт");
    assert_eq!(
        URL_SAFE_NO_PAD.encode(Sha256::digest(plaintext)),
        s_of(&v, "plaintextSha256Base64Url"),
    );

    let tag = frank_tag(&b64u(s_of(&v, "frankingKeyBase64Url")), &ci);
    assert_eq!(
        URL_SAFE_NO_PAD.encode(&tag),
        s_of(&v, "frankTagBase64Url"),
        "frankTag = HMAC-SHA-256"
    );

    let rp = receipt_payload(
        s_of(&v, "frankTagBase64Url"),
        &v["uuids"],
        s_of(&v["receipt"], "serverReceivedAt"),
    );
    assert_eq!(
        rp,
        s_of(&v, "receiptPayloadUtf8"),
        "receiptPayload байт-в-байт"
    );
}

#[test]
fn server_signing_seed_reproduces_receipt_signature() {
    // Rust как будущий серверный подписант: seed из вектора даёт ту же подпись и pk.
    let v = vector();
    let seed: [u8; 32] = b64u(s_of(&v["server"], "frankingSigningSeedBase64Url"))
        .try_into()
        .unwrap();
    let sk = SigningKey::from_bytes(&seed);
    assert_eq!(
        URL_SAFE_NO_PAD.encode(sk.verifying_key().as_bytes()),
        s_of(&v["server"], "frankingPublicKeyBase64Url"),
        "публичный ключ сервера"
    );
    let sig = sk.sign(s_of(&v, "receiptPayloadUtf8").as_bytes());
    assert_eq!(
        URL_SAFE_NO_PAD.encode(sig.to_bytes()),
        s_of(&v["receipt"], "signatureBase64Url"),
        "подпись квитанции детерминированно воспроизводится (Ed25519 без рандома)"
    );
}

#[test]
fn jury_verification_passes_on_golden_tuple_and_negatives_fail_as_declared() {
    let v = vector();
    let server_pk = VerifyingKey::from_bytes(
        &b64u(s_of(&v["server"], "frankingPublicKeyBase64Url"))
            .try_into()
            .unwrap(),
    )
    .unwrap();

    let golden = jury_verify(
        &Complaint {
            uuids: &v["uuids"],
            created_at: s_of(&v, "createdAt"),
            plaintext_utf8: s_of(&v, "plaintextUtf8").as_bytes(),
            franking_key: &b64u(s_of(&v, "frankingKeyBase64Url")),
            claimed_tag: &b64u(s_of(&v, "frankTagBase64Url")),
            server_received_at: s_of(&v["receipt"], "serverReceivedAt"),
            receipt_signature: &b64u(s_of(&v["receipt"], "signatureBase64Url")),
        },
        &server_pk,
    );
    assert_eq!(golden, Ok(()), "golden-кортеж обязан проходить");

    for negative in v["negatives"].as_array().unwrap() {
        let case_id = s_of(negative, "caseId");
        // Поля кортежа: подменённые берём из негатива, остальные — из позитива.
        let pick = |key: &str| -> String {
            negative
                .get(key)
                .and_then(|x| x.as_str())
                .unwrap_or_else(|| s_of(&v, key))
                .to_string()
        };
        let mut uuids = v["uuids"].clone();
        if let Some(m) = negative.get("messageUuid").and_then(|x| x.as_str()) {
            uuids["messageUuid"] = serde_json::Value::String(m.to_string());
        }
        let server_received_at = negative
            .get("serverReceivedAt")
            .and_then(|x| x.as_str())
            .unwrap_or_else(|| s_of(&v["receipt"], "serverReceivedAt"));
        let signature = negative
            .get("receiptSignatureBase64Url")
            .and_then(|x| x.as_str())
            .unwrap_or_else(|| s_of(&v["receipt"], "signatureBase64Url"));

        let plaintext = pick("plaintextUtf8");
        let franking_key = b64u(&pick("frankingKeyBase64Url"));
        let result = jury_verify(
            &Complaint {
                uuids: &uuids,
                created_at: s_of(&v, "createdAt"),
                plaintext_utf8: plaintext.as_bytes(),
                franking_key: &franking_key,
                claimed_tag: &b64u(s_of(&v, "frankTagBase64Url")),
                server_received_at,
                receipt_signature: &b64u(signature),
            },
            &server_pk,
        );
        assert_eq!(
            result,
            Err(s_of(negative, "expectedFailure")),
            "{case_id}: причина отказа разошлась с вектором"
        );
    }
}
