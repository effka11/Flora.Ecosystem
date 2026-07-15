use std::sync::Arc;

use chrono::{Duration, Utc};
use flora_users_contracts::UserProfileReadQueries;

use crate::http::{LoginResponse, format_utc};
use crate::infrastructure::jwt::{AccessTokenClaims, JwtOptions, issue_access_token};
use crate::infrastructure::repo::AuthRepo;
use crate::infrastructure::tokens::{generate_jwt_id, generate_refresh_token};

#[derive(Debug)]
pub enum RefreshError {
    BadRequest(&'static str),
    Unauthorized(&'static str),
    Internal(String),
}

pub struct RefreshService {
    repo: Arc<AuthRepo>,
    jwt: JwtOptions,
    profiles: Arc<dyn UserProfileReadQueries>,
}

impl RefreshService {
    pub fn new(
        repo: Arc<AuthRepo>,
        jwt: JwtOptions,
        profiles: Arc<dyn UserProfileReadQueries>,
    ) -> Self {
        Self {
            repo,
            jwt,
            profiles,
        }
    }

    pub async fn refresh(&self, refresh_token: &str) -> Result<LoginResponse, RefreshError> {
        let token = refresh_token.trim();
        if token.is_empty() {
            return Err(RefreshError::BadRequest("Refresh token is required."));
        }

        let now = Utc::now();
        let session = self
            .repo
            .find_active_session_by_refresh(token, now)
            .await
            .map_err(|e| RefreshError::Internal(e.to_string()))?
            .ok_or(RefreshError::Unauthorized(
                "Invalid or expired refresh token.",
            ))?;

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
        let new_refresh = generate_refresh_token();
        let refresh_expires = now + Duration::days(self.jwt.refresh_token_days);
        let access_expires = now + Duration::minutes(self.jwt.access_token_minutes);
        let new_rotation = session.rotation_id.saturating_add(1);

        self.repo
            .rotate_session(
                session.session_id,
                &new_jwt_id,
                &new_refresh,
                refresh_expires,
                now,
                new_rotation,
            )
            .await
            .map_err(|e| RefreshError::Internal(e.to_string()))?;

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

        Ok(LoginResponse {
            access_token,
            refresh_token: new_refresh,
            expires_at: format_utc(access_expires),
            token_type: "Bearer".into(),
            requires_profile_completion: requires_profile,
        })
    }
}
