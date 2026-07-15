//! sqlx-реализации Users: privacy, blocks, presence, profile queries.

use chrono::{DateTime, NaiveDate, Utc};
use flora_users_contracts::{
    BlockRecord, BoxFuture, PrivacySettingsDto, PrivacySettingsPatch, ProfileSnapshot,
    UserBlocklist, UserFollowMutations, UserPresence, UserPrivacySettings, UserProfileQueries,
};
use sqlx::PgPool;
use uuid::Uuid;

pub(crate) const VIS_ALL: i32 = 0;
pub(crate) const VIS_FRIENDS: i32 = 1;
const VIS_NONE: i32 = 2;
pub(crate) const MSG_ALL: i32 = 0;
pub(crate) const MSG_FRIENDS: i32 = 1;
pub(crate) const ONLINE_VISIBLE: i32 = 0;
pub(crate) const ONLINE_HIDDEN: i32 = 1;

pub struct SqlUsersStore {
    pool: PgPool,
}

impl SqlUsersStore {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[derive(sqlx::FromRow)]
struct PrivacyRow {
    friends_visibility: i32,
    subscriptions_visibility: i32,
    posts_visibility: i32,
    likes_visibility: i32,
    reposts_visibility: i32,
    messages_from: i32,
    comments_from: i32,
    online_friends: i32,
    online_strangers: i32,
}

#[derive(sqlx::FromRow)]
struct ProfileRow {
    display_name: Option<String>,
    status: Option<String>,
    gender: Option<i32>,
    birth_date: Option<NaiveDate>,
    avatar_uuid: Option<Uuid>,
}

fn default_privacy_dto() -> PrivacySettingsDto {
    PrivacySettingsDto {
        friends_visibility: "all".into(),
        subscriptions_visibility: "all".into(),
        posts_visibility: "all".into(),
        likes_visibility: "friends".into(),
        reposts_visibility: "all".into(),
        messages_from: "all".into(),
        comments_from: "all".into(),
        online_friends: "visible".into(),
        online_strangers: "hidden".into(),
    }
}

fn row_to_dto(r: &PrivacyRow) -> PrivacySettingsDto {
    PrivacySettingsDto {
        friends_visibility: vis_to_str(r.friends_visibility),
        subscriptions_visibility: vis_to_str(r.subscriptions_visibility),
        posts_visibility: vis_to_str(r.posts_visibility),
        likes_visibility: vis_to_str(r.likes_visibility),
        reposts_visibility: vis_to_str(r.reposts_visibility),
        messages_from: msg_to_str(r.messages_from),
        comments_from: vis_to_str(r.comments_from),
        online_friends: online_to_str(r.online_friends),
        online_strangers: online_to_str(r.online_strangers),
    }
}

fn vis_to_str(v: i32) -> String {
    match v {
        VIS_FRIENDS => "friends".into(),
        VIS_NONE => "none".into(),
        _ => "all".into(),
    }
}

fn msg_to_str(v: i32) -> String {
    if v == MSG_FRIENDS {
        "friends".into()
    } else {
        "all".into()
    }
}

fn online_to_str(v: i32) -> String {
    if v == ONLINE_HIDDEN {
        "hidden".into()
    } else {
        "visible".into()
    }
}

fn parse_vis(raw: &str, field: &str) -> Result<i32, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "all" => Ok(VIS_ALL),
        "friends" => Ok(VIS_FRIENDS),
        "none" => Ok(VIS_NONE),
        _ => Err(format!("Недопустимое значение {field}.")),
    }
}

fn parse_msg(raw: &str) -> Result<i32, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "all" => Ok(MSG_ALL),
        "friends" => Ok(MSG_FRIENDS),
        _ => Err("Недопустимое значение messagesFrom.".into()),
    }
}

fn parse_online(raw: &str, field: &str) -> Result<i32, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "visible" => Ok(ONLINE_VISIBLE),
        "hidden" => Ok(ONLINE_HIDDEN),
        _ => Err(format!("Недопустимое значение {field}.")),
    }
}

