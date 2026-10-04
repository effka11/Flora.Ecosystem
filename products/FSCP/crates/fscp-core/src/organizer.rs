//! Серверная структурная валидация конверта организатора чатов FSCP-ORG v1
//! (`fscporg1:`) — зашифрованное состояние папок/архива/mute.
//!
//! Сервер (модуль flora-chat-organizer) хранит wire как opaque blob и никогда
//! не расшифровывает: названия папок, состав и архив видны только клиентам
//! владельца. Здесь проверяется только форма + Ed25519-подпись.

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use uuid::Uuid;

use fscp_contracts::{BOOTSTRAP_KEY_EPOCH_ID, ORGANIZER_WIRE_PREFIX};

use super::{
    agreement_public_key_id, canonical_json, from_base64_url_like_dotnet, guid_field, int_field,
    parse_guid_like, parse_json_like_dotnet, string_field,
};

const MAX_ORGANIZER_WIRE_CHARS: usize = 200_000;
const MAX_ORGANIZER_INNER_UTF8_BYTES: usize = 120_000;
const MAX_STATE_CIPHER_BYTES: usize = 64 * 1024;
const MAX_KEY_ENVELOPE_CIPHER_BYTES: usize = 8 * 1024;

const RKE_ALGORITHM: &str = "x25519-hkdf-xchacha20poly1305";
const AEAD_NAME: &str = "xchacha20-poly1305";
const ORGANIZER_SIGNATURE_DOMAIN: &str = "flora.messaging.chat-organizer-signature.v1";

/// Итог структурной валидации конверта организатора.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrganizerWireSummary {
    pub owner_user_uuid: Uuid,
    /// Ревизия из конверта (входит в AAD и подпись).
    pub revision: i64,
}

