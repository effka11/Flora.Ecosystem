//! Серверная структурная валидация FSCP wire — порт `Products/Flora.Social/FscpWireEnvelopeValidator.cs`.
//!
//! Functional product: `Products/FSCP`. Инвариант next-architecture.md §4.4: сервер **не расшифровывает**.
//! Golden: `Documents/test-vectors/fscp-wire-validator-v1.json`.

mod d2d_recovery;
mod group;
mod notification_preview;
mod organizer;

use base64::Engine as _;
use base64::alphabet;
use base64::engine::DecodePaddingMode;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use serde_json::Value;
use uuid::Uuid;

pub use d2d_recovery::{
    D2D_AAD_DOMAIN, D2D_SIGNATURE_DOMAIN, D2dRecoveryEnvelopeSummary,
    device_agreement_public_key_id, try_validate_d2d_recovery_envelope,
    verify_d2d_recovery_signature,
};
pub use fscp_contracts::{
    BOOTSTRAP_DEVICE_UUID, BOOTSTRAP_KEY_EPOCH_ID, GROUP_MAX_MEMBERS, GROUP_WIRE_PREFIX,
    ORGANIZER_WIRE_PREFIX, WIRE_PREFIX,
};
pub use group::{GroupWireSummary, try_validate_group_wire, verify_group_envelope_signature};
pub use notification_preview::{
    NOTIFICATION_PREVIEW_MAX_WIRE_BYTES, NOTIFICATION_PREVIEW_WIRE_PREFIX,
    NotificationPreviewSummary, try_validate_notification_preview,
};
pub use organizer::{
    OrganizerWireSummary, try_validate_organizer_wire, verify_organizer_signature,
};

/// Policy-ошибка device revocation (FSCP.md §Device revocation): отправка wire
/// с отозванным `senderDeviceUuid` отклоняется. Golden: fscp-revoked-device-v1.json
/// (`message_session_revoked_device_v1_failure`).
pub const REVOKED_SENDER_DEVICE_ERROR: &str =
    "FSCP wire: senderDeviceUuid отозван — требуется re-handshake с активным устройством.";
const MAX_WIRE_CHARS: usize = 200_000;
const MAX_INNER_UTF8_BYTES: usize = 120_000;
const MAX_RECIPIENT_ENVELOPE_CIPHER_BYTES: usize = 8 * 1024;
const MAX_MESSAGE_BODY_CIPHER_BYTES: usize = 64 * 1024;

const RKE_ALGORITHM: &str = "x25519-hkdf-xchacha20poly1305";
const AEAD_NAME: &str = "xchacha20-poly1305";
const FLORA_NAMESPACE_DNS_SCOPE: Uuid = uuid::uuid!("6ba7b810-9dad-11d1-80b4-00c04fd430c8");

fn uuid_v5_name(name: &str) -> Uuid {
    Uuid::new_v5(&FLORA_NAMESPACE_DNS_SCOPE, name.as_bytes())
}

/// Идентификатор DM 1:1 — паритет `dmConversationUuid` в `@flora/fscp`.
pub fn dm_conversation_uuid(user_a: &Uuid, user_b: &Uuid) -> Uuid {
    let a = user_a.to_string();
    let b = user_b.to_string();
    let (low, high) = if a <= b { (a, b) } else { (b, a) };
    uuid_v5_name(&format!("{low}|{high}|fscp-dm-v1"))
}

/// Идентификатор agreement public key — паритет `agreementPublicKeyId` в `@flora/fscp`.
pub fn agreement_public_key_id(user_uuid: &Uuid, key_epoch_id: &Uuid) -> Uuid {
    uuid_v5_name(&format!("{user_uuid}|{key_epoch_id}|agreement-v1"))
}

/// Legacy dual-ciphertext путь: оба поля обязаны быть одним и тем же wire.
/// Порт `TryValidateDualWire`.
pub fn try_validate_dual_wire(
    encrypted_for_receiver: &str,
    encrypted_for_sender: &str,
    authenticated_sender: Uuid,
    message_recipient: Uuid,
) -> Result<(), String> {
    if encrypted_for_receiver != encrypted_for_sender {
        return Err("Для FSCP v1 оба ciphertext должны совпадать (один wire на сообщение).".into());
    }
    try_validate_wire(
        encrypted_for_receiver,
        authenticated_sender,
        message_recipient,
    )
}

