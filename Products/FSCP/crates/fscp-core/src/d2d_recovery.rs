//! Серверная валидация DeviceToDeviceRecoveryEnvelope
//! (Documents/fscp/e2e-security.md §DeviceToDeviceRecoveryEnvelope, §Devices recover-key).
//!
//! Сервер **не расшифровывает** payload (инвариант next-architecture.md §4.4):
//! проверяется только форма конверта, binding-инварианты (`targetAgreementPublicKeyId`)
//! и Ed25519-подпись source-устройства над canonical JSON без поля подписи.
//! Референс-реализация клиента — `deviceRecovery.ts` в `@flora/fscp`.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::Value;
use uuid::Uuid;

use crate::{canonical_json, uuid_v5_name};

/// Домен подписи конверта — байт-в-байт с TS (`D2D_SIGNATURE_DOMAIN`).
pub const D2D_SIGNATURE_DOMAIN: &str = "flora.messaging.device-to-device-recovery-signature.v1";
/// Домен AAD конверта — байт-в-байт с TS (`D2D_AAD_DOMAIN`); сервер AAD не использует
/// (не расшифровывает), константа — для потребителей golden-векторов.
pub const D2D_AAD_DOMAIN: &str = "flora.messaging.device-to-device-recovery.v1";

/// Максимум канонического JSON конверта (материал epochs невелик; защита от abuse).
const MAX_CANONICAL_JSON_BYTES: usize = 128 * 1024;
/// Максимум ciphertext (v1: root key + identity keys на epoch, conversationKeyBackups пуст).
const MAX_CIPHERTEXT_BYTES: usize = 64 * 1024;
/// Ограничивает application-layer authority checks (один DB lookup на epoch).
const MAX_TRANSFERRED_KEY_EPOCHS: usize = 64;

const AEAD_NAME: &str = "xchacha20-poly1305";

const TOP_LEVEL_FIELDS: [&str; 12] = [
    "version",
    "recoveryRequestId",
    "userUuid",
    "sourceDeviceUuid",
    "targetDeviceUuid",
    "transferredKeyEpochIds",
    "targetAgreementPublicKeyId",
    "ephemeralPublicKeyBase64Url",
    "saltBase64Url",
    "aead",
    "ciphertextBase64Url",
    "sourceDeviceSignatureBase64Url",
];

/// Идентификатор device agreement public key —
/// `UUIDv5(DNS, "{user}|{device}|device-agreement-v1")`.
/// Паритет: `deviceAgreementPublicKeyId` в `@flora/fscp`.
pub fn device_agreement_public_key_id(user_uuid: &Uuid, device_uuid: &Uuid) -> Uuid {
    uuid_v5_name(&format!("{user_uuid}|{device_uuid}|device-agreement-v1"))
}

/// Результат структурной валидации: типизированные поля для application-слоя
/// + canonical JSON конверта (детерминированный формат хранения/выдачи).
#[derive(Debug, Clone)]
pub struct D2dRecoveryEnvelopeSummary {
    pub recovery_request_id: Uuid,
    pub user_uuid: Uuid,
    pub source_device_uuid: Uuid,
    pub target_device_uuid: Uuid,
    pub transferred_key_epoch_ids: Vec<Uuid>,
    pub canonical_json: String,
}