/// Структурная валидация `fscporg1:base64url(JSON)` без расшифровки.
pub fn try_validate_organizer_wire(
    wire: &str,
    authenticated_owner: Uuid,
) -> Result<OrganizerWireSummary, String> {
    if wire.trim().is_empty() {
        return Err("Пустой FSCP-ORG wire.".into());
    }

    let wire = wire.trim();
    if wire.encode_utf16().count() > MAX_ORGANIZER_WIRE_CHARS {
        return Err("FSCP-ORG wire слишком длинный.".into());
    }

    let Some(inner) = wire.strip_prefix(ORGANIZER_WIRE_PREFIX) else {
        return Err("Неверный префикс FSCP-ORG wire (ожидается fscporg1:).".into());
    };

    let json_utf8 = from_base64_url_like_dotnet(inner, MAX_ORGANIZER_INNER_UTF8_BYTES)?;
    let root = parse_json_like_dotnet(&json_utf8)?;

    if !root.is_object() {
        return Err("FSCP-ORG wire: корень JSON должен быть объектом.".into());
    }

    if int_field(&root, "version") != Some(1) {
        return Err("FSCP-ORG wire: version должен быть 1.".into());
    }

    let owner = match guid_field(&root, "ownerUserUuid") {
        Some(owner) if owner == authenticated_owner => owner,
        _ => {
            return Err(
                "FSCP-ORG wire: ownerUserUuid не совпадает с текущим пользователем.".into(),
            );
        }
    };

    let key_epoch = match guid_field(&root, "keyEpochId") {
        Some(epoch) if epoch == BOOTSTRAP_KEY_EPOCH_ID => epoch,
        _ => {
            return Err(
                "FSCP-ORG wire: keyEpochId не поддерживается (ожидается bootstrap v1).".into(),
            );
        }
    };

    let revision = match int_field(&root, "revision") {
        Some(rev) if rev >= 1 => rev,
        _ => return Err("FSCP-ORG wire: revision должен быть целым числом ≥ 1.".into()),
    };

    if string_field(&root, "updatedAt").is_none() {
        return Err("FSCP-ORG wire: нет updatedAt.".into());
    }

    let Some(body_ct) = string_field(&root, "ciphertextBase64Url") else {
        return Err("FSCP-ORG wire: нет ciphertext состояния.".into());
    };
    if from_base64_url_like_dotnet(body_ct, MAX_STATE_CIPHER_BYTES)?.len() < 16 {
        return Err("FSCP-ORG wire: неверный ciphertext состояния.".into());
    }

    let body_aead = match root.get("aead") {
        Some(aead) if aead.is_object() => aead,
        _ => return Err("FSCP-ORG wire: отсутствует верхнеуровневый aead.".into()),
    };
    if string_field(body_aead, "name") != Some(AEAD_NAME) {
        return Err("FSCP-ORG wire: неподдерживаемый AEAD состояния.".into());
    }
    let Some(body_nonce) = string_field(body_aead, "nonceBase64Url") else {
        return Err("FSCP-ORG wire: нет nonce состояния.".into());
    };
    if from_base64_url_like_dotnet(body_nonce, 32)?.len() != 24 {
        return Err("FSCP-ORG wire: неверный nonce состояния.".into());
    }

    let rk = match root.get("keyEnvelope") {
        Some(rk) if rk.is_object() => rk,
        _ => return Err("FSCP-ORG wire: отсутствует keyEnvelope.".into()),
    };

    if int_field(rk, "version") != Some(1) {
        return Err("FSCP-ORG wire: keyEnvelope.version должен быть 1.".into());
    }
    if string_field(rk, "algorithm") != Some(RKE_ALGORITHM) {
        return Err("FSCP-ORG wire: неподдерживаемый алгоритм keyEnvelope.".into());
    }
    if let Some(pre) = rk.get("preKeyId")
        && !pre.is_null()
    {
        return Err("FSCP-ORG wire: preKeyId должен быть null в v1.".into());
    }

    let Some(pk_id) = string_field(rk, "recipientAgreementPublicKeyId").and_then(parse_guid_like)
    else {
        return Err("FSCP-ORG wire: неверный recipientAgreementPublicKeyId.".into());
    };
    if pk_id != agreement_public_key_id(&owner, &key_epoch) {
        return Err(
            "FSCP-ORG wire: recipientAgreementPublicKeyId не соответствует владельцу и эпохе."
                .into(),
        );
    }

    let Some(eph) = string_field(rk, "ephemeralPublicKeyBase64Url") else {
        return Err("FSCP-ORG wire: нет ephemeralPublicKeyBase64Url.".into());
    };
    if from_base64_url_like_dotnet(eph, 64)?.len() != 32 {
        return Err("FSCP-ORG wire: неверный ephemeralPublicKeyBase64Url.".into());
    }

    let Some(salt) = string_field(rk, "saltBase64Url") else {
        return Err("FSCP-ORG wire: нет saltBase64Url.".into());
    };
    if from_base64_url_like_dotnet(salt, 64)?.len() != 32 {
        return Err("FSCP-ORG wire: неверный saltBase64Url.".into());
    }

    let rk_aead = match rk.get("aead") {
        Some(aead) if aead.is_object() => aead,
        _ => return Err("FSCP-ORG wire: отсутствует aead в keyEnvelope.".into()),
    };
    if string_field(rk_aead, "name") != Some(AEAD_NAME) {
        return Err("FSCP-ORG wire: неподдерживаемый AEAD keyEnvelope.".into());
    }
    let Some(rk_nonce) = string_field(rk_aead, "nonceBase64Url") else {
        return Err("FSCP-ORG wire: нет nonce keyEnvelope.".into());
    };
    if from_base64_url_like_dotnet(rk_nonce, 32)?.len() != 24 {
        return Err("FSCP-ORG wire: неверный nonce keyEnvelope.".into());
    }

    let Some(rct) = string_field(rk, "ciphertextBase64Url") else {
        return Err("FSCP-ORG wire: нет ciphertext keyEnvelope.".into());
    };
    if from_base64_url_like_dotnet(rct, MAX_KEY_ENVELOPE_CIPHER_BYTES)?.len() < 16 {
        return Err("FSCP-ORG wire: неверный ciphertext keyEnvelope.".into());
    }

    match string_field(&root, "ownerSigningPublicKeyBase64Url") {
        Some(sign_pk) => {
            if from_base64_url_like_dotnet(sign_pk, 64)?.len() != 32 {
                return Err("FSCP-ORG wire: неверный ownerSigningPublicKeyBase64Url.".into());
            }
        }
        None => {
            return Err(
                "FSCP-ORG wire: требуется ownerSigningPublicKeyBase64Url (Ed25519, 32 байта)."
                    .into(),
            );
        }
    }

    let Some(sig) = string_field(&root, "ownerSignatureBase64Url") else {
        return Err("FSCP-ORG wire: нет подписи владельца.".into());
    };
    if from_base64_url_like_dotnet(sig, 96)?.len() != 64 {
        return Err("FSCP-ORG wire: неверная подпись владельца.".into());
    }

    Ok(OrganizerWireSummary {
        owner_user_uuid: owner,
        revision,
    })
}

