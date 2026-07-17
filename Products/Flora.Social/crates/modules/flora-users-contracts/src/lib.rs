//! Контракты модуля Users — DTO и trait-порты без бизнес-логики (next-architecture.md §2.2).

use std::future::Future;
use std::pin::Pin;

use chrono::{DateTime, Utc};
use uuid::Uuid;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// `(user_uuid, display_name, avatar_uuid)` — пакетный lookup для search/followers.
pub type ProfileFieldsRow = (Uuid, Option<String>, Option<Uuid>);

/// `(user_uuid, last_seen_utc)` — пакетное чтение presence.
pub type LastSeenRow = (Uuid, DateTime<Utc>);

/// Порт чтения профиля (C# `IUserProfileReadQueries` / god-controller profile checks).
pub trait UserProfileReadQueries: Send + Sync {
    /// `true`, если нет строки профиля или `display_name` пуст (шаг «Имя» на клиенте).
    fn requires_profile_completion(&self, user_uuid: Uuid) -> BoxFuture<'_, Result<bool, String>>;
}

/// Порт `IUserProfileProvisioner` — Auth создаёт пустой профиль при регистрации.
pub trait UserProfileProvisioner: Send + Sync {
    fn ensure_initial_profile(
        &self,
        user_uuid: Uuid,
        display_name: &str,
    ) -> BoxFuture<'_, Result<(), String>>;
}

#[derive(Debug, Clone)]
pub struct ProfileSnapshot {
    pub display_name: String,
    pub status: String,
    pub gender: Option<i32>,
    pub birth_date: Option<String>,
    pub avatar_uuid: Option<Uuid>,
}

/// Расширенное чтение профиля для HTTP Users.
pub trait UserProfileQueries: Send + Sync {
    fn get_profile(
        &self,
        user_uuid: Uuid,
    ) -> BoxFuture<'_, Result<Option<ProfileSnapshot>, String>>;

    fn display_names_by_uuids(
        &self,
        user_uuids: &[Uuid],
    ) -> BoxFuture<'_, Result<Vec<(Uuid, String)>, String>>;

    fn followers_count(&self, user_uuid: Uuid) -> BoxFuture<'_, Result<i64, String>>;

    fn following_people_count(&self, user_uuid: Uuid) -> BoxFuture<'_, Result<i64, String>>;

    fn upsert_profile_fields(
        &self,
        user_uuid: Uuid,
        display_name: Option<&str>,
        gender: Option<i32>,
        birth_date: Option<&str>,
        status: Option<&str>,
        fallback_username: &str,
    ) -> BoxFuture<'_, Result<(), String>>;

    /// `display_name` ILIKE `%query%` (lower), исключая `exclude_user_uuid`.
    fn search_user_uuids_by_display_name_contains(
        &self,
        exclude_user_uuid: Uuid,
        query_lower: &str,
    ) -> BoxFuture<'_, Result<Vec<Uuid>, String>>;

    /// Пакетное чтение display_name + avatar для search/followers list.
    fn profile_fields_by_uuids(
        &self,
        user_uuids: &[Uuid],
    ) -> BoxFuture<'_, Result<Vec<ProfileFieldsRow>, String>>;

    /// Подписчики профиля (ordered by follower_user_uuid), skip/take.
    fn list_follower_user_uuids(
        &self,
        owner_user_uuid: Uuid,
        skip: i32,
        take: i32,
    ) -> BoxFuture<'_, Result<Vec<Uuid>, String>>;

    /// Подписки профиля (ordered by following_user_uuid), skip/take.
    fn list_following_user_uuids(
        &self,
        owner_user_uuid: Uuid,
        skip: i32,
        take: i32,
    ) -> BoxFuture<'_, Result<Vec<Uuid>, String>>;
}

/// Мутации графа подписок (`user_followers`).
pub trait UserFollowMutations: Send + Sync {
    /// `Ok(true)` — вставлена новая подписка; `Ok(false)` — уже была.
    fn follow(
        &self,
        follower_user_uuid: Uuid,
        following_user_uuid: Uuid,
    ) -> BoxFuture<'_, Result<bool, String>>;

    /// `Ok(true)` — строка удалена; `Ok(false)` — подписки не было.
    fn unfollow(
        &self,
        follower_user_uuid: Uuid,
        following_user_uuid: Uuid,
    ) -> BoxFuture<'_, Result<bool, String>>;

    fn following_among(
        &self,
        follower_user_uuid: Uuid,
        candidate_following_uuids: &[Uuid],
    ) -> BoxFuture<'_, Result<Vec<Uuid>, String>>;
}

#[derive(Debug, Clone)]
pub struct PrivacySettingsDto {
    pub friends_visibility: String,
    pub subscriptions_visibility: String,
    pub posts_visibility: String,
    pub likes_visibility: String,
    pub reposts_visibility: String,
    pub messages_from: String,
    pub comments_from: String,
    pub online_friends: String,
    pub online_strangers: String,
}

#[derive(Debug, Clone, Default)]
pub struct PrivacySettingsPatch {
    pub friends_visibility: Option<String>,
    pub subscriptions_visibility: Option<String>,
    pub posts_visibility: Option<String>,
    pub likes_visibility: Option<String>,
    pub reposts_visibility: Option<String>,
    pub messages_from: Option<String>,
    pub comments_from: Option<String>,
    pub online_friends: Option<String>,
    pub online_strangers: Option<String>,
}

