//! HTTP Content — ServeNative (protected + anonymous comments).

mod byte_range;
mod media;
mod rate_limit;
mod uploads;

use std::sync::Arc;
use std::time::Duration;

use axum::extract::{DefaultBodyLimit, Extension, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use uuid::Uuid;

use crate::application::comments::{
    CommentsError, CommentsService, CreateCommentError, DeleteCommentError,
    MAX_COMMENT_CONTENT_LENGTH,
};
use crate::application::communities::{CommunitiesService, CommunityError};
use crate::application::drafts::{
    CreateDraftError, DeleteDraftError, DraftsService, MAX_POST_DRAFTS_PER_USER, UpdateDraftError,
};
use crate::application::feed::FeedService;
use crate::application::feed_controls::{
    FeedControlsError, FeedControlsService, FeedSettingsPatch,
};
use crate::application::media::MediaService;
use crate::application::post_images::PostImagesService;
use crate::application::post_videos::{MAX_POST_VIDEO_BYTES, PostVideosService};
use crate::application::posts::{
    CreatePostError, DeletePostError, MAX_POST_CONTENT_LENGTH, PostActionError, PostService,
};
use crate::application::profile_posts::{ProfilePostsOutcome, ProfilePostsService};
use crate::application::serialize::FeedSerializer;
use crate::application::time::format_utc;
use crate::http::media::{MediaCache, cached_media_response, cached_ranged_media_response};
use crate::http::rate_limit::{FixedWindowLimiter, client_ip_key};

pub use crate::http::rate_limit::default_upload_limiter;

/// 5 MiB × 10 images + 4 MiB buffer — паритет C# RequestSizeLimit.
const POST_IMAGES_BODY_LIMIT: usize = 5 * 1024 * 1024 * 10 + 4 * 1024 * 1024;
/// 200 MiB + 1 MiB — паритет C# `[RequestSizeLimit(MaxPostVideoBytes + 1024 * 1024)]`.
const POST_VIDEO_BODY_LIMIT: usize = (MAX_POST_VIDEO_BYTES as usize) + 1024 * 1024;

#[derive(Clone)]
pub struct ContentState {
    pub feed: Arc<FeedService>,
    pub feed_controls: Arc<FeedControlsService>,
    pub serialize: Arc<FeedSerializer>,
    pub posts: Arc<PostService>,
    pub comments: Arc<CommentsService>,
    pub profile_posts: Arc<ProfilePostsService>,
    pub communities: Arc<CommunitiesService>,
    pub media: Arc<MediaService>,
    pub drafts: Arc<DraftsService>,
    pub post_images: Arc<PostImagesService>,
    pub post_videos: Arc<PostVideosService>,
    pub write_limiter: Arc<FixedWindowLimiter>,
    pub upload_limiter: Arc<FixedWindowLimiter>,
}

/// Пользователь из JWT (внедряет flora-social middleware).
#[derive(Clone, Copy, Debug)]
pub struct CurrentUser(pub Uuid);

pub fn protected_router(state: ContentState) -> Router {
    Router::new()
        .route("/api/auth/feed", get(get_feed))
        .route("/api/auth/feed/has-new", get(feed_has_new))
        .route("/api/auth/me/feed-settings", get(get_feed_settings))
        .route("/api/auth/me/feed-settings", patch(update_feed_settings))
        .route(
            "/api/auth/posts/{post_uuid}/not-interested",
            post(mark_post_not_interested),
        )
        .route(
            "/api/auth/posts/{post_uuid}/not-interested",
            delete(unmark_post_not_interested),
        )
        .route(
            "/api/auth/me/feed/not-interested",
            delete(clear_not_interested),
        )
        .route(
            "/api/auth/feed/authors/{author_uuid}/hide",
            post(hide_feed_author),
        )
        .route(
            "/api/auth/feed/authors/{author_uuid}/hide",
            delete(unhide_feed_author),
        )
        .route(
            "/api/auth/me/feed/hidden-authors",
            get(list_hidden_feed_authors),
        )
        .route(
            "/api/auth/communities/{community_id}/dismiss",
            post(dismiss_community),
        )
        .route(
            "/api/auth/communities/{community_id}/dismiss",
            delete(undismiss_community),
        )
        .route(
            "/api/auth/me/feed/dismissed-communities",
            get(list_dismissed_communities),
        )
        .route("/api/auth/posts", post(create_post))
        .route(
            "/api/auth/posts/{post_uuid}/images",
            post(uploads::upload_post_images).layer(DefaultBodyLimit::max(POST_IMAGES_BODY_LIMIT)),
        )
        .route(
            "/api/auth/posts/{post_uuid}/video",
            post(uploads::upload_post_video).layer(DefaultBodyLimit::max(POST_VIDEO_BODY_LIMIT)),
        )
        .route("/api/auth/post-drafts", get(list_post_drafts))
        .route("/api/auth/post-drafts", post(create_post_draft))
        .route(
            "/api/auth/post-drafts/{draft_uuid}",
            patch(update_post_draft),
        )
        .route(
            "/api/auth/post-drafts/{draft_uuid}",
            delete(delete_post_draft),
        )
        .route("/api/auth/posts/{post_uuid}/like", post(like_post))
        .route("/api/auth/posts/{post_uuid}/like", delete(unlike_post))
        .route("/api/auth/posts/{post_uuid}/repost", post(repost_post))
        .route("/api/auth/posts/{post_uuid}/repost", delete(unrepost_post))
        .route("/api/auth/posts/{post_uuid}/view", post(record_view))
        .route("/api/auth/posts/{post_uuid}", delete(delete_post))
        .route("/api/auth/posts/{post_uuid}/comments", post(create_comment))
        .route(
            "/api/auth/posts/{post_uuid}/comments/{comment_uuid}",
            delete(delete_comment),
        )
        .route("/api/auth/communities/owned", get(get_owned_communities))
        .route(
            "/api/auth/communities/recommended",
            get(get_recommended_communities),
        )
        .route("/api/auth/communities/search", get(search_communities))
        .route("/api/auth/communities", post(create_community))
        .route(
            "/api/auth/communities/{community_id}/join",
            post(join_community),
        )
        .route(
            "/api/auth/communities/{community_id}/join",
            delete(leave_community),
        )
        .route(
            "/api/auth/communities/{community_id}",
            patch(update_community),
        )
        .route(
            "/api/auth/communities/{community_id}",
            delete(delete_community),
        )
        .route(
            "/api/auth/communities/{community_id}/avatar",
            post(uploads::upload_community_avatar)
                .layer(DefaultBodyLimit::max(POST_IMAGES_BODY_LIMIT)),
        )
        .with_state(state)
}

pub fn public_router(state: ContentState) -> Router {
    Router::new()
        .route("/api/auth/posts/{post_uuid}/comments", get(get_comments))
        .route(
            "/api/auth/posts/{post_uuid}/comments/{comment_uuid}/replies",
            get(get_comment_replies),
        )
        .route("/api/auth/profile/{username}/posts", get(get_profile_posts))
        .route("/api/auth/profile/{username}/likes", get(get_profile_likes))
        .route(
            "/api/auth/profile/{username}/reposts",
            get(get_profile_reposts),
        )
        .route("/api/auth/communities", get(get_all_communities))
        .route(
            "/api/auth/communities/slug/{slug}",
            get(get_community_by_slug),
        )
        .route(
            "/api/auth/communities/{community_id}/posts",
            get(get_community_posts),
        )
        .route(
            "/api/auth/profile/{username}/communities",
            get(get_profile_communities),
        )
        .route("/api/auth/posts/images/{uuid}", get(get_post_image))
        .route("/api/auth/avatar/{uuid}", get(get_avatar))
        .route("/api/auth/posts/videos/{uuid}", get(get_post_video))
        .route(
            "/api/auth/posts/videos/{uuid}/poster",
            get(get_post_video_poster),
        )
        .route(
            "/api/auth/posts/{post_uuid}/video/status",
            get(get_post_video_status),
        )
        .with_state(state)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FeedQuery {
    take: Option<i32>,
    cursor: Option<String>,
    kind: Option<String>,
    refresh: Option<bool>,
}

async fn get_feed(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
    Query(q): Query<FeedQuery>,
) -> Response {
    let take = q.take.unwrap_or(20);
    let refresh = q.refresh.unwrap_or(false);
    match state
        .feed
        .get_feed(
            user.0,
            take,
            q.cursor.as_deref(),
            q.kind.as_deref(),
            refresh,
        )
        .await
    {
        Ok(page) => match state.serialize.serialize_page(user.0, page).await {
            Ok(body) => Json(body).into_response(),
            Err(e) => internal(e),
        },
        Err(e) => internal(e),
    }
}

#[derive(Debug, Deserialize)]
struct HasNewQuery {
    since: Option<String>,
}

async fn feed_has_new(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
    Query(q): Query<HasNewQuery>,
) -> Response {
    let Some(raw) = q.since.filter(|s| !s.trim().is_empty()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "Параметр 'since' обязателен (ISO 8601 UTC)."
            })),
        )
            .into_response();
    };
    let Ok(since) = DateTime::parse_from_rfc3339(raw.trim())
        .map(|dt| dt.with_timezone(&Utc))
        .or_else(|_| {
            chrono::NaiveDateTime::parse_from_str(raw.trim(), "%Y-%m-%dT%H:%M:%S%.f")
                .or_else(|_| chrono::NaiveDateTime::parse_from_str(raw.trim(), "%Y-%m-%dT%H:%M:%S"))
                .map(|n| DateTime::<Utc>::from_naive_utc_and_offset(n, Utc))
        })
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "Параметр 'since' обязателен (ISO 8601 UTC)."
            })),
        )
            .into_response();
    };
    if since.timestamp() == 0 && since.timestamp_subsec_nanos() == 0 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "Параметр 'since' обязателен (ISO 8601 UTC)."
            })),
        )
            .into_response();
    }

    match state.feed.has_new(user.0, since).await {
        Ok(has_new) => Json(serde_json::json!({
            "hasNew": has_new,
            "checkedAt": format_utc(Utc::now()),
        }))
        .into_response(),
        Err(e) => internal(e),
    }
}

