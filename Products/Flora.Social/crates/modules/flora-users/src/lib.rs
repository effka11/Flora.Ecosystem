//! Модуль Users. Фаза 2b: профили/privacy/blocks HTTP + порты для Auth.

pub mod application;
pub mod http;
pub mod infrastructure;

use std::sync::Arc;

use flora_auth_contracts::AccountDirectory;
use flora_content_contracts::CommunityFollowStats;
use flora_notifications_contracts::UserNotificationDispatcher;
use sqlx::PgPool;

use crate::application::avatar::avatar_service;
use crate::application::people_recommendation::PeopleRecommendationService;
use crate::http::UsersState;
use crate::http::rate_limit::default_upload_limiter;
use crate::infrastructure::profile_reads::SqlUserProfileQueries;
use crate::infrastructure::recommendation::SqlUserRecommendationQueries;
use crate::infrastructure::store::SqlUsersStore;

pub struct UsersModule {
    pub protected_router: axum::Router,
    pub public_router: axum::Router,
}

pub fn router() -> axum::Router {
    axum::Router::new()
}

/// Порты Users для Auth (один sqlx-адаптер реализует read + provisioner).
pub fn profile_ports(
    pool: PgPool,
) -> (
    Arc<dyn flora_users_contracts::UserProfileReadQueries>,
    Arc<dyn flora_users_contracts::UserProfileProvisioner>,
) {
    let q = Arc::new(SqlUserProfileQueries::new(pool));
    (q.clone(), q)
}

pub fn profile_read_queries(
    pool: PgPool,
) -> Arc<dyn flora_users_contracts::UserProfileReadQueries> {
    profile_ports(pool).0
}

/// Порты графа/блоклиста/профилей для Content ServeNative.
pub fn content_ports(
    pool: PgPool,
) -> (
    Arc<dyn flora_users_contracts::FollowGraphReader>,
    Arc<dyn flora_users_contracts::BidirectionalBlocklist>,
    Arc<dyn flora_users_contracts::FeedAuthorProfiles>,
) {
    infrastructure::social_graph::as_ports(pool)
}

/// Порты presence / профилей / online-access / messages для Messaging ServeNative.
pub fn messaging_ports(
    pool: PgPool,
) -> (
    Arc<dyn flora_users_contracts::UserPresence>,
    Arc<dyn flora_users_contracts::FeedAuthorProfiles>,
    Arc<dyn flora_users_contracts::OnlineStatusAccess>,
    Arc<dyn flora_users_contracts::MessagesAccess>,
) {
    let presence: Arc<dyn flora_users_contracts::UserPresence> =
        Arc::new(SqlUsersStore::new(pool.clone()));
    let profiles: Arc<dyn flora_users_contracts::FeedAuthorProfiles> = Arc::new(
        infrastructure::social_graph::SqlSocialGraph::new(pool.clone()),
    );
    let online: Arc<dyn flora_users_contracts::OnlineStatusAccess> = Arc::new(
        infrastructure::online_access::SqlOnlineStatusAccess::new(pool.clone()),
    );
    let messages: Arc<dyn flora_users_contracts::MessagesAccess> = Arc::new(
        infrastructure::messages_access::SqlMessagesAccess::new(pool),
    );
    (presence, profiles, online, messages)
}

/// Профили для Notifications (display name в FCM title).
pub fn profile_queries(pool: PgPool) -> Arc<dyn flora_users_contracts::UserProfileQueries> {
    Arc::new(SqlUsersStore::new(pool))
}

/// Порт ProfileAccess для Content ServeNative (posts/likes/reposts visibility).
pub fn profile_access_port(pool: PgPool) -> Arc<dyn flora_users_contracts::ProfileAccess> {
    Arc::new(infrastructure::profile_access::SqlProfileAccess::new(pool))
}

pub fn compose(
    pool: PgPool,
    accounts: Arc<dyn AccountDirectory>,
    communities: Arc<dyn CommunityFollowStats>,
    notifications: Arc<dyn UserNotificationDispatcher>,
) -> UsersModule {
    let store = Arc::new(SqlUsersStore::new(pool.clone()));
    let (follow_graph, _, _) = infrastructure::social_graph::as_ports(pool.clone());
    let messages_access: Arc<dyn flora_users_contracts::MessagesAccess> = Arc::new(
        infrastructure::messages_access::SqlMessagesAccess::new(pool.clone()),
    );
    let profile_access: Arc<dyn flora_users_contracts::ProfileAccess> = Arc::new(
        infrastructure::profile_access::SqlProfileAccess::new(pool.clone()),
    );
    let recommendation_queries = Arc::new(SqlUserRecommendationQueries::new(pool.clone()));
    let recommendations = Arc::new(PeopleRecommendationService::new(
        recommendation_queries,
        follow_graph.clone(),
    ));
    let avatars = avatar_service(pool.clone());
    let state = UsersState {
        profiles: store.clone(),
        privacy: store.clone(),
        blocklist: store.clone(),
        presence: store.clone(),
        accounts,
        communities,
        follows: store,
        follow_graph,
        messages_access,
        profile_access,
        avatars,
        recommendations,
        notifications,
        upload_limiter: default_upload_limiter(),
    };
    UsersModule {
        protected_router: http::protected_router(state.clone()),
        public_router: http::public_router(state),
    }
}