pub trait UserPrivacySettings: Send + Sync {
    fn get(&self, user_uuid: Uuid) -> BoxFuture<'_, Result<PrivacySettingsDto, String>>;

    fn update(
        &self,
        user_uuid: Uuid,
        patch: PrivacySettingsPatch,
    ) -> BoxFuture<'_, Result<PrivacySettingsDto, String>>;
}

#[derive(Debug, Clone)]
pub struct BlockRecord {
    pub blocked_user_uuid: Uuid,
    pub blocked_at_utc: DateTime<Utc>,
}

pub trait UserBlocklist: Send + Sync {
    fn list(&self, owner_user_uuid: Uuid) -> BoxFuture<'_, Result<Vec<BlockRecord>, String>>;

    fn block(
        &self,
        owner_user_uuid: Uuid,
        blocked_user_uuid: Uuid,
    ) -> BoxFuture<'_, Result<(), String>>;

    fn unblock(
        &self,
        owner_user_uuid: Uuid,
        blocked_user_uuid: Uuid,
    ) -> BoxFuture<'_, Result<(), String>>;
}

pub trait UserPresence: Send + Sync {
    fn touch(&self, user_uuid: Uuid) -> BoxFuture<'_, Result<(), String>>;

    /// Пакетное чтение last-seen (C# `GetLastSeenUtcByUserUuidsAsync`).
    fn last_seen_by_uuids(
        &self,
        user_uuids: &[Uuid],
    ) -> BoxFuture<'_, Result<Vec<LastSeenRow>, String>>;
}

/// Поле политики доступа к профилю (C# `ProfileAccessField`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileAccessField {
    Friends,
    Subscriptions,
    Posts,
    Likes,
    Reposts,
    Comments,
}

/// Порт `IProfileAccessPolicy` — видимость секций профиля (posts/likes/followers/…).
pub trait ProfileAccess: Send + Sync {
    fn can_access(
        &self,
        viewer_user_uuid: Option<Uuid>,
        owner_user_uuid: Uuid,
        field: ProfileAccessField,
    ) -> BoxFuture<'_, Result<bool, String>>;
}

/// Порт `IProfileAccessPolicy` для поля OnlineStatus (Messaging list enrichment).
pub trait OnlineStatusAccess: Send + Sync {
    fn can_see_online(
        &self,
        viewer_user_uuid: Uuid,
        subject_user_uuid: Uuid,
    ) -> BoxFuture<'_, Result<bool, String>>;
}

/// Порт `IProfileAccessPolicy` для поля Messages (public profile `canMessageByMe`, compose gate).
pub trait MessagesAccess: Send + Sync {
    fn can_send_messages(
        &self,
        viewer_user_uuid: Uuid,
        subject_user_uuid: Uuid,
    ) -> BoxFuture<'_, Result<bool, String>>;
}

/// Порт `IFollowGraphReader` — чтение графа подписок для Content/FIRA-F.
pub trait FollowGraphReader: Send + Sync {
    fn following_user_ids(
        &self,
        follower_user_uuid: Uuid,
    ) -> BoxFuture<'_, Result<Vec<Uuid>, String>>;

    fn following_user_ids_for_followers(
        &self,
        follower_user_uuids: &[Uuid],
        exclude_user_uuid: Uuid,
    ) -> BoxFuture<'_, Result<Vec<Uuid>, String>>;

    fn follower_counts(&self, user_ids: &[Uuid])
    -> BoxFuture<'_, Result<Vec<(Uuid, i32)>, String>>;
}

/// Порт bidirectional blocklist (`IUserBlocklistService.GetBlockedUserIdsBidirectionalAsync`).
pub trait BidirectionalBlocklist: Send + Sync {
    fn blocked_user_ids_bidirectional(
        &self,
        user_uuid: Uuid,
    ) -> BoxFuture<'_, Result<Vec<Uuid>, String>>;
}

/// Минимальный снимок автора для сериализации ленты/постов.
#[derive(Debug, Clone)]
pub struct FeedAuthorProfile {
    pub user_uuid: Uuid,
    pub display_name: String,
    pub avatar_uuid: Option<Uuid>,
}

/// Пакетное чтение профилей для Content (без бизнес-логики).
pub trait FeedAuthorProfiles: Send + Sync {
    fn by_uuids(
        &self,
        user_uuids: &[Uuid],
    ) -> BoxFuture<'_, Result<Vec<FeedAuthorProfile>, String>>;
}

/// Opaque media blob пользователя. Выбор wire-варианта выполняет HTTP-слой
/// потребителя; Users остаётся единственным читателем своей avatar-таблицы.
#[derive(Debug, Clone)]
pub struct UserAvatarMediaBlob {
    pub data: Vec<u8>,
    pub content_type: String,
}

pub trait UserAvatarMedia: Send + Sync {
    fn by_uuid(
        &self,
        avatar_uuid: Uuid,
    ) -> BoxFuture<'_, Result<Option<UserAvatarMediaBlob>, String>>;
}