impl UserPrivacySettings for SqlUsersStore {
    fn get(&self, user_uuid: Uuid) -> BoxFuture<'_, Result<PrivacySettingsDto, String>> {
        Box::pin(async move {
            let row = sqlx::query_as::<_, PrivacyRow>(
                r#"
                SELECT friends_visibility, subscriptions_visibility, posts_visibility,
                       likes_visibility, reposts_visibility, messages_from, comments_from,
                       online_friends, online_strangers
                FROM flora_core.user_privacy_settings
                WHERE user_uuid = $1
                "#,
            )
            .bind(user_uuid)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
            Ok(row.map(|r| row_to_dto(&r)).unwrap_or_else(default_privacy_dto))
        })
    }

    fn update(
        &self,
        user_uuid: Uuid,
        patch: PrivacySettingsPatch,
    ) -> BoxFuture<'_, Result<PrivacySettingsDto, String>> {
        Box::pin(async move {
            let mut current = match sqlx::query_as::<_, PrivacyRow>(
                r#"
                SELECT friends_visibility, subscriptions_visibility, posts_visibility,
                       likes_visibility, reposts_visibility, messages_from, comments_from,
                       online_friends, online_strangers
                FROM flora_core.user_privacy_settings
                WHERE user_uuid = $1
                "#,
            )
            .bind(user_uuid)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| e.to_string())?
            {
                Some(r) => r,
                None => PrivacyRow {
                    friends_visibility: VIS_ALL,
                    subscriptions_visibility: VIS_ALL,
                    posts_visibility: VIS_ALL,
                    likes_visibility: VIS_FRIENDS,
                    reposts_visibility: VIS_ALL,
                    messages_from: MSG_ALL,
                    comments_from: VIS_ALL,
                    online_friends: ONLINE_VISIBLE,
                    online_strangers: ONLINE_HIDDEN,
                },
            };

            if let Some(v) = patch.friends_visibility.as_deref() {
                current.friends_visibility = parse_vis(v, "friendsVisibility")?;
            }
            if let Some(v) = patch.subscriptions_visibility.as_deref() {
                current.subscriptions_visibility = parse_vis(v, "subscriptionsVisibility")?;
            }
            if let Some(v) = patch.posts_visibility.as_deref() {
                current.posts_visibility = parse_vis(v, "postsVisibility")?;
            }
            if let Some(v) = patch.likes_visibility.as_deref() {
                current.likes_visibility = parse_vis(v, "likesVisibility")?;
            }
            if let Some(v) = patch.reposts_visibility.as_deref() {
                current.reposts_visibility = parse_vis(v, "repostsVisibility")?;
            }
            if let Some(v) = patch.messages_from.as_deref() {
                current.messages_from = parse_msg(v)?;
            }
            if let Some(v) = patch.comments_from.as_deref() {
                current.comments_from = parse_vis(v, "commentsFrom")?;
            }
            if let Some(v) = patch.online_friends.as_deref() {
                current.online_friends = parse_online(v, "onlineFriends")?;
            }
            if let Some(v) = patch.online_strangers.as_deref() {
                current.online_strangers = parse_online(v, "onlineStrangers")?;
            }

            let now = Utc::now();
            sqlx::query(
                r#"
                INSERT INTO flora_core.user_privacy_settings (
                    user_uuid, friends_visibility, subscriptions_visibility, posts_visibility,
                    likes_visibility, reposts_visibility, messages_from, comments_from,
                    online_friends, online_strangers, updated_at
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                ON CONFLICT (user_uuid) DO UPDATE SET
                    friends_visibility = EXCLUDED.friends_visibility,
                    subscriptions_visibility = EXCLUDED.subscriptions_visibility,
                    posts_visibility = EXCLUDED.posts_visibility,
                    likes_visibility = EXCLUDED.likes_visibility,
                    reposts_visibility = EXCLUDED.reposts_visibility,
                    messages_from = EXCLUDED.messages_from,
                    comments_from = EXCLUDED.comments_from,
                    online_friends = EXCLUDED.online_friends,
                    online_strangers = EXCLUDED.online_strangers,
                    updated_at = EXCLUDED.updated_at
                "#,
            )
            .bind(user_uuid)
            .bind(current.friends_visibility)
            .bind(current.subscriptions_visibility)
            .bind(current.posts_visibility)
            .bind(current.likes_visibility)
            .bind(current.reposts_visibility)
            .bind(current.messages_from)
            .bind(current.comments_from)
            .bind(current.online_friends)
            .bind(current.online_strangers)
            .bind(now)
            .execute(&self.pool)
            .await
            .map_err(|e| e.to_string())?;

            Ok(row_to_dto(&current))
        })
    }
}

