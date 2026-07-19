//! Proof-токены E2E-восстановления (e2e-security.md §Proof model, errata-5).
//!
//! `recoveryUnlockToken` / `trustedDeviceApprovalToken` — короткоживущие HMAC-SHA256
//! токены, выдаваемые сервером и проверяемые в `unlock-complete`. До errata-5 сервер
//! требовал только непустое поле — токены не проверялись вовсе.
//!
//! Формат: `fet1.<base64url(payload_json)>.<base64url(hmac_sha256)>`.
//! MAC-ключ доменно-разделён от исходного секрета (HMAC(secret, DOMAIN)), поэтому
//! допустим fallback на общий серверный секрет без риска cross-protocol подписи.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Duration, Utc};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

const TOKEN_PREFIX: &str = "fet1";
const KEY_DOMAIN: &[u8] = b"flora.messaging.e2e-proof-token.v1";
/// Recovery-flow: от выдачи ciphertext до unlock-complete (локальный decrypt + ввод фразы).
const RECOVERY_UNLOCK_TTL_MINUTES: i64 = 30;
/// Trusted-device flow: от approve старым устройством до unlock-complete нового.
const DEVICE_APPROVAL_TTL_MINUTES: i64 = 30;

#[derive(Debug, Serialize, Deserialize)]
struct TokenPayload {
    /// Вид токена: `recovery-unlock` | `device-approval`.
    kind: String,
    user_uuid: Uuid,
    /// recovery-unlock: recoveryKeyId; device-approval: keyEpochId.
    scope_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    new_device_uuid: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    approving_device_uuid: Option<Uuid>,
    expires_at_unix: i64,
}

/// Подписывает и проверяет proof-токены. `None`-секрет = токены отключены:
/// выдача возвращает `None`, проверка всегда отклоняет (fail-closed).
pub struct E2eProofTokens {
    mac_key: Option<[u8; 32]>,
}

impl E2eProofTokens {
    pub fn new(secret: Option<Vec<u8>>) -> Self {
        let mac_key = secret.filter(|s| !s.is_empty()).map(|s| {
            let mut mac = HmacSha256::new_from_slice(&s).expect("HMAC принимает ключ любой длины");
            mac.update(KEY_DOMAIN);
            let digest = mac.finalize().into_bytes();
            let mut key = [0u8; 32];
            key.copy_from_slice(&digest);
            key
        });
        Self { mac_key }
    }

    pub fn disabled() -> Self {
        Self { mac_key: None }
    }

    pub fn is_enabled(&self) -> bool {
        self.mac_key.is_some()
    }

    pub fn issue_recovery_unlock(
        &self,
        user_uuid: Uuid,
        recovery_key_id: Uuid,
    ) -> Option<(String, DateTime<Utc>)> {
        let expires_at = Utc::now() + Duration::minutes(RECOVERY_UNLOCK_TTL_MINUTES);
        let payload = TokenPayload {
            kind: "recovery-unlock".into(),
            user_uuid,
            scope_id: recovery_key_id,
            new_device_uuid: None,
            approving_device_uuid: None,
            expires_at_unix: expires_at.timestamp(),
        };
        Some((self.sign(&payload)?, expires_at))
    }

    pub fn issue_device_approval(
        &self,
        user_uuid: Uuid,
        key_epoch_id: Uuid,
        new_device_uuid: Uuid,
        approving_device_uuid: Uuid,
    ) -> Option<(String, DateTime<Utc>)> {
        let expires_at = Utc::now() + Duration::minutes(DEVICE_APPROVAL_TTL_MINUTES);
        let payload = TokenPayload {
            kind: "device-approval".into(),
            user_uuid,
            scope_id: key_epoch_id,
            new_device_uuid: Some(new_device_uuid),
            approving_device_uuid: Some(approving_device_uuid),
            expires_at_unix: expires_at.timestamp(),
        };
        Some((self.sign(&payload)?, expires_at))
    }

    pub fn verify_recovery_unlock(&self, token: &str, user_uuid: Uuid) -> Result<(), String> {
        self.verify(token, user_uuid, "recovery-unlock").map(|_| ())
    }

    pub fn verify_device_approval(&self, token: &str, user_uuid: Uuid) -> Result<(), String> {
        self.verify(token, user_uuid, "device-approval").map(|_| ())
    }