/// Структурная валидация `fscp1:base64url(JSON)`. Порт `TryValidateWire`;
/// порядок проверок и тексты ошибок — 1:1 с C#.
pub fn try_validate_wire(
    wire: &str,
    authenticated_sender: Uuid,
    message_recipient: Uuid,
) -> Result<(), String> {
    if wire.trim().is_empty() {
        return Err("Пустой FSCP wire.".into());
    }

    let wire = wire.trim();
    // C# string.Length — UTF-16 code units.
    if wire.encode_utf16().count() > MAX_WIRE_CHARS {
        return Err("FSCP wire слишком длинный.".into());
    }

    let Some(inner) = wire.strip_prefix(WIRE_PREFIX) else {
        return Err("Неверный префикс FSCP wire (ожидается fscp1:).".into());
    };

    let json_utf8 = from_base64_url_like_dotnet(inner, MAX_INNER_UTF8_BYTES)?;
    let root = parse_json_like_dotnet(&json_utf8)?;

    if !root.is_object() {
        return Err("FSCP wire: корень JSON должен быть объектом.".into());
    }

    if int_field(&root, "version") != Some(1) {
        return Err("FSCP wire: version должен быть 1.".into());
    }

    match guid_field(&root, "senderUserUuid") {
        Some(sender) if sender == authenticated_sender => {}
        _ => return Err("FSCP wire: senderUserUuid не совпадает с текущим пользователем.".into()),
    }

    let expected_conversation = dm_conversation_uuid(&authenticated_sender, &message_recipient);
    match guid_field(&root, "conversationUuid") {
        Some(conversation) if conversation == expected_conversation => {}
        _ => {
            return Err(
                "FSCP wire: conversationUuid не соответствует участникам сообщения.".into(),
            );
        }
    }

    let key_epoch = match guid_field(&root, "keyEpochId") {
        Some(epoch) if epoch == BOOTSTRAP_KEY_EPOCH_ID => epoch,
        _ => {
            return Err("FSCP wire: keyEpochId не поддерживается (ожидается bootstrap v1).".into());
        }
    };

    let recipients = match root.get("recipients").and_then(Value::as_array) {
        Some(arr) if arr.len() == 2 => arr,
        _ => {
            return Err(
                "FSCP wire: recipients должен быть массивом из двух элементов (1:1).".into(),
            );
        }
    };

    let mut seen: Vec<Uuid> = Vec::with_capacity(2);
    for r in recipients {
        if !r.is_object() {
            return Err("FSCP wire: элемент recipients должен быть объектом.".into());
        }
        let Some(ru) = guid_field(r, "userUuid") else {
            return Err("FSCP wire: неверный userUuid в recipients.".into());
        };
        if !seen.contains(&ru) {
            seen.push(ru);
        }
    }

    if !seen.contains(&authenticated_sender) || !seen.contains(&message_recipient) {
        return Err("FSCP wire: recipients должны включать отправителя и получателя.".into());
    }

    for r in recipients {
        // Недостижимо: первый проход уже проверил userUuid (в C# здесь остаётся пустая ошибка).
        let ru = guid_field(r, "userUuid").ok_or(String::new())?;

        match r.get("deviceUuid").and_then(Value::as_str) {
            Some(device) if !device.trim().is_empty() => {
                if parse_guid_like(device).is_none() {
                    return Err("FSCP wire: неверный deviceUuid.".into());
                }
            }
            _ => return Err("FSCP wire: отсутствует deviceUuid у получателя.".into()),
        }

        let rk = match r.get("recipientKeyEnvelope") {
            Some(rk) if rk.is_object() => rk,
            _ => return Err("FSCP wire: отсутствует recipientKeyEnvelope.".into()),
        };

        if int_field(rk, "version") != Some(1) {
            return Err("FSCP wire: recipientKeyEnvelope.version должен быть 1.".into());
        }

        if string_field(rk, "algorithm") != Some(RKE_ALGORITHM) {
            return Err("FSCP wire: неподдерживаемый алгоритм RKE.".into());
        }

        if let Some(pre) = rk.get("preKeyId")
            && !pre.is_null()
        {
            return Err("FSCP wire: preKeyId должен быть null в v1.".into());
        }

        let Some(pk_id) =
            string_field(rk, "recipientAgreementPublicKeyId").and_then(parse_guid_like)
        else {
            return Err("FSCP wire: неверный recipientAgreementPublicKeyId.".into());
        };

        let expected_pk_id = agreement_public_key_id(&ru, &key_epoch);
        if pk_id != expected_pk_id {
            return Err(
                "FSCP wire: recipientAgreementPublicKeyId не соответствует пользователю и эпохе."
                    .into(),
            );
        }

        let Some(eph) = string_field(rk, "ephemeralPublicKeyBase64Url") else {
            return Err("FSCP wire: нет ephemeralPublicKeyBase64Url.".into());
        };
        if from_base64_url_like_dotnet(eph, 64)?.len() != 32 {
            return Err("FSCP wire: неверный ephemeralPublicKeyBase64Url.".into());
        }

        let Some(salt) = string_field(rk, "saltBase64Url") else {
            return Err("FSCP wire: нет saltBase64Url.".into());
        };
        if from_base64_url_like_dotnet(salt, 64)?.len() != 32 {
            return Err("FSCP wire: неверный saltBase64Url.".into());
        }

        let aead = match rk.get("aead") {
            Some(aead) if aead.is_object() => aead,
            _ => return Err("FSCP wire: отсутствует aead в recipientKeyEnvelope.".into()),
        };

        if string_field(aead, "name") != Some(AEAD_NAME) {
            return Err("FSCP wire: неподдерживаемый AEAD в RKE.".into());
        }

        let Some(nonce) = string_field(aead, "nonceBase64Url") else {
            return Err("FSCP wire: нет nonce RKE.".into());
        };
        if from_base64_url_like_dotnet(nonce, 32)?.len() != 24 {
            return Err("FSCP wire: неверный nonce RKE.".into());
        }

        let Some(rct) = string_field(rk, "ciphertextBase64Url") else {
            return Err("FSCP wire: нет ciphertext RKE.".into());
        };
        if from_base64_url_like_dotnet(rct, MAX_RECIPIENT_ENVELOPE_CIPHER_BYTES)?.len() < 16 {
            return Err("FSCP wire: неверный ciphertext RKE.".into());
        }
    }

    let Some(body_ct) = string_field(&root, "ciphertextBase64Url") else {
        return Err("FSCP wire: нет ciphertext тела сообщения.".into());
    };
    if from_base64_url_like_dotnet(body_ct, MAX_MESSAGE_BODY_CIPHER_BYTES)?.len() < 16 {
        return Err("FSCP wire: неверный ciphertext тела сообщения.".into());
    }

    let body_aead = match root.get("aead") {
        Some(aead) if aead.is_object() => aead,
        _ => return Err("FSCP wire: отсутствует верхнеуровневый aead.".into()),
    };

    if string_field(body_aead, "name") != Some(AEAD_NAME) {
        return Err("FSCP wire: неподдерживаемый AEAD тела сообщения.".into());
    }

    let Some(body_nonce) = string_field(body_aead, "nonceBase64Url") else {
        return Err("FSCP wire: нет nonce тела сообщения.".into());
    };
    if from_base64_url_like_dotnet(body_nonce, 32)?.len() != 24 {
        return Err("FSCP wire: неверный nonce тела сообщения.".into());
    }

    match root
        .get("senderSigningPublicKeyBase64Url")
        .and_then(Value::as_str)
    {
        Some(sign_pk) if !sign_pk.trim().is_empty() => {
            if from_base64_url_like_dotnet(sign_pk, 64)?.len() != 32 {
                return Err("FSCP wire: неверный senderSigningPublicKeyBase64Url.".into());
            }
        }
        _ => {
            return Err(
                "FSCP wire: требуется senderSigningPublicKeyBase64Url (Ed25519, 32 байта).".into(),
            );
        }
    }

    let Some(sig) = string_field(&root, "senderSignatureBase64Url") else {
        return Err("FSCP wire: нет подписи отправителя.".into());
    };
    if from_base64_url_like_dotnet(sig, 96)?.len() != 64 {
        return Err("FSCP wire: неверная подпись отправителя.".into());
    }

    Ok(())
}