impl UserBlocklist for SqlUsersStore {
    fn list(&self, owner_user_uuid: Uuid) -> BoxFuture<'_, Result<Vec<BlockRecord>, String>> {
        Box::pin(async move {
            let rows = sqlx::query_as::<_, (Uuid, DateTime<Utc>)>(
                r#"
                SELECT blocked_user_uuid, created_at
                FROM flora_core.user_blocks
                WHERE owner_user_uuid = $1
                ORDER BY created_at DESC
                "#,
            )
            .bind(owner_user_uuid)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
            Ok(rows
                .into_iter()
                .map(|(blocked_user_uuid, blocked_at_utc)| BlockRecord {
                    blocked_user_uuid,
                    blocked_at_utc,
                })
                .collect())
        })
    }

    fn block(
        &self,
        owner_user_uuid: Uuid,
        blocked_user_uuid: Uuid,
    ) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            if owner_user_uuid == blocked_user_uuid {
                return Err("Нельзя заблокировать себя.".into());
            }
            let exists: bool = sqlx::query_scalar(
                r#"
                SELECT EXISTS(
                    SELECT 1 FROM flora_core.user_blocks
                    WHERE owner_user_uuid = $1 AND blocked_user_uuid = $2
                )
                "#,
            )
            .bind(owner_user_uuid)
            .bind(blocked_user_uuid)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
            if exists {
                return Ok(());
            }
            let now = Utc::now();
            sqlx::query(
                r#"
                INSERT INTO flora_core.user_blocks (owner_user_uuid, blocked_user_uuid, created_at)
                VALUES ($1, $2, $3)
                "#,
            )
            .bind(owner_user_uuid)
            .bind(blocked_user_uuid)
            .bind(now)
            .execute(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
            Ok(())
        })
    }

    fn unblock(
        &self,
        owner_user_uuid: Uuid,
        blocked_user_uuid: Uuid,
    ) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            sqlx::query(
                r#"
                DELETE FROM flora_core.user_blocks
                WHERE owner_user_uuid = $1 AND blocked_user_uuid = $2
                "#,
            )
            .bind(owner_user_uuid)
            .bind(blocked_user_uuid)
            .execute(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
            Ok(())
        })
    }
}

impl UserPresence for SqlUsersStore {
    fn touch(&self, user_uuid: Uuid) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let now = Utc::now();
            sqlx::query(
                r#"
                INSERT INTO flora_core.user_presence (user_uuid, last_seen_at_utc)
                VALUES ($1, $2)
                ON CONFLICT (user_uuid) DO UPDATE SET last_seen_at_utc = EXCLUDED.last_seen_at_utc
                "#,
            )
            .bind(user_uuid)
            .bind(now)
            .execute(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
            Ok(())
        })
    }

    fn last_seen_by_uuids(
        &self,
        user_uuids: &[Uuid],
    ) -> BoxFuture<'_, Result<Vec<(Uuid, DateTime<Utc>)>, String>> {
        let ids = user_uuids.to_vec();
        Box::pin(async move {
            if ids.is_empty() {
                return Ok(Vec::new());
            }
            sqlx::query_as(
                r#"
                SELECT user_uuid, last_seen_at_utc
                FROM flora_core.user_presence
                WHERE user_uuid = ANY($1)
                "#,
            )
            .bind(&ids)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| e.to_string())
        })
    }
}

