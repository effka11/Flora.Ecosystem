//! Контракты модуля Auth — DTO и trait-порты без бизнес-логики (next-architecture.md §2.2).

use std::future::Future;
use std::pin::Pin;

use uuid::Uuid;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone)]
pub struct AccountPublicInfo {
    pub user_uuid: Uuid,
    pub username: String,
    pub phone: String,
    pub email: String,
}

/// Порт чтения аккаунта для Users/Content (C# `UserAccounts` AsNoTracking в god-controller).
pub trait AccountDirectory: Send + Sync {
    fn get_public(
        &self,
        user_uuid: Uuid,
    ) -> BoxFuture<'_, Result<Option<AccountPublicInfo>, String>>;

    fn find_uuid_by_username(&self, username: &str) -> BoxFuture<'_, Result<Option<Uuid>, String>>;

    /// Пакетное чтение username по uuid (blocklist и т.п.).
    fn usernames_by_uuids(
        &self,
        user_uuids: &[Uuid],
    ) -> BoxFuture<'_, Result<Vec<(Uuid, String)>, String>>;

    fn update_username(&self, user_uuid: Uuid, username: &str)
    -> BoxFuture<'_, Result<(), String>>;

    fn username_taken_by_other(
        &self,
        username: &str,
        user_uuid: Uuid,
    ) -> BoxFuture<'_, Result<bool, String>>;

    /// Reserved-никнеймы Auth (тот же список, что при регистрации).
    fn is_username_reserved(&self, username: &str) -> bool;

    /// Поиск по username (lower contains); исключает `exclude_user_uuid`; ORDER BY username.
    fn search_accounts_by_username_contains(
        &self,
        exclude_user_uuid: Uuid,
        query_lower: &str,
    ) -> BoxFuture<'_, Result<Vec<(Uuid, String)>, String>>;

    /// Активные аккаунты (`status = Active`) — паритет `IAccountReadQueries.ListActiveUserUuidsAsync`.
    fn list_active_user_uuids(&self) -> BoxFuture<'_, Result<Vec<Uuid>, String>>;
}