// ---------------------------------------------------------------------------
// §User Controls: настройки ленты + «не интересно» (FIRA-F v1.1)
// ---------------------------------------------------------------------------

fn feed_controls_error(err: FeedControlsError) -> Response {
    match err {
        FeedControlsError::NotFound => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Не найдено." })),
        )
            .into_response(),
        FeedControlsError::Validation(message) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": message })),
        )
            .into_response(),
    }
}

async fn get_feed_settings(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
) -> Response {
    match state.feed_controls.get_settings(user.0).await {
        Ok(body) => Json(body).into_response(),
        Err(e) => internal(e),
    }
}

async fn update_feed_settings(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
    Json(patch): Json<FeedSettingsPatch>,
) -> Response {
    match state.feed_controls.update_settings(user.0, patch).await {
        Ok(Ok(body)) => Json(body).into_response(),
        Ok(Err(err)) => feed_controls_error(err),
        Err(e) => internal(e),
    }
}

async fn mark_post_not_interested(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
    Path(post_uuid): Path<Uuid>,
) -> Response {
    match state
        .feed_controls
        .mark_post_not_interested(user.0, post_uuid)
        .await
    {
        Ok(Ok(())) => Json(serde_json::json!({ "notInterested": true })).into_response(),
        Ok(Err(err)) => feed_controls_error(err),
        Err(e) => internal(e),
    }
}