/// Криптографическая проверка Ed25519-подписи конверта (defense-in-depth, errata-5).
///
/// Аддитивная ступень ПОСЛЕ замороженного валидатора формы [`try_validate_wire`]
/// (тот остаётся байт-в-байт с golden `fscp-wire-validator-v1.json` и не меняется).
/// Сервер по-прежнему не расшифровывает содержимое (§4.4) — проверяется только
/// подпись над canonical JSON конверта, что закрывает подмену/порчу конверта
/// на пути клиент→сервер и хранение мусора под чужим ключом подписи.
///
/// Вызывать только после успешного `try_validate_wire` (форма гарантирует
/// присутствие и длины ключа/подписи).
pub fn verify_envelope_signature(wire: &str) -> Result<(), String> {
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    let wire = wire.trim();
    let Some(inner) = wire.strip_prefix(WIRE_PREFIX) else {
        return Err("Неверный префикс FSCP wire (ожидается fscp1:).".into());
    };
    let json_utf8 = from_base64_url_like_dotnet(inner, MAX_INNER_UTF8_BYTES)?;
    let root = parse_json_like_dotnet(&json_utf8)?;

    let Some(pk_b64) = string_field(&root, "senderSigningPublicKeyBase64Url") else {
        return Err(
            "FSCP wire: требуется senderSigningPublicKeyBase64Url (Ed25519, 32 байта).".into(),
        );
    };
    let Some(sig_b64) = string_field(&root, "senderSignatureBase64Url") else {
        return Err("FSCP wire: нет подписи отправителя.".into());
    };

    let pk_bytes: [u8; 32] = from_base64_url_like_dotnet(pk_b64, 64)?
        .try_into()
        .map_err(|_| String::from("FSCP wire: неверный senderSigningPublicKeyBase64Url."))?;
    let sig_bytes: [u8; 64] = from_base64_url_like_dotnet(sig_b64, 96)?
        .try_into()
        .map_err(|_| String::from("FSCP wire: неверная подпись отправителя."))?;

    let mut no_sig = root;
    if let Some(obj) = no_sig.as_object_mut() {
        obj.remove("senderSignatureBase64Url");
    }
    let payload = format!(
        "flora.messaging.envelope-signature.v1 | {}",
        canonical_json(&no_sig)
    );

    let vk = VerifyingKey::from_bytes(&pk_bytes)
        .map_err(|_| String::from("FSCP wire: неверный senderSigningPublicKeyBase64Url."))?;
    vk.verify(payload.as_bytes(), &Signature::from_bytes(&sig_bytes))
        .map_err(|_| String::from("FSCP wire: подпись конверта Ed25519 не прошла проверку."))
}

