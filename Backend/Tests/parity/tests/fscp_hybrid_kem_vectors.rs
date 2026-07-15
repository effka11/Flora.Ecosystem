//! Consumer golden-вектора fscp-hybrid-kem-v2draft-v1.json — прототип гибридного
//! пост-квантового KEM X25519 + ML-KEM-768 (Documents/fscp/FSCP.md §Целевой алгоритм → Post-quantum).
//!
//! Статус: v2-draft. Wire v1 не затрагивает; в продакшн-крейты ML-KEM не входит —
//! ml-kem (RustCrypto) живёт только в dev-dependencies паритет-харнесса.
//!
//! Тройная независимая верификация ML-KEM: kyber-py (генератор) ↔ @noble/post-quantum
//! (TS consumer) ↔ RustCrypto ml-kem (этот тест). Классическая часть — те же примитивы,
//! что в fscp_client_crypto_vectors.rs.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use flora_parity::{load_json, repo_root};
use hkdf::Hkdf;
use ml_kem::kem::Decapsulate as _;
use ml_kem::{B32, DecapsulationKey768, KeyExport as _, Seed};
use sha2::{Digest, Sha256};
use x25519_dalek::{X25519_BASEPOINT_BYTES, x25519};

fn vector() -> serde_json::Value {
    load_json(
        &repo_root()
            .join("Documents")
            .join("test-vectors")
            .join("fscp-hybrid-kem-v2draft-v1.json"),
    )
    .expect(
        "нет fscp-hybrid-kem-v2draft-v1.json (регенерация: python Documents/test-vectors/_gen_fscp_hybrid_kem_v2draft_v1.py)",
    )
}

fn b64u(s: &str) -> Vec<u8> {
    URL_SAFE_NO_PAD.decode(s).expect("base64url без padding")
}

fn b64u_32(s: &str) -> [u8; 32] {
    b64u(s).try_into().expect("ровно 32 байта")
}

fn str_field<'a>(v: &'a serde_json::Value, path: &[&str]) -> &'a str {
    let mut cur = v;
    for key in path {
        cur = &cur[*key];
    }
    cur.as_str().unwrap_or_else(|| panic!("нет поля {path:?}"))
}

fn decapsulation_key(v: &serde_json::Value) -> DecapsulationKey768 {
    let seed_bytes = b64u(str_field(v, &["mlKem768", "keygenSeedBase64Url"]));
    let seed = Seed::try_from(seed_bytes.as_slice()).expect("seed = d||z, 64 байта");
    DecapsulationKey768::from_seed(seed)
}

fn transcript_hash(v: &serde_json::Value, ct: &[u8]) -> Vec<u8> {
    let mut h = Sha256::new();
    h.update(str_field(v, &["combiner", "transcriptPrefixUtf8"]).as_bytes());
    h.update(b64u(str_field(
        v,
        &["x25519", "aliceEphemeralPublicKeyBase64Url"],
    )));
    h.update(b64u(str_field(
        v,
        &["x25519", "bobAgreementPublicKeyBase64Url"],
    )));
    h.update(b64u(str_field(
        v,
        &["mlKem768", "encapsulationKeyBase64Url"],
    )));
    h.update(ct);
    h.finalize().to_vec()
}

fn hybrid_wrap_key(v: &serde_json::Value, ss_pq: &[u8], aad: &str) -> [u8; 32] {
    let ss_x = b64u_32(str_field(v, &["x25519", "sharedSecretBase64Url"]));
    let salt = b64u(str_field(v, &["hybrid", "hkdfSaltBase64Url"]));
    let mut ikm = ss_x.to_vec();
    ikm.extend_from_slice(ss_pq);

    let hk = Hkdf::<Sha256>::new(Some(&salt), &ikm);
    let mut wrap_key = [0u8; 32];
    hk.expand(aad.as_bytes(), &mut wrap_key).unwrap();
    wrap_key
}