impl UserProfileQueries for SqlUsersStore {
    fn get_profile(
        &self,
        user_uuid: Uuid,
    ) -> BoxFuture<'_, Result<Option<ProfileSnapshot>, String>> {
        Box::pin(async move {
            let row = sqlx::query_as::<_, ProfileRow>(
                r#"
                SELECT display_name, status, gender, birth_date, avatar_uuid
                FROM flora_core.user_profiles
                WHERE user_uuid = $1
                "#,
            )
            .bind(user_uuid)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
            Ok(row.map(|r| ProfileSnapshot {
                display_name: r
                    .display_name
                    .unwrap_or_default()
                    .trim()
                    .to_string(),
                status: r.status.unwrap_or_default(),
                gender: r.gender,
                birth_date: r.birth_date.map(|d| d.format("%Y-%m-%d").to_string()),
                avatar_uuid: r.avatar_uuid,
            }))
        })
    }

    fn display_names_by_uuids(
        &self,
        user_uuids: &[Uuid],
    ) -> BoxFuture<'_, Result<Vec<(Uuid, String)>, String>> {
        let ids = user_uuids.to_vec();
        Box::pin(async move {
            if ids.is_empty() {
                return Ok(Vec::new());
            }
            let rows = sqlx::query_as::<_, (Uuid, Option<String>)>(
                r#"
                SELECT user_uuid, display_name
                FROM flora_core.user_profiles
                WHERE user_uuid = ANY($1)
                "#,
            )
            .bind(&ids)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
            Ok(rows
                .into_iter()
                .map(|(u, n)| (u, n.unwrap_or_default()))
                .collect())
        })
    }

    fn followers_count(&self, user_uuid: Uuid) -> BoxFuture<'_, Result<i64, String>> {
        Box::pin(async move {
            sqlx::query_scalar(
                r#"
                SELECT count(*)::bigint
                FROM flora_core.user_followers
                WHERE following_user_uuid = $1
                "#,
            )
            .bind(user_uuid)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| e.to_string())
        })
    }

    fn following_people_count(&self, user_uuid: Uuid) -> BoxFuture<'_, Result<i64, String>> {
        Box::pin(async move {
            sqlx::query_scalar(
                r#"
                SELECT count(*)::bigint
                FROM flora_core.user_followers
                WHERE follower_user_uuid = $1
                "#,
            )
            .bind(user_uuid)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| e.to_string())
        })
    }

    fn upsert_profile_fields(
        &self,
        user_uuid: Uuid,
        display_name: Option<&str>,
        gender: Option<i32>,
        birth_date: Option<&str>,
        status: Option<&str>,
        fallback_username: &str,
    ) -> BoxFuture<'_, Result<(), String>> {
        let display_name = display_name.map(str::to_string);
        let birth_date = birth_date.map(str::to_string);
        let status = status.map(str::to_string);
        let fallback_username = fallback_username.to_string();
        Box::pin(async move {
            let now = Utc::now();
            let existing = sqlx::query_as::<_, ProfileRow>(
                r#"
                SELECT display_name, status, gender, birth_date, avatar_uuid
                FROM flora_core.user_profiles
                WHERE user_uuid = $1
                "#,
            )
            .bind(user_uuid)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| e.to_string())?;

            let parsed_birth = match birth_date.as_deref() {
                None => None,
                Some("") => Some(None),
                Some(s) => {
                    let d = NaiveDate::parse_from_str(s, "%Y-%m-%d")
                        .map_err(|_| "Неверный формат даты рождения (ожидается ГГГГ-ММ-ДД).".to_string())?;
                    Some(Some(d))
                }
            };

            if let Some(row) = existing {
                let new_display = display_name
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| row.display_name.unwrap_or_default());
                let new_gender = gender.or(row.gender);
                let new_birth = match parsed_birth {
                    Some(v) => v,
                    None => row.birth_date,
                };
                let new_status = match status {
                    Some(s) => Some(if s.len() > 150 { s[..150].to_string() } else { s }),
                    None => row.status,
                };
                sqlx::query(
                    r#"
                    UPDATE flora_core.user_profiles
                    SET display_name = $1, gender = $2, birth_date = $3, status = $4, updated_at = $5
                    WHERE user_uuid = $6
                    "#,
                )
                .bind(new_display)
                .bind(new_gender)
                .bind(new_birth)
                .bind(new_status)
                .bind(now)
                .bind(user_uuid)
                .execute(&self.pool)
                .await
                .map_err(|e| e.to_string())?;
            } else {
                let dn = display_name
                    .filter(|s| !s.is_empty())
                    .unwrap_or(fallback_username);
                let st = status.filter(|s| s.len() <= 150);
                let bd = parsed_birth.flatten();
                sqlx::query(
                    r#"
                    INSERT INTO flora_core.user_profiles (
                        user_uuid, display_name, gender, birth_date, status, created_at, updated_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, $6)
                    "#,
                )
                .bind(user_uuid)
                .bind(dn)
                .bind(gender)
                .bind(bd)
                .bind(st)
                .bind(now)
                .execute(&self.pool)
                .await
                .map_err(|e| e.to_string())?;
            }
            Ok(())
        })
    }

    fn search_user_uuids_by_display_name_contains(
        &self,
        exclude_user_uuid: Uuid,
        query_lower: &str,
    ) -> BoxFuture<'_, Result<Vec<Uuid>, String>> {
        let pattern = format!("%{query_lower}%");
        Box::pin(async move {
            sqlx::query_scalar(
                r#"
                SELECT user_uuid
                FROM flora_core.user_profiles
                WHERE user_uuid <> $1
                  AND display_name IS NOT NULL
                  AND LOWER(display_name) LIKE $2
                "#,
            )
            .bind(exclude_user_uuid)
            .bind(pattern)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| e.to_string())
        })
    }

    fn profile_fields_by_uuids(
        &self,
        user_uuids: &[Uuid],
    ) -> BoxFuture<'_, Result<Vec<(Uuid, Option<String>, Option<Uuid>)>, String>> {
        let ids = user_uuids.to_vec();
        Box::pin(async move {
            if ids.is_empty() {
                return Ok(Vec::new());
            }
            sqlx::query_as(
                r#"
                SELECT user_uuid, display_name, avatar_uuid
                FROM flora_core.user_profiles
                WHERE user_uuid = ANY($1)
                "#,
            )
            .bind(&ids)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| e.to_string())
        })
    }

    fn list_follower_user_uuids(
        &self,
        owner_user_uuid: Uuid,
        skip: i32,
        take: i32,
    ) -> BoxFuture<'_, Result<Vec<Uuid>, String>> {
        Box::pin(async move {
            sqlx::query_scalar(
                r#"
                SELECT follower_user_uuid
                FROM flora_core.user_followers
                WHERE following_user_uuid = $1
                ORDER BY follower_user_uuid
                OFFSET $2 LIMIT $3
                "#,
            )
            .bind(owner_user_uuid)
            .bind(i64::from(skip.max(0)))
            .bind(i64::from(take.max(1)))
            .fetch_all(&self.pool)
            .await
            .map_err(|e| e.to_string())
        })
    }

    fn list_following_user_uuids(
        &self,
        owner_user_uuid: Uuid,
        skip: i32,
        take: i32,
    ) -> BoxFuture<'_, Result<Vec<Uuid>, String>> {
        Box::pin(async move {
            sqlx::query_scalar(
                r#"
                SELECT following_user_uuid
                FROM flora_core.user_followers
                WHERE follower_user_uuid = $1
                ORDER BY following_user_uuid
                OFFSET $2 LIMIT $3
                "#,
            )
            .bind(owner_user_uuid)
            .bind(i64::from(skip.max(0)))
            .bind(i64::from(take.max(1)))
            .fetch_all(&self.pool)
            .await
            .map_err(|e| e.to_string())
        })
    }
}

