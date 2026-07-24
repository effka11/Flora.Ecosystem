use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use chrono::{Duration, Utc};
use flora_users_contracts::UserProfileReadQueries;

use crate::application::replay_grant::{ReplayGrantV1, replay_aad};
use crate::domain::refresh_machine::REFRESH_GRACE_SECONDS;
use crate::http::{LoginResponse, format_utc};
use crate::infrastructure::jwt::{AccessTokenClaims, JwtOptions, issue_access_token};
use crate::infrastructure::replay_keys::ReplayKeyRing;
use crate::infrastructure::repo::{AuthRepo, PreparedGrant, RefreshOutcome};
use crate::infrastructure::tokens::{
    generate_jwt_id, generate_refresh_token, hash_refresh_token, refresh_token_session_id,
};

const REPLAY_GRANT_VERSION: i32 = 1;
const INVALID_REFRESH: &str = "Invalid or expired refresh token.";

#[derive(Debug)]
pub enum RefreshError {
    BadRequest(&'static str),
    Unauthorized(&'static str),
    Internal(String),
    /// Инстанс в drain-режиме (rollback): новая ротация недоступна, повторите
    /// запрос. Маппится в HTTP 503 (retryable). Replay в grace сюда не попадает.
    ServiceUnavailable(&'static str),
}

/// Конфигурация retry-safe replay-протокола (plan §2). `None` в сервисе →
/// legacy-ротация (revoke on reuse). Grace фиксирован (`G=60s`).
#[derive(Clone)]
pub struct ReplayConfig {
    key_ring: Arc<ReplayKeyRing>,
    grace_seconds: i64,
    /// Drain-переключатель (rollback, plan §3). Общий на инстанс: в drain новые
    /// ротации отдают 503, replay в grace продолжает обслуживаться.
    drain: Arc<AtomicBool>,
}

impl ReplayConfig {
    pub fn new(key_ring: Arc<ReplayKeyRing>) -> Self {
        Self {
            key_ring,
            grace_seconds: REFRESH_GRACE_SECONDS,
            drain: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Собрать из конфигурации. `Ok(None)` — протокол выключен (feature off и
    /// `Auth:RetrySafeRefresh` не true). `Err` — включён, но key ring не задан/битый
    /// (startup fail-fast). `Jwt:Secret` для этого не используется.
    ///
    /// `Auth:RefreshDrain=true` поднимает инстанс сразу в drain-режиме (rollback):
    /// retry-safe binary остаётся, но новые ротации возвращают 503.
    pub fn from_config(cfg: &flora_shared::config::FloraConfig) -> Result<Option<Self>, String> {
        let default_on = cfg!(feature = "retry-safe-refresh");
        let enabled = cfg.get_bool("Auth:RetrySafeRefresh").unwrap_or(default_on);
        if !enabled {
            return Ok(None);
        }
        let ring = ReplayKeyRing::from_config(cfg)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| {
                "retry-safe refresh включён, но Auth:ReplayKeyRing не задан (startup fail-fast)"
                    .to_string()
            })?;
        let config = Self::new(Arc::new(ring));
        if cfg.get_bool("Auth:RefreshDrain") == Some(true) {
            config.set_drain(true);
        }
        Ok(Some(config))
    }

    /// Переключить drain-режим (config-driven на старте или админ-сигнал в рантайме).
    pub fn set_drain(&self, draining: bool) {
        self.drain.store(draining, Ordering::SeqCst);
    }

    /// Дренируется ли инстанс сейчас.
    pub fn is_draining(&self) -> bool {
        self.drain.load(Ordering::SeqCst)
    }
}

pub struct RefreshService {
    repo: Arc<AuthRepo>,
    jwt: JwtOptions,
    profiles: Arc<dyn UserProfileReadQueries>,
    replay: Option<ReplayConfig>,
}

impl RefreshService {
    /// Legacy-конструктор: replay-протокол выключен (revoke on reuse).
    pub fn new(
        repo: Arc<AuthRepo>,
        jwt: JwtOptions,
        profiles: Arc<dyn UserProfileReadQueries>,
    ) -> Self {
        Self {
            repo,
            jwt,
            profiles,
            replay: None,
        }
    }

    /// Конструктор с retry-safe replay-протоколом (feature-gated на уровне compose).
    pub fn with_replay(
        repo: Arc<AuthRepo>,
        jwt: JwtOptions,
        profiles: Arc<dyn UserProfileReadQueries>,
        replay: Option<ReplayConfig>,
    ) -> Self {
        Self {
            repo,
            jwt,
            profiles,
            replay,
        }
    }

    pub async fn refresh(&self, refresh_token: &str) -> Result<LoginResponse, RefreshError> {
        match &self.replay {
            Some(config) => self.refresh_replay_safe(refresh_token, config).await,
            None => self.refresh_legacy(refresh_token).await,
        }
    }

    /// Прежняя одноразовая ротация: повтор потраченного токена отзывает сессию.
    async fn refresh_legacy(&self, refresh_token: &str) -> Result<LoginResponse, RefreshError> {
        let token = refresh_token.trim();
        if token.is_empty() {
            return Err(RefreshError::BadRequest("Refresh token is required."));
        }

        let now = Utc::now();
        let session = self
            .repo
            .find_active_session_by_refresh(token, now)
            .await
            .map_err(|e| RefreshError::Internal(e.to_string()))?;
        let Some(session) = session else {
            if let Some(session_id) = refresh_token_session_id(token, self.jwt.secret.as_bytes()) {
                self.repo
                    .revoke_session_by_id(session_id)
                    .await
                    .map_err(|e| RefreshError::Internal(e.to_string()))?;
                tracing::warn!(
                    target: "flora_auth::refresh_outcome",
                    metric = "refresh_reuse_revoked",
                    outcome = "reused",
                    protocol = "legacy",
                    status = 401_u16,
                    counter_delta = 1_u64,
                    "auth refresh outcome"
                );
            } else {
                tracing::info!(
                    target: "flora_auth::refresh_outcome",
                    metric = "refresh_error",
                    outcome = "invalid",
                    protocol = "legacy",
                    status = 401_u16,
                    counter_delta = 1_u64,
                    "auth refresh outcome"
                );
            }
            return Err(RefreshError::Unauthorized(INVALID_REFRESH));
        };

        let identity = self
            .repo
            .get_account_identity(session.user_uuid)
            .await
            .map_err(|e| RefreshError::Internal(e.to_string()))?;

        // Паритет C#: Phone ?? Email ?? Username ?? ""
        let identifier = identity
            .phone
            .filter(|s| !s.is_empty())
            .or(identity.email.filter(|s| !s.is_empty()))
            .or(identity.username.filter(|s| !s.is_empty()))
            .unwrap_or_default();

        let new_jwt_id = generate_jwt_id();
        let new_refresh = generate_refresh_token(session.session_id, self.jwt.secret.as_bytes());
        let refresh_expires = now + Duration::days(self.jwt.refresh_token_days);
        let access_expires = now + Duration::minutes(self.jwt.access_token_minutes);
        let new_rotation = session.rotation_id.saturating_add(1);

        let rotated = self
            .repo
            .rotate_session(
                session.session_id,
                token,
                session.rotation_id,
                &new_jwt_id,
                &new_refresh,
                refresh_expires,
                now,
                new_rotation,
            )
            .await
            .map_err(|e| RefreshError::Internal(e.to_string()))?;
        if !rotated {
            self.repo
                .revoke_session_by_id(session.session_id)
                .await
                .map_err(|e| RefreshError::Internal(e.to_string()))?;
            tracing::warn!(
                target: "flora_auth::refresh_outcome",
                metric = "refresh_reuse_revoked",
                outcome = "rotation_conflict",
                protocol = "legacy",
                status = 401_u16,
                counter_delta = 1_u64,
                "auth refresh outcome"
            );
            return Err(RefreshError::Unauthorized(INVALID_REFRESH));
        }

        let access_token = issue_access_token(
            &self.jwt,
            &AccessTokenClaims {
                sub: session.user_uuid.to_string(),
                email: identifier,
                jti: new_jwt_id,
                expires_at: access_expires.timestamp(),
            },
        );

        let requires_profile = self
            .profiles
            .requires_profile_completion(session.user_uuid)
            .await
            .map_err(RefreshError::Internal)?;

        let response = LoginResponse {
            access_token,
            refresh_token: new_refresh,
            expires_at: format_utc(access_expires),
            token_type: "Bearer".into(),
            requires_profile_completion: requires_profile,
        };
        tracing::info!(
            target: "flora_auth::refresh_outcome",
            metric = "refresh_rotated",
            outcome = "rotated",
            protocol = "legacy",
            counter_delta = 1_u64,
            "auth refresh outcome"
        );
        Ok(response)
    }

    /// Retry-safe транзакционная ротация с grace-барьером (plan §2). Внешний
    /// profile-порт вызывается ДО транзакции; сам row lock держит только Auth DB.
    async fn refresh_replay_safe(
        &self,
        refresh_token: &str,
        config: &ReplayConfig,
    ) -> Result<LoginResponse, RefreshError> {
        let token = refresh_token.trim();
        if token.is_empty() {
            return Err(RefreshError::BadRequest("Refresh token is required."));
        }

        let now = Utc::now();

        // 1. Разрешить session_id. Крипто-привязанный (HMAC family) токен даёт
        //    session_id напрямую; иначе legacy-fallback по hash активной сессии.
        let (session_id, bound) = match refresh_token_session_id(token, self.jwt.secret.as_bytes())
        {
            Some(session_id) => (session_id, true),
            None => {
                match self
                    .repo
                    .find_session_id_by_refresh(token, now)
                    .await
                    .map_err(|e| RefreshError::Internal(e.to_string()))?
                {
                    Some(session_id) => (session_id, false),
                    None => {
                        tracing::info!(
                            target: "flora_auth::refresh_outcome",
                            metric = "refresh_error",
                            outcome = "invalid",
                            protocol = "retry_safe",
                            status = 401_u16,
                            counter_delta = 1_u64,
                            "auth refresh outcome"
                        );
                        return Err(RefreshError::Unauthorized(INVALID_REFRESH));
                    }
                }
            }
        };

        // 2. Prefetch (без row lock): ядро сессии + профильные данные для payload.
        let Some(core) = self
            .repo
            .find_refresh_session_by_id(session_id)
            .await
            .map_err(|e| RefreshError::Internal(e.to_string()))?
        else {
            tracing::info!(
                target: "flora_auth::refresh_outcome",
                metric = "refresh_error",
                outcome = "invalid",
                protocol = "retry_safe",
                status = 401_u16,
                counter_delta = 1_u64,
                "auth refresh outcome"
            );
            return Err(RefreshError::Unauthorized(INVALID_REFRESH));
        };
        let user_uuid = core.user_uuid;

        let identity = self
            .repo
            .get_account_identity(user_uuid)
            .await
            .map_err(|e| RefreshError::Internal(e.to_string()))?;
        let identifier = identity
            .phone
            .filter(|s| !s.is_empty())
            .or(identity.email.filter(|s| !s.is_empty()))
            .or(identity.username.filter(|s| !s.is_empty()))
            .unwrap_or_default();

        // Внешний порт под row lock не вызывается: profile failure → 5xx до транзакции.
        let requires_profile = self
            .profiles
            .requires_profile_completion(user_uuid)
            .await
            .map_err(RefreshError::Internal)?;

        // 3. Собрать прогнозный R2 (используется только при Rotate).
        let new_jwt_id = generate_jwt_id();
        let new_refresh = generate_refresh_token(session_id, self.jwt.secret.as_bytes());
        let refresh_expires = now + Duration::days(self.jwt.refresh_token_days);
        let access_expires = now + Duration::minutes(self.jwt.access_token_minutes);
        let new_rotation = core.rotation_id.saturating_add(1);
        let access_token = issue_access_token(
            &self.jwt,
            &AccessTokenClaims {
                sub: user_uuid.to_string(),
                email: identifier,
                jti: new_jwt_id.clone(),
                expires_at: access_expires.timestamp(),
            },
        );
        let response = LoginResponse {
            access_token,
            refresh_token: new_refresh.clone(),
            expires_at: format_utc(access_expires),
            token_type: "Bearer".into(),
            requires_profile_completion: requires_profile,
        };

        // 4. Зашифровать grant новым Auth key ring'ом (не Jwt:Secret).
        let presented_hash = hash_refresh_token(token);
        let new_refresh_hash = hash_refresh_token(&new_refresh);
        let aad = replay_aad(
            session_id,
            new_rotation,
            &presented_hash,
            &new_refresh_hash,
            refresh_expires,
        );
        let sealed = config
            .key_ring
            .seal(&aad, &ReplayGrantV1::from_response(&response).encode());
        let prepared = PreparedGrant {
            expected_rotation_id: core.rotation_id,
            new_rotation_id: new_rotation,
            new_jwt_id,
            new_refresh_hash,
            refresh_expires_at: refresh_expires,
            spent_hash: presented_hash.clone(),
            key_id: sealed.key_id,
            nonce: sealed.nonce,
            ciphertext: sealed.ciphertext,
            version: REPLAY_GRANT_VERSION,
        };

        // 5. Одна Auth DB транзакция. Commit ambiguity → Internal (transient 5xx),
        //    retry R1 восстановит R2 через replay-строку.
        let outcome = self
            .repo
            .rotate_or_replay(
                session_id,
                token,
                &presented_hash,
                bound,
                &prepared,
                config.grace_seconds,
                config.is_draining(),
            )
            .await
            .map_err(|e| RefreshError::Internal(e.to_string()))?;

        match outcome {
            RefreshOutcome::Rotated { .. } => {
                tracing::info!(
                    target: "flora_auth::refresh_outcome",
                    metric = "refresh_rotated",
                    outcome = "rotated",
                    protocol = "retry_safe",
                    counter_delta = 1_u64,
                    "auth refresh outcome"
                );
                Ok(response)
            }
            RefreshOutcome::Replayed(stored) => {
                // Recover AAD из полей строки и расшифровать. Любая ошибка —
                // transient 5xx (corruption/decrypt), никогда ложный revoke.
                let aad = replay_aad(
                    stored.session_id,
                    stored.replacement_rotation_id,
                    &stored.spent_hash,
                    &stored.replacement_hash,
                    stored.refresh_expires_at,
                );
                let plaintext = config
                    .key_ring
                    .open(&stored.key_id, &stored.nonce, &aad, &stored.ciphertext)
                    .map_err(|e| RefreshError::Internal(e.to_string()))?;
                let grant = ReplayGrantV1::decode(&plaintext)
                    .map_err(|_| RefreshError::Internal("replay grant decode failed".into()))?;
                tracing::info!(
                    target: "flora_auth::refresh_outcome",
                    metric = "refresh_replayed",
                    outcome = "replayed",
                    protocol = "retry_safe",
                    counter_delta = 1_u64,
                    "auth refresh outcome"
                );
                Ok(grant.into_response())
            }
            RefreshOutcome::ReusedOutsideGrace => {
                tracing::warn!(
                    target: "flora_auth::refresh_outcome",
                    metric = "refresh_reuse_revoked",
                    outcome = "reused_outside_grace",
                    protocol = "retry_safe",
                    status = 401_u16,
                    counter_delta = 1_u64,
                    "auth refresh outcome"
                );
                Err(RefreshError::Unauthorized(INVALID_REFRESH))
            }
            RefreshOutcome::Invalid => {
                tracing::info!(
                    target: "flora_auth::refresh_outcome",
                    metric = "refresh_error",
                    outcome = "invalid",
                    protocol = "retry_safe",
                    status = 401_u16,
                    counter_delta = 1_u64,
                    "auth refresh outcome"
                );
                Err(RefreshError::Unauthorized(INVALID_REFRESH))
            }
            RefreshOutcome::Draining => {
                tracing::info!(
                    target: "flora_auth::refresh_outcome",
                    metric = "refresh_draining",
                    outcome = "draining",
                    protocol = "retry_safe",
                    status = 503_u16,
                    counter_delta = 1_u64,
                    "auth refresh outcome"
                );
                Err(RefreshError::ServiceUnavailable(
                    "Refresh temporarily unavailable, retry.",
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;
    use flora_shared::config::FloraConfig;

    fn key_b64() -> String {
        STANDARD.encode([5_u8; 32])
    }

    /// Выключено по умолчанию (feature off, флаг не задан) ⇒ None ⇒ legacy.
    #[cfg(not(feature = "retry-safe-refresh"))]
    #[test]
    fn from_config_disabled_selects_legacy() {
        let cfg = FloraConfig::from_layers("Production", &[], &[]);
        assert!(ReplayConfig::from_config(&cfg).unwrap().is_none());
    }

    /// Явный `Auth:RetrySafeRefresh=false` всегда даёт legacy, даже с feature on.
    #[test]
    fn from_config_explicit_false_selects_legacy() {
        let cfg = FloraConfig::from_layers(
            "Production",
            &[serde_json::json!({ "Auth": { "RetrySafeRefresh": false } })],
            &[],
        );
        assert!(ReplayConfig::from_config(&cfg).unwrap().is_none());
    }

    /// Включён, но key ring не задан ⇒ startup fail-fast (Err), не тихий legacy.
    #[test]
    fn from_config_enabled_without_keys_fails_fast() {
        let cfg = FloraConfig::from_layers(
            "Production",
            &[serde_json::json!({ "Auth": { "RetrySafeRefresh": true } })],
            &[],
        );
        assert!(ReplayConfig::from_config(&cfg).is_err());
    }

    /// Включён + валидный key ring ⇒ Some ⇒ retry-safe (drain выключен).
    #[test]
    fn from_config_enabled_with_keys_selects_replay() {
        let cfg = FloraConfig::from_layers(
            "Production",
            &[serde_json::json!({
                "Auth": {
                    "RetrySafeRefresh": true,
                    "ReplayKeyRing": {
                        "ActiveKeyId": "k1",
                        "KeyIds": ["k1"],
                        "Key": { "k1": key_b64() }
                    }
                }
            })],
            &[],
        );
        let config = ReplayConfig::from_config(&cfg).unwrap().expect("Some");
        assert!(!config.is_draining(), "по умолчанию не дренируется");
    }

    /// `Auth:RefreshDrain=true` поднимает инстанс сразу в drain-режиме.
    #[test]
    fn from_config_drain_flag_starts_draining() {
        let cfg = FloraConfig::from_layers(
            "Production",
            &[serde_json::json!({
                "Auth": {
                    "RetrySafeRefresh": true,
                    "RefreshDrain": true,
                    "ReplayKeyRing": {
                        "ActiveKeyId": "k1",
                        "KeyIds": ["k1"],
                        "Key": { "k1": key_b64() }
                    }
                }
            })],
            &[],
        );
        let config = ReplayConfig::from_config(&cfg).unwrap().expect("Some");
        assert!(config.is_draining(), "config-driven drain на старте");
    }

    /// Runtime-переключатель drain (админ-сигнал).
    #[test]
    fn set_drain_toggles_at_runtime() {
        let mut keys = std::collections::HashMap::new();
        keys.insert("k1".to_string(), [1_u8; 32]);
        let config = ReplayConfig::new(Arc::new(ReplayKeyRing::new("k1", keys).unwrap()));
        assert!(!config.is_draining());
        config.set_drain(true);
        assert!(config.is_draining());
        config.set_drain(false);
        assert!(!config.is_draining());
    }
}
