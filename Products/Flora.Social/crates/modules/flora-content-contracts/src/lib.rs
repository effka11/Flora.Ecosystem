//! Контракты модуля Content — DTO и trait-порты без бизнес-логики (next-architecture.md §2.2).

use std::future::Future;
use std::pin::Pin;

use uuid::Uuid;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Порт статистики подписок на сообщества для `GET /api/auth/me` (Фаза 2b мост).
pub trait CommunityFollowStats: Send + Sync {
    /// Число публичных сообществ, на которые подписан пользователь, исключая owned.
    fn count_public_following(
        &self,
        user_uuid: Uuid,
    ) -> BoxFuture<'_, Result<i64, String>>;
}
