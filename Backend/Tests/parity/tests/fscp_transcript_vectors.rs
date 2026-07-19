//! Consumer полного транскрипт-вектора fscp-message-transcript-v1.json
//! (Documents/fscp/FSCP.md §Test vectors) — единственный вектор, проходящий ВЕСЬ путь
//! FSCP v1 на Rust: форма wire (боевой порт `flora_messaging::fscp`) →
//! canonical JSON (`flora_parity::canonical_json`, байт-паритет с TS) →
//! Ed25519 (ed25519-dalek) → RKE unwrap → расшифровка тела (RustCrypto).
//!
//! Регенерация вектора: python Documents/test-vectors/_gen_fscp_message_transcript_v1.py

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use flora_messaging::fscp;
use flora_parity::canonical_json::canonical_json;
use flora_parity::{load_json, repo_root};
use hkdf::Hkdf;
use sha2::Sha256;
use uuid::Uuid;
use x25519_dalek::x25519;

fn vector() -> serde_json::Value {
    let path = repo_root()
        .join("Documents")
        .join("test-vectors")
        .join("fscp-message-transcript-v1.json");
    load_json(&path).expect(
        "нет fscp-message-transcript-v1.json — регенерация: \
         python Documents/test-vectors/_gen_fscp_message_transcript_v1.py",
    )
}

fn b64u(s: &str) -> Vec<u8> {
    URL_SAFE_NO_PAD.decode(s).expect("base64url без padding")
}

fn b64u_32(s: &str) -> [u8; 32] {
    b64u(s).try_into().expect("ровно 32 байта")
}

fn guid(v: &serde_json::Value) -> Uuid {
    v.as_str().unwrap().parse().unwrap()
}

fn str_of<'a>(v: &'a serde_json::Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or_else(|| panic!("нет поля {key}"))
}

#[test]
fn wire_passes_frozen_form_validator_and_receiver_extraction() {
    let v = vector();
    let wire = str_of(&v, "wire");
    let sender = guid(&v["uuids"]["senderUserUuid"]);
    let receiver = guid(&v["uuids"]["receiverUserUuid"]);

    fscp::try_validate_dual_wire(wire, wire, sender, receiver)
        .expect("транскрипт обязан проходить замороженную серверную валидацию");
    assert_eq!(
        fscp::try_extract_receiver(wire, sender).unwrap(),
        receiver,
        "extract receiver из транскрипта"
    );
}

#[test]
fn wire_is_prefix_plus_base64url_of_envelope_json() {
    let v = vector();
    let wire = str_of(&v, "wire");
    let inner = wire.strip_prefix("fscp1:").expect("префикс fscp1:");
    assert_eq!(
        String::from_utf8(b64u(inner)).unwrap(),
        str_of(&v, "envelopeJsonUtf8"),
        "wire — это base64url(envelopeJsonUtf8) байт-в-байт"
    );
}

#[test]
fn canonical_signing_payload_is_reproduced_byte_for_byte() {
    let v = vector();
    let mut envelope: serde_json::Value =
        serde_json::from_str(str_of(&v, "envelopeJsonUtf8")).unwrap();
    envelope
        .as_object_mut()
        .unwrap()
        .remove("senderSignatureBase64Url")
        .expect("в конверте была подпись");

    let payload = format!(
        "flora.messaging.envelope-signature.v1 | {}",
        canonical_json(&envelope)
    );
    assert_eq!(
        payload,
        str_of(&v, "canonicalSigningPayloadUtf8"),
        "canonical JSON разошёлся с TS/python"
    );
}

#[test]
fn ed25519_signature_verifies_and_tampered_variant_fails() {
    let v = vector();
    let vk = VerifyingKey::from_bytes(&b64u_32(str_of(
        &v["keys"],
        "senderSigningPublicKeyBase64Url",
    )))
    .unwrap();
    let payload = str_of(&v, "canonicalSigningPayloadUtf8").as_bytes();

    let sig_bytes: [u8; 64] = b64u(str_of(&v, "signatureBase64Url")).try_into().unwrap();
    vk.verify(payload, &Signature::from_bytes(&sig_bytes))
        .expect("честная подпись обязана верифицироваться");

    let mut bad = sig_bytes;
    bad[0] ^= 0x01;
    assert!(
        vk.verify(payload, &Signature::from_bytes(&bad)).is_err(),
        "инвертированный бит подписи обязан падать"
    );
}