#[test]
fn mlkem768_keygen_from_seed_reproduces_ek_and_expanded_dk() {
    let v = vector();
    assert_eq!(str_field(&v, &["fscpProtocolVersion"]), "2-draft");

    let dk = decapsulation_key(&v);
    assert_eq!(
        dk.encapsulation_key().to_bytes().as_slice(),
        b64u(str_field(&v, &["mlKem768", "encapsulationKeyBase64Url"])).as_slice(),
        "ek из seed (d||z)"
    );
    // Expanded-форма dk (2400 B) в ml-kem deprecated в пользу seed, но в векторе она
    // намеренно: @noble/post-quantum потребляет именно её — сверяем и здесь.
    #[allow(deprecated)]
    let expanded = {
        use ml_kem::ExpandedKeyEncoding as _;
        dk.to_expanded_bytes()
    };
    assert_eq!(
        expanded.as_slice(),
        b64u(str_field(
            &v,
            &["mlKem768", "decapsulationKeyExpandedBase64Url"]
        ))
        .as_slice(),
        "expanded dk (2400 B)"
    );
}

#[test]
fn mlkem768_deterministic_encaps_and_decaps_match_golden() {
    let v = vector();
    let dk = decapsulation_key(&v);
    let m_bytes = b64u_32(str_field(&v, &["mlKem768", "encapsMSeedBase64Url"]));
    let m = B32::from(m_bytes);

    let (ct, ss_send) = dk.encapsulation_key().encapsulate_deterministic(&m);
    assert_eq!(
        ct.as_slice(),
        b64u(str_field(&v, &["mlKem768", "ciphertextBase64Url"])).as_slice(),
        "детерминированный encaps(ek, m) — ciphertext"
    );
    assert_eq!(
        ss_send.as_slice(),
        b64u(str_field(&v, &["mlKem768", "sharedSecretBase64Url"])).as_slice(),
        "детерминированный encaps(ek, m) — shared secret"
    );

    let ss_recv = dk.decapsulate(&ct);
    assert_eq!(ss_recv, ss_send, "decaps(dk, ct) == encaps ss");
}

#[test]
fn x25519_component_matches_golden() {
    let v = vector();
    let alice_priv = b64u_32(str_field(
        &v,
        &["x25519", "aliceEphemeralPrivateKeyBase64Url"],
    ));
    let bob_priv = b64u_32(str_field(
        &v,
        &["x25519", "bobAgreementPrivateKeyBase64Url"],
    ));
    let alice_pub = b64u_32(str_field(
        &v,
        &["x25519", "aliceEphemeralPublicKeyBase64Url"],
    ));
    let bob_pub = b64u_32(str_field(&v, &["x25519", "bobAgreementPublicKeyBase64Url"]));
    let shared = b64u_32(str_field(&v, &["x25519", "sharedSecretBase64Url"]));

    assert_eq!(x25519(alice_priv, X25519_BASEPOINT_BYTES), alice_pub);
    assert_eq!(x25519(bob_priv, X25519_BASEPOINT_BYTES), bob_pub);
    assert_eq!(x25519(alice_priv, bob_pub), shared);
    assert_eq!(x25519(bob_priv, alice_pub), shared);
}

#[test]
fn transcript_hash_aad_and_hybrid_kdf_are_reproduced() {
    let v = vector();
    let ct = b64u(str_field(&v, &["mlKem768", "ciphertextBase64Url"]));

    let th = transcript_hash(&v, &ct);
    assert_eq!(
        URL_SAFE_NO_PAD.encode(&th),
        str_field(&v, &["hybrid", "transcriptHashBase64Url"]),
        "transcript hash связывает ephPub/agreementPub/ek/ct"
    );

    let aad = str_field(&v, &["hybrid", "aadUtf8"]);
    assert!(
        aad.ends_with(&format!("pq:{}", URL_SAFE_NO_PAD.encode(&th))),
        "AAD оканчивается pq:<transcriptHash>"
    );

    let ss_pq = b64u(str_field(&v, &["mlKem768", "sharedSecretBase64Url"]));
    let wrap_key = hybrid_wrap_key(&v, &ss_pq, aad);
    assert_eq!(
        wrap_key,
        b64u_32(str_field(&v, &["hybrid", "wrapKeyBase64Url"])),
        "IKM = ss_x25519 || ss_mlkem, HKDF-SHA-256(info=AAD)"
    );
}

