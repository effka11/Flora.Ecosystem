//! JWT HS256 — порт `JwtTokenService.cs` + валидационных параметров `FloraJwtExtensions.cs`.
//!
//! Инварианты (next-architecture.md §4.1): HS256, issuer `Flora.Auth`, audience
//! `Flora.Ecosystem`, clock skew 60 с, секрет ≥32 символов (UTF-8 байты — ключ HMAC).
//! Wire-набор клеймов зафиксирован вектором `docs/test-vectors/backend-parity/jwt-hs256-v1.json`:
//! `JwtSecurityToken` пишет клеймы без outbound-маппинга, поэтому дубли идут с полными
//! URI-именами схем (`.../nameidentifier`, `.../emailaddress`) — воспроизводим 1:1.
//!
//! Реализация на `hmac`+`sha2` (RustCrypto): без C-зависимостей — совместимо со статической
//! сборкой musl; поверхность алгоритмов сужена до единственного используемого HS256.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// Клейм-имена .NET `ClaimTypes`, попадающие в wire-токен (см. golden-вектор).
const CLAIM_NAME_IDENTIFIER: &str =
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier";
const CLAIM_EMAIL_ADDRESS: &str =
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress";

/// Допуск часов при валидации lifetime — `ClockSkew = TimeSpan.FromMinutes(1)`.
pub const CLOCK_SKEW_SECONDS: i64 = 60;

/// Секция `Jwt` конфигурации — те же ключи, что у `JwtOptions.cs`.
#[derive(Debug, Clone)]
pub struct JwtOptions {
    pub issuer: String,
    pub audience: String,
    pub secret: String,
    pub access_token_minutes: i64,
    pub refresh_token_days: i64,
}

impl JwtOptions {
    pub const SECTION_NAME: &'static str = "Jwt";

    /// Чтение секции с дефолтами `JwtOptions.cs`. Валидацию силы секрета делает
    /// продукт (flora-social), как `AddFloraJwtBearer` в C#.
    pub fn from_config(cfg: &flora_shared::config::FloraConfig) -> Self {
        Self {
            issuer: cfg.get_non_empty("Jwt:Issuer").unwrap_or("Flora.Auth").to_string(),
            audience: cfg
                .get_non_empty("Jwt:Audience")
                .unwrap_or("Flora.Ecosystem")
                .to_string(),
            secret: cfg.get("Jwt:Secret").unwrap_or_default().to_string(),
            access_token_minutes: cfg.get_i64("Jwt:AccessTokenMinutes").unwrap_or(15),
            refresh_token_days: cfg.get_i64("Jwt:RefreshTokenDays").unwrap_or(7),
        }
    }
}

/// Полезная нагрузка access-токена в порядке и составе `JwtTokenService.CreateTokenPair`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessTokenClaims {
    pub sub: String,
    pub email: String,
    pub jti: String,
    /// unix-секунды UTC.
    pub expires_at: i64,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum JwtError {
    #[error("токен не в формате JWS Compact (header.payload.signature)")]
    Malformed,
    #[error("недопустимый алгоритм: ожидается HS256")]
    Algorithm,
    #[error("подпись не совпадает")]
    Signature,
    #[error("токен просрочен либо ещё не действует")]
    Lifetime,
    #[error("issuer не совпадает")]
    Issuer,
    #[error("audience не совпадает")]
    Audience,
    #[error("отсутствует обязательный клейм: {0}")]
    MissingClaim(&'static str),
}

/// Выпуск access-токена — байтовый аналог `CreateTokenPair` (тот же состав и порядок клеймов).
pub fn issue_access_token(options: &JwtOptions, claims: &AccessTokenClaims) -> String {
    let header = r#"{"alg":"HS256","typ":"JWT"}"#;

    // serde_json с preserve_order сохраняет порядок вставки — как JwtPayload в .NET.
    let mut payload = serde_json::Map::new();
    payload.insert("sub".into(), claims.sub.clone().into());
    payload.insert("email".into(), claims.email.clone().into());
    payload.insert("jti".into(), claims.jti.clone().into());
    payload.insert(CLAIM_NAME_IDENTIFIER.into(), claims.sub.clone().into());
    payload.insert(CLAIM_EMAIL_ADDRESS.into(), claims.email.clone().into());
    payload.insert("exp".into(), claims.expires_at.into());
    payload.insert("iss".into(), options.issuer.clone().into());
    payload.insert("aud".into(), options.audience.clone().into());
    let payload = serde_json::Value::Object(payload).to_string();

    let signing_input = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(header.as_bytes()),
        URL_SAFE_NO_PAD.encode(payload.as_bytes()),
    );
    let signature = sign(options.secret.as_bytes(), signing_input.as_bytes());
    format!("{signing_input}.{}", URL_SAFE_NO_PAD.encode(signature))
}

