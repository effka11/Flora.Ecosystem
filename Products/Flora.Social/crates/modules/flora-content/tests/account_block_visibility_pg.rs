//! PostgreSQL integration for reversible account-block post visibility.
//!
//! ```powershell
//! $env:FLORA_CONTENT_ACCOUNT_BLOCKS_PG = "1"
//! cargo test -p flora-content --test account_block_visibility_pg -- --nocapture --test-threads=1
//! ```
//! Without `FLORA_CONTENT_ACCOUNT_BLOCKS_PG=1`, the test is a no-op (skip).

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use flora_auth_contracts::{AccountDirectory, AccountPublicInfo, BoxFuture as AuthBoxFuture};
use flora_content::application::serialize::FeedSerializer;
use flora_content::infrastructure::repo::{ContentRepo, PostRow, ProfilePostRow};
use flora_shared::config::FloraConfig;
use flora_shared::npgsql::NpgsqlConnectionString;
use flora_users_contracts::{
    AccountSanctionStatus, BoxFuture as UsersBoxFuture, FeedAuthorProfile, FeedAuthorProfiles,
    FollowGraphReader, ProfileAccess, ProfileAccessField,
};
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

fn enabled() -> bool {
    std::env::var("FLORA_CONTENT_ACCOUNT_BLOCKS_PG")
        .ok()
        .as_deref()
        == Some("1")
}

async fn connect() -> PgPool {
    let raw = if let Ok(url) = std::env::var("FLORA_CONTENT_ACCOUNT_BLOCKS_PG_URL") {
        url
    } else {
        let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        for _ in 0..5 {
            path.pop();
        }
        path.push("Backend");
        let cfg = FloraConfig::load("Development", &path).expect("Backend/appsettings");
        cfg.get_non_empty("ConnectionStrings:FloraDatabase")
            .expect("ConnectionStrings:FloraDatabase")
            .to_string()
    };
    let parsed = NpgsqlConnectionString::parse(&raw).expect("npgsql");
    let mut options = PgConnectOptions::new()
        .host(parsed.host.as_deref().unwrap_or("localhost"))
        .port(parsed.port.unwrap_or(5432));
    if let Some(database) = &parsed.database {
        options = options.database(database);
    }
    if let Some(username) = &parsed.username {
        options = options.username(username);
    }
    if let Some(password) = &parsed.password {
        options = options.password(password);
    }
    PgPoolOptions::new()
        .max_connections(3)
        .connect_with(options)
        .await
        .expect("pg")
}

struct Accounts;

impl AccountDirectory for Accounts {
    fn get_public(
        &self,
        user_uuid: Uuid,
    ) -> AuthBoxFuture<'_, Result<Option<AccountPublicInfo>, String>> {
        Box::pin(async move {
            Ok(Some(AccountPublicInfo {
                user_uuid,
                username: format!("user-{user_uuid}"),
                phone: String::new(),
                email: String::new(),
            }))
        })
    }

    fn find_uuid_by_username(
        &self,
        _username: &str,
    ) -> AuthBoxFuture<'_, Result<Option<Uuid>, String>> {
        Box::pin(async { Ok(None) })
    }

    fn usernames_by_uuids(
        &self,
        user_uuids: &[Uuid],
    ) -> AuthBoxFuture<'_, Result<Vec<(Uuid, String)>, String>> {
        let usernames = user_uuids
            .iter()
            .copied()
            .map(|user_uuid| (user_uuid, format!("user-{user_uuid}")))
            .collect();
        Box::pin(async move { Ok(usernames) })
    }

    fn update_username(
        &self,
        _user_uuid: Uuid,
        _username: &str,
    ) -> AuthBoxFuture<'_, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }

    fn username_taken_by_other(
        &self,
        _username: &str,
        _user_uuid: Uuid,
    ) -> AuthBoxFuture<'_, Result<bool, String>> {
        Box::pin(async { Ok(false) })
    }

    fn is_username_reserved(&self, _username: &str) -> bool {
        false
    }

    fn search_accounts_by_username_contains(
        &self,
        _exclude_user_uuid: Uuid,
        _query_lower: &str,
    ) -> AuthBoxFuture<'_, Result<Vec<(Uuid, String)>, String>> {
        Box::pin(async { Ok(Vec::new()) })
    }

    fn list_active_user_uuids(&self) -> AuthBoxFuture<'_, Result<Vec<Uuid>, String>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

struct Profiles {
    blocked: HashSet<Uuid>,
}

impl FeedAuthorProfiles for Profiles {
    fn by_uuids(
        &self,
        user_uuids: &[Uuid],
    ) -> UsersBoxFuture<'_, Result<Vec<FeedAuthorProfile>, String>> {
        let profiles = user_uuids
            .iter()
            .copied()
            .map(|user_uuid| FeedAuthorProfile {
                user_uuid,
                display_name: format!("User {user_uuid}"),
                avatar_uuid: None,
                account_blocked: self.blocked.contains(&user_uuid),
            })
            .collect();
        Box::pin(async move { Ok(profiles) })
    }
}

struct Follow;