/// Canonical JSON конверта (Documents/fscp/FSCP.md §Canonical encoding) — байт-паритет
/// с TS `canonicalJson.ts` и паритет-харнессом `flora_parity::canonical_json`:
/// рекурсивная сортировка ключей объектов, массивы в исходном порядке,
/// экранирование строк как `JSON.stringify`. Ключи v1 — ASCII, поэтому байтовый
/// порядок `str::cmp` совпадает с UTF-16 code-unit порядком TS.
pub fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    write_canonical(value, &mut out);
    out
}

fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&n.to_string()),
        Value::String(s) => out.push_str(&escape_like_json_stringify(s)),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_unstable();
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&escape_like_json_stringify(k));
                out.push(':');
                write_canonical(&map[k.as_str()], out);
            }
            out.push('}');
        }
    }
}

/// `JSON.stringify` для строки: короткие формы `\" \\ \b \t \n \f \r`,
/// прочие управляющие — `\u00xx`, не-ASCII — как есть (UTF-8).
fn escape_like_json_stringify(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{0C}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Извлекает `senderDeviceUuid` конверта для policy-проверок device revocation
/// (FSCP.md §Device revocation). Вызывать после `try_validate_wire` (форма
/// гарантирует присутствие/валидность поля); сообщения об ошибках — от структурного слоя.
pub fn extract_sender_device_uuid(wire: &str) -> Result<Uuid, String> {
    let wire = wire.trim();
    let Some(inner) = wire.strip_prefix(WIRE_PREFIX) else {
        return Err("Неверный префикс FSCP wire (ожидается fscp1:).".into());
    };
    let json_utf8 = from_base64_url_like_dotnet(inner, MAX_INNER_UTF8_BYTES)?;
    let root = parse_json_like_dotnet(&json_utf8)?;
    guid_field(&root, "senderDeviceUuid")
        .ok_or_else(|| String::from("FSCP wire: неверный senderDeviceUuid."))
}

/// Извлекает клиентский `messageUuid` из подписанного wire. Это отдельный id от
/// persisted message UUID, который создаёт Messaging repository.
pub fn extract_message_uuid(wire: &str) -> Result<Uuid, String> {
    let wire = wire.trim();
    let Some(inner) = wire.strip_prefix(WIRE_PREFIX) else {
        return Err("Неверный префикс FSCP wire (ожидается fscp1:).".into());
    };
    let json_utf8 = from_base64_url_like_dotnet(inner, MAX_INNER_UTF8_BYTES)?;
    let root = parse_json_like_dotnet(&json_utf8)?;
    guid_field(&root, "messageUuid").ok_or_else(|| String::from("FSCP wire: неверный messageUuid."))
}

/// Извлекает UUID собеседника (участник ≠ `authenticated_sender`) без полной валидации.
/// Порт `TryExtractReceiver`; после определения получателя вызывается `try_validate_dual_wire`.
pub fn try_extract_receiver(wire: &str, authenticated_sender: Uuid) -> Result<Uuid, String> {
    if wire.trim().is_empty() || !wire.trim_start().starts_with(WIRE_PREFIX) {
        return Err("Неверный префикс FSCP wire.".into());
    }

    let inner = &wire.trim()[WIRE_PREFIX.len()..];
    let json_utf8 = from_base64_url_like_dotnet(inner, MAX_INNER_UTF8_BYTES)?;
    let root = parse_json_like_dotnet(&json_utf8)?;

    match guid_field(&root, "senderUserUuid") {
        Some(sender) if sender == authenticated_sender => {}
        _ => return Err("FSCP wire: senderUserUuid не совпадает с текущим пользователем.".into()),
    }

    let recipients = match root.get("recipients").and_then(Value::as_array) {
        Some(arr) if arr.len() == 2 => arr,
        _ => return Err("FSCP wire: recipients должен быть массивом из двух элементов.".into()),
    };

    for r in recipients {
        let Some(ru) = guid_field(r, "userUuid") else {
            continue;
        };
        if ru != authenticated_sender {
            return Ok(ru);
        }
    }

    Err("FSCP wire: не удалось найти получателя в recipients.".into())
}

/// base64url → байты с семантикой `Convert.FromBase64String`:
/// trim, `-`→`+`, `_`→`/`, добивка `=` по длине, допуск ASCII-пробелов внутри,
/// каноничная длина padding, ненулевые хвостовые биты не отвергаются.
fn from_base64_url_like_dotnet(chars: &str, max_decoded_bytes: usize) -> Result<Vec<u8>, String> {
    // Паритет по конфигурации: .NET требует каноничный padding, но не проверяет хвостовые биты.
    const DOTNET_LIKE: GeneralPurpose = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_allow_trailing_bits(true)
            .with_decode_padding_mode(DecodePaddingMode::RequireCanonical),
    );

    let mut s = chars.trim().replace('-', "+").replace('_', "/");
    match s.len() % 4 {
        2 => s.push_str("=="),
        3 => s.push('='),
        _ => {}
    }
    // Convert.FromBase64String игнорирует пробельные символы в любом месте строки.
    s.retain(|c| !matches!(c, ' ' | '\t' | '\r' | '\n'));

    let bytes = DOTNET_LIKE
        .decode(s)
        .map_err(|_| String::from("Некорректный base64url."))?;
    if bytes.len() > max_decoded_bytes {
        return Err("Декодированные данные превышают лимит.".into());
    }
    Ok(bytes)
}