/// Валидация — семантика `TokenValidationParameters` из `FloraJwtExtensions.cs`:
/// подпись, issuer, audience, lifetime (exp обязателен, nbf — если присутствует)
/// с допуском [`CLOCK_SKEW_SECONDS`].
pub fn validate_access_token(
    options: &JwtOptions,
    token: &str,
    now_unix: i64,
) -> Result<AccessTokenClaims, JwtError> {
    let mut parts = token.split('.');
    let (Some(header_b64), Some(payload_b64), Some(signature_b64), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(JwtError::Malformed);
    };

    let header = decode_json_part(header_b64)?;
    if header.get("alg").and_then(|v| v.as_str()) != Some("HS256") {
        return Err(JwtError::Algorithm);
    }

    let signature = URL_SAFE_NO_PAD
        .decode(signature_b64)
        .map_err(|_| JwtError::Malformed)?;
    let signing_input = format!("{header_b64}.{payload_b64}");
    let mut mac = HmacSha256::new_from_slice(options.secret.as_bytes())
        .expect("HMAC принимает ключ любой длины");
    mac.update(signing_input.as_bytes());
    mac.verify_slice(&signature).map_err(|_| JwtError::Signature)?;

    let payload = decode_json_part(payload_b64)?;

    // Lifetime: RequireExpirationTime=true по умолчанию в .NET — exp обязателен.
    let expires_at = payload
        .get("exp")
        .and_then(as_unix_seconds)
        .ok_or(JwtError::MissingClaim("exp"))?;
    if expires_at < now_unix - CLOCK_SKEW_SECONDS {
        return Err(JwtError::Lifetime);
    }
    if let Some(not_before) = payload.get("nbf").and_then(as_unix_seconds)
        && not_before > now_unix + CLOCK_SKEW_SECONDS
    {
        return Err(JwtError::Lifetime);
    }

    if payload.get("iss").and_then(|v| v.as_str()) != Some(options.issuer.as_str()) {
        return Err(JwtError::Issuer);
    }
    match payload.get("aud") {
        Some(serde_json::Value::String(aud)) if aud == &options.audience => {}
        Some(serde_json::Value::Array(auds))
            if auds.iter().any(|a| a.as_str() == Some(options.audience.as_str())) => {}
        _ => return Err(JwtError::Audience),
    }

    Ok(AccessTokenClaims {
        sub: required_string(&payload, "sub")?,
        email: required_string(&payload, "email")?,
        jti: required_string(&payload, "jti")?,
        expires_at,
    })
}

fn sign(secret: &[u8], input: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC принимает ключ любой длины");
    mac.update(input);
    mac.finalize().into_bytes().to_vec()
}

fn decode_json_part(b64: &str) -> Result<serde_json::Value, JwtError> {
    let bytes = URL_SAFE_NO_PAD.decode(b64).map_err(|_| JwtError::Malformed)?;
    serde_json::from_slice(&bytes).map_err(|_| JwtError::Malformed)
}

fn as_unix_seconds(value: &serde_json::Value) -> Option<i64> {
    value.as_i64().or_else(|| value.as_f64().map(|f| f as i64))
}

