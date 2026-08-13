//! Users-owned profile snapshot for FSA-P rebuild (username comes from Auth).

use sqlx::PgPool;
use uuid::Uuid;

pub struct PeopleIndexProfile {
    pub user_uuid: Uuid,
    pub display_name: String,
    pub status: String,
}

pub async fn load_profiles(pool: &PgPool) -> Result<Vec<PeopleIndexProfile>, sqlx::Error> {
    let rows: Vec<(Uuid, Option<String>, Option<String>)> = sqlx::query_as(
        r#"
        SELECT user_uuid, display_name, status
        FROM flora_core.user_profiles
        "#,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(user_uuid, display_name, status)| PeopleIndexProfile {
            user_uuid,
            display_name: display_name.unwrap_or_default(),
            status: status.unwrap_or_default(),
        })
        .collect())
}
