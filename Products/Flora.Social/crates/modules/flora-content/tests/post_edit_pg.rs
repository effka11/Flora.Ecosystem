//! PostgreSQL integration for published-post edits (revisions + is_current).
//!
//! ```powershell
//! $env:FLORA_CONTENT_POST_EDIT_PG = "1"
//! cargo test -p flora-content --test post_edit_pg -- --nocapture --test-threads=1
//! ```
//! Without the env flag the test is a no-op (skip).

use std::path::PathBuf;

use chrono::Utc;
use flora_content::infrastructure::repo::ContentRepo;
use flora_shared::config::FloraConfig;
use flora_shared::flora_uuid::new_uuid;
use flora_shared::npgsql::NpgsqlConnectionString;
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

fn enabled() -> bool {
    std::env::var("FLORA_CONTENT_POST_EDIT_PG").ok().as_deref() == Some("1")
}

async fn connect() -> PgPool {
    let raw = if let Ok(url) = std::env::var("FLORA_CONTENT_POST_EDIT_PG_URL") {
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

#[tokio::test]
async fn edit_snapshots_revision_and_hides_detached_images() {
    if !enabled() {
        eprintln!("skip: set FLORA_CONTENT_POST_EDIT_PG=1");
        return;
    }

    let pool = connect().await;
    let author: Uuid = sqlx::query_scalar(
        r#"
        SELECT author_user_uuid
        FROM flora_core.user_posts
        LIMIT 1
        "#,
    )
    .fetch_optional(&pool)
    .await
    .expect("author query")
    .expect("need at least one user_posts row for author uuid");

    let repo = ContentRepo::new(pool.clone());
    let post_uuid = new_uuid();
    let image_uuid = new_uuid();
    repo.insert_post(post_uuid, author, "old text", None, Utc::now())
        .await
        .expect("insert post");
    repo.insert_post_image(image_uuid, post_uuid, "image/jpeg", &[0xff, 0xd8, 0xff], 0)
        .await
        .expect("insert image");

    repo.commit_post_edit(
        post_uuid,
        author,
        "old text",
        &[image_uuid],
        None,
        "new text",
        &[],
        false,
    )
    .await
    .expect("commit edit");

    let is_edited: bool =
        sqlx::query_scalar("SELECT is_edited FROM flora_core.user_posts WHERE post_uuid = $1")
            .bind(post_uuid)
            .fetch_one(&pool)
            .await
            .expect("is_edited");
    assert!(is_edited);

    let content: String =
        sqlx::query_scalar("SELECT content FROM flora_core.user_posts WHERE post_uuid = $1")
            .bind(post_uuid)
            .fetch_one(&pool)
            .await
            .expect("content");
    assert_eq!(content, "new text");

    let revision_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::bigint FROM flora_core.post_revisions WHERE post_uuid = $1",
    )
    .bind(post_uuid)
    .fetch_one(&pool)
    .await
    .expect("revisions");
    assert_eq!(revision_count, 1);

    let current = repo
        .current_image_uuids(post_uuid)
        .await
        .expect("current images");
    assert!(current.is_empty());

    let live = repo
        .image_uuids_by_posts(&[post_uuid])
        .await
        .expect("live images");
    assert!(live.get(&post_uuid).map(|v| v.is_empty()).unwrap_or(true));

    let still_stored: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM flora_core.post_images WHERE uuid = $1 AND NOT is_current)",
    )
    .bind(image_uuid)
    .fetch_one(&pool)
    .await
    .expect("historical image");
    assert!(still_stored);

    repo.soft_delete_post(post_uuid, Utc::now())
        .await
        .expect("cleanup");
}
