//! Consumers of `fscp-franking-wire-v1_1.json` and
//! `fscp-franking-disclosure-bundle-v2.json` (FSCP-FRANK v1.1).
//!
//! Wire: ingest (`try_validate_wire` + `verify_envelope_signature` + 32-byte
//! `extract_frank_tag`) plus Algorithm A HMAC/AAD. Disclosure: canonical JSON of
//! the tuple/bundle, XChaCha20-Poly1305 seal, wrap-v2 AAD and packed wrap bytes.
//! `npm run generate:franking-wire-v1-1-vector --workspace=@flora/fscp`
//! `npm run generate:franking-disclosure-bundle-v2-vector --workspace=@flora/fscp`

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use flora_messaging::fscp;
use flora_parity::canonical_json::canonical_json;
use flora_parity::{load_json, repo_root};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use x25519_dalek::{X25519_BASEPOINT_BYTES, x25519};

type HmacSha256 = Hmac<Sha256>;

fn wire_vector() -> serde_json::Value {
    let path = repo_root()
        .join("Documents")
        .join("test-vectors")
        .join("fscp-franking-wire-v1_1.json");
    load_json(&path).expect(
        "нет fscp-franking-wire-v1_1.json — регенерация: npm run generate:franking-wire-v1-1-vector --workspace=@flora/fscp",
    )
}

fn bundle_vector() -> serde_json::Value {
    let path = repo_root()
        .join("Documents")
        .join("test-vectors")
        .join("fscp-franking-disclosure-bundle-v2.json");
    load_json(&path).expect(
        "нет fscp-franking-disclosure-bundle-v2.json — регенерация: npm run generate:franking-disclosure-bundle-v2-vector --workspace=@flora/fscp",
    )
}

fn s<'a>(v: &'a serde_json::Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or_else(|| panic!("нет поля {key}"))
}

fn protocol_version(v: &serde_json::Value) -> f64 {
    v["fscpProtocolVersion"]
        .as_f64()
        .unwrap_or_else(|| panic!("нет fscpProtocolVersion"))
}

fn frank_tag(franking_key: &[u8], commit_input_utf8: &str) -> Vec<u8> {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(franking_key).expect("ключ HMAC");
    mac.update(commit_input_utf8.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

fn b64u(value: &str) -> Vec<u8> {
    URL_SAFE_NO_PAD
        .decode(value)
        .expect("base64url без padding")
}

fn b64u32(value: &str) -> [u8; 32] {
    b64u(value).try_into().expect("ровно 32 байта")
}

fn disclosure_record(input: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "v": 1,
        "plaintextUtf8Base64Url": URL_SAFE_NO_PAD.encode(s(input, "plaintextUtf8").as_bytes()),
        "frankingKeyBase64Url": input["frankingKeyBase64Url"],
        "frankTagBase64Url": input["frankTagBase64Url"],
        "serverFrankReceipt": input["serverFrankReceipt"],
        "messageUuid": input["messageUuid"],
        "persistedMessageUuid": input["persistedMessageUuid"],
        "conversationUuid": input["conversationUuid"],
        "senderUserUuid": input["senderUserUuid"],
        "senderDeviceUuid": input["senderDeviceUuid"],
        "receiverUserUuid": input["receiverUserUuid"],
        "createdAt": input["createdAt"],
    })
}

