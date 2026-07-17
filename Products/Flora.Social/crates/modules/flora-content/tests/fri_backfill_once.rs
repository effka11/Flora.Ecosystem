//! One-shot local DB backfill. Run:
//! `cargo test -p flora-content --test fri_backfill_once -- --ignored --nocapture`

use sqlx::postgres::PgPoolOptions;

#[tokio::test]
#[ignore = "mutates local flora_social DB"]
async fn backfill_content_media_to_fri() {
    let url = std::env::var("DATABASE_URL").unwrap_or_else(|_| {
        "postgres://flora:change-me@127.0.0.1:5432/flora_social".to_string()
    });
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&url)
        .await
        .expect("connect flora_social");
    sqlx::query("SET search_path TO flora_core")
        .execute(&pool)
        .await
        .expect("search_path");
    flora_content::infrastructure::image_backfill::run(pool).await;
}