impl UserFollowMutations for SqlUsersStore {
    fn follow(
        &self,
        follower_user_uuid: Uuid,
        following_user_uuid: Uuid,
    ) -> BoxFuture<'_, Result<bool, String>> {
        Box::pin(async move {
            let exists: bool = sqlx::query_scalar(
                r#"
                SELECT EXISTS(
                    SELECT 1 FROM flora_core.user_followers
                    WHERE follower_user_uuid = $1 AND following_user_uuid = $2
                )
                "#,
            )
            .bind(follower_user_uuid)
            .bind(following_user_uuid)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
            if exists {
                return Ok(false);
            }
            sqlx::query(
                r#"
                INSERT INTO flora_core.user_followers (follower_user_uuid, following_user_uuid)
                VALUES ($1, $2)
                "#,
            )
            .bind(follower_user_uuid)
            .bind(following_user_uuid)
            .execute(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
            Ok(true)
        })
    }

    fn unfollow(
        &self,
        follower_user_uuid: Uuid,
        following_user_uuid: Uuid,
    ) -> BoxFuture<'_, Result<bool, String>> {
        Box::pin(async move {
            let result = sqlx::query(
                r#"
                DELETE FROM flora_core.user_followers
                WHERE follower_user_uuid = $1 AND following_user_uuid = $2
                "#,
            )
            .bind(follower_user_uuid)
            .bind(following_user_uuid)
            .execute(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
            Ok(result.rows_affected() > 0)
        })
    }

    fn following_among(
        &self,
        follower_user_uuid: Uuid,
        candidate_following_uuids: &[Uuid],
    ) -> BoxFuture<'_, Result<Vec<Uuid>, String>> {
        let ids = candidate_following_uuids.to_vec();
        Box::pin(async move {
            if ids.is_empty() {
                return Ok(Vec::new());
            }
            sqlx::query_scalar(
                r#"
                SELECT following_user_uuid
                FROM flora_core.user_followers
                WHERE follower_user_uuid = $1
                  AND following_user_uuid = ANY($2)
                "#,
            )
            .bind(follower_user_uuid)
            .bind(&ids)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| e.to_string())
        })
    }
}