#[test]
fn algorithm_a_commit_and_body_aad_match_golden() {
    let v = wire_vector();
    assert_eq!(protocol_version(&v), 1.1);
    let inputs = &v["deterministicAlgorithmA"]["inputs"];
    let expected = &v["deterministicAlgorithmA"]["expected"];
    let commit = &inputs["commit"];
    let plaintext = s(inputs, "plaintextUtf8").as_bytes();
    let commit_input = [
        "flora.fscp.franking.v1",
        &s(commit, "conversationUuid").to_lowercase(),
        &s(commit, "messageUuid").to_lowercase(),
        &s(commit, "senderUserUuid").to_lowercase(),
        &s(commit, "senderDeviceUuid").to_lowercase(),
        &s(commit, "receiverUserUuid").to_lowercase(),
        s(commit, "createdAt"),
        &URL_SAFE_NO_PAD.encode(Sha256::digest(plaintext)),
    ]
    .join(" | ");
    assert_eq!(commit_input, s(expected, "commitInputUtf8"));

    let tag = frank_tag(
        &URL_SAFE_NO_PAD
            .decode(s(inputs, "frankingKeyBase64Url"))
            .unwrap(),
        &commit_input,
    );
    assert_eq!(
        URL_SAFE_NO_PAD.encode(&tag),
        s(expected, "frankTagBase64Url")
    );

    let body_aad = [
        "flora.messaging.message.v1_1",
        &s(commit, "conversationUuid").to_lowercase(),
        &s(inputs, "keyEpochId").to_lowercase(),
        &s(commit, "messageUuid").to_lowercase(),
        &s(inputs, "messageKeyId").to_lowercase(),
        &s(commit, "senderUserUuid").to_lowercase(),
        &s(commit, "senderDeviceUuid").to_lowercase(),
        s(commit, "createdAt"),
        s(expected, "frankTagBase64Url"),
    ]
    .join(" | ");
    assert_eq!(body_aad, s(expected, "bodyAadUtf8"));
}

#[test]
fn tagged_recorded_wire_passes_ingest_validators() {
    let v = wire_vector();
    let recorded = &v["recordedWire"];
    let wire = s(recorded, "wire");
    let sender = Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap();
    let receiver = Uuid::parse_str(s(&recorded["receiver"], "userUuid")).unwrap();

    assert_eq!(fscp::try_validate_wire(wire, sender, receiver), Ok(()));
    assert_eq!(fscp::verify_envelope_signature(wire), Ok(()));
    let tag = fscp::extract_frank_tag(wire)
        .unwrap()
        .expect("tagged v1.1 wire");
    let expected = URL_SAFE_NO_PAD
        .decode(s(&recorded["expected"], "frankTagBase64Url"))
        .unwrap();
    assert_eq!(tag.as_slice(), expected.as_slice());

    let tampered = s(recorded, "tamperedFrankTagResignedWire");
    assert_eq!(fscp::try_validate_wire(tampered, sender, receiver), Ok(()));
    assert_eq!(fscp::verify_envelope_signature(tampered), Ok(()));
    let tampered_tag = fscp::extract_frank_tag(tampered)
        .unwrap()
        .expect("re-signed tampered tag");
    let expected_tampered = URL_SAFE_NO_PAD
        .decode(s(recorded, "tamperedFrankTagBase64Url"))
        .unwrap();
    assert_eq!(tampered_tag.as_slice(), expected_tampered.as_slice());
    assert_ne!(tampered_tag, tag);
}

