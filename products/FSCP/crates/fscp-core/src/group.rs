//! Серверная структурная валидация группового конверта FSCP-G v1 (`fscpg1:`).
//!
//! Отдельная спецификация поверх криптопримитивов FSCP v1 (FSCP.md §Целевой
//! алгоритм → Group messaging). Замороженный DM-валидатор v1 (`lib.rs`,
//! golden `fscp-wire-validator-v1.json`) не изменяется; групповой валидатор —
//! новый код без заморозки строк, но в том же стиле «форма без расшифровки».
//!
//! Ключевое отличие от DM: состав `recipients` сверяется с **активным ростером
//! группы**, который передаёт Messaging (server-authoritative membership).

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::Value;
use uuid::Uuid;

use fscp_contracts::{BOOTSTRAP_KEY_EPOCH_ID, GROUP_MAX_MEMBERS, GROUP_WIRE_PREFIX};

use super::{
    agreement_public_key_id, canonical_json, from_base64_url_like_dotnet, guid_field, int_field,
    parse_guid_like, parse_json_like_dotnet, string_field,
};

/// Лимиты группового wire: N получателей вместо двух, поэтому свои границы.
/// 128 RKE-строк (~600 Б каждая) + тело 64 KiB укладываются с запасом.
const MAX_GROUP_WIRE_CHARS: usize = 600_000;
const MAX_GROUP_INNER_UTF8_BYTES: usize = 400_000;
const MAX_RECIPIENT_ENVELOPE_CIPHER_BYTES: usize = 8 * 1024;
const MAX_MESSAGE_BODY_CIPHER_BYTES: usize = 64 * 1024;

const RKE_ALGORITHM: &str = "x25519-hkdf-xchacha20poly1305";
const AEAD_NAME: &str = "xchacha20-poly1305";
const GROUP_SIGNATURE_DOMAIN: &str = "flora.messaging.group-envelope-signature.v1";

/// Итог структурной валидации группового wire (метаданные для policy-слоя).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupWireSummary {
    /// Клиентский `messageUuid` из подписанного конверта.
    pub message_uuid: Uuid,
    pub conversation_uuid: Uuid,
    pub sender_user_uuid: Uuid,
    pub sender_device_uuid: Uuid,
    /// Уникальные userUuid из `recipients` (включая отправителя).
    pub recipient_user_uuids: Vec<Uuid>,
}