/// Структурная валидация конверта (fail-closed, strict: неизвестные поля — ошибка).
///
/// Не проверяет подпись — см. [`verify_d2d_recovery_signature`]; не расшифровывает.
pub fn try_validate_d2d_recovery_envelope(
    envelope: &Value,
) -> Result<D2dRecoveryEnvelopeSummary, String> {
    let obj = envelope
        .as_object()
        .ok_or_else(|| String::from("D2D recovery: конверт должен быть JSON-объектом."))?;

    for key in obj.keys() {
        if !TOP_LEVEL_FIELDS.contains(&key.as_str()) {
            return Err(format!("D2D recovery: неизвестное поле {key}."));
        }
    }

    if envelope.get("version").and_then(Value::as_i64) != Some(1) {
        return Err("D2D recovery: version должен быть 1.".into());
    }

    let recovery_request_id = strict_uuid_field(envelope, "recoveryRequestId")?;
    let user_uuid = strict_uuid_field(envelope, "userUuid")?;
    let source_device_uuid = strict_uuid_field(envelope, "sourceDeviceUuid")?;
    let target_device_uuid = strict_uuid_field(envelope, "targetDeviceUuid")?;
    let target_agreement_public_key_id = strict_uuid_field(envelope, "targetAgreementPublicKeyId")?;

    if source_device_uuid == target_device_uuid {
        return Err("D2D recovery: sourceDeviceUuid и targetDeviceUuid не могут совпадать.".into());
    }

    let transferred = envelope
        .get("transferredKeyEpochIds")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            String::from("D2D recovery: transferredKeyEpochIds должен быть непустым массивом.")
        })?;
    if transferred.is_empty() {
        return Err("D2D recovery: transferredKeyEpochIds должен быть непустым массивом.".into());
    }
    if transferred.len() > MAX_TRANSFERRED_KEY_EPOCHS {
        return Err(format!(
            "D2D recovery: transferredKeyEpochIds не должен превышать {MAX_TRANSFERRED_KEY_EPOCHS} элементов."
        ));
    }

    let mut transferred_key_epoch_ids: Vec<Uuid> = Vec::with_capacity(transferred.len());
    let mut previous_raw: Option<&str> = None;
    for item in transferred {
        let raw = item.as_str().ok_or_else(|| {
            String::from("D2D recovery: неверный элемент transferredKeyEpochIds.")
        })?;
        let parsed = strict_lowercase_uuid(raw).ok_or_else(|| {
            String::from("D2D recovery: неверный элемент transferredKeyEpochIds.")
        })?;
        // Референс-билдер выдаёт lowercase-отсортированный список без дублей;
        // strict-валидация фиксирует это как инвариант (детерминированные AAD/подпись).
        if let Some(prev) = previous_raw
            && prev >= raw
        {
            return Err(
                "D2D recovery: transferredKeyEpochIds должны быть отсортированы и без дублей."
                    .into(),
            );
        }
        previous_raw = Some(raw);
        transferred_key_epoch_ids.push(parsed);
    }

    let expected_target_agreement_id =
        device_agreement_public_key_id(&user_uuid, &target_device_uuid);
    if target_agreement_public_key_id != expected_target_agreement_id {
        return Err(
            "D2D recovery: targetAgreementPublicKeyId не соответствует target-устройству.".into(),
        );
    }

    check_b64u_len(envelope, "ephemeralPublicKeyBase64Url", 32)?;
    check_b64u_len(envelope, "saltBase64Url", 32)?;

    let aead = envelope
        .get("aead")
        .and_then(Value::as_object)
        .ok_or_else(|| String::from("D2D recovery: отсутствует aead."))?;
    for key in aead.keys() {
        if key != "name" && key != "nonceBase64Url" {
            return Err(format!("D2D recovery: неизвестное поле aead.{key}."));
        }
    }
    if aead.get("name").and_then(Value::as_str) != Some(AEAD_NAME) {
        return Err("D2D recovery: неподдерживаемый AEAD.".into());
    }
    check_b64u_len(&envelope["aead"], "nonceBase64Url", 24)?;

    let ciphertext = string_field(envelope, "ciphertextBase64Url")
        .ok_or_else(|| String::from("D2D recovery: нет ciphertextBase64Url."))?;
    let ciphertext_bytes = decode_b64u(ciphertext)
        .ok_or_else(|| String::from("D2D recovery: неверный ciphertextBase64Url."))?;
    if ciphertext_bytes.len() < 16 || ciphertext_bytes.len() > MAX_CIPHERTEXT_BYTES {
        return Err("D2D recovery: неверный ciphertextBase64Url.".into());
    }

    let signature = string_field(envelope, "sourceDeviceSignatureBase64Url")
        .ok_or_else(|| String::from("D2D recovery: нет подписи source-устройства."))?;
    let signature_bytes = decode_b64u(signature)
        .ok_or_else(|| String::from("D2D recovery: неверная подпись source-устройства."))?;
    if signature_bytes.len() != 64 {
        return Err("D2D recovery: неверная подпись source-устройства.".into());
    }

    let canonical = canonical_json(envelope);
    if canonical.len() > MAX_CANONICAL_JSON_BYTES {
        return Err("D2D recovery: конверт превышает лимит размера.".into());
    }

    Ok(D2dRecoveryEnvelopeSummary {
        recovery_request_id,
        user_uuid,
        source_device_uuid,
        target_device_uuid,
        transferred_key_epoch_ids,
        canonical_json: canonical,
    })
}