#[test]
fn aead_wrap_unwrap_and_negative_cases_match_declared_behavior() {
    let v = vector();
    let aad = str_field(&v, &["hybrid", "aadUtf8"]);
    let wrap_key = b64u_32(str_field(&v, &["hybrid", "wrapKeyBase64Url"]));
    let message_key = b64u(str_field(&v, &["aead", "messageKeyBase64Url"]));
    let nonce_bytes = b64u(str_field(&v, &["aead", "nonceBase64Url"]));
    let golden_ct = b64u(str_field(&v, &["aead", "ciphertextBase64Url"]));

    let cipher = XChaCha20Poly1305::new((&wrap_key).into());
    let nonce = XNonce::from_slice(&nonce_bytes);

    let ct = cipher
        .encrypt(
            nonce,
            Payload {
                msg: &message_key,
                aad: aad.as_bytes(),
            },
        )
        .unwrap();
    assert_eq!(ct, golden_ct, "AEAD с фиксированным nonce");

    let pt = cipher
        .decrypt(
            nonce,
            Payload {
                msg: &golden_ct,
                aad: aad.as_bytes(),
            },
        )
        .unwrap();
    assert_eq!(pt, message_key);

    let dk = decapsulation_key(&v);
    for case in v["negativeCases"].as_array().unwrap() {
        let case_id = str_field(case, &["caseId"]);
        assert_eq!(
            str_field(case, &["expected"]),
            "aead-open-fails",
            "{case_id}"
        );
        match case_id {
            "mlkem_ciphertext_tampered" => {
                let tampered_ct = b64u(str_field(case, &["tamperedCiphertextBase64Url"]));
                let ct_arr =
                    ml_kem::Ciphertext::<ml_kem::MlKem768>::try_from(tampered_ct.as_slice())
                        .unwrap();
                // FIPS 203 implicit rejection: decaps не падает, а даёт K̄ = J(z||c).
                let implied = dk.decapsulate(&ct_arr);
                assert_eq!(
                    implied.as_slice(),
                    b64u(str_field(case, &["impliedSharedSecretBase64Url"])).as_slice(),
                    "{case_id}: implied ss"
                );

                let th = transcript_hash(&v, &tampered_ct);
                assert_eq!(
                    URL_SAFE_NO_PAD.encode(&th),
                    str_field(case, &["tamperedTranscriptHashBase64Url"]),
                    "{case_id}: transcript hash получателя"
                );

                let tampered_aad = str_field(case, &["tamperedAadUtf8"]);
                let receiver_key = hybrid_wrap_key(&v, implied.as_slice(), tampered_aad);
                let opened = XChaCha20Poly1305::new((&receiver_key).into()).decrypt(
                    nonce,
                    Payload {
                        msg: &golden_ct,
                        aad: tampered_aad.as_bytes(),
                    },
                );
                assert!(opened.is_err(), "{case_id}: AEAD обязан не открываться");
            }
            "aad_metadata_mismatch" => {
                let mismatched_aad = str_field(case, &["mismatchedAadUtf8"]);
                let ss_pq = b64u(str_field(&v, &["mlKem768", "sharedSecretBase64Url"]));
                let key = hybrid_wrap_key(&v, &ss_pq, mismatched_aad);
                let opened = XChaCha20Poly1305::new((&key).into()).decrypt(
                    nonce,
                    Payload {
                        msg: &golden_ct,
                        aad: mismatched_aad.as_bytes(),
                    },
                );
                assert!(opened.is_err(), "{case_id}: AEAD обязан не открываться");
            }
            other => panic!("неизвестный negative case: {other}"),
        }
    }
}