async fn unmark_post_not_interested(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
    Path(post_uuid): Path<Uuid>,
) -> Response {
    match state
        .feed_controls
        .unmark_post_not_interested(user.0, post_uuid)
        .await
    {
        Ok(_) => Json(serde_json::json!({ "notInterested": false })).into_response(),
        Err(e) => internal(e),
    }
}

async fn clear_not_interested(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
) -> Response {
    match state.feed_controls.clear_not_interested(user.0).await {
        Ok(cleared) => Json(serde_json::json!({ "cleared": cleared })).into_response(),
        Err(e) => internal(e),
    }
}

async fn hide_feed_author(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
    Path(author_uuid): Path<Uuid>,
) -> Response {
    match state.feed_controls.hide_author(user.0, author_uuid).await {
        Ok(Ok(())) => Json(serde_json::json!({ "hidden": true })).into_response(),
        Ok(Err(err)) => feed_controls_error(err),
        Err(e) => internal(e),
    }
}

async fn unhide_feed_author(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
    Path(author_uuid): Path<Uuid>,
) -> Response {
    match state.feed_controls.unhide_author(user.0, author_uuid).await {
        Ok(_) => Json(serde_json::json!({ "hidden": false })).into_response(),
        Err(e) => internal(e),
    }
}

async fn list_hidden_feed_authors(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
) -> Response {
    match state.feed_controls.hidden_authors(user.0).await {
        Ok(body) => Json(body).into_response(),
        Err(e) => internal(e),
    }
}

async fn dismiss_community(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
    Path(community_id): Path<Uuid>,
) -> Response {
    match state
        .feed_controls
        .dismiss_community(user.0, community_id)
        .await
    {
        Ok(Ok(())) => Json(serde_json::json!({ "dismissed": true })).into_response(),
        Ok(Err(err)) => feed_controls_error(err),
        Err(e) => internal(e),
    }
}

async fn undismiss_community(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
    Path(community_id): Path<Uuid>,
) -> Response {
    match state
        .feed_controls
        .undismiss_community(user.0, community_id)
        .await
    {
        Ok(_) => Json(serde_json::json!({ "dismissed": false })).into_response(),
        Err(e) => internal(e),
    }
}

async fn list_dismissed_communities(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
) -> Response {
    match state.feed_controls.dismissed_communities(user.0).await {
        Ok(body) => Json(body).into_response(),
        Err(e) => internal(e),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreatePostBody {
    content: Option<String>,
    community_id: Option<Uuid>,
}

async fn create_post(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
    headers: axum::http::HeaderMap,
    Json(parsed): Json<CreatePostBody>,
) -> Response {
    let ip = client_ip_key(&headers);
    let key = format!("write:{ip}:{}", user.0);
    if !state.write_limiter.check_and_increment(&key) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }

    match state
        .posts
        .create(
            user.0,
            parsed.content.as_deref().unwrap_or(""),
            parsed.community_id,
        )
        .await
    {
        Ok(Ok(body)) => Json(body).into_response(),
        Ok(Err(CreatePostError::TooLong)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": format!("Пост не более {MAX_POST_CONTENT_LENGTH} символов.")
            })),
        )
            .into_response(),
        Ok(Err(CreatePostError::Forbidden)) => StatusCode::FORBIDDEN.into_response(),
        Err(e) => internal(e),
    }
}