impl FollowGraphReader for Follow {
    fn following_user_ids(
        &self,
        _follower_user_uuid: Uuid,
    ) -> UsersBoxFuture<'_, Result<Vec<Uuid>, String>> {
        Box::pin(async { Ok(Vec::new()) })
    }

    fn following_user_ids_for_followers(
        &self,
        _follower_user_uuids: &[Uuid],
        _exclude_user_uuid: Uuid,
    ) -> UsersBoxFuture<'_, Result<Vec<Uuid>, String>> {
        Box::pin(async { Ok(Vec::new()) })
    }

    fn follower_counts(
        &self,
        _user_ids: &[Uuid],
    ) -> UsersBoxFuture<'_, Result<Vec<(Uuid, i32)>, String>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

struct AllowProfileAccess;

impl ProfileAccess for AllowProfileAccess {
    fn can_access(
        &self,
        _viewer_user_uuid: Option<Uuid>,
        _owner_user_uuid: Uuid,
        _field: ProfileAccessField,
    ) -> UsersBoxFuture<'_, Result<bool, String>> {
        Box::pin(async { Ok(true) })
    }

    fn accessible_owners(
        &self,
        _viewer_user_uuid: Option<Uuid>,
        owner_user_uuids: &[Uuid],
        _field: ProfileAccessField,
    ) -> UsersBoxFuture<'_, Result<Vec<Uuid>, String>> {
        let owners = owner_user_uuids.to_vec();
        Box::pin(async move { Ok(owners) })
    }
}

struct Status {
    blocked: HashSet<Uuid>,
}

impl AccountSanctionStatus for Status {
    fn is_blocked(&self, user_uuid: Uuid) -> UsersBoxFuture<'_, Result<bool, String>> {
        Box::pin(async move { Ok(self.blocked.contains(&user_uuid)) })
    }

    fn blocked_among(&self, user_uuids: &[Uuid]) -> UsersBoxFuture<'_, Result<Vec<Uuid>, String>> {
        let blocked = user_uuids
            .iter()
            .copied()
            .filter(|user_uuid| self.blocked.contains(user_uuid))
            .collect();
        Box::pin(async move { Ok(blocked) })
    }
}

#[tokio::test]
async fn blocked_posts_are_hidden_without_soft_delete() {
    if !enabled() {
        eprintln!("skip: set FLORA_CONTENT_ACCOUNT_BLOCKS_PG=1");
        return;
    }

    let pool = connect().await;
    let personal: PostRow = sqlx::query_as(
        r#"
        SELECT post_uuid, content, created_at, author_user_uuid, community_id
        FROM flora_core.user_posts
        WHERE is_deleted = false
          AND community_id IS NULL
        ORDER BY created_at DESC
        LIMIT 1
        "#,
    )
    .fetch_optional(&pool)
    .await
    .expect("personal post query")
    .expect("need one non-deleted personal post");
    let community: PostRow = sqlx::query_as(
        r#"
        SELECT p.post_uuid, p.content, p.created_at, p.author_user_uuid, p.community_id
        FROM flora_core.user_posts p
        INNER JOIN flora_core.communities c ON c.community_id = p.community_id
        WHERE p.is_deleted = false
          AND c.is_private = false
        ORDER BY p.created_at DESC
        LIMIT 1
        "#,
    )
    .fetch_optional(&pool)
    .await
    .expect("community post query")
    .expect("need one non-deleted public-community post");

    let blocked = HashSet::from([personal.author_user_uuid, community.author_user_uuid]);
    let serializer = FeedSerializer::new(
        Arc::new(ContentRepo::new(pool.clone())),
        Arc::new(Accounts),
        Arc::new(Profiles {
            blocked: blocked.clone(),
        }),
        Arc::new(Follow),
        Arc::new(AllowProfileAccess),
        Arc::new(Status { blocked }),
    );
    let viewer = Uuid::now_v7();

    let feed = serializer
        .serialize_feed_post_dtos(viewer, &[personal.post_uuid, community.post_uuid])
        .await
        .expect("feed serialization");
    assert!(feed.is_empty(), "blocked posts must be absent from feed");

    let profile = serializer
        .serialize_profile_posts(
            vec![ProfilePostRow {
                post_uuid: personal.post_uuid,
                content: personal.content.clone(),
                created_at: personal.created_at,
            }],
            Some(viewer),
        )
        .await
        .expect("profile serialization");
    assert_eq!(profile, serde_json::json!([]));

    let community_cards = serializer
        .serialize_post_cards(Some(viewer), std::slice::from_ref(&community))
        .await
        .expect("community serialization");
    assert!(community_cards.is_empty());

    let deletion_states: Vec<(Uuid, bool)> = sqlx::query_as(
        r#"
        SELECT post_uuid, is_deleted
        FROM flora_core.user_posts
        WHERE post_uuid = ANY($1)
        "#,
    )
    .bind([personal.post_uuid, community.post_uuid])
    .fetch_all(&pool)
    .await
    .expect("post deletion states");
    assert_eq!(deletion_states.len(), 2);
    assert!(
        deletion_states.iter().all(|(_, is_deleted)| !is_deleted),
        "visibility filtering must not mutate is_deleted"
    );
}
