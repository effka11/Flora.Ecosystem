//! Модуль Content. Перенос — Фаза 3 (next-architecture.md §6); владелец — таблица §6.0.
//!
//! Уже перенесено: FIRA-F/C scorers; ServeNative HTTP: feed / has-new / create+delete post /
//! like / unlike / repost / view / create+delete comment / comments (+ replies) /
//! profile posts/likes/reposts / communities (list/owned/recommended/search/slug/join/posts/profile/create/update/delete);
//! media GET (post images, avatars user+community, post videos+poster); post drafts CRUD;
//! POST post images (multipart WebP); GET post video/status;
//! POST post video + фоновый SVT-AV1 worker (Rust при ServeNative; C# dual-writer guard — follow-up).

pub mod application;
pub mod http;
pub mod infrastructure;

use std::sync::Arc;

use flora_auth_contracts::AccountDirectory;
use flora_notifications_contracts::UserNotificationDispatcher;
use flora_users_contracts::{
    BidirectionalBlocklist, FeedAuthorProfiles, FollowGraphReader, ProfileAccess, UserAvatarMedia,
};
use sqlx::PgPool;

use crate::application::comments::CommentsService;
use crate::application::communities::CommunitiesService;
use crate::application::community_recommendation::CommunityRecommendationService;
use crate::application::drafts::DraftsService;
use crate::application::feed::FeedService;
use crate::application::feed_controls::FeedControlsService;
use crate::application::media::MediaService;
use crate::application::post_access::PostAccessService;
use crate::application::post_images::PostImagesService;
use crate::application::post_videos::{
    ContentVideoWorker, PostVideoTranscodeQueue, PostVideosService, spawn_video_worker,
};
use crate::application::posts::PostService;
use crate::application::profile_posts::ProfilePostsService;
use crate::application::serialize::FeedSerializer;
use crate::http::{ContentState, default_upload_limiter, default_write_limiter};
use crate::infrastructure::ffmpeg_video::{FfmpegVideoTranscoder, MediaOptions};
use crate::infrastructure::repo::ContentRepo;

pub use crate::infrastructure::ffmpeg_video::MediaOptions as ContentMediaOptions;

/// Rust-миграции модуля Content (регистрируются в flora-migrate, §11.1).
pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

/// Хэндл фонового воркера Content (abort при shutdown хоста).
pub type WorkerHandle = tokio::task::JoinHandle<()>;

/// Собранный модуль: protected (JWT) + public (optional JWT) роутеры + video worker parts.
pub struct ContentModule {
    pub protected_router: axum::Router,
    pub public_router: axum::Router,
    /// Take once → [`spawn_video_worker`] при `Content:ServeNative`.
    pub video_worker: Option<ContentVideoWorker>,
    pub image_backfill: Option<WorkerHandle>,
}

/// Пустой роутер (ServeNative=false / нет пула) — gateway-fallback на .NET.
pub fn router() -> axum::Router {
    axum::Router::new()
}

/// Порт статистики подписок на сообщества (Фаза 2b → Users).
pub fn community_follow_stats(
    pool: PgPool,
) -> Arc<dyn flora_content_contracts::CommunityFollowStats> {
    infrastructure::community_stats::community_follow_stats(pool)
}

#[allow(clippy::too_many_arguments)]
pub fn compose(
    pool: PgPool,
    accounts: Arc<dyn AccountDirectory>,
    follow: Arc<dyn FollowGraphReader>,
    blocklist: Arc<dyn BidirectionalBlocklist>,
    profiles: Arc<dyn FeedAuthorProfiles>,
    profile_access: Arc<dyn ProfileAccess>,
    user_avatars: Arc<dyn UserAvatarMedia>,
    media: MediaOptions,
    notifications: Arc<dyn UserNotificationDispatcher>,
) -> ContentModule {
    let frc_i_backfill_enabled = media.frc_i_backfill_enabled;
    let backfill_pool = pool.clone();
    let repo = Arc::new(ContentRepo::new(pool));
    let feed = Arc::new(FeedService::new(
        repo.clone(),
        follow.clone(),
        blocklist,
        profile_access.clone(),
    ));
    let recommendations = Arc::new(CommunityRecommendationService::new(
        repo.clone(),
        follow.clone(),
    ));
    let feed_controls = Arc::new(FeedControlsService::new(
        repo.clone(),
        accounts.clone(),
        profiles.clone(),
        feed.clone(),
        recommendations.clone(),
    ));
    let serialize = Arc::new(FeedSerializer::new(
        repo.clone(),
        accounts.clone(),
        profiles.clone(),
        follow,
        profile_access.clone(),
    ));
    let profile_posts = Arc::new(ProfilePostsService::new(
        repo.clone(),
        accounts.clone(),
        profile_access.clone(),
        serialize.clone(),
    ));
    let access = Arc::new(PostAccessService::new(repo.clone(), profile_access.clone()));
    let comments = Arc::new(CommentsService::new(
        repo.clone(),
        access.clone(),
        accounts.clone(),
        profiles.clone(),
        profile_access,
        feed.clone(),
        Arc::clone(&notifications),
    ));
    let posts = Arc::new(PostService::new(
        repo.clone(),
        feed.clone(),
        accounts.clone(),
        profiles,
        access.clone(),
        notifications,
    ));
    let media_svc = Arc::new(MediaService::new(repo.clone(), user_avatars, access));
    let drafts = Arc::new(DraftsService::new(repo.clone()));
    let post_images = Arc::new(PostImagesService::new(repo.clone()));

    let (queue, rx) = PostVideoTranscodeQueue::new();
    let queue = Arc::new(queue);
    let transcoder = Arc::new(FfmpegVideoTranscoder::new(media));
    let post_videos = Arc::new(PostVideosService::new(
        repo.clone(),
        transcoder.clone(),
        queue,
    ));
    let video_worker = Some(ContentVideoWorker {
        repo: repo.clone(),
        transcoder,
        rx,
    });

    let communities = Arc::new(CommunitiesService::new(
        repo,
        accounts,
        serialize.clone(),
        feed.clone(),
        recommendations,
    ));
    let state = ContentState {
        feed,
        feed_controls,
        serialize,
        posts,
        comments,
        profile_posts,
        communities,
        media: media_svc,
        drafts,
        post_images,
        post_videos,
        write_limiter: default_write_limiter(),
        upload_limiter: default_upload_limiter(),
    };
    ContentModule {
        protected_router: http::protected_router(state.clone()),
        public_router: http::public_router(state),
        video_worker,
        image_backfill: frc_i_backfill_enabled
            .then(|| tokio::spawn(infrastructure::image_backfill::run(backfill_pool))),
    }
}

/// Запускает воркер транскода post video (если parts ещё не взяты).
pub fn take_and_spawn_video_worker(module: &mut ContentModule) -> Option<WorkerHandle> {
    module.video_worker.take().map(spawn_video_worker)
}

pub fn take_image_backfill(module: &mut ContentModule) -> Option<WorkerHandle> {
    module.image_backfill.take()
}
