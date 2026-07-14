//! Контракты модуля Users — DTO и trait-порты без бизнес-логики (next-architecture.md §2.2).
//!
//! Фаза 2b: profile read + provisioner; далее — follow graph.

use std::future::Future;
use std::pin::Pin;

use uuid::Uuid;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Порт чтения профиля (C# `IUserProfileReadQueries` / god-controller profile checks).
pub trait UserProfileReadQueries: Send + Sync {
    /// `true`, если нет строки профиля или `display_name` пуст (шаг «Имя» на клиенте).
    fn requires_profile_completion(
        &self,
        user_uuid: Uuid,
    ) -> BoxFuture<'_, Result<bool, String>>;
}

/// Порт `IUserProfileProvisioner` — Auth создаёт пустой профиль при регистрации.
pub trait UserProfileProvisioner: Send + Sync {
    fn ensure_initial_profile(
        &self,
        user_uuid: Uuid,
        display_name: &str,
    ) -> BoxFuture<'_, Result<(), String>>;
}
