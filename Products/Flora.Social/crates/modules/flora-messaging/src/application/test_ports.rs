//! Заглушки портов Auth/Users для юнит-тестов application-слоя.
//!
//! Сервисы Messaging держат репозитории, но проверки портов стоят до первого
//! запроса, поэтому связка «ленивый пул + заглушка» даёт тесты без Postgres.

use std::sync::Mutex;

use chrono::{DateTime, Utc};
use flora_auth_contracts::{AccountDirectory, AccountPublicInfo, BoxFuture as AuthBoxFuture};
use flora_users_contracts::{
    AccountSanctions, BoxFuture as UsersBoxFuture, FeedAuthorProfile, FeedAuthorProfiles,
    MessagesAccess,
};
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

/// Пул без установленного соединения — конструирование репозиториев в БД не ходит.
pub(crate) fn lazy_pool() -> PgPool {
    PgPoolOptions::new().connect_lazy_with(PgConnectOptions::new())
}

pub(crate) struct StubAccounts;

impl AccountDirectory for StubAccounts {
    fn get_public(
        &self,
        user_uuid: Uuid,
    ) -> AuthBoxFuture<'_, Result<Option<AccountPublicInfo>, String>> {
        Box::pin(async move {
            Ok(Some(AccountPublicInfo {
                user_uuid,
                username: "u".into(),
                phone: String::new(),
                email: String::new(),
            }))
        })
    }
    fn find_uuid_by_username(&self, _: &str) -> AuthBoxFuture<'_, Result<Option<Uuid>, String>> {
        Box::pin(async { Ok(None) })
    }
    fn usernames_by_uuids(
        &self,
        _: &[Uuid],
    ) -> AuthBoxFuture<'_, Result<Vec<(Uuid, String)>, String>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    fn update_username(&self, _: Uuid, _: &str) -> AuthBoxFuture<'_, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
    fn username_taken_by_other(&self, _: &str, _: Uuid) -> AuthBoxFuture<'_, Result<bool, String>> {
        Box::pin(async { Ok(false) })
    }
    fn is_username_reserved(&self, _: &str) -> bool {
        false
    }
    fn search_accounts_by_username_contains(
        &self,
        _: Uuid,
        _: &str,
    ) -> AuthBoxFuture<'_, Result<Vec<(Uuid, String)>, String>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    fn list_active_user_uuids(&self) -> AuthBoxFuture<'_, Result<Vec<Uuid>, String>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

pub(crate) struct StubProfiles;

impl FeedAuthorProfiles for StubProfiles {
    fn by_uuids(&self, _: &[Uuid]) -> UsersBoxFuture<'_, Result<Vec<FeedAuthorProfile>, String>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

pub(crate) struct StubMessagesAccess(pub bool);

impl MessagesAccess for StubMessagesAccess {
    fn can_send_messages(&self, _: Uuid, _: Uuid) -> UsersBoxFuture<'_, Result<bool, String>> {
        let can_send = self.0;
        Box::pin(async move { Ok(can_send) })
    }
}

/// Один `apply_block`: цель, срок (`None` — навсегда), автор.
pub(crate) type BlockCall = (Uuid, Option<DateTime<Utc>>, Uuid);

#[derive(Default)]
pub(crate) struct RecordingSanctions {
    calls: Mutex<Vec<BlockCall>>,
}

impl RecordingSanctions {
    pub(crate) fn calls(&self) -> Vec<BlockCall> {
        self.calls.lock().expect("sanctions log").clone()
    }
}

impl AccountSanctions for RecordingSanctions {
    fn apply_block(
        &self,
        user_uuid: Uuid,
        blocked_until: Option<DateTime<Utc>>,
        created_by: Uuid,
    ) -> UsersBoxFuture<'_, Result<(), String>> {
        self.calls
            .lock()
            .expect("sanctions log")
            .push((user_uuid, blocked_until, created_by));
        Box::pin(async { Ok(()) })
    }
}