/// Структурная валидация `fscpg1:base64url(JSON)` без расшифровки.
///
/// `active_member_uuids` — актуальный ростер группы (включая отправителя);
/// множество получателей конверта обязано совпадать с ним в точности, иначе
/// клиент шифровал на устаревший состав и обязан пересобрать конверт.
pub fn try_validate_group_wire(
    wire: &str,
    authenticated_sender: Uuid,
    expected_conversation: Uuid,
    active_member_uuids: &[Uuid],
) -> Result<GroupWireSummary, String> {
    if wire.trim().is_empty() {
        return Err("Пустой FSCP-G wire.".into());
    }

    let wire = wire.trim();
    if wire.encode_utf16().count() > MAX_GROUP_WIRE_CHARS {
        return Err("FSCP-G wire слишком длинный.".into());
    }

    let Some(inner) = wire.strip_prefix(GROUP_WIRE_PREFIX) else {
        return Err("Неверный префикс FSCP-G wire (ожидается fscpg1:).".into());
    };

    let json_utf8 = from_base64_url_like_dotnet(inner, MAX_GROUP_INNER_UTF8_BYTES)?;
    let root = parse_json_like_dotnet(&json_utf8)?;

    if !root.is_object() {
        return Err("FSCP-G wire: корень JSON должен быть объектом.".into());
    }

    if int_field(&root, "version") != Some(1) {
        return Err("FSCP-G wire: version должен быть 1.".into());
    }

    let sender = match guid_field(&root, "senderUserUuid") {
        Some(sender) if sender == authenticated_sender => sender,
        _ => {
            return Err("FSCP-G wire: senderUserUuid не совпадает с текущим пользователем.".into());
        }
    };

    let conversation = match guid_field(&root, "conversationUuid") {
        Some(conversation) if conversation == expected_conversation => conversation,
        _ => return Err("FSCP-G wire: conversationUuid не соответствует группе.".into()),
    };

    let key_epoch = match guid_field(&root, "keyEpochId") {
        Some(epoch) if epoch == BOOTSTRAP_KEY_EPOCH_ID => epoch,
        _ => {
            return Err(
                "FSCP-G wire: keyEpochId не поддерживается (ожидается bootstrap v1).".into(),
            );
        }
    };

    let Some(message_uuid) = guid_field(&root, "messageUuid") else {
        return Err("FSCP-G wire: неверный messageUuid.".into());
    };

    let Some(sender_device_uuid) = guid_field(&root, "senderDeviceUuid") else {
        return Err("FSCP-G wire: неверный senderDeviceUuid.".into());
    };

    let recipients = match root.get("recipients").and_then(Value::as_array) {
        Some(arr) if !arr.is_empty() && arr.len() <= GROUP_MAX_MEMBERS => arr,
        Some(arr) if arr.len() > GROUP_MAX_MEMBERS => {
            return Err("FSCP-G wire: слишком много получателей.".into());
        }
        _ => return Err("FSCP-G wire: recipients должен быть непустым массивом.".into()),
    };

    let mut seen: Vec<Uuid> = Vec::with_capacity(recipients.len());
    for r in recipients {
        if !r.is_object() {
            return Err("FSCP-G wire: элемент recipients должен быть объектом.".into());
        }
        let Some(ru) = guid_field(r, "userUuid") else {
            return Err("FSCP-G wire: неверный userUuid в recipients.".into());
        };
        if seen.contains(&ru) {
            return Err("FSCP-G wire: дубликат userUuid в recipients.".into());
        }
        seen.push(ru);
    }

    if !seen.contains(&sender) {
        return Err("FSCP-G wire: recipients должны включать отправителя (self-copy).".into());
    }

    // Состав получателей == активный ростер группы (точное совпадение множеств).
    {
        let mut expected: Vec<Uuid> = active_member_uuids.to_vec();
        expected.sort_unstable();
        expected.dedup();
        let mut actual = seen.clone();
        actual.sort_unstable();
        if actual != expected {
            return Err(
                "FSCP-G wire: состав recipients не совпадает с активными участниками группы."
                    .into(),
            );
        }
    }

    for r in recipients {
        let ru = guid_field(r, "userUuid").ok_or(String::new())?;

        match r.get("deviceUuid").and_then(Value::as_str) {
            Some(device) if !device.trim().is_empty() => {
                if parse_guid_like(device).is_none() {
                    return Err("FSCP-G wire: неверный deviceUuid.".into());
                }
            }
            _ => return Err("FSCP-G wire: отсутствует deviceUuid у получателя.".into()),
        }

        let rk = match r.get("recipientKeyEnvelope") {
            Some(rk) if rk.is_object() => rk,
            _ => return Err("FSCP-G wire: отсутствует recipientKeyEnvelope.".into()),
        };

        if int_field(rk, "version") != Some(1) {
            return Err("FSCP-G wire: recipientKeyEnvelope.version должен быть 1.".into());
        }

        if string_field(rk, "algorithm") != Some(RKE_ALGORITHM) {
            return Err("FSCP-G wire: неподдерживаемый алгоритм RKE.".into());
        }

        if let Some(pre) = rk.get("preKeyId")
            && !pre.is_null()
        {
            return Err("FSCP-G wire: preKeyId должен быть null в v1.".into());
        }

        let Some(pk_id) =
            string_field(rk, "recipientAgreementPublicKeyId").and_then(parse_guid_like)
        else {
            return Err("FSCP-G wire: неверный recipientAgreementPublicKeyId.".into());
        };

        let expected_pk_id = agreement_public_key_id(&ru, &key_epoch);
        if pk_id != expected_pk_id {
            return Err(
                "FSCP-G wire: recipientAgreementPublicKeyId не соответствует пользователю и эпохе."
                    .into(),
            );
        }

        let Some(eph) = string_field(rk, "ephemeralPublicKeyBase64Url") else {
            return Err("FSCP-G wire: нет ephemeralPublicKeyBase64Url.".into());
        };
        if from_base64_url_like_dotnet(eph, 64)?.len() != 32 {
            return Err("FSCP-G wire: неверный ephemeralPublicKeyBase64Url.".into());
        }

        let Some(salt) = string_field(rk, "saltBase64Url") else {
            return Err("FSCP-G wire: нет saltBase64Url.".into());
        };
        if from_base64_url_like_dotnet(salt, 64)?.len() != 32 {
            return Err("FSCP-G wire: неверный saltBase64Url.".into());
        }

        let aead = match rk.get("aead") {
            Some(aead) if aead.is_object() => aead,
            _ => return Err("FSCP-G wire: отсутствует aead в recipientKeyEnvelope.".into()),
        };

        if string_field(aead, "name") != Some(AEAD_NAME) {
            return Err("FSCP-G wire: неподдерживаемый AEAD в RKE.".into());
        }

        let Some(nonce) = string_field(aead, "nonceBase64Url") else {
            return Err("FSCP-G wire: нет nonce RKE.".into());
        };
        if from_base64_url_like_dotnet(nonce, 32)?.len() != 24 {
            return Err("FSCP-G wire: неверный nonce RKE.".into());
        }

        let Some(rct) = string_field(rk, "ciphertextBase64Url") else {
            return Err("FSCP-G wire: нет ciphertext RKE.".into());
        };
        if from_base64_url_like_dotnet(rct, MAX_RECIPIENT_ENVELOPE_CIPHER_BYTES)?.len() < 16 {
            return Err("FSCP-G wire: неверный ciphertext RKE.".into());
        }
    }

    let Some(body_ct) = string_field(&root, "ciphertextBase64Url") else {
        return Err("FSCP-G wire: нет ciphertext тела сообщения.".into());
    };
    if from_base64_url_like_dotnet(body_ct, MAX_MESSAGE_BODY_CIPHER_BYTES)?.len() < 16 {
        return Err("FSCP-G wire: неверный ciphertext тела сообщения.".into());
    }

    let body_aead = match root.get("aead") {
        Some(aead) if aead.is_object() => aead,
        _ => return Err("FSCP-G wire: отсутствует верхнеуровневый aead.".into()),
    };

    if string_field(body_aead, "name") != Some(AEAD_NAME) {
        return Err("FSCP-G wire: неподдерживаемый AEAD тела сообщения.".into());
    }

    let Some(body_nonce) = string_field(body_aead, "nonceBase64Url") else {
        return Err("FSCP-G wire: нет nonce тела сообщения.".into());
    };
    if from_base64_url_like_dotnet(body_nonce, 32)?.len() != 24 {
        return Err("FSCP-G wire: неверный nonce тела сообщения.".into());
    }

    match root
        .get("senderSigningPublicKeyBase64Url")
        .and_then(Value::as_str)
    {
        Some(sign_pk) if !sign_pk.trim().is_empty() => {
            if from_base64_url_like_dotnet(sign_pk, 64)?.len() != 32 {
                return Err("FSCP-G wire: неверный senderSigningPublicKeyBase64Url.".into());
            }
        }
        _ => {
            return Err(
                "FSCP-G wire: требуется senderSigningPublicKeyBase64Url (Ed25519, 32 байта)."
                    .into(),
            );
        }
    }

    let Some(sig) = string_field(&root, "senderSignatureBase64Url") else {
        return Err("FSCP-G wire: нет подписи отправителя.".into());
    };
    if from_base64_url_like_dotnet(sig, 96)?.len() != 64 {
        return Err("FSCP-G wire: неверная подпись отправителя.".into());
    }

    Ok(GroupWireSummary {
        message_uuid,
        conversation_uuid: conversation,
        sender_user_uuid: sender,
        sender_device_uuid,
        recipient_user_uuids: seen,
    })
}