/// Проверка Ed25519-подписи source-устройства.
///
/// `source_signing_public_key_base64_url` — **server-attested** ключ из записи
/// `user_device_keys` (не из конверта). Вызывать после успешной структурной валидации.
pub fn verify_d2d_recovery_signature(
    envelope: &Value,
    source_signing_public_key_base64_url: &str,
) -> Result<(), String> {
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    let signature_b64 = string_field(envelope, "sourceDeviceSignatureBase64Url")
        .ok_or_else(|| String::from("D2D recovery: нет подписи source-устройства."))?;
    let signature_bytes: [u8; 64] = decode_b64u(signature_b64)
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| String::from("D2D recovery: неверная подпись source-устройства."))?;

    let pk_bytes: [u8; 32] = decode_b64u(source_signing_public_key_base64_url)
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| {
            String::from("D2D recovery: неверный signing public key source-устройства.")
        })?;
    let verifying_key = VerifyingKey::from_bytes(&pk_bytes).map_err(|_| {
        String::from("D2D recovery: неверный signing public key source-устройства.")
    })?;

    let mut without_signature = envelope.clone();
    if let Some(obj) = without_signature.as_object_mut() {
        obj.remove("sourceDeviceSignatureBase64Url");
    }
    let payload = format!(
        "{D2D_SIGNATURE_DOMAIN} | {}",
        canonical_json(&without_signature)
    );

    verifying_key
        .verify(payload.as_bytes(), &Signature::from_bytes(&signature_bytes))
        .map_err(|_| String::from("D2D recovery: подпись source-устройства не прошла проверку."))
}

/// UUID-поле в строгой форме референс-билдера: lowercase hyphenated (D-form).
fn strict_uuid_field(obj: &Value, name: &str) -> Result<Uuid, String> {
    string_field(obj, name)
        .and_then(strict_lowercase_uuid)
        .ok_or_else(|| format!("D2D recovery: неверный {name}."))
}

fn strict_lowercase_uuid(raw: &str) -> Option<Uuid> {
    let parsed = Uuid::try_parse(raw).ok()?;
    // to_string() — всегда lowercase hyphenated: отвергает uppercase/braced/simple формы.
    (parsed.to_string() == raw).then_some(parsed)
}

fn string_field<'a>(obj: &'a Value, name: &str) -> Option<&'a str> {
    match obj.get(name)?.as_str() {
        Some(s) if !s.is_empty() => Some(s),
        _ => None,
    }
}

fn check_b64u_len(obj: &Value, name: &str, expected_len: usize) -> Result<(), String> {
    let raw = string_field(obj, name).ok_or_else(|| format!("D2D recovery: нет {name}."))?;
    match decode_b64u(raw) {
        Some(bytes) if bytes.len() == expected_len => Ok(()),
        _ => Err(format!("D2D recovery: неверный {name}.")),
    }
}