async fn like_post(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
    Path(post_uuid): Path<Uuid>,
) -> Response {
    match state.posts.like(user.0, post_uuid).await {
        Ok(Ok(body)) => Json(body).into_response(),
        Ok(Err(PostActionError::NotFound)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Пост не найден." })),
        )
            .into_response(),
        Err(e) => internal(e),
    }
}

async fn unlike_post(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
    Path(post_uuid): Path<Uuid>,
) -> Response {
    match state.posts.unlike(user.0, post_uuid).await {
        Ok(body) => Json(body).into_response(),
        Err(e) => internal(e),
    }
}

async fn repost_post(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
    Path(post_uuid): Path<Uuid>,
) -> Response {
    match state.posts.repost(user.0, post_uuid).await {
        Ok(Ok(body)) => Json(body).into_response(),
        Ok(Err(PostActionError::NotFound)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Пост не найден." })),
        )
            .into_response(),
        Err(e) => internal(e),
    }
}

async fn unrepost_post(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
    Path(post_uuid): Path<Uuid>,
) -> Response {
    match state.posts.unrepost(user.0, post_uuid).await {
        Ok(body) => Json(body).into_response(),
        Err(e) => internal(e),
    }
}

async fn record_view(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
    Path(post_uuid): Path<Uuid>,
) -> Response {
    match state.posts.record_view(user.0, post_uuid).await {
        Ok(Ok(body)) => Json(body).into_response(),
        Ok(Err(PostActionError::NotFound)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Пост не найден." })),
        )
            .into_response(),
        Err(e) => internal(e),
    }
}

async fn delete_post(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
    Path(post_uuid): Path<Uuid>,
) -> Response {
    match state.posts.delete(user.0, post_uuid).await {
        Ok(Ok(())) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(DeletePostError::NotFound)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Пост не найден." })),
        )
            .into_response(),
        Ok(Err(DeletePostError::Forbidden)) => StatusCode::FORBIDDEN.into_response(),
        Err(e) => internal(e),
    }
}

#[derive(Debug, Deserialize)]
struct ListPostDraftsQuery {
    #[serde(rename = "communityId")]
    community_id: Option<Uuid>,
}

async fn list_post_drafts(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
    Query(q): Query<ListPostDraftsQuery>,
) -> Response {
    match state.drafts.list(user.0, q.community_id).await {
        Ok(list) => Json(list).into_response(),
        Err(e) => internal(e),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreatePostDraftBody {
    label: Option<String>,
    content: Option<String>,
    community_id: Option<Uuid>,
}

async fn create_post_draft(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
    headers: HeaderMap,
    Json(body): Json<CreatePostDraftBody>,
) -> Response {
    let ip = client_ip_key(&headers);
    let key = format!("write:{ip}:{}", user.0);
    if !state.write_limiter.check_and_increment(&key) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }

    match state
        .drafts
        .create(
            user.0,
            body.label.as_deref(),
            body.content.as_deref().unwrap_or(""),
            body.community_id,
        )
        .await
    {
        Ok(Ok(json)) => Json(json).into_response(),
        Ok(Err(CreateDraftError::TooLong)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": format!("Черновик не более {MAX_POST_CONTENT_LENGTH} символов.")
            })),
        )
            .into_response(),
        Ok(Err(CreateDraftError::Forbidden)) => StatusCode::FORBIDDEN.into_response(),
        Ok(Err(CreateDraftError::TooMany)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": format!("Не более {MAX_POST_DRAFTS_PER_USER} черновиков.")
            })),
        )
            .into_response(),
        Err(e) => internal(e),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdatePostDraftBody {
    label: Option<String>,
    content: Option<String>,
}

async fn update_post_draft(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
    Path(draft_uuid): Path<Uuid>,
    Json(body): Json<UpdatePostDraftBody>,
) -> Response {
    match state
        .drafts
        .update(
            user.0,
            draft_uuid,
            body.label.as_deref(),
            body.content.as_deref(),
        )
        .await
    {
        Ok(Ok(json)) => Json(json).into_response(),
        Ok(Err(UpdateDraftError::NotFound)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Черновик не найден." })),
        )
            .into_response(),
        Ok(Err(UpdateDraftError::Forbidden)) => StatusCode::FORBIDDEN.into_response(),
        Ok(Err(UpdateDraftError::EmptyLabel)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "Название черновика не может быть пустым."
            })),
        )
            .into_response(),
        Ok(Err(UpdateDraftError::TooLong)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": format!("Черновик не более {MAX_POST_CONTENT_LENGTH} символов.")
            })),
        )
            .into_response(),
        Err(e) => internal(e),
    }
}

