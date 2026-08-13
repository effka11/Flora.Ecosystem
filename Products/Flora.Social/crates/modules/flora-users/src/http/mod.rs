//! HTTP Users — me / privacy / blocks / profile (Users:ServeNative).

pub mod rate_limit;

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{DefaultBodyLimit, Extension, Multipart, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use chrono::{DateTime, SecondsFormat, Utc};
use flora_auth_contracts::AccountDirectory;
use flora_content_contracts::CommunityFollowStats;
use flora_notifications_contracts::UserNotificationDispatcher;
use flora_shared::latin_identifiers::{
    USERNAME_FORMAT_MESSAGE, has_only_username_chars, normalize_username,
};
use flora_users_contracts::{
    FollowGraphReader, MessagesAccess, PrivacySettingsDto, PrivacySettingsPatch, ProfileAccess,
    ProfileAccessField, UserBlocklist, UserFollowMutations, UserPresence, UserPrivacySettings,
    UserProfileQueries,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::application::avatar::{
    AvatarService, AvatarUploadError, AvatarUploadInput, MAX_AVATAR_SIZE_BYTES,
};
use crate::application::follow_notifications::{try_notify_follow, try_retract_follow};
use crate::application::people_recommendation::PeopleRecommendationService;
use crate::application::people_search::PeopleSearchHost;
use crate::application::presence::{MAX_WATCH_UUIDS, PresenceService};
use crate::application::profile::{
    PersistProfileError, PersistProfileUpdate, persist_profile_update,
};
use crate::http::rate_limit::{FixedWindowLimiter, client_ip_key};

/// JWT user (внедряет flora-social).
#[derive(Clone, Debug)]
pub struct CurrentUser {
    pub user_uuid: Uuid,
}

#[derive(Clone)]
pub struct UsersState {
    pub profiles: Arc<dyn UserProfileQueries>,
    pub privacy: Arc<dyn UserPrivacySettings>,
    pub blocklist: Arc<dyn UserBlocklist>,
    pub presence: Arc<dyn UserPresence>,
    pub presence_service: Arc<PresenceService>,
    pub accounts: Arc<dyn AccountDirectory>,
    pub communities: Arc<dyn CommunityFollowStats>,
    pub follows: Arc<dyn UserFollowMutations>,
    pub follow_graph: Arc<dyn FollowGraphReader>,
    pub messages_access: Arc<dyn MessagesAccess>,
    pub profile_access: Arc<dyn ProfileAccess>,
    pub avatars: Arc<AvatarService>,
    pub recommendations: Arc<PeopleRecommendationService>,
    pub notifications: Arc<dyn UserNotificationDispatcher>,
    pub people_search: Arc<PeopleSearchHost>,
    pub upload_limiter: Arc<FixedWindowLimiter>,
}

const AVATAR_BODY_LIMIT: usize = MAX_AVATAR_SIZE_BYTES + 64 * 1024;

pub fn protected_router(state: UsersState) -> Router {
    Router::new()
        .route("/api/auth/me", get(get_me))
        .route(
            "/api/auth/me/privacy",
            get(get_privacy).patch(update_privacy),
        )
        .route("/api/auth/me/blocks", get(list_blocks))
        .route(
            "/api/auth/me/blocks/{username}",
            post(block_user).delete(unblock_user),
        )
        .route("/api/auth/profile", axum::routing::patch(update_profile))
        .route(
            "/api/auth/profile/avatar",
            post(upload_avatar)
                .layer(DefaultBodyLimit::max(AVATAR_BODY_LIMIT))
                .delete(delete_avatar),
        )
        .route(
            "/api/auth/profile/{username}/follow",
            post(follow_user).delete(unfollow_user),
        )
        .route("/api/auth/users/search", get(search_users))
        .route("/api/auth/users/recommended", get(get_recommended_users))
        .route(
            "/api/auth/users/{user_uuid}/dismiss",
            post(dismiss_recommended_user).delete(undismiss_recommended_user),
        )
        .route(
            "/api/auth/users/by-username/{username}",
            get(get_user_by_username),
        )
        .route("/api/auth/presence/heartbeat", post(presence_heartbeat))
        // POST primary: edge CDN on flora-s.net rejects PUT with nginx 405 (same as chat-organizer).
        .route(
            "/api/auth/presence/watch",
            post(presence_watch).put(presence_watch),
        )
        .route("/api/auth/presence", get(presence_batch))
        .with_state(state)
}

pub fn public_router(state: UsersState) -> Router {
    Router::new()
        .route("/api/auth/profile/{username}", get(get_profile_by_username))
        .route(
            "/api/auth/profile/{username}/followers",
            get(get_profile_followers),
        )
        .route(
            "/api/auth/profile/{username}/following",
            get(get_profile_following),
        )
        .with_state(state)
}

async fn get_profile_by_username(
    State(state): State<UsersState>,
    Path(username): Path<String>,
    viewer: Option<Extension<CurrentUser>>,
) -> Response {
    let normalized = normalize_username(Some(&username), 50);
    if normalized.is_empty() {
        return bad_request("Укажите юзернейм.".into());
    }
    let Some(user_uuid) = (match state.accounts.find_uuid_by_username(&normalized).await {
        Ok(v) => v,
        Err(e) => return internal(e),
    }) else {
        return not_found("Пользователь не найден.");
    };
    let Some(account) = (match state.accounts.get_public(user_uuid).await {
        Ok(v) => v,
        Err(e) => return internal(e),
    }) else {
        return not_found("Пользователь не найден.");
    };

    let profile = match state.profiles.get_profile(account.user_uuid).await {
        Ok(p) => p,
        Err(e) => return internal(e),
    };
    let (display_name, status, avatar_uuid) = match profile {
        Some(p) => (
            p.display_name,
            p.status,
            p.avatar_uuid.map(|u| u.to_string()),
        ),
        None => (String::new(), String::new(), None),
    };

    let followers_count = match state.profiles.followers_count(account.user_uuid).await {
        Ok(n) => n,
        Err(e) => return internal(e),
    };
    let following_people_count = match state
        .profiles
        .following_people_count(account.user_uuid)
        .await
    {
        Ok(n) => n,
        Err(e) => return internal(e),
    };
    let following_communities_count = match state
        .communities
        .count_public_following(account.user_uuid)
        .await
    {
        Ok(n) => n,
        Err(e) => return internal(e),
    };

    let mut is_online = false;
    let mut last_seen_at: Option<String> = None;
    if let Some(Extension(viewer)) = viewer.as_ref() {
        match presence_fields_for(&state, Some(viewer.user_uuid), &[account.user_uuid]).await {
            Ok(map) => {
                if let Some((online, seen)) = map.get(&account.user_uuid) {
                    is_online = *online;
                    last_seen_at = seen.clone();
                }
            }
            Err(e) => return internal(e),
        }
    }

    let mut is_following_by_me = false;
    let mut can_message_by_me = false;
    if let Some(Extension(viewer)) = viewer
        && viewer.user_uuid != account.user_uuid
    {
        let following = match state
            .follows
            .following_among(viewer.user_uuid, &[account.user_uuid])
            .await
        {
            Ok(v) => v,
            Err(e) => return internal(e),
        };
        is_following_by_me = following.contains(&account.user_uuid);
        can_message_by_me = match state
            .messages_access
            .can_send_messages(viewer.user_uuid, account.user_uuid)
            .await
        {
            Ok(v) => v,
            Err(e) => return internal(e),
        };
    }

    let resolved_display_name = if display_name.is_empty() {
        account.username.clone()
    } else {
        display_name
    };

    Json(PublicProfileResponse {
        user_uuid: account.user_uuid,
        username: account.username,
        display_name: resolved_display_name,
        status,
        avatar_uuid,
        followers_count,
        following_count: following_people_count + following_communities_count,
        is_following_by_me,
        can_message_by_me,
        is_online,
        last_seen_at,
    })
    .into_response()
}

#[derive(Debug, Deserialize)]
struct FollowListQuery {
    #[serde(default)]
    skip: i32,
    #[serde(default = "default_follow_take")]
    take: i32,
}

fn default_follow_take() -> i32 {
    50
}

async fn get_profile_followers(
    State(state): State<UsersState>,
    Path(username): Path<String>,
    Query(params): Query<FollowListQuery>,
    viewer: Option<Extension<CurrentUser>>,
) -> Response {
    get_follow_list(
        state,
        username,
        params,
        viewer,
        ProfileAccessField::Friends,
        true,
    )
    .await
}

async fn get_profile_following(
    State(state): State<UsersState>,
    Path(username): Path<String>,
    Query(params): Query<FollowListQuery>,
    viewer: Option<Extension<CurrentUser>>,
) -> Response {
    get_follow_list(
        state,
        username,
        params,
        viewer,
        ProfileAccessField::Subscriptions,
        false,
    )
    .await
}

async fn get_follow_list(
    state: UsersState,
    username: String,
    params: FollowListQuery,
    viewer: Option<Extension<CurrentUser>>,
    field: ProfileAccessField,
    followers: bool,
) -> Response {
    let normalized = normalize_username(Some(&username), 50);
    if normalized.is_empty() {
        return bad_request("Укажите юзернейм.".into());
    }
    let Some(user_uuid) = (match state.accounts.find_uuid_by_username(&normalized).await {
        Ok(v) => v,
        Err(e) => return internal(e),
    }) else {
        return not_found("Пользователь не найден.");
    };

    let viewer_uuid = viewer.map(|Extension(u)| u.user_uuid);
    let can_access = match state
        .profile_access
        .can_access(viewer_uuid, user_uuid, field)
        .await
    {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    if !can_access {
        return Json(serde_json::json!([])).into_response();
    }

    let take = params.take.clamp(1, 100);
    let skip = params.skip.max(0);
    let ids = match if followers {
        state
            .profiles
            .list_follower_user_uuids(user_uuid, skip, take)
            .await
    } else {
        state
            .profiles
            .list_following_user_uuids(user_uuid, skip, take)
            .await
    } {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    if ids.is_empty() {
        return Json(serde_json::json!([])).into_response();
    }

    let usernames = match state.accounts.usernames_by_uuids(&ids).await {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    let user_by: std::collections::HashMap<_, _> = usernames.into_iter().collect();
    let profile_fields = match state.profiles.profile_fields_by_uuids(&ids).await {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    let profile_by: std::collections::HashMap<_, _> = profile_fields
        .into_iter()
        .map(|(id, dn, av)| (id, (dn.unwrap_or_default(), av)))
        .collect();
    let follower_counts = match state.follow_graph.follower_counts(&ids).await {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    let count_by: std::collections::HashMap<_, _> = follower_counts.into_iter().collect();

    let presence_by = match presence_fields_for(&state, viewer_uuid, &ids).await {
        Ok(v) => v,
        Err(e) => return internal(e),
    };

    let list: Vec<FollowListItem> = ids
        .into_iter()
        .map(|uid| {
            let username = user_by.get(&uid).cloned().unwrap_or_default();
            let (display_name, avatar_uuid) = profile_by.get(&uid).cloned().unwrap_or_default();
            let (is_online, last_seen_at) = presence_by.get(&uid).cloned().unwrap_or((false, None));
            FollowListItem {
                user_uuid: uid,
                username,
                display_name,
                avatar_uuid: avatar_uuid.map(|u| u.to_string()),
                follower_count: i64::from(*count_by.get(&uid).unwrap_or(&0)),
                is_online,
                last_seen_at,
            }
        })
        .collect();

    Json(list).into_response()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresenceWatchBody {
    connection_id: Uuid,
    #[serde(default)]
    user_uuids: Vec<Uuid>,
}

#[derive(Debug, Deserialize)]
struct PresenceBatchQuery {
    /// Comma-separated UUIDs.
    uuids: Option<String>,
}

async fn presence_heartbeat(
    State(state): State<UsersState>,
    Extension(user): Extension<CurrentUser>,
) -> Response {
    match state.presence_service.touch(user.user_uuid).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => internal(e),
    }
}

async fn presence_watch(
    State(state): State<UsersState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<PresenceWatchBody>,
) -> Response {
    if body.user_uuids.len() > MAX_WATCH_UUIDS {
        return bad_request("too many uuids".into());
    }
    match state
        .presence_service
        .set_watch(user.user_uuid, body.connection_id, &body.user_uuids)
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) if e.contains("unknown connectionId") => bad_request(e),
        Err(e) => bad_request(e),
    }
}

async fn presence_batch(
    State(state): State<UsersState>,
    Extension(user): Extension<CurrentUser>,
    Query(q): Query<PresenceBatchQuery>,
) -> Response {
    let raw = q.uuids.unwrap_or_default();
    let mut ids = Vec::new();
    for part in raw.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        match Uuid::parse_str(part) {
            Ok(u) => ids.push(u),
            Err(_) => return bad_request("invalid uuid".into()),
        }
    }
    if ids.len() > MAX_WATCH_UUIDS {
        return bad_request("too many uuids".into());
    }
    match state
        .presence_service
        .snapshot_for_viewer(user.user_uuid, &ids)
        .await
    {
        Ok(rows) => {
            let items: Vec<_> = rows
                .into_iter()
                .map(|r| {
                    serde_json::json!({
                        "userUuid": r.user_uuid,
                        "isOnline": r.is_online,
                        "lastSeenAt": r.last_seen_iso(),
                    })
                })
                .collect();
            Json(serde_json::json!({ "items": items })).into_response()
        }
        Err(e) => {
            if e.contains("too many") {
                bad_request(e)
            } else {
                internal(e)
            }
        }
    }
}

async fn presence_fields_for(
    state: &UsersState,
    viewer: Option<Uuid>,
    subjects: &[Uuid],
) -> Result<std::collections::HashMap<Uuid, (bool, Option<String>)>, String> {
    let Some(viewer) = viewer else {
        return Ok(subjects.iter().map(|id| (*id, (false, None))).collect());
    };
    let snaps = state
        .presence_service
        .snapshot_for_viewer(viewer, subjects)
        .await?;
    Ok(snaps
        .into_iter()
        .map(|s| (s.user_uuid, (s.is_online, s.last_seen_iso())))
        .collect())
}

async fn get_me(
    State(state): State<UsersState>,
    Extension(user): Extension<CurrentUser>,
) -> Response {
    let Some(account) = (match state.accounts.get_public(user.user_uuid).await {
        Ok(v) => v,
        Err(e) => return internal(e),
    }) else {
        return not_found("Аккаунт не найден.");
    };

    let profile = match state.profiles.get_profile(user.user_uuid).await {
        Ok(p) => p,
        Err(e) => return internal(e),
    };
    let (display_name, status, gender, birth_date, avatar_uuid) = match profile {
        Some(p) => (
            p.display_name,
            p.status,
            p.gender,
            p.birth_date,
            p.avatar_uuid.map(|u| u.to_string()),
        ),
        None => (String::new(), String::new(), None, None, None),
    };

    let followers = match state.profiles.followers_count(user.user_uuid).await {
        Ok(n) => n,
        Err(e) => return internal(e),
    };
    let following_people = match state.profiles.following_people_count(user.user_uuid).await {
        Ok(n) => n,
        Err(e) => return internal(e),
    };
    let following_communities = match state
        .communities
        .count_public_following(user.user_uuid)
        .await
    {
        Ok(n) => n,
        Err(e) => return internal(e),
    };

    Json(MeResponse {
        user_uuid: account.user_uuid,
        username: account.username,
        display_name,
        status,
        gender,
        birth_date,
        avatar_uuid,
        phone: account.phone,
        email: account.email,
        followers_count: followers,
        following_count: following_people + following_communities,
    })
    .into_response()
}

async fn get_privacy(
    State(state): State<UsersState>,
    Extension(user): Extension<CurrentUser>,
) -> Response {
    match state.privacy.get(user.user_uuid).await {
        Ok(dto) => Json(privacy_json(&dto)).into_response(),
        Err(e) => internal(e),
    }
}

async fn update_privacy(
    State(state): State<UsersState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<UpdatePrivacyRequest>,
) -> Response {
    let online_visibility_changed =
        body.online_friends.is_some() || body.online_strangers.is_some();
    let patch = PrivacySettingsPatch {
        friends_visibility: body.friends_visibility,
        subscriptions_visibility: body.subscriptions_visibility,
        posts_visibility: body.posts_visibility,
        likes_visibility: body.likes_visibility,
        reposts_visibility: body.reposts_visibility,
        messages_from: body.messages_from,
        comments_from: body.comments_from,
        online_friends: body.online_friends,
        online_strangers: body.online_strangers,
    };
    match state.privacy.update(user.user_uuid, patch).await {
        Ok(dto) => {
            if online_visibility_changed {
                state
                    .presence_service
                    .republish_for_subject(user.user_uuid)
                    .await;
            }
            Json(privacy_json(&dto)).into_response()
        }
        Err(e) if e.starts_with("Недопустимое") => bad_request(e),
        Err(e) => internal(e),
    }
}

async fn list_blocks(
    State(state): State<UsersState>,
    Extension(user): Extension<CurrentUser>,
) -> Response {
    let rows = match state.blocklist.list(user.user_uuid).await {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    if rows.is_empty() {
        return Json(serde_json::json!([])).into_response();
    }
    let ids: Vec<Uuid> = rows.iter().map(|r| r.blocked_user_uuid).collect();
    let usernames = match state.accounts.usernames_by_uuids(&ids).await {
        Ok(u) => u,
        Err(e) => return internal(e),
    };
    let display_names = match state.profiles.display_names_by_uuids(&ids).await {
        Ok(d) => d,
        Err(e) => return internal(e),
    };
    let user_by: std::collections::HashMap<_, _> = usernames.into_iter().collect();
    let name_by: std::collections::HashMap<_, _> = display_names.into_iter().collect();

    let list: Vec<BlockListItem> = rows
        .into_iter()
        .map(|row| {
            let username = user_by
                .get(&row.blocked_user_uuid)
                .cloned()
                .unwrap_or_default();
            let display = name_by
                .get(&row.blocked_user_uuid)
                .cloned()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| username.clone());
            BlockListItem {
                user_uuid: row.blocked_user_uuid,
                username,
                display_name: display,
                blocked_at_utc: format_utc(row.blocked_at_utc),
            }
        })
        .collect();
    Json(list).into_response()
}

async fn block_user(
    State(state): State<UsersState>,
    Extension(user): Extension<CurrentUser>,
    Path(username): Path<String>,
) -> Response {
    let normalized = normalize_username(Some(&username), 50);
    if normalized.is_empty() {
        return bad_request("Укажите юзернейм.".into());
    }
    let Some(target) = (match state.accounts.find_uuid_by_username(&normalized).await {
        Ok(v) => v,
        Err(e) => return internal(e),
    }) else {
        return not_found("Пользователь не найден.");
    };
    match state.blocklist.block(user.user_uuid, target).await {
        Ok(()) => {
            // Blocker is subject: blocked viewer must drop online badge immediately.
            state
                .presence_service
                .republish_for_subject(user.user_uuid)
                .await;
            Json(serde_json::json!({ "message": "Пользователь заблокирован." })).into_response()
        }
        Err(e) if e.contains("Нельзя заблокировать") => bad_request(e),
        Err(e) => internal(e),
    }
}

async fn unblock_user(
    State(state): State<UsersState>,
    Extension(user): Extension<CurrentUser>,
    Path(username): Path<String>,
) -> Response {
    let normalized = normalize_username(Some(&username), 50);
    if normalized.is_empty() {
        return bad_request("Укажите юзернейм.".into());
    }
    let Some(target) = (match state.accounts.find_uuid_by_username(&normalized).await {
        Ok(v) => v,
        Err(e) => return internal(e),
    }) else {
        return not_found("Пользователь не найден.");
    };
    match state.blocklist.unblock(user.user_uuid, target).await {
        Ok(()) => {
            state
                .presence_service
                .republish_for_subject(user.user_uuid)
                .await;
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => internal(e),
    }
}

async fn update_profile(
    State(state): State<UsersState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<UpdateProfileRequest>,
) -> Response {
    let username = normalize_username(body.username.as_deref(), 50);
    let display_name = body
        .display_name
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_string();

    if !username.is_empty() {
        if !has_only_username_chars(body.username.as_deref()) {
            return bad_request(USERNAME_FORMAT_MESSAGE.into());
        }
        if username.len() > 50 {
            return bad_request("Юзернейм не более 50 символов.".into());
        }
        if username.len() < 2 || username.chars().all(|c| c == '_') {
            return bad_request(
                "Юзернейм: минимум 2 символа, не только подчёркивания; используйте буквы или цифры."
                    .into(),
            );
        }
        if state.accounts.is_username_reserved(&username) {
            return bad_request(
                "Этот никнейм зарезервирован системой и недоступен для регистрации.".into(),
            );
        }
    }
    if !display_name.is_empty() && display_name.len() > 100 {
        return bad_request("Имя не более 100 символов.".into());
    }
    if let Some(g) = body.gender
        && g != 0
        && g != 1
    {
        return bad_request("Пол: укажите 0 (мужской) или 1 (женский).".into());
    }
    if let Some(ref st) = body.status
        && st.len() > 150
    {
        return bad_request("Статус не более 150 символов.".into());
    }

    if let Some(ref bd) = body.birth_date
        && !bd.trim().is_empty()
    {
        let Ok(parsed) = chrono::NaiveDate::parse_from_str(bd.trim(), "%Y-%m-%d") else {
            return bad_request("Неверный формат даты рождения (ожидается ГГГГ-ММ-ДД).".into());
        };
        let today = chrono::Utc::now().date_naive();
        if parsed > today {
            return bad_request("Дата рождения не может быть в будущем.".into());
        }
        if parsed.year() < 1900 {
            return bad_request("Укажите год рождения не ранее 1900.".into());
        }
    }

    match persist_profile_update(
        state.accounts.as_ref(),
        state.profiles.as_ref(),
        state.people_search.as_ref(),
        PersistProfileUpdate {
            user_uuid: user.user_uuid,
            username,
            display_name: &display_name,
            gender: body.gender,
            birth_date: body.birth_date.as_deref(),
            status: body.status.as_deref(),
        },
    )
    .await
    {
        Ok(()) => Json(serde_json::json!({ "message": "Профиль обновлён." })).into_response(),
        Err(PersistProfileError::NotFound) => not_found("Аккаунт не найден."),
        Err(PersistProfileError::UsernameTaken) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": "Этот юзернейм уже занят." })),
        )
            .into_response(),
        Err(PersistProfileError::BadRequest(e)) => bad_request(e),
        Err(PersistProfileError::Internal(e)) => internal(e),
    }
}

async fn follow_user(
    State(state): State<UsersState>,
    Extension(user): Extension<CurrentUser>,
    Path(username): Path<String>,
) -> Response {
    let normalized = normalize_username(Some(&username), 50);
    if normalized.is_empty() {
        return bad_request("Укажите юзернейм.".into());
    }
    let Some(target) = (match state.accounts.find_uuid_by_username(&normalized).await {
        Ok(v) => v,
        Err(e) => return internal(e),
    }) else {
        return not_found("Пользователь не найден.");
    };
    if user.user_uuid == target {
        return bad_request("Нельзя подписаться на себя.".into());
    }
    match state.follows.follow(user.user_uuid, target).await {
        Ok(true) => {
            state.recommendations.invalidate(user.user_uuid);
            try_notify_follow(
                &state.notifications,
                &state.accounts,
                &state.profiles,
                user.user_uuid,
                target,
                &normalized,
            )
            .await;
            Json(serde_json::json!({ "message": "Подписка оформлена." })).into_response()
        }
        Ok(false) => Json(serde_json::json!({ "message": "Уже подписаны." })).into_response(),
        Err(e) => internal(e),
    }
}

async fn unfollow_user(
    State(state): State<UsersState>,
    Extension(user): Extension<CurrentUser>,
    Path(username): Path<String>,
) -> Response {
    let normalized = normalize_username(Some(&username), 50);
    if normalized.is_empty() {
        return bad_request("Укажите юзернейм.".into());
    }
    let Some(target) = (match state.accounts.find_uuid_by_username(&normalized).await {
        Ok(v) => v,
        Err(e) => return internal(e),
    }) else {
        return not_found("Пользователь не найден.");
    };
    match state.follows.unfollow(user.user_uuid, target).await {
        Ok(true) => {
            state.recommendations.invalidate(user.user_uuid);
            try_retract_follow(
                &state.notifications,
                &state.accounts,
                &state.profiles,
                user.user_uuid,
                target,
                &normalized,
            )
            .await;
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(false) => Json(serde_json::json!({ "message": "Подписки не было." })).into_response(),
        Err(e) => internal(e),
    }
}

#[derive(Debug, Deserialize)]
struct SearchUsersQuery {
    q: Option<String>,
    #[serde(default)]
    skip: i32,
    #[serde(default = "default_search_take")]
    take: i32,
}

fn default_search_take() -> i32 {
    20
}

async fn search_users(
    State(state): State<UsersState>,
    Extension(user): Extension<CurrentUser>,
    Query(params): Query<SearchUsersQuery>,
) -> Response {
    let query = params.q.unwrap_or_default().trim().to_string();
    if query.is_empty() {
        return Json(serde_json::json!([])).into_response();
    }
    let take = params.take.clamp(1, 50);
    let skip = params.skip.max(0);

    let ids = match state
        .people_search
        .search(&query, user.user_uuid, skip, take)
        .await
    {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    if ids.is_empty() {
        return Json(serde_json::json!([])).into_response();
    }

    let names = match state.accounts.usernames_by_uuids(&ids).await {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    let name_by: std::collections::HashMap<_, _> = names.into_iter().collect();
    let page: Vec<(Uuid, String)> = ids
        .into_iter()
        .filter_map(|id| {
            let username = name_by.get(&id).cloned().unwrap_or_default();
            if username.is_empty() {
                None
            } else {
                Some((id, username))
            }
        })
        .collect();
    if page.is_empty() {
        return Json(serde_json::json!([])).into_response();
    }

    let ids: Vec<Uuid> = page.iter().map(|(id, _)| *id).collect();
    let profile_fields = match state.profiles.profile_fields_by_uuids(&ids).await {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    let profile_by: std::collections::HashMap<_, _> = profile_fields
        .into_iter()
        .map(|(id, dn, av)| (id, (dn, av)))
        .collect();

    let follower_counts = match state.follow_graph.follower_counts(&ids).await {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    let count_by: std::collections::HashMap<_, _> = follower_counts.into_iter().collect();

    let following_set: std::collections::HashSet<_> =
        match state.follows.following_among(user.user_uuid, &ids).await {
            Ok(v) => v.into_iter().collect(),
            Err(e) => return internal(e),
        };

    let presence_by = match presence_fields_for(&state, Some(user.user_uuid), &ids).await {
        Ok(v) => v,
        Err(e) => return internal(e),
    };

    let list: Vec<UserSearchItem> = page
        .into_iter()
        .map(|(id, username)| {
            let (display_name, avatar_uuid) = profile_by.get(&id).cloned().unwrap_or((None, None));
            let (is_online, last_seen_at) = presence_by.get(&id).cloned().unwrap_or((false, None));
            UserSearchItem {
                username: username.clone(),
                display_name: display_name.filter(|s| !s.is_empty()).unwrap_or(username),
                avatar_uuid: avatar_uuid.map(|u| u.to_string()),
                follower_count: i64::from(*count_by.get(&id).unwrap_or(&0)),
                is_following: following_set.contains(&id),
                user_uuid: id,
                is_online,
                last_seen_at,
            }
        })
        .collect();

    Json(list).into_response()
}

async fn upload_avatar(
    State(state): State<UsersState>,
    Extension(user): Extension<CurrentUser>,
    headers: HeaderMap,
    multipart: Multipart,
) -> Response {
    let ip = client_ip_key(&headers);
    let key = format!("upload:{ip}:{}", user.user_uuid);
    if !state.upload_limiter.check_and_increment(&key) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }

    let file = match parse_avatar_file(multipart).await {
        Ok(Some(file)) => file,
        Ok(None) => {
            return bad_request("Выберите файл изображения (JPEG, PNG или WebP, до 2 МБ).".into());
        }
        Err(resp) => return resp,
    };

    match state.avatars.upload(user.user_uuid, file).await {
        Ok(avatar_uuid) => {
            Json(serde_json::json!({ "avatarUuid": avatar_uuid.to_string() })).into_response()
        }
        Err(AvatarUploadError::NoFile) => {
            bad_request("Выберите файл изображения (JPEG, PNG или WebP, до 2 МБ).".into())
        }
        Err(AvatarUploadError::FileTooLarge) => {
            bad_request("Файл не должен превышать 2 МБ.".into())
        }
        Err(AvatarUploadError::BadType) => {
            bad_request("Допустимые форматы: JPEG, PNG, WebP.".into())
        }
        Err(AvatarUploadError::Unreadable) => {
            bad_request("Файл не является корректным изображением (JPEG, PNG или WebP).".into())
        }
    }
}

async fn delete_avatar(
    State(state): State<UsersState>,
    Extension(user): Extension<CurrentUser>,
) -> Response {
    match state.avatars.delete(user.user_uuid).await {
        Ok(()) => Json(serde_json::json!({ "message": "Аватар удалён." })).into_response(),
        Err(e) => internal(e),
    }
}

async fn parse_avatar_file(
    mut multipart: Multipart,
) -> Result<Option<AvatarUploadInput>, Response> {
    let mut content_type = String::new();
    let mut bytes = Vec::new();
    while let Some(field) = multipart.next_field().await.map_err(multipart_bad)? {
        if field.name() != Some("file") {
            continue;
        }
        content_type = field
            .content_type()
            .map(|ct| ct.to_string())
            .unwrap_or_default();
        bytes = field.bytes().await.map_err(multipart_bad)?.to_vec();
        break;
    }
    if bytes.is_empty() {
        return Ok(None);
    }
    Ok(Some(AvatarUploadInput {
        content_type,
        bytes,
    }))
}

fn multipart_bad(e: axum::extract::multipart::MultipartError) -> Response {
    bad_request(e.to_string())
}

/// §User Controls (FIRA-P): «не интересно» для рекомендованного пользователя.
async fn dismiss_recommended_user(
    State(state): State<UsersState>,
    Extension(user): Extension<CurrentUser>,
    Path(target_uuid): Path<Uuid>,
) -> Response {
    if target_uuid == user.user_uuid {
        return bad_request("Нельзя отклонить рекомендацию самого себя.".into());
    }
    let known = match state.accounts.usernames_by_uuids(&[target_uuid]).await {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    if known.is_empty() {
        return not_found("Пользователь не найден.");
    }
    match state
        .recommendations
        .dismiss(user.user_uuid, target_uuid)
        .await
    {
        Ok(()) => Json(serde_json::json!({ "dismissed": true })).into_response(),
        Err(e) => internal(e),
    }
}

async fn undismiss_recommended_user(
    State(state): State<UsersState>,
    Extension(user): Extension<CurrentUser>,
    Path(target_uuid): Path<Uuid>,
) -> Response {
    match state
        .recommendations
        .undismiss(user.user_uuid, target_uuid)
        .await
    {
        Ok(_) => Json(serde_json::json!({ "dismissed": false })).into_response(),
        Err(e) => internal(e),
    }
}

#[derive(Debug, Deserialize)]
struct RecommendedUsersQuery {
    #[serde(default = "default_recommended_take")]
    take: i32,
}

fn default_recommended_take() -> i32 {
    30
}

async fn get_recommended_users(
    State(state): State<UsersState>,
    Extension(user): Extension<CurrentUser>,
    Query(params): Query<RecommendedUsersQuery>,
) -> Response {
    let (list, generated_at, expires_at) = match state
        .recommendations
        .get_recommended(user.user_uuid, params.take)
        .await
    {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    if list.is_empty() {
        return Json(serde_json::json!({
            "items": [],
            "generatedAt": format_utc(generated_at),
            "expiresAt": format_utc(expires_at),
        }))
        .into_response();
    }

    let user_ids: Vec<Uuid> = list.iter().map(|x| x.user_uuid).collect();
    let usernames = match state.accounts.usernames_by_uuids(&user_ids).await {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    let username_by: std::collections::HashMap<_, _> = usernames.into_iter().collect();

    let following_set: std::collections::HashSet<_> = match state
        .follows
        .following_among(user.user_uuid, &user_ids)
        .await
    {
        Ok(v) => v.into_iter().collect(),
        Err(e) => return internal(e),
    };

    let presence_by = match presence_fields_for(&state, Some(user.user_uuid), &user_ids).await {
        Ok(v) => v,
        Err(e) => return internal(e),
    };

    let items: Vec<RecommendedUserItem> = list
        .into_iter()
        .filter_map(|x| {
            let username = username_by.get(&x.user_uuid)?.clone();
            if username.is_empty() {
                return None;
            }
            let display_name = if x.display_name.trim().is_empty() {
                username.clone()
            } else {
                x.display_name
            };
            let (is_online, last_seen_at) = presence_by
                .get(&x.user_uuid)
                .cloned()
                .unwrap_or((false, None));
            Some(RecommendedUserItem {
                user_uuid: x.user_uuid,
                username,
                display_name,
                avatar_uuid: x.avatar_uuid.map(|u| u.to_string()),
                follower_count: i64::from(x.follower_count),
                is_following: following_set.contains(&x.user_uuid),
                is_online,
                last_seen_at,
            })
        })
        .collect();

    Json(serde_json::json!({
        "items": items,
        "generatedAt": format_utc(generated_at),
        "expiresAt": format_utc(expires_at),
    }))
    .into_response()
}

async fn get_user_by_username(
    State(state): State<UsersState>,
    Extension(user): Extension<CurrentUser>,
    Path(username): Path<String>,
) -> Response {
    let normalized = normalize_username(Some(&username), 50);
    if normalized.is_empty() {
        return bad_request("Укажите юзернейм.".into());
    }
    let Some(target_uuid) = (match state.accounts.find_uuid_by_username(&normalized).await {
        Ok(v) => v,
        Err(e) => return internal(e),
    }) else {
        return not_found("Пользователь не найден.");
    };
    if target_uuid == user.user_uuid {
        return bad_request("Нельзя начать переписку с собой.".into());
    }
    let Some(account) = (match state.accounts.get_public(target_uuid).await {
        Ok(v) => v,
        Err(e) => return internal(e),
    }) else {
        return not_found("Пользователь не найден.");
    };
    let profile = match state.profiles.get_profile(target_uuid).await {
        Ok(p) => p,
        Err(e) => return internal(e),
    };
    let display_name = profile
        .as_ref()
        .map(|p| p.display_name.clone())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| account.username.clone());
    let avatar_uuid = profile.and_then(|p| p.avatar_uuid).map(|u| u.to_string());

    Json(UserByUsernameResponse {
        user_uuid: account.user_uuid,
        username: account.username,
        display_name,
        avatar_uuid,
    })
    .into_response()
}

use chrono::Datelike;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProfileRequest {
    username: Option<String>,
    display_name: Option<String>,
    gender: Option<i32>,
    birth_date: Option<String>,
    status: Option<String>,
}

fn privacy_json(dto: &PrivacySettingsDto) -> serde_json::Value {
    serde_json::json!({
        "friendsVisibility": dto.friends_visibility,
        "subscriptionsVisibility": dto.subscriptions_visibility,
        "postsVisibility": dto.posts_visibility,
        "likesVisibility": dto.likes_visibility,
        "repostsVisibility": dto.reposts_visibility,
        "messagesFrom": dto.messages_from,
        "commentsFrom": dto.comments_from,
        "onlineFriends": dto.online_friends,
        "onlineStrangers": dto.online_strangers,
    })
}

fn format_utc(dt: DateTime<Utc>) -> String {
    dt.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn bad_request(msg: String) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({ "error": msg })),
    )
        .into_response()
}

fn not_found(msg: &'static str) -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({ "error": msg })),
    )
        .into_response()
}

fn internal(e: String) -> Response {
    tracing::error!(error = %e, "users http failed");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({ "error": "Внутренняя ошибка сервера." })),
    )
        .into_response()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicProfileResponse {
    user_uuid: Uuid,
    username: String,
    display_name: String,
    status: String,
    avatar_uuid: Option<String>,
    followers_count: i64,
    following_count: i64,
    is_following_by_me: bool,
    can_message_by_me: bool,
    is_online: bool,
    last_seen_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MeResponse {
    user_uuid: Uuid,
    username: String,
    display_name: String,
    status: String,
    gender: Option<i32>,
    birth_date: Option<String>,
    avatar_uuid: Option<String>,
    phone: String,
    email: String,
    followers_count: i64,
    following_count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BlockListItem {
    user_uuid: Uuid,
    username: String,
    display_name: String,
    blocked_at_utc: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdatePrivacyRequest {
    friends_visibility: Option<String>,
    subscriptions_visibility: Option<String>,
    posts_visibility: Option<String>,
    likes_visibility: Option<String>,
    reposts_visibility: Option<String>,
    messages_from: Option<String>,
    comments_from: Option<String>,
    online_friends: Option<String>,
    online_strangers: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FollowListItem {
    user_uuid: Uuid,
    username: String,
    display_name: String,
    avatar_uuid: Option<String>,
    follower_count: i64,
    is_online: bool,
    last_seen_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UserSearchItem {
    user_uuid: Uuid,
    username: String,
    display_name: String,
    avatar_uuid: Option<String>,
    follower_count: i64,
    is_following: bool,
    is_online: bool,
    last_seen_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecommendedUserItem {
    /// §User Controls (FIRA-P): нужен клиенту для POST /users/{uuid}/dismiss.
    user_uuid: Uuid,
    username: String,
    display_name: String,
    avatar_uuid: Option<String>,
    follower_count: i64,
    is_following: bool,
    is_online: bool,
    last_seen_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UserByUsernameResponse {
    user_uuid: Uuid,
    username: String,
    display_name: String,
    avatar_uuid: Option<String>,
}
