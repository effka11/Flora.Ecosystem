//! Display name for push titles — паритет `UserDisplayNameResolver.cs`.
//! Precedence: profile DisplayName → "@username" → "Пользователь".

use std::sync::Arc;

use flora_auth_contracts::AccountDirectory;
use flora_users_contracts::UserProfileQueries;
use uuid::Uuid;

pub struct PushSenderIdentity {
    pub display_name: String,
    pub avatar_uuid: Option<Uuid>,
}

pub struct UserDisplayNameResolver {
    profiles: Arc<dyn UserProfileQueries>,
    accounts: Arc<dyn AccountDirectory>,
}

impl UserDisplayNameResolver {
    pub fn new(profiles: Arc<dyn UserProfileQueries>, accounts: Arc<dyn AccountDirectory>) -> Self {
        Self { profiles, accounts }
    }

    pub async fn resolve_identity(&self, user_uuid: Uuid) -> PushSenderIdentity {
        let mut avatar_uuid = None;
        if let Ok(Some(profile)) = self.profiles.get_profile(user_uuid).await {
            avatar_uuid = profile.avatar_uuid;
            let name = profile.display_name.trim();
            if !name.is_empty() {
                return PushSenderIdentity {
                    display_name: name.to_string(),
                    avatar_uuid,
                };
            }
        }
        if let Ok(Some(account)) = self.accounts.get_public(user_uuid).await {
            let username = account.username.trim();
            if !username.is_empty() {
                return PushSenderIdentity {
                    display_name: format!("@{username}"),
                    avatar_uuid,
                };
            }
        }
        PushSenderIdentity {
            display_name: "Пользователь".into(),
            avatar_uuid,
        }
    }

    pub async fn resolve(&self, user_uuid: Uuid) -> String {
        self.resolve_identity(user_uuid).await.display_name
    }
}