async fn delete_post_draft(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
    Path(draft_uuid): Path<Uuid>,
) -> Response {
    match state.drafts.delete(user.0, draft_uuid).await {
        Ok(Ok(())) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(DeleteDraftError::NotFound)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Черновик не найден." })),
        )
            .into_response(),
        Ok(Err(DeleteDraftError::Forbidden)) => StatusCode::FORBIDDEN.into_response(),
        Err(e) => internal(e),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateCommentBody {
    content: Option<String>,
    parent_comment_uuid: Option<Uuid>,
}

async fn create_comment(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
    Path(post_uuid): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<CreateCommentBody>,
) -> Response {
    let ip = client_ip_key(&headers);
    let key = format!("write:{ip}:{}", user.0);
    if !state.write_limiter.check_and_increment(&key) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }

    match state
        .comments
        .create(
            user.0,
            post_uuid,
            body.content.as_deref().unwrap_or(""),
            body.parent_comment_uuid,
        )
        .await
    {
        Ok(Ok(json)) => Json(json).into_response(),
        Ok(Err(CreateCommentError::PostNotFound)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Пост не найден." })),
        )
            .into_response(),
        Ok(Err(CreateCommentError::CommentsForbidden)) => (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "Автор ограничил комментарии к своим публикациям."
            })),
        )
            .into_response(),
        Ok(Err(CreateCommentError::EmptyContent)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "Текст комментария не может быть пустым."
            })),
        )
            .into_response(),
        Ok(Err(CreateCommentError::TooLong)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": format!("Комментарий не более {MAX_COMMENT_CONTENT_LENGTH} символов.")
            })),
        )
            .into_response(),
        Ok(Err(CreateCommentError::InvalidParent)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "Некорректный родительский комментарий."
            })),
        )
            .into_response(),
        Ok(Err(CreateCommentError::ParentNotFound)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Родительский комментарий не найден." })),
        )
            .into_response(),
        Ok(Err(CreateCommentError::ParentNotRoot)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "Ответы можно оставлять только к корневым комментариям."
            })),
        )
            .into_response(),
        Err(e) => internal(e),
    }
}

async fn delete_comment(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
    Path((post_uuid, comment_uuid)): Path<(Uuid, Uuid)>,
) -> Response {
    match state.comments.delete(user.0, post_uuid, comment_uuid).await {
        Ok(Ok(())) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(DeleteCommentError::NotFound)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Комментарий не найден." })),
        )
            .into_response(),
        Ok(Err(DeleteCommentError::Forbidden)) => StatusCode::FORBIDDEN.into_response(),
        Err(e) => internal(e),
    }
}

async fn get_post_image(
    State(state): State<ContentState>,
    Path(uuid): Path<Uuid>,
    viewer: Option<Extension<CurrentUser>>,
) -> Response {
    match state
        .media
        .post_image(uuid, viewer.map(|Extension(user)| user.0))
        .await
    {
        Ok(Some(media)) => cached_media_response(
            media.blob.data,
            &media.blob.content_type,
            media_cache(media.publicly_cacheable),
        ),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => internal(e),
    }
}

#[derive(Debug, Deserialize)]
struct AvatarQuery {
    /// `fri` (default / stored) or `png` for interoperable clients (FCM/Android BitmapFactory).
    fmt: Option<String>,
}

