//! Серверная структурная валидация FSCP wire — порт `Products/Flora.Social/FscpWireEnvelopeValidator.cs`.
//!
//! Инвариант next-architecture.md §4.4: сервер **не расшифровывает** конверт, только форма.
//! Поведение (accept/reject, порядок проверок и **точные строки ошибок**) заморожено на время
//! миграции и воспроизводится байт-в-байт; эталон закреплён golden-вектором
//! `docs/test-vectors/fscp-wire-validator-v1.json` (consumer: `tests/parity/tests/fscp_wire_vectors.rs`
//! и C# `tests/Flora.GoldenVectors/FscpWireValidatorVectors.cs`).
//! Спецификация: `docs/fscp/FSCP.md` §Server-side validation, §Algorithms C.
//!
//! Известные осознанные отличия от C# на патологических входах (не покрываются контрактом):
//! - дубликаты ключей JSON: `JsonElement.TryGetProperty` берёт первое вхождение, `serde_json` —
//!   последнее (клиенты Flora дубликатов не выпускают);
//! - `TryExtractReceiver` в C# кидает `InvalidOperationException` (→ 500), если корень JSON —
//!   не объект; Rust возвращает ошибку валидации (паника недопустима).

use base64::Engine as _;
use base64::alphabet;
use base64::engine::DecodePaddingMode;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use serde_json::Value;
use uuid::Uuid;

pub const WIRE_PREFIX: &str = "fscp1:";

/// Bootstrap key epoch FSCP v1 (`FSCP_BOOTSTRAP_KEY_EPOCH_ID` в client-core,
/// `FscpWireEnvelopeValidator.BootstrapKeyEpochIdString` в C#).
pub const BOOTSTRAP_KEY_EPOCH_ID: Uuid = uuid::uuid!("00000000-0000-4000-8000-000000000001");

const MAX_WIRE_CHARS: usize = 200_000;
const MAX_INNER_UTF8_BYTES: usize = 120_000;
const MAX_RECIPIENT_ENVELOPE_CIPHER_BYTES: usize = 8 * 1024;
const MAX_MESSAGE_BODY_CIPHER_BYTES: usize = 64 * 1024;

const RKE_ALGORITHM: &str = "x25519-hkdf-xchacha20poly1305";
const AEAD_NAME: &str = "xchacha20-poly1305";

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

    let expected_conversation =
        flora_shared::uuid_v5::dm_conversation_uuid(&authenticated_sender, &message_recipient);
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

        let expected_pk_id = flora_shared::uuid_v5::agreement_public_key_id(&ru, &key_epoch);
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
    // consumer в tests/parity/tests/fscp_wire_vectors.rs. Здесь — инварианты хелперов.

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
}