fn required_string(
    payload: &serde_json::Value,
    claim: &'static str,
) -> Result<String, JwtError> {
    payload
        .get(claim)
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or(JwtError::MissingClaim(claim))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> JwtOptions {
        JwtOptions {
            issuer: "Flora.Auth".into(),
            audience: "Flora.Ecosystem".into(),
            secret: "unit-test-secret-0123456789-0123456789".into(),
            access_token_minutes: 15,
            refresh_token_days: 7,
        }
    }

    fn claims(expires_at: i64) -> AccessTokenClaims {
        AccessTokenClaims {
            sub: "7f2c9a4e-1b3d-4c5e-8f6a-2d1e0b9c8a7f".into(),
            email: "unit@flora.local".into(),
            jti: "0123456789abcdef0123456789abcdef".into(),
            expires_at,
        }
    }

    const NOW: i64 = 1_800_000_000;

    #[test]
    fn roundtrip_issue_validate() {
        let token = issue_access_token(&options(), &claims(NOW + 900));
        let validated = validate_access_token(&options(), &token, NOW).unwrap();
        assert_eq!(validated, claims(NOW + 900));
    }

    #[test]
    fn wire_payload_matches_dotnet_claim_set_and_order() {
        let token = issue_access_token(&options(), &claims(NOW + 900));
        let payload_b64 = token.split('.').nth(1).unwrap();
        let payload = decode_json_part(payload_b64).unwrap();
        let keys: Vec<&str> = payload.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            vec![
                "sub",
                "email",
                "jti",
                CLAIM_NAME_IDENTIFIER,
                CLAIM_EMAIL_ADDRESS,
                "exp",
                "iss",
                "aud",
            ],
        );
    }

    #[test]
    fn rejects_wrong_secret() {
        let token = issue_access_token(&options(), &claims(NOW + 900));
        let other = JwtOptions {
            secret: "another-secret-0123456789-0123456789".into(),
            ..options()
        };
        assert_eq!(validate_access_token(&other, &token, NOW), Err(JwtError::Signature));
    }

    #[test]
    fn lifetime_respects_one_minute_clock_skew() {
        let just_expired = issue_access_token(&options(), &claims(NOW - CLOCK_SKEW_SECONDS));
        assert!(validate_access_token(&options(), &just_expired, NOW).is_ok());

        let too_old = issue_access_token(&options(), &claims(NOW - CLOCK_SKEW_SECONDS - 1));
        assert_eq!(
            validate_access_token(&options(), &too_old, NOW),
            Err(JwtError::Lifetime),
        );
    }

    #[test]
    fn rejects_wrong_issuer_or_audience() {
        let token = issue_access_token(&options(), &claims(NOW + 900));
        let wrong_issuer = JwtOptions { issuer: "Evil".into(), ..options() };
        assert_eq!(validate_access_token(&wrong_issuer, &token, NOW), Err(JwtError::Issuer));
        let wrong_audience = JwtOptions { audience: "Evil".into(), ..options() };
        assert_eq!(
            validate_access_token(&wrong_audience, &token, NOW),
            Err(JwtError::Audience),
        );
    }

    #[test]
    fn rejects_alg_none_even_with_valid_signature_shape() {
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"none","typ":"JWT"}"#);
        let payload = URL_SAFE_NO_PAD.encode(br#"{"exp":9999999999}"#);
        let forged = format!("{header}.{payload}.");
        assert_eq!(
            validate_access_token(&options(), &forged, NOW),
            Err(JwtError::Algorithm),
        );
    }

    #[test]
    fn rejects_tampered_payload() {
        let token = issue_access_token(&options(), &claims(NOW + 900));
        let mut parts: Vec<String> = token.split('.').map(str::to_string).collect();
        parts[1] = URL_SAFE_NO_PAD.encode(br#"{"sub":"evil"}"#);
        let tampered = parts.join(".");
        assert_eq!(
            validate_access_token(&options(), &tampered, NOW),
            Err(JwtError::Signature),
        );
    }

    #[test]
    fn options_from_config_use_reference_defaults() {
        let cfg = flora_shared::config::FloraConfig::from_layers(
            "Production",
            &[serde_json::json!({ "Jwt": { "Secret": "s" } })],
            &[],
        );
        let opts = JwtOptions::from_config(&cfg);
        assert_eq!(opts.issuer, "Flora.Auth");
        assert_eq!(opts.audience, "Flora.Ecosystem");
        assert_eq!(opts.access_token_minutes, 15);
        assert_eq!(opts.refresh_token_days, 7);
    }
}