async fn get_avatar(
    State(state): State<ContentState>,
    Path(uuid): Path<Uuid>,
    Query(q): Query<AvatarQuery>,
) -> Response {
    match state.media.avatar(uuid).await {
        Ok(Some(blob)) => {
            let want_png = q
                .fmt
                .as_deref()
                .map(|v| v.eq_ignore_ascii_case("png"))
                .unwrap_or(false);
            if want_png {
                match avatar_as_png(&blob.data) {
                    Ok(png) => cached_media_response(png, "image/png", MediaCache::PublicImmutable),
                    Err(e) => {
                        tracing::warn!(error = %e, %uuid, "avatar png export failed");
                        StatusCode::UNSUPPORTED_MEDIA_TYPE.into_response()
                    }
                }
            } else {
                cached_media_response(blob.data, &blob.content_type, MediaCache::PublicImmutable)
            }
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => internal(e),
    }
}

fn avatar_as_png(bytes: &[u8]) -> Result<Vec<u8>, String> {
    use frc_i::DecodeLimits;
    use frc_i_integration::{decode_frc_i_to_png, is_frc_i};
    if is_frc_i(bytes) {
        return decode_frc_i_to_png(bytes, DecodeLimits::default()).map_err(|e| e.to_string());
    }
    // Legacy JPEG/PNG/WebP still stored for some rows — re-encode to PNG for a stable wire type.
    let image = image::load_from_memory(bytes).map_err(|e| e.to_string())?;
    let mut png = Vec::new();
    image
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(png)
}

async fn get_post_video(
    State(state): State<ContentState>,
    Path(uuid): Path<Uuid>,
    headers: HeaderMap,
    viewer: Option<Extension<CurrentUser>>,
) -> Response {
    match state
        .media
        .post_video(uuid, viewer.map(|Extension(user)| user.0))
        .await
    {
        Ok(Some(media)) => cached_ranged_media_response(
            media.blob.data,
            &media.blob.content_type,
            &headers,
            media_cache(media.publicly_cacheable),
        ),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => internal(e),
    }
}

async fn get_post_video_poster(
    State(state): State<ContentState>,
    Path(uuid): Path<Uuid>,
    viewer: Option<Extension<CurrentUser>>,
) -> Response {
    match state
        .media
        .post_video_poster(uuid, viewer.map(|Extension(user)| user.0))
        .await
    {
        Ok(Some(media)) => cached_media_response(
            media.blob.data,
            &media.blob.content_type,
            media_cache(media.publicly_cacheable),
        ),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => internal(e),
    }
}

async fn get_post_video_status(
    State(state): State<ContentState>,
    Path(post_uuid): Path<Uuid>,
    viewer: Option<Extension<CurrentUser>>,
) -> Response {
    match state
        .media
        .post_video_status(post_uuid, viewer.map(|Extension(user)| user.0))
        .await
    {
        Ok(Some(body)) => Json(body).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => internal(e),
    }
}

fn media_cache(publicly_cacheable: bool) -> MediaCache {
    if publicly_cacheable {
        // Community privacy is mutable; a previously public blob must be
        // re-authorized after the community becomes private.
        MediaCache::PublicRevalidate
    } else {
        MediaCache::PrivateNoStore
    }
}

#[derive(Debug, Deserialize)]
struct CommentsQuery {
    skip: Option<i32>,
    take: Option<i32>,
    #[serde(rename = "includeReplies", default = "default_include_replies")]
    include_replies: bool,
}

fn default_include_replies() -> bool {
    true
}

#[derive(Debug, Deserialize)]
struct ProfilePostsQuery {
    #[serde(default)]
    skip: i32,
    #[serde(default = "default_profile_posts_take")]
    take: i32,
}

fn default_profile_posts_take() -> i32 {
    20
}

async fn get_profile_posts(
    State(state): State<ContentState>,
    Path(username): Path<String>,
    Query(q): Query<ProfilePostsQuery>,
    viewer: Option<Extension<CurrentUser>>,
) -> Response {
    let viewer_uuid = viewer.map(|Extension(u)| u.0);
    match state
        .profile_posts
        .posts_by_username(&username, viewer_uuid, q.skip, q.take)
        .await
    {
        Ok(ProfilePostsOutcome::BadUsername) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Укажите юзернейм." })),
        )
            .into_response(),
        Ok(ProfilePostsOutcome::NotFound) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Пользователь не найден." })),
        )
            .into_response(),
        Ok(ProfilePostsOutcome::Posts(posts)) => {
            match state.profile_posts.serialize(posts, viewer_uuid).await {
                Ok(body) => Json(body).into_response(),
                Err(e) => internal(e),
            }
        }
        Err(e) => internal(e),
    }
}

async fn get_profile_likes(
    State(state): State<ContentState>,
    Path(username): Path<String>,
    Query(q): Query<ProfilePostsQuery>,
    viewer: Option<Extension<CurrentUser>>,
) -> Response {
    profile_interaction_posts(state, username, q, viewer, true).await
}

async fn get_profile_reposts(
    State(state): State<ContentState>,
    Path(username): Path<String>,
    Query(q): Query<ProfilePostsQuery>,
    viewer: Option<Extension<CurrentUser>>,
) -> Response {
    profile_interaction_posts(state, username, q, viewer, false).await
}

async fn profile_interaction_posts(
    state: ContentState,
    username: String,
    q: ProfilePostsQuery,
    viewer: Option<Extension<CurrentUser>>,
    liked: bool,
) -> Response {
    let viewer_uuid = viewer.map(|Extension(u)| u.0);
    let result = if liked {
        state
            .profile_posts
            .liked_by_username(&username, viewer_uuid, q.skip, q.take)
            .await
    } else {
        state
            .profile_posts
            .reposted_by_username(&username, viewer_uuid, q.skip, q.take)
            .await
    };
    match result {
        Ok(ProfilePostsOutcome::NotFound) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Пользователь не найден." })),
        )
            .into_response(),
        Ok(ProfilePostsOutcome::BadUsername) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Пользователь не найден." })),
        )
            .into_response(),
        Ok(ProfilePostsOutcome::Posts(posts)) => {
            match state.profile_posts.serialize(posts, viewer_uuid).await {
                Ok(body) => Json(body).into_response(),
                Err(e) => internal(e),
            }
        }
        Err(e) => internal(e),
    }
}