/// Криптопроверка Ed25519-подписи группового конверта (defense-in-depth после
/// [`try_validate_group_wire`]) — параллель `verify_envelope_signature` для DM.
/// Содержимое не расшифровывается.
pub fn verify_group_envelope_signature(wire: &str) -> Result<(), String> {
    let wire = wire.trim();
    let Some(inner) = wire.strip_prefix(GROUP_WIRE_PREFIX) else {
        return Err("Неверный префикс FSCP-G wire (ожидается fscpg1:).".into());
    };
    let json_utf8 = from_base64_url_like_dotnet(inner, MAX_GROUP_INNER_UTF8_BYTES)?;
    let root = parse_json_like_dotnet(&json_utf8)?;

    let Some(pk_b64) = string_field(&root, "senderSigningPublicKeyBase64Url") else {
        return Err(
            "FSCP-G wire: требуется senderSigningPublicKeyBase64Url (Ed25519, 32 байта).".into(),
        );
    };
    let Some(sig_b64) = string_field(&root, "senderSignatureBase64Url") else {
        return Err("FSCP-G wire: нет подписи отправителя.".into());
    };

    let pk_bytes: [u8; 32] = from_base64_url_like_dotnet(pk_b64, 64)?
        .try_into()
        .map_err(|_| String::from("FSCP-G wire: неверный senderSigningPublicKeyBase64Url."))?;
    let sig_bytes: [u8; 64] = from_base64_url_like_dotnet(sig_b64, 96)?
        .try_into()
        .map_err(|_| String::from("FSCP-G wire: неверная подпись отправителя."))?;

    let mut no_sig = root;
    if let Some(obj) = no_sig.as_object_mut() {
        obj.remove("senderSignatureBase64Url");
    }
    let payload = format!("{GROUP_SIGNATURE_DOMAIN} | {}", canonical_json(&no_sig));

    let vk = VerifyingKey::from_bytes(&pk_bytes)
        .map_err(|_| String::from("FSCP-G wire: неверный senderSigningPublicKeyBase64Url."))?;
    vk.verify(payload.as_bytes(), &Signature::from_bytes(&sig_bytes))
        .map_err(|_| String::from("FSCP-G wire: подпись конверта Ed25519 не прошла проверку."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::json;

    const SENDER: Uuid = uuid::uuid!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const MEMBER_B: Uuid = uuid::uuid!("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const MEMBER_C: Uuid = uuid::uuid!("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    const CONV: Uuid = uuid::uuid!("11111111-2222-4333-8444-555555555555");
    const DEVICE: Uuid = uuid::uuid!("00000000-0000-4000-8000-000000000002");

    fn recipient_entry(user: Uuid) -> Value {
        json!({
            "userUuid": user.to_string(),
            "deviceUuid": DEVICE.to_string(),
            "recipientKeyEnvelope": {
                "version": 1,
                "algorithm": "x25519-hkdf-xchacha20poly1305",
                "ephemeralPublicKeyBase64Url": URL_SAFE_NO_PAD.encode([1u8; 32]),
                "recipientAgreementPublicKeyId":
                    agreement_public_key_id(&user, &BOOTSTRAP_KEY_EPOCH_ID).to_string(),
                "preKeyId": null,
                "saltBase64Url": URL_SAFE_NO_PAD.encode([2u8; 32]),
                "aead": {
                    "name": "xchacha20-poly1305",
                    "nonceBase64Url": URL_SAFE_NO_PAD.encode([3u8; 24])
                },
                "ciphertextBase64Url": URL_SAFE_NO_PAD.encode([4u8; 48])
            }
        })
    }

    fn signed_group_wire(members: &[Uuid], mutate: impl FnOnce(&mut Value)) -> String {
        let sk = SigningKey::from_bytes(&[9u8; 32]);
        let mut env = json!({
            "version": 1,
            "messageUuid": "99999999-9999-4999-8999-999999999999",
            "conversationUuid": CONV.to_string(),
            "keyEpochId": BOOTSTRAP_KEY_EPOCH_ID.to_string(),
            "senderUserUuid": SENDER.to_string(),
            "senderDeviceUuid": DEVICE.to_string(),
            "messageKeyId": "88888888-8888-4888-8888-888888888888",
            "createdAt": "2026-08-02T00:00:00.000Z",
            "ciphertextBase64Url": URL_SAFE_NO_PAD.encode([5u8; 32]),
            "aead": {
                "name": "xchacha20-poly1305",
                "nonceBase64Url": URL_SAFE_NO_PAD.encode([6u8; 24])
            },
            "recipients": members.iter().map(|m| recipient_entry(*m)).collect::<Vec<_>>(),
            "senderSigningPublicKeyBase64Url":
                URL_SAFE_NO_PAD.encode(sk.verifying_key().to_bytes()),
        });
        let payload = format!("{GROUP_SIGNATURE_DOMAIN} | {}", canonical_json(&env));
        let sig = sk.sign(payload.as_bytes());
        env.as_object_mut().unwrap().insert(
            "senderSignatureBase64Url".into(),
            Value::String(URL_SAFE_NO_PAD.encode(sig.to_bytes())),
        );
        mutate(&mut env);
        format!(
            "{GROUP_WIRE_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_string(&env).unwrap())
        )
    }

    #[test]
    fn valid_group_wire_passes_and_returns_summary() {
        let wire = signed_group_wire(&[SENDER, MEMBER_B, MEMBER_C], |_| {});
        let summary =
            try_validate_group_wire(&wire, SENDER, CONV, &[SENDER, MEMBER_B, MEMBER_C]).unwrap();
        assert_eq!(summary.sender_user_uuid, SENDER);
        assert_eq!(summary.conversation_uuid, CONV);
        assert_eq!(summary.recipient_user_uuids.len(), 3);
        assert_eq!(verify_group_envelope_signature(&wire), Ok(()));
    }

    #[test]
    fn dm_wire_prefix_is_rejected() {
        assert_eq!(
            try_validate_group_wire("fscp1:AAAA", SENDER, CONV, &[SENDER]).unwrap_err(),
            "Неверный префикс FSCP-G wire (ожидается fscpg1:)."
        );
    }

    #[test]
    fn recipients_must_match_active_roster_exactly() {
        // Конверт без MEMBER_C, хотя ростер содержит его.
        let wire = signed_group_wire(&[SENDER, MEMBER_B], |_| {});
        assert_eq!(
            try_validate_group_wire(&wire, SENDER, CONV, &[SENDER, MEMBER_B, MEMBER_C])
                .unwrap_err(),
            "FSCP-G wire: состав recipients не совпадает с активными участниками группы."
        );
        // Конверт с лишним (уже удалённым) участником.
        let wire = signed_group_wire(&[SENDER, MEMBER_B, MEMBER_C], |_| {});
        assert_eq!(
            try_validate_group_wire(&wire, SENDER, CONV, &[SENDER, MEMBER_B]).unwrap_err(),
            "FSCP-G wire: состав recipients не совпадает с активными участниками группы."
        );
    }

    #[test]
    fn sender_self_copy_is_required() {
        let wire = signed_group_wire(&[MEMBER_B, MEMBER_C], |_| {});
        assert_eq!(
            try_validate_group_wire(&wire, SENDER, CONV, &[MEMBER_B, MEMBER_C]).unwrap_err(),
            "FSCP-G wire: recipients должны включать отправителя (self-copy)."
        );
    }

    #[test]
    fn duplicate_recipient_is_rejected() {
        let wire = signed_group_wire(&[SENDER, MEMBER_B, MEMBER_B], |_| {});
        assert_eq!(
            try_validate_group_wire(&wire, SENDER, CONV, &[SENDER, MEMBER_B]).unwrap_err(),
            "FSCP-G wire: дубликат userUuid в recipients."
        );
    }

    #[test]
    fn foreign_conversation_is_rejected() {
        let wire = signed_group_wire(&[SENDER, MEMBER_B], |_| {});
        let other = uuid::uuid!("22222222-2222-4222-8222-222222222222");
        assert_eq!(
            try_validate_group_wire(&wire, SENDER, other, &[SENDER, MEMBER_B]).unwrap_err(),
            "FSCP-G wire: conversationUuid не соответствует группе."
        );
    }

    #[test]
    fn tampered_recipients_break_signature() {
        let wire = signed_group_wire(&[SENDER, MEMBER_B, MEMBER_C], |env| {
            let arr = env["recipients"].as_array_mut().unwrap();
            arr.pop();
        });
        // Форма с усечённым ростером валидна…
        assert!(try_validate_group_wire(&wire, SENDER, CONV, &[SENDER, MEMBER_B]).is_ok());
        // …но криптопроверка подписи ловит подмену.
        assert_eq!(
            verify_group_envelope_signature(&wire).unwrap_err(),
            "FSCP-G wire: подпись конверта Ed25519 не прошла проверку."
        );
    }

    #[test]
    fn wrong_agreement_key_id_is_rejected() {
        let wire = signed_group_wire(&[SENDER, MEMBER_B], |env| {
            env["recipients"][0]["recipientKeyEnvelope"]["recipientAgreementPublicKeyId"] =
                Value::String("77777777-7777-4777-8777-777777777777".into());
        });
        assert_eq!(
            try_validate_group_wire(&wire, SENDER, CONV, &[SENDER, MEMBER_B]).unwrap_err(),
            "FSCP-G wire: recipientAgreementPublicKeyId не соответствует пользователю и эпохе."
        );
    }
}