/// Строгий base64url без padding — как TS `fromBase64Url`/`toBase64Url`
/// (без .NET-послаблений wire-валидатора: конверт D2D не имеет C#-legacy).
fn decode_b64u(s: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(s).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use ed25519_dalek::{Signer, SigningKey};

    const USER: Uuid = uuid::uuid!("55555555-5555-4555-8555-555555555555");
    const SOURCE: Uuid = uuid::uuid!("66666666-6666-4666-8666-666666666666");
    const TARGET: Uuid = uuid::uuid!("77777777-7777-4777-8777-777777777777");
    const REQUEST: Uuid = uuid::uuid!("88888888-8888-4888-8888-888888888888");
    const EPOCH: Uuid = uuid::uuid!("11111111-1111-4111-8111-111111111111");

    fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&[9u8; 32])
    }

    /// Валидный по форме конверт, подписанный `signing_key()`.
    fn synthetic_envelope(mutate_after_sign: impl FnOnce(&mut Value)) -> Value {
        let target_agreement_id = device_agreement_public_key_id(&USER, &TARGET);
        let mut env = serde_json::json!({
            "version": 1,
            "recoveryRequestId": REQUEST.to_string(),
            "userUuid": USER.to_string(),
            "sourceDeviceUuid": SOURCE.to_string(),
            "targetDeviceUuid": TARGET.to_string(),
            "transferredKeyEpochIds": [EPOCH.to_string()],
            "targetAgreementPublicKeyId": target_agreement_id.to_string(),
            "ephemeralPublicKeyBase64Url": URL_SAFE_NO_PAD.encode([1u8; 32]),
            "saltBase64Url": URL_SAFE_NO_PAD.encode([2u8; 32]),
            "aead": { "name": "xchacha20-poly1305", "nonceBase64Url": URL_SAFE_NO_PAD.encode([3u8; 24]) },
            "ciphertextBase64Url": URL_SAFE_NO_PAD.encode([4u8; 48]),
        });
        let payload = format!("{D2D_SIGNATURE_DOMAIN} | {}", canonical_json(&env));
        let signature = signing_key().sign(payload.as_bytes());
        env.as_object_mut().unwrap().insert(
            "sourceDeviceSignatureBase64Url".into(),
            Value::String(URL_SAFE_NO_PAD.encode(signature.to_bytes())),
        );
        mutate_after_sign(&mut env);
        env
    }

    fn source_pk_b64() -> String {
        URL_SAFE_NO_PAD.encode(signing_key().verifying_key().to_bytes())
    }

    #[test]
    fn honest_envelope_passes_validation_and_signature() {
        let env = synthetic_envelope(|_| {});
        let summary = try_validate_d2d_recovery_envelope(&env).unwrap();
        assert_eq!(summary.user_uuid, USER);
        assert_eq!(summary.source_device_uuid, SOURCE);
        assert_eq!(summary.target_device_uuid, TARGET);
        assert_eq!(summary.recovery_request_id, REQUEST);
        assert_eq!(summary.transferred_key_epoch_ids, vec![EPOCH]);
        assert!(summary.canonical_json.contains("\"version\":1"));
        assert_eq!(
            verify_d2d_recovery_signature(&env, &source_pk_b64()),
            Ok(())
        );
    }

    #[test]
    fn unknown_top_level_field_is_rejected() {
        let env = synthetic_envelope(|e| {
            e.as_object_mut()
                .unwrap()
                .insert("extra".into(), Value::Bool(true));
        });
        assert_eq!(
            try_validate_d2d_recovery_envelope(&env).unwrap_err(),
            "D2D recovery: неизвестное поле extra."
        );
    }

    #[test]
    fn uppercase_uuid_form_is_rejected() {
        let env = synthetic_envelope(|e| {
            e.as_object_mut().unwrap().insert(
                "userUuid".into(),
                Value::String("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA".into()),
            );
        });
        assert_eq!(
            try_validate_d2d_recovery_envelope(&env).unwrap_err(),
            "D2D recovery: неверный userUuid."
        );
    }

    #[test]
    fn wrong_target_agreement_id_is_rejected() {
        let env = synthetic_envelope(|e| {
            e.as_object_mut().unwrap().insert(
                "targetAgreementPublicKeyId".into(),
                Value::String(REQUEST.to_string()),
            );
        });
        assert_eq!(
            try_validate_d2d_recovery_envelope(&env).unwrap_err(),
            "D2D recovery: targetAgreementPublicKeyId не соответствует target-устройству."
        );
    }

    #[test]
    fn unsorted_or_duplicate_epochs_are_rejected() {
        let env = synthetic_envelope(|e| {
            e.as_object_mut().unwrap().insert(
                "transferredKeyEpochIds".into(),
                serde_json::json!([EPOCH.to_string(), EPOCH.to_string()]),
            );
        });
        assert_eq!(
            try_validate_d2d_recovery_envelope(&env).unwrap_err(),
            "D2D recovery: transferredKeyEpochIds должны быть отсортированы и без дублей."
        );
    }

    #[test]
    fn excessive_epoch_count_is_rejected() {
        let env = synthetic_envelope(|e| {
            let epochs = (0..=MAX_TRANSFERRED_KEY_EPOCHS)
                .map(|i| Uuid::from_u128((i + 1) as u128).to_string())
                .collect::<Vec<_>>();
            e.as_object_mut()
                .unwrap()
                .insert("transferredKeyEpochIds".into(), serde_json::json!(epochs));
        });
        assert_eq!(
            try_validate_d2d_recovery_envelope(&env).unwrap_err(),
            "D2D recovery: transferredKeyEpochIds не должен превышать 64 элементов."
        );
    }

    #[test]
    fn tampered_field_after_signing_fails_signature() {
        let env = synthetic_envelope(|e| {
            e.as_object_mut()
                .unwrap()
                .insert("recoveryRequestId".into(), Value::String(EPOCH.to_string()));
        });
        // Форма остаётся валидной, но подпись больше не сходится (challenge binding).
        assert!(try_validate_d2d_recovery_envelope(&env).is_ok());
        assert_eq!(
            verify_d2d_recovery_signature(&env, &source_pk_b64()).unwrap_err(),
            "D2D recovery: подпись source-устройства не прошла проверку."
        );
    }

    #[test]
    fn foreign_signing_key_fails_signature() {
        let env = synthetic_envelope(|_| {});
        let foreign = SigningKey::from_bytes(&[13u8; 32]);
        let foreign_pk = URL_SAFE_NO_PAD.encode(foreign.verifying_key().to_bytes());
        assert_eq!(
            verify_d2d_recovery_signature(&env, &foreign_pk).unwrap_err(),
            "D2D recovery: подпись source-устройства не прошла проверку."
        );
    }

    #[test]
    fn same_source_and_target_devices_are_rejected() {
        let env = synthetic_envelope(|e| {
            e.as_object_mut()
                .unwrap()
                .insert("sourceDeviceUuid".into(), Value::String(TARGET.to_string()));
        });
        assert_eq!(
            try_validate_d2d_recovery_envelope(&env).unwrap_err(),
            "D2D recovery: sourceDeviceUuid и targetDeviceUuid не могут совпадать."
        );
    }
}