async fn get_comments(
    State(state): State<ContentState>,
    Path(post_uuid): Path<Uuid>,
    Query(q): Query<CommentsQuery>,
    viewer: Option<Extension<CurrentUser>>,
) -> Response {
    let viewer_uuid = viewer.map(|Extension(u)| u.0);
    match state
        .comments
        .list_roots(
            post_uuid,
            viewer_uuid,
            q.skip.unwrap_or(0),
            q.take.unwrap_or(50),
            q.include_replies,
        )
        .await
    {
        Ok(Ok(list)) => Json(list).into_response(),
        Ok(Err(CommentsError::PostNotFound)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Пост не найден." })),
        )
            .into_response(),
        Ok(Err(CommentsError::CommentNotFound)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Комментарий не найден." })),
        )
            .into_response(),
        Err(e) => internal(e),
    }
}

async fn get_comment_replies(
    State(state): State<ContentState>,
    Path((post_uuid, comment_uuid)): Path<(Uuid, Uuid)>,
    viewer: Option<Extension<CurrentUser>>,
) -> Response {
    let viewer_uuid = viewer.map(|Extension(u)| u.0);
    match state
        .comments
        .list_replies(post_uuid, comment_uuid, viewer_uuid)
        .await
    {
        Ok(Ok(list)) => Json(list).into_response(),
        Ok(Err(CommentsError::PostNotFound)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Пост не найден." })),
        )
            .into_response(),
        Ok(Err(CommentsError::CommentNotFound)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Комментарий не найден." })),
        )
            .into_response(),
        Err(e) => internal(e),
    }
}

fn internal(e: String) -> Response {
    tracing::error!(error = %e, "flora-content internal");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({ "error": "Внутренняя ошибка сервера." })),
    )
        .into_response()
}

fn community_error(err: CommunityError) -> Response {
    let (status, message): (StatusCode, &str) = match err {
        CommunityError::NotFound => (StatusCode::NOT_FOUND, "Сообщество не найдено."),
        CommunityError::NotFoundEdit => (
            StatusCode::NOT_FOUND,
            "Сообщество не найдено или у вас нет прав на редактирование.",
        ),
        CommunityError::NotFoundDelete => (
            StatusCode::NOT_FOUND,
            "Сообщество не найдено или у вас нет прав на удаление.",
        ),
        CommunityError::UserNotFound => (StatusCode::NOT_FOUND, "Пользователь не найден."),
        CommunityError::PrivateCommunity => (StatusCode::FORBIDDEN, "Это приватное сообщество."),
        CommunityError::AlreadyMember => {
            (StatusCode::CONFLICT, "Вы уже состоите в этом сообществе.")
        }
        CommunityError::OwnerCannotLeave => (
            StatusCode::BAD_REQUEST,
            "Владелец не может отписаться от своего сообщества.",
        ),
        CommunityError::Forbidden => (StatusCode::FORBIDDEN, "Недостаточно прав."),
        CommunityError::SlugTaken => (
            StatusCode::CONFLICT,
            "Сообщество с такой ссылкой уже существует.",
        ),
        CommunityError::SlugReserved => (
            StatusCode::BAD_REQUEST,
            "Эта ссылка зарезервирована системой и недоступна для регистрации.",
        ),
        CommunityError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg),
    };
    (status, Json(serde_json::json!({ "error": message }))).into_response()
}

async fn get_all_communities(State(state): State<ContentState>) -> Response {
    match state.communities.list_public().await {
        Ok(list) => Json(list).into_response(),
        Err(e) => internal(e),
    }
}

async fn get_owned_communities(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
) -> Response {
    match state.communities.list_owned(user.0).await {
        Ok(list) => Json(list).into_response(),
        Err(e) => internal(e),
    }
}

#[derive(Debug, Deserialize)]
struct RecommendedQuery {
    take: Option<i32>,
}

async fn get_recommended_communities(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
    Query(q): Query<RecommendedQuery>,
) -> Response {
    match state
        .communities
        .get_recommended(user.0, q.take.unwrap_or(30))
        .await
    {
        Ok(body) => Json(body).into_response(),
        Err(e) => internal(e),
    }
}

#[derive(Debug, Deserialize)]
struct SearchCommunitiesQuery {
    q: Option<String>,
    skip: Option<i32>,
    take: Option<i32>,
}

async fn search_communities(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
    Query(q): Query<SearchCommunitiesQuery>,
) -> Response {
    match state
        .communities
        .search(
            user.0,
            q.q.as_deref().unwrap_or(""),
            q.skip.unwrap_or(0),
            q.take.unwrap_or(20),
        )
        .await
    {
        Ok(list) => Json(list).into_response(),
        Err(e) => internal(e),
    }
}

async fn get_community_by_slug(
    State(state): State<ContentState>,
    Path(slug): Path<String>,
    viewer: Option<Extension<CurrentUser>>,
) -> Response {
    let viewer_uuid = viewer.map(|Extension(u)| u.0);
    match state.communities.by_slug(&slug, viewer_uuid).await {
        Ok(Ok(body)) => Json(body).into_response(),
        Ok(Err(err)) => community_error(err),
        Err(e) => internal(e),
    }
}