/// `JsonDocument.Parse`: UTF-8 BOM допускается и пропускается.
fn parse_json_like_dotnet(json_utf8: &[u8]) -> Result<Value, String> {
    let body = json_utf8
        .strip_prefix(&[0xEF, 0xBB, 0xBF][..])
        .unwrap_or(json_utf8);
    serde_json::from_slice(body).map_err(|_| String::from("FSCP wire: невалидный JSON."))
}

/// `TryGetInt`: свойство есть, JSON-число, целое (нецелые и вне i64 → None).
fn int_field(obj: &Value, name: &str) -> Option<i64> {
    obj.get(name)?.as_i64()
}

/// `TryGetString`: свойство есть, строка, непустая.
fn string_field<'a>(obj: &'a Value, name: &str) -> Option<&'a str> {
    match obj.get(name)?.as_str() {
        Some(s) if !s.is_empty() => Some(s),
        _ => None,
    }
}

/// `TryGetGuidString`: строковое свойство + `Guid.TryParse`.
fn guid_field(obj: &Value, name: &str) -> Option<Uuid> {
    string_field(obj, name).and_then(parse_guid_like)
}

/// `Guid.TryParse`: форматы N (32 hex), D (8-4-4-4-12), B `{D}`, P `(D)`;
/// регистронезависимо, с обрезкой пробелов. Отличия от uuid-crate по умолчанию:
/// urn-форму не принимаем (C# отвергает); экзотическую X-форму `{0x..,0x..}` C# принимает,
/// Rust — нет (осознанное ужесточение, реальные клиенты шлют lowercase D).
fn parse_guid_like(s: &str) -> Option<Uuid> {
    let t = s.trim();
    let (body, braced) = if let Some(b) = t.strip_prefix('{').and_then(|r| r.strip_suffix('}')) {
        (b, true)
    } else if let Some(b) = t.strip_prefix('(').and_then(|r| r.strip_suffix(')')) {
        (b, true)
    } else {
        (t, false)
    };

    let is_d_form = body.len() == 36 && body.as_bytes().get(8) == Some(&b'-');
    let is_n_form = body.len() == 32;
    if braced && !is_d_form {
        return None; // B/P допускают только D-форму внутри скобок.
    }
    if !braced && !is_d_form && !is_n_form {
        return None;
    }
    Uuid::try_parse(body).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Полный паритет с C#-эталоном — golden-вектор fscp-wire-validator-v1.json,
    // consumer в Tests/parity/tests/fscp_wire_vectors.rs. Здесь — инварианты хелперов.

    #[test]
    fn fscp_uuid_derivations_match_golden_values() {
        let user_a = uuid::uuid!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        let user_b = uuid::uuid!("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
        assert_eq!(
            dm_conversation_uuid(&user_a, &user_b),
            uuid::uuid!("17caed55-ccf4-5fd2-8dc6-286a38ddea14")
        );
        assert_eq!(
            dm_conversation_uuid(&user_b, &user_a),
            uuid::uuid!("17caed55-ccf4-5fd2-8dc6-286a38ddea14")
        );
        assert_eq!(
            agreement_public_key_id(&user_a, &BOOTSTRAP_KEY_EPOCH_ID),
            uuid::uuid!("23971987-91da-5b01-a5d7-4b857b80031c")
        );
    }

    #[test]
    fn base64_helper_matches_dotnet_quirks() {
        // Каноничный base64url без padding.
        assert_eq!(
            from_base64_url_like_dotnet("AQID", 16).unwrap(),
            vec![1, 2, 3]
        );
        // Достройка padding по длине; пробелы внутри игнорируются (.NET-семантика).
        assert_eq!(
            from_base64_url_like_dotnet("AQ ID", 16).unwrap(),
            vec![1, 2, 3]
        );
        // Недопустимые символы.
        assert_eq!(
            from_base64_url_like_dotnet("%%%", 16).unwrap_err(),
            "Некорректный base64url."
        );
        // Лимит декодированных байт.
        assert_eq!(
            from_base64_url_like_dotnet("AQIDBA", 3).unwrap_err(),
            "Декодированные данные превышают лимит."
        );
    }

    #[test]
    fn guid_parser_accepts_dotnet_formats() {
        let expected = uuid::uuid!("55555555-5555-4555-8555-555555555555");
        let upper = "55555555-5555-4555-8555-555555555555".to_uppercase();
        for form in [
            "55555555-5555-4555-8555-555555555555",
            "55555555555545558555555555555555",
            "{55555555-5555-4555-8555-555555555555}",
            "(55555555-5555-4555-8555-555555555555)",
            " 55555555-5555-4555-8555-555555555555 ",
            upper.as_str(),
        ] {
            assert_eq!(parse_guid_like(form), Some(expected), "форма {form:?}");
        }
        // Как Guid.TryParse: urn и скобки вокруг N-формы не принимаются.
        assert_eq!(
            parse_guid_like("urn:uuid:55555555-5555-4555-8555-555555555555"),
            None
        );
        assert_eq!(parse_guid_like("{55555555555545558555555555555555}"), None);
        assert_eq!(parse_guid_like("не uuid"), None);
    }

    #[test]
    fn wire_longer_than_limit_is_rejected() {
        let wire = format!("{WIRE_PREFIX}{}", "A".repeat(MAX_WIRE_CHARS));
        assert_eq!(
            try_validate_wire(&wire, Uuid::nil(), Uuid::nil()).unwrap_err(),
            "FSCP wire слишком длинный."
        );
    }

    // ── verify_envelope_signature (errata-5, аддитивная криптоступень) ──────
    // Golden-паритет с TS/python — Tests/parity/tests/fscp_transcript_vectors.rs;
    // здесь — самодостаточные синтетические проверки.

    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use ed25519_dalek::{Signer, SigningKey};

    fn synthetic_signed_wire(mutate_after_sign: impl FnOnce(&mut serde_json::Value)) -> String {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pk_b64 = URL_SAFE_NO_PAD.encode(sk.verifying_key().to_bytes());
        let mut env = serde_json::json!({
            "version": 1,
            "messageUuid": "33333333-3333-4333-8333-333333333333",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "recipients": [{"userUuid": "AA"}, {"userUuid": "bb"}],
            "senderSigningPublicKeyBase64Url": pk_b64,
        });
        let payload = format!(
            "flora.messaging.envelope-signature.v1 | {}",
            canonical_json(&env)
        );
        let sig = sk.sign(payload.as_bytes());
        env.as_object_mut().unwrap().insert(
            "senderSignatureBase64Url".into(),
            serde_json::Value::String(URL_SAFE_NO_PAD.encode(sig.to_bytes())),
        );
        mutate_after_sign(&mut env);
        format!(
            "{WIRE_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_string(&env).unwrap())
        )
    }

    #[test]
    fn envelope_signature_verifies_for_honest_wire() {
        let wire = synthetic_signed_wire(|_| {});
        assert_eq!(verify_envelope_signature(&wire), Ok(()));
    }

    #[test]
    fn tampered_field_after_signing_is_rejected() {
        let wire = synthetic_signed_wire(|env| {
            env.as_object_mut().unwrap().insert(
                "createdAt".into(),
                serde_json::Value::String("2026-02-02T00:00:00.000Z".into()),
            );
        });
        assert_eq!(
            verify_envelope_signature(&wire).unwrap_err(),
            "FSCP wire: подпись конверта Ed25519 не прошла проверку."
        );
    }

    #[test]
    fn tampered_signature_is_rejected() {
        let wire = synthetic_signed_wire(|env| {
            let obj = env.as_object_mut().unwrap();
            let sig = obj["senderSignatureBase64Url"].as_str().unwrap();
            let mut bytes = URL_SAFE_NO_PAD.decode(sig).unwrap();
            bytes[0] ^= 0x01;
            obj.insert(
                "senderSignatureBase64Url".into(),
                serde_json::Value::String(URL_SAFE_NO_PAD.encode(bytes)),
            );
        });
        assert_eq!(
            verify_envelope_signature(&wire).unwrap_err(),
            "FSCP wire: подпись конверта Ed25519 не прошла проверку."
        );
    }

    #[test]
    fn missing_signing_key_is_rejected() {
        let wire = synthetic_signed_wire(|env| {
            env.as_object_mut()
                .unwrap()
                .remove("senderSigningPublicKeyBase64Url");
        });
        assert_eq!(
            verify_envelope_signature(&wire).unwrap_err(),
            "FSCP wire: требуется senderSigningPublicKeyBase64Url (Ed25519, 32 байта)."
        );
    }
}