/// RKE unwrap + расшифровка тела — полный клиентский путь получателя на RustCrypto.
#[test]
fn receiver_unwraps_message_key_and_decrypts_body() {
    let v = vector();
    let receiver_uuid = str_of(&v["uuids"], "receiverUserUuid");
    let row = v["recipients"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["userUuid"].as_str() == Some(receiver_uuid))
        .expect("строка получателя в recipients");

    // 1. X25519(receiver agreement priv, ephemeral pub) → HKDF(salt, info=AAD) → wrapKey.
    let ss = x25519(
        b64u_32(str_of(&v["keys"], "receiverAgreementPrivateKeyBase64Url")),
        b64u_32(str_of(row, "ephemeralPublicKeyBase64Url")),
    );
    assert_eq!(
        ss,
        b64u_32(str_of(row, "x25519SharedSecretBase64Url")),
        "shared secret"
    );

    let salt = b64u(str_of(row, "saltBase64Url"));
    let aad = str_of(row, "aadUtf8");
    let hk = Hkdf::<Sha256>::new(Some(&salt), &ss);
    let mut wrap_key = [0u8; 32];
    hk.expand(aad.as_bytes(), &mut wrap_key).unwrap();
    assert_eq!(wrap_key, b64u_32(str_of(row, "wrapKeyBase64Url")));

    // 2. XChaCha20-Poly1305 unwrap → messageKey.
    let rke_cipher = XChaCha20Poly1305::new((&wrap_key).into());
    let message_key = rke_cipher
        .decrypt(
            XNonce::from_slice(&b64u(str_of(row, "nonceBase64Url"))),
            Payload {
                msg: &b64u(str_of(row, "ciphertextBase64Url")),
                aad: aad.as_bytes(),
            },
        )
        .expect("RKE unwrap");
    assert_eq!(
        message_key,
        b64u(str_of(&v["keys"], "messageKeyBase64Url")),
        "messageKey"
    );

    // 3. Расшифровка тела с body-AAD → plaintext JSON байт-в-байт.
    let message_key: [u8; 32] = message_key.try_into().unwrap();
    let body_cipher = XChaCha20Poly1305::new((&message_key).into());
    let plaintext = body_cipher
        .decrypt(
            XNonce::from_slice(&b64u(str_of(&v["body"], "nonceBase64Url"))),
            Payload {
                msg: &b64u(str_of(&v["body"], "ciphertextBase64Url")),
                aad: str_of(&v["body"], "aadUtf8").as_bytes(),
            },
        )
        .expect("расшифровка тела");
    assert_eq!(
        String::from_utf8(plaintext).unwrap(),
        str_of(&v, "plaintextUtf8"),
        "plaintext JSON"
    );

    // 4. Смысловая проверка: текст сообщения (unicode) доехал.
    let parsed: serde_json::Value = serde_json::from_str(str_of(&v, "plaintextUtf8")).unwrap();
    assert_eq!(
        parsed["blocks"][0]["body"].as_str(),
        v["text"].as_str(),
        "текст блока"
    );
}

/// Боевая серверная криптоступень (errata-5): `fscp::verify_envelope_signature`
/// принимает golden wire и отклоняет tampered/unsigned варианты.
#[test]
fn production_signature_check_matches_golden_vector() {
    let v = vector();
    fscp::verify_envelope_signature(str_of(&v, "wire"))
        .expect("честный golden wire обязан проходить серверную криптопроверку");

    for variant in v["variants"].as_array().unwrap() {
        let id = str_of(variant, "variantId");
        let wire = str_of(variant, "wire");
        match id {
            "signature_tampered" => assert_eq!(
                fscp::verify_envelope_signature(wire).unwrap_err(),
                "FSCP wire: подпись конверта Ed25519 не прошла проверку.",
                "{id}"
            ),
            "legacy_unsigned" => assert_eq!(
                fscp::verify_envelope_signature(wire).unwrap_err(),
                "FSCP wire: требуется senderSigningPublicKeyBase64Url (Ed25519, 32 байта).",
                "{id}"
            ),
            _ => {}
        }
    }
}

#[test]
fn variants_match_declared_server_and_client_behavior() {
    let v = vector();
    let sender = guid(&v["uuids"]["senderUserUuid"]);
    let receiver = guid(&v["uuids"]["receiverUserUuid"]);

    for variant in v["variants"].as_array().unwrap() {
        let id = str_of(variant, "variantId");
        let wire = str_of(variant, "wire");
        let form = fscp::try_validate_dual_wire(wire, wire, sender, receiver);

        match str_of(variant, "serverFormValidation") {
            "accept" => form.unwrap_or_else(|e| panic!("{id}: форма должна проходить: {e}")),
            "reject" => {
                let err = form.expect_err("форма должна отклоняться");
                assert_eq!(
                    err,
                    str_of(variant, "serverExpectedError"),
                    "{id}: текст серверной ошибки"
                );
            }
            other => panic!("{id}: неизвестный serverFormValidation {other}"),
        }

        // Клиентская сторона подписи: tampered-вариант не должен верифицироваться.
        if id == "signature_tampered" {
            let inner: serde_json::Value =
                serde_json::from_slice(&b64u(wire.strip_prefix("fscp1:").unwrap())).unwrap();
            let sig_bytes: [u8; 64] = b64u(inner["senderSignatureBase64Url"].as_str().unwrap())
                .try_into()
                .unwrap();
            let vk = VerifyingKey::from_bytes(&b64u_32(
                inner["senderSigningPublicKeyBase64Url"].as_str().unwrap(),
            ))
            .unwrap();

            let mut no_sig = inner.clone();
            no_sig
                .as_object_mut()
                .unwrap()
                .remove("senderSignatureBase64Url");
            let payload = format!(
                "flora.messaging.envelope-signature.v1 | {}",
                canonical_json(&no_sig)
            );
            assert!(
                vk.verify(payload.as_bytes(), &Signature::from_bytes(&sig_bytes))
                    .is_err(),
                "{id}: испорченная подпись верифицировалась"
            );
        }
    }
}
