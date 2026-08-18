//! PostgreSQL integration for account-block apply, status, expiry, and upsert.
//!
//! ```powershell
//! $env:FLORA_USERS_BLOCKS_PG = "1"
//! cargo test -p flora-users --test account_blocks_pg -- --nocapture --test-threads=1
//! ```
//! Without `FLORA_USERS_BLOCKS_PG=1`, the test is a no-op (skip).

use std::path::PathBuf;

use chrono::{Duration, Utc};
use flora_shared::config::FloraConfig;
use flora_shared::npgsql::NpgsqlConnectionString;
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

fn enabled() -> bool {
    std::env::var("FLORA_USERS_BLOCKS_PG").ok().as_deref() == Some("1")
}

async fn connect() -> PgPool {
    let raw = if let Ok(url) = std::env::var("FLORA_USERS_BLOCKS_PG_URL") {
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
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await
        .expect("pg");
    require_account_blocks_schema(&pool).await;
    pool
}

async fn require_account_blocks_schema(pool: &PgPool) {
    let present: Option<String> =
        sqlx::query_scalar("SELECT to_regclass('flora_core.user_account_blocks')::text")
            .fetch_one(pool)
            .await
            .expect("to_regclass flora_core.user_account_blocks");
    assert!(
        present.is_some(),
        "flora_core.user_account_blocks is missing; apply flora-migrate before opting into this test"
    );
}

async fn cleanup(pool: &PgPool, user_uuids: &[Uuid]) {
    sqlx::query("DELETE FROM flora_core.user_account_blocks WHERE user_uuid = ANY($1)")
        .bind(user_uuids)
        .execute(pool)
        .await
        .expect("cleanup account blocks");
}

#[tokio::test]
async fn apply_timed_forever_expiry_and_reapply() {
    if !enabled() {
        eprintln!("skip: set FLORA_USERS_BLOCKS_PG=1");
        return;
    }

    let pool = connect().await;
    let (sanctions, status) = flora_users::account_sanctions_ports(pool.clone());
    let timed = Uuid::now_v7();
    let forever = Uuid::now_v7();
    let expired = Uuid::now_v7();
    let missing = Uuid::now_v7();
    let created_by = Uuid::now_v7();
    let reapplied_by = Uuid::now_v7();
    let test_users = [timed, forever, expired];

    sanctions
        .apply_block(timed, Some(Utc::now() + Duration::hours(1)), created_by)
        .await
        .expect("apply timed block");
    assert!(status.is_blocked(timed).await.expect("timed status"));

    sanctions
        .apply_block(forever, None, created_by)
        .await
        .expect("apply forever block");
    assert!(status.is_blocked(forever).await.expect("forever status"));

    sanctions
        .apply_block(expired, Some(Utc::now() - Duration::seconds(1)), created_by)
        .await
        .expect("apply already-expired block");
    assert!(!status.is_blocked(expired).await.expect("expired status"));
    assert!(!status.is_blocked(missing).await.expect("missing status"));

    let mut active = status
        .blocked_among(&[expired, missing, forever, timed, timed])
        .await
        .expect("active blocked subset");
    active.sort_unstable();
    let mut expected = vec![timed, forever];
    expected.sort_unstable();
    assert_eq!(active, expected);

    sanctions
        .apply_block(timed, Some(Utc::now() - Duration::seconds(1)), reapplied_by)
        .await
        .expect("reapply with expired deadline");
    assert!(
        !status
            .is_blocked(timed)
            .await
            .expect("status after expired reapply")
    );
    let (expired_deadline, stored_creator): (Option<chrono::DateTime<Utc>>, Uuid) = sqlx::query_as(
        r#"
            SELECT blocked_until, created_by
            FROM flora_core.user_account_blocks
            WHERE user_uuid = $1
            "#,
    )
    .bind(timed)
    .fetch_one(&pool)
    .await
    .expect("reapplied row");
    assert!(expired_deadline.is_some_and(|deadline| deadline < Utc::now()));
    assert_eq!(stored_creator, reapplied_by);

    sanctions
        .apply_block(timed, None, created_by)
        .await
        .expect("reapply forever");
    assert!(
        status
            .is_blocked(timed)
            .await
            .expect("status after forever reapply")
    );
    let (forever_deadline, stored_creator): (Option<chrono::DateTime<Utc>>, Uuid) = sqlx::query_as(
        r#"
            SELECT blocked_until, created_by
            FROM flora_core.user_account_blocks
            WHERE user_uuid = $1
            "#,
    )
    .bind(timed)
    .fetch_one(&pool)
    .await
    .expect("forever reapplied row");
    assert!(forever_deadline.is_none());
    assert_eq!(stored_creator, created_by);

    cleanup(&pool, &test_users).await;
}