async fn get_profile_communities(
    State(state): State<ContentState>,
    Path(username): Path<String>,
) -> Response {
    match state.communities.profile_communities(&username).await {
        Ok(Ok(list)) => Json(list).into_response(),
        Ok(Err(CommunityError::BadRequest(msg))) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        Ok(Err(err)) => community_error(err),
        Err(e) => internal(e),
    }
}

async fn join_community(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
    Path(community_id): Path<Uuid>,
) -> Response {
    match state.communities.join(user.0, community_id).await {
        Ok(Ok(body)) => Json(body).into_response(),
        Ok(Err(err)) => community_error(err),
        Err(e) => internal(e),
    }
}

async fn leave_community(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
    Path(community_id): Path<Uuid>,
) -> Response {
    match state.communities.leave(user.0, community_id).await {
        Ok(Ok(Some(body))) => Json(body).into_response(),
        Ok(Ok(None)) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(err)) => community_error(err),
        Err(e) => internal(e),
    }
}

#[derive(Debug, Deserialize)]
struct CommunityPostsQuery {
    skip: Option<i32>,
    take: Option<i32>,
}

async fn get_community_posts(
    State(state): State<ContentState>,
    Path(community_id): Path<Uuid>,
    Query(q): Query<CommunityPostsQuery>,
    viewer: Option<Extension<CurrentUser>>,
) -> Response {
    let viewer_uuid = viewer.map(|Extension(u)| u.0);
    match state
        .communities
        .community_posts(
            community_id,
            viewer_uuid,
            q.skip.unwrap_or(0),
            q.take.unwrap_or(20),
        )
        .await
    {
        Ok(Ok(list)) => Json(list).into_response(),
        Ok(Err(err)) => community_error(err),
        Err(e) => internal(e),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateCommunityBody {
    name: Option<String>,
    slug: Option<String>,
    is_private: Option<bool>,
}

async fn create_community(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
    headers: axum::http::HeaderMap,
    Json(body): Json<CreateCommunityBody>,
) -> Response {
    let ip = client_ip_key(&headers);
    let key = format!("write:{ip}:{}", user.0);
    if !state.write_limiter.check_and_increment(&key) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    match state
        .communities
        .create(
            user.0,
            body.name.as_deref(),
            body.slug.as_deref(),
            body.is_private,
        )
        .await
    {
        Ok(Ok(body)) => Json(body).into_response(),
        Ok(Err(err)) => community_error(err),
        Err(e) => internal(e),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCommunityBody {
    name: Option<String>,
    slug: Option<String>,
    is_private: Option<bool>,
}

async fn update_community(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
    Path(community_id): Path<Uuid>,
    Json(body): Json<UpdateCommunityBody>,
) -> Response {
    match state
        .communities
        .update(
            user.0,
            community_id,
            body.name.as_deref(),
            body.slug.as_deref(),
            body.is_private,
        )
        .await
    {
        Ok(Ok(body)) => Json(body).into_response(),
        Ok(Err(err)) => community_error(err),
        Err(e) => internal(e),
    }
}

async fn delete_community(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
    Path(community_id): Path<Uuid>,
) -> Response {
    match state.communities.delete(user.0, community_id).await {
        Ok(Ok(())) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(err)) => community_error(err),
        Err(e) => internal(e),
    }
}

pub fn default_write_limiter() -> Arc<FixedWindowLimiter> {
    Arc::new(FixedWindowLimiter::new(60, Duration::from_secs(5 * 60)))
}

#[cfg(test)]
mod avatar_png_tests {
    use super::avatar_as_png;
    use frc_i_integration::{IngestOptions, ingest, is_frc_i};
    use image::codecs::png::PngEncoder;
    use image::{ExtendedColorType, ImageEncoder};

    fn tiny_png() -> Vec<u8> {
        let mut png = Vec::new();
        PngEncoder::new(&mut png)
            .write_image(&[20, 40, 60, 255], 1, 1, ExtendedColorType::Rgba8)
            .unwrap();
        png
    }

    #[test]
    fn avatar_as_png_roundtrips_fri() {
        let fri = ingest(
            &tiny_png(),
            IngestOptions {
                max_dimension: 256,
                max_pixels: 50_000_000,
                quality: 85,
            },
        )
        .unwrap()
        .bytes;
        assert!(is_frc_i(&fri));
        let png = avatar_as_png(&fri).unwrap();
        let decoded = image::load_from_memory(&png).unwrap();
        assert!(decoded.width() >= 1 && decoded.height() >= 1);
    }

    #[test]
    fn avatar_as_png_accepts_legacy_png() {
        let png = tiny_png();
        let out = avatar_as_png(&png).unwrap();
        assert!(image::load_from_memory(&out).is_ok());
    }
}
