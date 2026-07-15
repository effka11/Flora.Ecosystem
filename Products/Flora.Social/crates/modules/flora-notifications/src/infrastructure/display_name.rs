//! Display name for push titles — паритет `UserDisplayNameResolver.cs`.
//! Precedence: profile DisplayName → "@username" → "Пользователь".

use std::sync::Arc;

use flora_auth_contracts::AccountDirectory;
use flora_users_contracts::UserProfileQueries;
use uuid::Uuid;

pub struct UserDisplayNameResolver {
    profiles: Arc<dyn UserProfileQueries>,
    accounts: Arc<dyn AccountDirectory>,
}

impl UserDisplayNameResolver {
    pub fn new(profiles: Arc<dyn UserProfileQueries>, accounts: Arc<dyn AccountDirectory>) -> Self {
        Self { profiles, accounts }
    }

    pub async fn resolve(&self, user_uuid: Uuid) -> String {
        if let Ok(Some(profile)) = self.profiles.get_profile(user_uuid).await {
            let name = profile.display_name.trim();
            if !name.is_empty() {
                return name.to_string();
            }
        }
        if let Ok(Some(account)) = self.accounts.get_public(user_uuid).await {
            let username = account.username.trim();
            if !username.is_empty() {
                return format!("@{username}");
            }
        }
        "Пользователь".into()
    }
}
