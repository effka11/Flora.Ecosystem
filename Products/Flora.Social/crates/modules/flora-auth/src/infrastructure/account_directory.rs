//! Адаптер `AuthRepo` → `AccountDirectory` (flora-auth-contracts).

use std::sync::Arc;

use flora_auth_contracts::{AccountDirectory, AccountPublicInfo, BoxFuture};
use uuid::Uuid;

use crate::infrastructure::repo::AuthRepo;

pub struct SqlAccountDirectory {
    repo: Arc<AuthRepo>,
}

impl SqlAccountDirectory {
    pub fn new(repo: Arc<AuthRepo>) -> Self {
        Self { repo }
    }
}

impl AccountDirectory for SqlAccountDirectory {
    fn get_public(
        &self,
        user_uuid: Uuid,
    ) -> BoxFuture<'_, Result<Option<AccountPublicInfo>, String>> {
        Box::pin(async move {
            let row = self
                .repo
                .get_account_public(user_uuid)
                .await
                .map_err(|e| e.to_string())?;
            Ok(row.map(|r| AccountPublicInfo {
                user_uuid: r.user_uuid,
                username: r.username,
                phone: r.phone,
                email: r.email.unwrap_or_default(),
            }))
        })
    }

    fn find_uuid_by_username(
        &self,
        username: &str,
    ) -> BoxFuture<'_, Result<Option<Uuid>, String>> {
        let username = username.to_string();
        Box::pin(async move {
            self.repo
                .find_uuid_by_username(&username)
                .await
                .map_err(|e| e.to_string())
        })
    }

    fn usernames_by_uuids(
        &self,
        user_uuids: &[Uuid],
    ) -> BoxFuture<'_, Result<Vec<(Uuid, String)>, String>> {
        let ids = user_uuids.to_vec();
        Box::pin(async move {
            self.repo
                .usernames_by_uuids(&ids)
                .await
                .map_err(|e| e.to_string())
        })
    }

    fn update_username(
        &self,
        user_uuid: Uuid,
        username: &str,
    ) -> BoxFuture<'_, Result<(), String>> {
        let username = username.to_string();
        Box::pin(async move {
            self.repo
                .update_username(user_uuid, &username)
                .await
                .map_err(|e| e.to_string())
        })
    }

    fn username_taken_by_other(
        &self,
        username: &str,
        user_uuid: Uuid,
    ) -> BoxFuture<'_, Result<bool, String>> {
        let username = username.to_string();
        Box::pin(async move {
            self.repo
                .username_taken_by_other(&username, user_uuid)
                .await
                .map_err(|e| e.to_string())
        })
    }

    fn is_username_reserved(&self, username: &str) -> bool {
        crate::domain::reserved_usernames::is_reserved(username)
    }

    fn search_accounts_by_username_contains(
        &self,
        exclude_user_uuid: Uuid,
        query_lower: &str,
    ) -> BoxFuture<'_, Result<Vec<(Uuid, String)>, String>> {
        let query_lower = query_lower.to_string();
        Box::pin(async move {
            self.repo
                .search_accounts_by_username_contains(exclude_user_uuid, &query_lower)
                .await
                .map_err(|e| e.to_string())
        })
    }

    fn list_active_user_uuids(&self) -> BoxFuture<'_, Result<Vec<Uuid>, String>> {
        Box::pin(async move {
            self.repo
                .list_active_user_uuids()
                .await
                .map_err(|e| e.to_string())
        })
    }
}

pub fn as_directory(repo: Arc<AuthRepo>) -> Arc<dyn AccountDirectory> {
    Arc::new(SqlAccountDirectory::new(repo))
}
