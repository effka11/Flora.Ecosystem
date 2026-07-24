//! Версионированный внутренний `ReplayGrantV1` (plan §2).
//!
//! Это НЕ HTTP DTO: сериализуется в приватный payload, который шифруется key
//! ring'ом ([`crate::infrastructure::replay_keys`]) и хранится в
//! `auth_refresh_replays`. Содержит точную token pair и метаданные ответа,
//! чтобы повтор в пределах grace вернул ровно тот же ответ, что и первая ротация.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::http::LoginResponse;

const AAD_DOMAIN: &str = "flora-auth.refresh-replay.v1";
const GRANT_VERSION: u16 = 1;

/// Приватный payload replay-grant'а (шифруется, в БД не в открытом виде).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplayGrantV1 {
    pub v: u16,
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: String,
    pub token_type: String,
    pub requires_profile_completion: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum GrantDecodeError {
    Malformed,
    UnsupportedVersion(u16),
}

impl ReplayGrantV1 {
    pub fn from_response(response: &LoginResponse) -> Self {
        Self {
            v: GRANT_VERSION,
            access_token: response.access_token.clone(),
            refresh_token: response.refresh_token.clone(),
            expires_at: response.expires_at.clone(),
            token_type: response.token_type.clone(),
            requires_profile_completion: response.requires_profile_completion,
        }
    }

    pub fn into_response(self) -> LoginResponse {
        LoginResponse {
            access_token: self.access_token,
            refresh_token: self.refresh_token,
            expires_at: self.expires_at,
            token_type: self.token_type,
            requires_profile_completion: self.requires_profile_completion,
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("ReplayGrantV1 сериализуется")
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, GrantDecodeError> {
        let grant: ReplayGrantV1 =
            serde_json::from_slice(bytes).map_err(|_| GrantDecodeError::Malformed)?;
        if grant.v != GRANT_VERSION {
            return Err(GrantDecodeError::UnsupportedVersion(grant.v));
        }
        Ok(grant)
    }
}

/// AAD связывает ciphertext с session/rotation/hash/expiry/version — нельзя
/// переиспользовать grant в другой сессии/ротации.
pub fn replay_aad(
    session_id: Uuid,
    replacement_rotation_id: i64,
    spent_hash: &str,
    replacement_hash: &str,
    refresh_expires_at: DateTime<Utc>,
) -> Vec<u8> {
    format!(
        "{AAD_DOMAIN}|{session_id}|{replacement_rotation_id}|{spent_hash}|{replacement_hash}|{}",
        refresh_expires_at.timestamp()
    )
    .into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response() -> LoginResponse {
        LoginResponse {
            access_token: "access".into(),
            refresh_token: "refresh".into(),
            expires_at: "2026-07-24T12:15:00.000Z".into(),
            token_type: "Bearer".into(),
            requires_profile_completion: true,
        }
    }

    #[test]
    fn grant_roundtrips_response() {
        let grant = ReplayGrantV1::from_response(&response());
        let bytes = grant.encode();
        let decoded = ReplayGrantV1::decode(&bytes).unwrap();
        let restored = decoded.into_response();
        assert_eq!(restored.access_token, "access");
        assert_eq!(restored.refresh_token, "refresh");
        assert_eq!(restored.token_type, "Bearer");
        assert!(restored.requires_profile_completion);
    }

    #[test]
    fn decode_rejects_wrong_version() {
        let mut grant = ReplayGrantV1::from_response(&response());
        grant.v = 99;
        assert_eq!(
            ReplayGrantV1::decode(&grant.encode()),
            Err(GrantDecodeError::UnsupportedVersion(99))
        );
    }

    #[test]
    fn decode_rejects_garbage() {
        assert_eq!(
            ReplayGrantV1::decode(b"not-json"),
            Err(GrantDecodeError::Malformed)
        );
    }

    #[test]
    fn aad_changes_with_binding_fields() {
        let sid = Uuid::now_v7();
        let base = replay_aad(sid, 1, "spent", "repl", Utc::now());
        let other_rotation = replay_aad(sid, 2, "spent", "repl", Utc::now());
        assert_ne!(base, other_rotation);
    }
}
