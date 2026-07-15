//! Клиентская криптография FSCP на RustCrypto против golden-векторов
//! (Documents/fscp/FSCP.md §Key agreement, §Safety number; вектора — Documents/test-vectors/).
//!
//! Сервер эту криптографию не исполняет (§4.4: только форма). Тест решает две задачи:
//! 1) тройная верификация векторов (python-генератор ↔ TS consumer ↔ Rust) — расхождение
//!    любой пары ловится до Фазы 4;
//! 2) задел будущего Rust client-core (WASM/native): X25519 + HKDF-SHA256 + XChaCha20-Poly1305
//!    IETF из RustCrypto доказуемо байт-совместимы с libsodium/@noble у клиентов.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use flora_parity::{load_json, repo_root};
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use x25519_dalek::{X25519_BASEPOINT_BYTES, x25519};

fn vectors_dir() -> std::path::PathBuf {
    repo_root().join("Documents").join("test-vectors")
}

fn b64u(s: &str) -> Vec<u8> {
    URL_SAFE_NO_PAD.decode(s).expect("base64url без padding")
}

fn b64u_32(s: &str) -> [u8; 32] {
    b64u(s).try_into().expect("ровно 32 байта")
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------- fscp-rke-wrap-key-v1.json ----------

fn rke_vector() -> serde_json::Value {
    load_json(&vectors_dir().join("fscp-rke-wrap-key-v1.json")).expect(
        "нет fscp-rke-wrap-key-v1.json (регенерация: python Documents/test-vectors/_gen_fscp_rke_v1.py)",
    )
}

#[test]
fn rke_aad_line_is_reproduced_byte_for_byte() {
    let v = rke_vector();
    let u = &v["uuids"];
    let field = |k: &str| u[k].as_str().unwrap().to_lowercase();
    let line = format!(
        "flora.messaging.recipient-key-envelope.v1 | {} | {} | {} | {} | {} | {} | {} | {} | {}",
        field("conversationUuid"),
        field("keyEpochId"),
        field("messageUuid"),
        field("messageKeyId"),
        field("senderUserUuid"),
        field("senderDeviceUuid"),
        field("recipientUserUuid"),
        field("recipientDeviceUuid"),
        field("recipientAgreementPublicKeyId"),
    );
    assert_eq!(line, v["aadUtf8"].as_str().unwrap());
}

#[test]
fn x25519_public_keys_and_shared_secret_match() {
    let v = rke_vector();
    let alice_priv = b64u_32(v["aliceEphemeralPrivateKeyBase64Url"].as_str().unwrap());
    let bob_priv = b64u_32(v["bobAgreementPrivateKeyBase64Url"].as_str().unwrap());
    let alice_pub = b64u_32(v["aliceEphemeralPublicKeyBase64Url"].as_str().unwrap());
    let bob_pub = b64u_32(v["bobAgreementPublicKeyBase64Url"].as_str().unwrap());
    let shared = b64u_32(v["x25519SharedSecretBase64Url"].as_str().unwrap());

    assert_eq!(
        x25519(alice_priv, X25519_BASEPOINT_BYTES),
        alice_pub,
        "alice pub"
    );
    assert_eq!(x25519(bob_priv, X25519_BASEPOINT_BYTES), bob_pub, "bob pub");
    assert_eq!(x25519(alice_priv, bob_pub), shared, "ss (сторона Алисы)");
    assert_eq!(x25519(bob_priv, alice_pub), shared, "ss (сторона Боба)");
}

#[test]
fn hkdf_wrap_key_matches_with_aad_as_info() {
    let v = rke_vector();
    assert_eq!(v["hkdfInfoIsAad"].as_bool(), Some(true));

    let ss = b64u_32(v["x25519SharedSecretBase64Url"].as_str().unwrap());
    let salt = b64u(v["hkdfSaltBase64Url"].as_str().unwrap());
    let aad = v["aadUtf8"].as_str().unwrap();

    let hk = Hkdf::<Sha256>::new(Some(&salt), &ss);
    let mut wrap_key = [0u8; 32];
    hk.expand(aad.as_bytes(), &mut wrap_key).unwrap();

    assert_eq!(
        wrap_key,
        b64u_32(v["wrapKeyBase64Url"].as_str().unwrap()),
        "HKDF-Extract(salt, ss) → Expand(info=AAD)"
    );
}

#[test]
fn xchacha20poly1305_wrap_and_unwrap_match_golden() {
    let v = rke_vector();
    assert_eq!(v["aead"]["name"].as_str(), Some("xchacha20-poly1305"));

    let wrap_key = b64u_32(v["wrapKeyBase64Url"].as_str().unwrap());
    let message_key = b64u(v["messageKeyBase64Url"].as_str().unwrap());
    let nonce_bytes = b64u(v["aead"]["nonceBase64Url"].as_str().unwrap());
    let golden_ct = b64u(v["aead"]["ciphertextBase64Url"].as_str().unwrap());
    let aad = v["aadUtf8"].as_str().unwrap().as_bytes();

    let cipher = XChaCha20Poly1305::new((&wrap_key).into());
    let nonce = XNonce::from_slice(&nonce_bytes);

    // Комбинированный режим libsodium: ciphertext ‖ tag — RustCrypto использует тот же layout.
    let ct = cipher
        .encrypt(
            nonce,
            Payload {
                msg: &message_key,
                aad,
            },
        )
        .unwrap();
    assert_eq!(
        ct, golden_ct,
        "детерминированный AEAD при фиксированном nonce"
    );

    let pt = cipher
        .decrypt(
            nonce,
            Payload {
                msg: &golden_ct,
                aad,
            },
        )
        .unwrap();
    assert_eq!(pt, message_key, "unwrap возвращает 32-байтовый messageKey");

    let tampered = cipher.decrypt(
        nonce,
        Payload {
            msg: &golden_ct,
            aad: b"flora.messaging.recipient-key-envelope.v2",
        },
    );
    assert!(tampered.is_err(), "подмена AAD обязана ронять расшифровку");
}

// ---------- fingerprint-v1.json ----------

#[test]
fn safety_number_preimage_and_sha256_match_golden() {
    let v = load_json(&vectors_dir().join("fingerprint-v1.json")).expect("нет fingerprint-v1.json");

    let keys: Vec<[u8; 32]> = v["epochAccountIdentityPublicKeysBase64UrlSorted"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| b64u_32(k.as_str().unwrap()))
        .collect();
    let [a, b]: [[u8; 32]; 2] = keys.try_into().unwrap();

    // Порядок в preimage — memcmp сырых 32 байт (FSCP.md §Safety number);
    // сортировка независима от порядка аргументов.
    let (low, high) = if a <= b { (a, b) } else { (b, a) };

    let preimage = format!(
        "flora.fscp.v1.safety-number|{}|{}|{}|{}",
        v["keyEpochId"].as_str().unwrap().to_lowercase(),
        v["conversationUuid"].as_str().unwrap().to_lowercase(),
        URL_SAFE_NO_PAD.encode(low),
        URL_SAFE_NO_PAD.encode(high),
    );
    assert_eq!(preimage, v["preimageUtf8"].as_str().unwrap());

    let fingerprint = hex_lower(&Sha256::digest(preimage.as_bytes()));
    assert_eq!(fingerprint, v["fingerprintSha256Hex"].as_str().unwrap());
}
