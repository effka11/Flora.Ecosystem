//! Контракты модуля Users — DTO и trait-порты без бизнес-логики (next-architecture.md §2.2).
//!
//! Фаза 2b: `UserProfileReadQueries` (срез refresh/login); далее — follow graph, provisioner.

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