    fn sign(&self, payload: &TokenPayload) -> Option<String> {
        let key = self.mac_key.as_ref()?;
        let payload_b64 = URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(payload).expect("TokenPayload всегда сериализуем"));
        let mac = Self::mac_over(key, &payload_b64);
        Some(format!("{TOKEN_PREFIX}.{payload_b64}.{mac}"))
    }

    fn verify(
        &self,
        token: &str,
        user_uuid: Uuid,
        expected_kind: &str,
    ) -> Result<TokenPayload, String> {
        let Some(key) = self.mac_key.as_ref() else {
            return Err("Проверка proof-токенов не сконфигурирована на сервере.".into());
        };

        let mut parts = token.trim().split('.');
        let (Some(prefix), Some(payload_b64), Some(mac_b64), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err("Неверный формат proof-токена.".into());
        };
        if prefix != TOKEN_PREFIX {
            return Err("Неверный формат proof-токена.".into());
        }

        let mut mac = HmacSha256::new_from_slice(key).expect("HMAC принимает ключ любой длины");
        mac.update(TOKEN_PREFIX.as_bytes());
        mac.update(b".");
        mac.update(payload_b64.as_bytes());
        let mac_bytes = URL_SAFE_NO_PAD
            .decode(mac_b64)
            .map_err(|_| String::from("Неверный формат proof-токена."))?;
        // verify_slice — константное время (subtle внутри hmac).
        mac.verify_slice(&mac_bytes)
            .map_err(|_| String::from("Подпись proof-токена не прошла проверку."))?;

        let payload_json = URL_SAFE_NO_PAD
            .decode(payload_b64)
            .map_err(|_| String::from("Неверный формат proof-токена."))?;
        let payload: TokenPayload = serde_json::from_slice(&payload_json)
            .map_err(|_| String::from("Неверный формат proof-токена."))?;

        if payload.kind != expected_kind {
            return Err("Proof-токен другого вида.".into());
        }
        if payload.user_uuid != user_uuid {
            return Err("Proof-токен выдан другому пользователю.".into());
        }
        if Utc::now().timestamp() > payload.expires_at_unix {
            return Err("Proof-токен истёк.".into());
        }
        Ok(payload)
    }

    fn mac_over(key: &[u8; 32], payload_b64: &str) -> String {
        let mut mac = HmacSha256::new_from_slice(key).expect("HMAC принимает ключ любой длины");
        mac.update(TOKEN_PREFIX.as_bytes());
        mac.update(b".");
        mac.update(payload_b64.as_bytes());
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens() -> E2eProofTokens {
        E2eProofTokens::new(Some(b"test-secret".to_vec()))
    }

    #[test]
    fn recovery_unlock_roundtrip() {
        let t = tokens();
        let user = Uuid::now_v7();
        let (token, _) = t.issue_recovery_unlock(user, Uuid::now_v7()).unwrap();
        assert_eq!(t.verify_recovery_unlock(&token, user), Ok(()));
    }

    #[test]
    fn device_approval_roundtrip() {
        let t = tokens();
        let user = Uuid::now_v7();
        let (token, _) = t
            .issue_device_approval(user, Uuid::now_v7(), Uuid::now_v7(), Uuid::now_v7())
            .unwrap();
        assert_eq!(t.verify_device_approval(&token, user), Ok(()));
    }

    #[test]
    fn wrong_user_is_rejected() {
        let t = tokens();
        let (token, _) = t
            .issue_recovery_unlock(Uuid::now_v7(), Uuid::now_v7())
            .unwrap();
        assert_eq!(
            t.verify_recovery_unlock(&token, Uuid::now_v7())
                .unwrap_err(),
            "Proof-токен выдан другому пользователю."
        );
    }

    #[test]
    fn cross_kind_use_is_rejected() {
        let t = tokens();
        let user = Uuid::now_v7();
        let (token, _) = t.issue_recovery_unlock(user, Uuid::now_v7()).unwrap();
        assert_eq!(
            t.verify_device_approval(&token, user).unwrap_err(),
            "Proof-токен другого вида."
        );
    }

    #[test]
    fn tampered_payload_is_rejected() {
        let t = tokens();
        let user = Uuid::now_v7();
        let (token, _) = t.issue_recovery_unlock(user, Uuid::now_v7()).unwrap();
        let mut parts: Vec<&str> = token.split('.').collect();
        let forged_payload = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&TokenPayload {
                kind: "recovery-unlock".into(),
                user_uuid: user,
                scope_id: Uuid::now_v7(),
                new_device_uuid: None,
                approving_device_uuid: None,
                expires_at_unix: Utc::now().timestamp() + 10_000,
            })
            .unwrap(),
        );
        parts[1] = &forged_payload;
        let forged = parts.join(".");
        assert_eq!(
            t.verify_recovery_unlock(&forged, user).unwrap_err(),
            "Подпись proof-токена не прошла проверку."
        );
    }

    #[test]
    fn different_secret_is_rejected() {
        let a = E2eProofTokens::new(Some(b"secret-a".to_vec()));
        let b = E2eProofTokens::new(Some(b"secret-b".to_vec()));
        let user = Uuid::now_v7();
        let (token, _) = a.issue_recovery_unlock(user, Uuid::now_v7()).unwrap();
        assert_eq!(
            b.verify_recovery_unlock(&token, user).unwrap_err(),
            "Подпись proof-токена не прошла проверку."
        );
    }

    #[test]
    fn disabled_tokens_fail_closed() {
        let t = E2eProofTokens::disabled();
        assert!(
            t.issue_recovery_unlock(Uuid::now_v7(), Uuid::now_v7())
                .is_none()
        );
        assert_eq!(
            t.verify_recovery_unlock("fet1.x.y", Uuid::now_v7())
                .unwrap_err(),
            "Проверка proof-токенов не сконфигурирована на сервере."
        );
    }
}