#[test]
fn disclosure_tuple_hmac_and_wrap_aad_match_golden() {
    let v = bundle_vector();
    assert_eq!(protocol_version(&v), 1.1);
    let input = &v["disclosureV1"]["input"];
    let plaintext = s(input, "plaintextUtf8").as_bytes();
    let commit_input = [
        "flora.fscp.franking.v1",
        &s(input, "conversationUuid").to_lowercase(),
        &s(input, "messageUuid").to_lowercase(),
        &s(input, "senderUserUuid").to_lowercase(),
        &s(input, "senderDeviceUuid").to_lowercase(),
        &s(input, "receiverUserUuid").to_lowercase(),
        s(input, "createdAt"),
        &URL_SAFE_NO_PAD.encode(Sha256::digest(plaintext)),
    ]
    .join(" | ");
    let tag = frank_tag(
        &URL_SAFE_NO_PAD
            .decode(s(input, "frankingKeyBase64Url"))
            .unwrap(),
        &commit_input,
    );
    assert_eq!(
        URL_SAFE_NO_PAD.encode(&tag),
        s(input, "frankTagBase64Url"),
        "disclosure v1 frankTag"
    );

    let wrap = &v["wrapV2"];
    let aad = [
        "flora.fscp.franking-wrap.v2",
        &s(&v["bundleV2"]["input"], "bundleUuid").to_lowercase(),
        &s(&wrap["target"], "userUuid").to_lowercase(),
        &s(&wrap["target"], "deviceUuid").to_lowercase(),
    ]
    .join(" | ");
    assert_eq!(aad, s(&wrap["expected"], "aadUtf8"));

    let disclosure_canonical = canonical_json(&disclosure_record(input));
    assert_eq!(
        disclosure_canonical,
        s(&v["disclosureV1"]["expected"], "canonicalUtf8")
    );
    assert_eq!(
        URL_SAFE_NO_PAD.encode(disclosure_canonical.as_bytes()),
        s(&v["disclosureV1"]["expected"], "canonicalBytesBase64Url")
    );

    let bundle_input = &v["bundleV2"]["input"];
    let messages: Vec<serde_json::Value> = bundle_input["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(disclosure_record)
        .collect();
    let bundle_canonical = canonical_json(&serde_json::json!({
        "v": 2,
        "bundleUuid": bundle_input["bundleUuid"],
        "messages": messages,
    }));
    assert_eq!(
        bundle_canonical,
        s(&v["bundleV2"]["expected"], "canonicalUtf8")
    );
    assert_eq!(
        URL_SAFE_NO_PAD.encode(bundle_canonical.as_bytes()),
        s(&v["bundleV2"]["expected"], "canonicalBytesBase64Url")
    );

    let sealed_bytes = b64u(s(&v["bundleV2"]["sealed"], "disclosureCiphertextBase64Url"));
    let nonce = b64u(s(&v["bundleV2"]["sealed"], "nonceBase64Url"));
    assert_eq!(&sealed_bytes[..24], nonce.as_slice(), "seal nonce prefix");
    let report_content_key = b64u32(s(&v["bundleV2"]["sealed"], "reportContentKeyBase64Url"));
    let opened = XChaCha20Poly1305::new((&report_content_key).into())
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &sealed_bytes[24..],
                aad: b"flora.fscp.franking-disclosure.v1",
            },
        )
        .expect("open bundle seal");
    assert_eq!(opened, bundle_canonical.as_bytes());

    let salt = b64u(s(&wrap["randomInputs"], "saltBase64Url"));
    let eph_secret = b64u32(s(&wrap["randomInputs"], "ephemeralSecretBase64Url"));
    let wrap_nonce = b64u(s(&wrap["randomInputs"], "nonceBase64Url"));
    let recipient_pub = b64u32(s(&wrap["target"], "agreementPublicKeyBase64Url"));
    let shared = x25519(eph_secret, recipient_pub);
    let hk = Hkdf::<Sha256>::new(Some(&salt), &shared);
    let mut wrap_key = [0u8; 32];
    hk.expand(aad.as_bytes(), &mut wrap_key).unwrap();
    let wrap_ct = XChaCha20Poly1305::new((&wrap_key).into())
        .encrypt(
            XNonce::from_slice(&wrap_nonce),
            Payload {
                msg: &report_content_key,
                aad: aad.as_bytes(),
            },
        )
        .expect("wrap encrypt");
    let mut packed = Vec::with_capacity(32 + 32 + 24 + wrap_ct.len());
    packed.extend_from_slice(&x25519(eph_secret, X25519_BASEPOINT_BYTES));
    packed.extend_from_slice(&salt);
    packed.extend_from_slice(&wrap_nonce);
    packed.extend_from_slice(&wrap_ct);
    assert_eq!(
        URL_SAFE_NO_PAD.encode(&packed),
        s(&wrap["expected"], "wrappedKey")
    );

    let opened_key = XChaCha20Poly1305::new((&wrap_key).into())
        .decrypt(
            XNonce::from_slice(&wrap_nonce),
            Payload {
                msg: &wrap_ct,
                aad: aad.as_bytes(),
            },
        )
        .expect("unwrap reportContentKey");
    assert_eq!(opened_key.as_slice(), report_content_key.as_slice());
}