/// Криптопроверка Ed25519-подписи конверта организатора (после
/// [`try_validate_organizer_wire`]). Содержимое не расшифровывается.
pub fn verify_organizer_signature(wire: &str) -> Result<(), String> {
    let wire = wire.trim();
    let Some(inner) = wire.strip_prefix(ORGANIZER_WIRE_PREFIX) else {
        return Err("Неверный префикс FSCP-ORG wire (ожидается fscporg1:).".into());
    };
    let json_utf8 = from_base64_url_like_dotnet(inner, MAX_ORGANIZER_INNER_UTF8_BYTES)?;
    let root = parse_json_like_dotnet(&json_utf8)?;

    let Some(pk_b64) = string_field(&root, "ownerSigningPublicKeyBase64Url") else {
        return Err(
            "FSCP-ORG wire: требуется ownerSigningPublicKeyBase64Url (Ed25519, 32 байта).".into(),
        );
    };
    let Some(sig_b64) = string_field(&root, "ownerSignatureBase64Url") else {
        return Err("FSCP-ORG wire: нет подписи владельца.".into());
    };

    let pk_bytes: [u8; 32] = from_base64_url_like_dotnet(pk_b64, 64)?
        .try_into()
        .map_err(|_| String::from("FSCP-ORG wire: неверный ownerSigningPublicKeyBase64Url."))?;
    let sig_bytes: [u8; 64] = from_base64_url_like_dotnet(sig_b64, 96)?
        .try_into()
        .map_err(|_| String::from("FSCP-ORG wire: неверная подпись владельца."))?;

    let mut no_sig = root;
    if let Some(obj) = no_sig.as_object_mut() {
        obj.remove("ownerSignatureBase64Url");
    }
    let payload = format!("{ORGANIZER_SIGNATURE_DOMAIN} | {}", canonical_json(&no_sig));

    let vk = VerifyingKey::from_bytes(&pk_bytes)
        .map_err(|_| String::from("FSCP-ORG wire: неверный ownerSigningPublicKeyBase64Url."))?;
    vk.verify(payload.as_bytes(), &Signature::from_bytes(&sig_bytes))
        .map_err(|_| String::from("FSCP-ORG wire: подпись конверта Ed25519 не прошла проверку."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::{Value, json};

    const OWNER: Uuid = uuid::uuid!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

    fn signed_organizer_wire(revision: i64, mutate: impl FnOnce(&mut Value)) -> String {
        let sk = SigningKey::from_bytes(&[11u8; 32]);
        let mut env = json!({
            "version": 1,
            "ownerUserUuid": OWNER.to_string(),
            "keyEpochId": BOOTSTRAP_KEY_EPOCH_ID.to_string(),
            "revision": revision,
            "updatedAt": "2026-08-02T00:00:00.000Z",
            "ciphertextBase64Url": URL_SAFE_NO_PAD.encode([5u8; 48]),
            "aead": {
                "name": "xchacha20-poly1305",
                "nonceBase64Url": URL_SAFE_NO_PAD.encode([6u8; 24])
            },
            "keyEnvelope": {
                "version": 1,
                "algorithm": "x25519-hkdf-xchacha20poly1305",
                "ephemeralPublicKeyBase64Url": URL_SAFE_NO_PAD.encode([1u8; 32]),
                "recipientAgreementPublicKeyId":
                    agreement_public_key_id(&OWNER, &BOOTSTRAP_KEY_EPOCH_ID).to_string(),
                "preKeyId": null,
                "saltBase64Url": URL_SAFE_NO_PAD.encode([2u8; 32]),
                "aead": {
                    "name": "xchacha20-poly1305",
                    "nonceBase64Url": URL_SAFE_NO_PAD.encode([3u8; 24])
                },
                "ciphertextBase64Url": URL_SAFE_NO_PAD.encode([4u8; 48])
            },
            "ownerSigningPublicKeyBase64Url":
                URL_SAFE_NO_PAD.encode(sk.verifying_key().to_bytes()),
        });
        let payload = format!("{ORGANIZER_SIGNATURE_DOMAIN} | {}", canonical_json(&env));
        let sig = sk.sign(payload.as_bytes());
        env.as_object_mut().unwrap().insert(
            "ownerSignatureBase64Url".into(),
            Value::String(URL_SAFE_NO_PAD.encode(sig.to_bytes())),
        );
        mutate(&mut env);
        format!(
            "{ORGANIZER_WIRE_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_string(&env).unwrap())
        )
    }

    #[test]
    fn valid_organizer_wire_passes() {
        let wire = signed_organizer_wire(7, |_| {});
        let summary = try_validate_organizer_wire(&wire, OWNER).unwrap();
        assert_eq!(summary.owner_user_uuid, OWNER);
        assert_eq!(summary.revision, 7);
        assert_eq!(verify_organizer_signature(&wire), Ok(()));
    }

    #[test]
    fn foreign_owner_is_rejected() {
        let wire = signed_organizer_wire(1, |_| {});
        let other = uuid::uuid!("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
        assert_eq!(
            try_validate_organizer_wire(&wire, other).unwrap_err(),
            "FSCP-ORG wire: ownerUserUuid не совпадает с текущим пользователем."
        );
    }

    #[test]
    fn zero_revision_is_rejected() {
        let wire = signed_organizer_wire(1, |env| {
            env["revision"] = json!(0);
        });
        assert_eq!(
            try_validate_organizer_wire(&wire, OWNER).unwrap_err(),
            "FSCP-ORG wire: revision должен быть целым числом ≥ 1."
        );
    }

    #[test]
    fn tampered_revision_breaks_signature() {
        let wire = signed_organizer_wire(3, |env| {
            env["revision"] = json!(4);
        });
        assert!(try_validate_organizer_wire(&wire, OWNER).is_ok());
        assert_eq!(
            verify_organizer_signature(&wire).unwrap_err(),
            "FSCP-ORG wire: подпись конверта Ed25519 не прошла проверку."
        );
    }

    #[test]
    fn wrong_agreement_key_id_is_rejected() {
        let wire = signed_organizer_wire(1, |env| {
            env["keyEnvelope"]["recipientAgreementPublicKeyId"] =
                Value::String("77777777-7777-4777-8777-777777777777".into());
        });
        assert_eq!(
            try_validate_organizer_wire(&wire, OWNER).unwrap_err(),
            "FSCP-ORG wire: recipientAgreementPublicKeyId не соответствует владельцу и эпохе."
        );
    }

    #[test]
    fn dm_prefix_is_rejected() {
        assert_eq!(
            try_validate_organizer_wire("fscp1:AAAA", OWNER).unwrap_err(),
            "Неверный префикс FSCP-ORG wire (ожидается fscporg1:)."
        );
    }
}
