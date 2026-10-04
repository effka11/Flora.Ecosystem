//! §User Controls (FIRA-F v1.1): настройки ленты + негативный фидбек.
//! Персистенс — таблицы Content-модуля; kernel-логика — `fira_core::feed`.

use std::sync::Arc;

use chrono::Utc;
use fira_core::{AuthorDiversity, ExplorationLevel, FeedFreshness, FeedPreferences, SeenPostsMode};
use flora_auth_contracts::AccountDirectory;
use flora_users_contracts::FeedAuthorProfiles;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::application::community_recommendation::CommunityRecommendationService;
use crate::application::feed::FeedService;
use crate::application::time::format_utc;
use crate::infrastructure::repo::{ContentRepo, FeedSettingsRow};

#[derive(Debug, PartialEq, Eq)]
pub enum FeedControlsError {
    NotFound,
    Validation(String),
}

/// PATCH-семантика: отсутствующее поле = «не менять».
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedSettingsPatch {
    pub freshness: Option<String>,
    pub exploration: Option<String>,
    pub show_reposts: Option<bool>,
    pub community_posts: Option<bool>,
    pub seen_posts: Option<String>,
    pub author_diversity: Option<String>,
}

pub struct FeedControlsService {
    repo: Arc<ContentRepo>,
    accounts: Arc<dyn AccountDirectory>,
    profiles: Arc<dyn FeedAuthorProfiles>,
    feed: Arc<FeedService>,
    recommendations: Arc<CommunityRecommendationService>,
}

impl FeedControlsService {
    pub fn new(
        repo: Arc<ContentRepo>,
        accounts: Arc<dyn AccountDirectory>,
        profiles: Arc<dyn FeedAuthorProfiles>,
        feed: Arc<FeedService>,
        recommendations: Arc<CommunityRecommendationService>,
    ) -> Self {
        Self {
            repo,
            accounts,
            profiles,
            feed,
            recommendations,
        }
    }

    // ------------------------------------------------------------------
    // Настройки ленты
    // ------------------------------------------------------------------

    pub async fn get_settings(&self, user_uuid: Uuid) -> Result<Value, String> {
        let row = self
            .repo
            .feed_settings(user_uuid)
            .await
            .map_err(|e| e.to_string())?;
        let updated_at = row.as_ref().map(|r| r.updated_at);
        let prefs = row.map(|r| preferences_from_row(&r)).unwrap_or_default();
        Ok(settings_json(&prefs, updated_at.map(format_utc)))
    }

    pub async fn update_settings(
        &self,
        user_uuid: Uuid,
        patch: FeedSettingsPatch,
    ) -> Result<Result<Value, FeedControlsError>, String> {
        let current = self
            .repo
            .feed_settings(user_uuid)
            .await
            .map_err(|e| e.to_string())?
            .map(|r| preferences_from_row(&r))
            .unwrap_or_default();

        let mut next = current;
        if let Some(raw) = patch.freshness.as_deref() {
            match FeedFreshness::parse(raw) {
                Some(v) => next.freshness = v,
                None => return Ok(Err(invalid_value("freshness", raw))),
            }
        }
        if let Some(raw) = patch.exploration.as_deref() {
            match ExplorationLevel::parse(raw) {
                Some(v) => next.exploration = v,
                None => return Ok(Err(invalid_value("exploration", raw))),
            }
        }
        if let Some(v) = patch.show_reposts {
            next.show_reposts = v;
        }
        if let Some(v) = patch.community_posts {
            next.community_posts = v;
        }
        if let Some(raw) = patch.seen_posts.as_deref() {
            match SeenPostsMode::parse(raw) {
                Some(v) => next.seen_posts = v,
                None => return Ok(Err(invalid_value("seenPosts", raw))),
            }
        }
        if let Some(raw) = patch.author_diversity.as_deref() {
            match AuthorDiversity::parse(raw) {
                Some(v) => next.author_diversity = v,
                None => return Ok(Err(invalid_value("authorDiversity", raw))),
            }
        }

        let updated_at = Utc::now();
        self.repo
            .upsert_feed_settings(user_uuid, &row_from_preferences(&next, updated_at))
            .await
            .map_err(|e| e.to_string())?;
        self.feed.invalidate(user_uuid);
        Ok(Ok(settings_json(&next, Some(format_utc(updated_at)))))
    }

    // ------------------------------------------------------------------
    // «Не интересно» для постов
    // ------------------------------------------------------------------

    pub async fn mark_post_not_interested(
        &self,
        user_uuid: Uuid,
        post_uuid: Uuid,
    ) -> Result<Result<(), FeedControlsError>, String> {
        let Some(author) = self
            .repo
            .post_author_uuid(post_uuid)
            .await
            .map_err(|e| e.to_string())?
        else {
            return Ok(Err(FeedControlsError::NotFound));
        };
        if author == user_uuid {
            return Ok(Err(FeedControlsError::Validation(
                "Нельзя отметить свой пост как неинтересный.".into(),
            )));
        }
        self.repo
            .insert_post_not_interested(user_uuid, post_uuid, author, Utc::now())
            .await
            .map_err(|e| e.to_string())?;
        self.feed.invalidate(user_uuid);
        Ok(Ok(()))
    }

    pub async fn unmark_post_not_interested(
        &self,
        user_uuid: Uuid,
        post_uuid: Uuid,
    ) -> Result<bool, String> {
        let removed = self
            .repo
            .delete_post_not_interested(user_uuid, post_uuid)
            .await
            .map_err(|e| e.to_string())?;
        if removed {
            self.feed.invalidate(user_uuid);
        }
        Ok(removed)
    }

    pub async fn clear_not_interested(&self, user_uuid: Uuid) -> Result<u64, String> {
        let cleared = self
            .repo
            .clear_post_not_interested(user_uuid)
            .await
            .map_err(|e| e.to_string())?;
        if cleared > 0 {
            self.feed.invalidate(user_uuid);
        }
        Ok(cleared)
    }

    // ------------------------------------------------------------------
    // Скрытые авторы (только рекомендации; подписки не трогаем)
    // ------------------------------------------------------------------

    pub async fn hide_author(
        &self,
        user_uuid: Uuid,
        author_uuid: Uuid,
    ) -> Result<Result<(), FeedControlsError>, String> {
        if author_uuid == user_uuid {
            return Ok(Err(FeedControlsError::Validation(
                "Нельзя скрыть собственные посты из своей ленты.".into(),
            )));
        }
        let known = self.accounts.usernames_by_uuids(&[author_uuid]).await?;
        if known.is_empty() {
            return Ok(Err(FeedControlsError::NotFound));
        }
        self.repo
            .insert_hidden_author(user_uuid, author_uuid, Utc::now())
            .await
            .map_err(|e| e.to_string())?;
        self.feed.invalidate(user_uuid);
        Ok(Ok(()))
    }

    pub async fn unhide_author(&self, user_uuid: Uuid, author_uuid: Uuid) -> Result<bool, String> {
        let removed = self
            .repo
            .delete_hidden_author(user_uuid, author_uuid)
            .await
            .map_err(|e| e.to_string())?;
        if removed {
            self.feed.invalidate(user_uuid);
        }
        Ok(removed)
    }

    pub async fn hidden_authors(&self, user_uuid: Uuid) -> Result<Value, String> {
        let rows = self
            .repo
            .hidden_authors_with_dates(user_uuid)
            .await
            .map_err(|e| e.to_string())?;
        let ids: Vec<Uuid> = rows.iter().map(|(id, _)| *id).collect();
        let usernames: std::collections::HashMap<Uuid, String> = self
            .accounts
            .usernames_by_uuids(&ids)
            .await?
            .into_iter()
            .collect();
        let profiles: std::collections::HashMap<Uuid, _> = self
            .profiles
            .by_uuids(&ids)
            .await?
            .into_iter()
            .map(|p| (p.user_uuid, p))
            .collect();
        let items: Vec<Value> = rows
            .into_iter()
            .map(|(id, hidden_at)| {
                let profile = profiles.get(&id);
                json!({
                    "userUuid": id,
                    "username": usernames.get(&id).cloned().unwrap_or_default(),
                    "displayName": profile.map(|p| p.display_name.clone()).unwrap_or_default(),
                    "avatarUuid": profile.and_then(|p| p.avatar_uuid),
                    "hiddenAt": format_utc(hidden_at),
                })
            })
            .collect();
        Ok(json!({ "items": items }))
    }

    // ------------------------------------------------------------------
    // Отклонённые сообщества (только рекомендации FIRA-C)
    // ------------------------------------------------------------------

    pub async fn dismiss_community(
        &self,
        user_uuid: Uuid,
        community_id: Uuid,
    ) -> Result<Result<(), FeedControlsError>, String> {
        let known = self
            .repo
            .communities_by_ids(&[community_id])
            .await
            .map_err(|e| e.to_string())?;
        if known.is_empty() {
            return Ok(Err(FeedControlsError::NotFound));
        }
        self.repo
            .insert_community_dismissal(user_uuid, community_id, Utc::now())
            .await
            .map_err(|e| e.to_string())?;
        self.recommendations.invalidate(user_uuid);
        Ok(Ok(()))
    }

    pub async fn undismiss_community(
        &self,
        user_uuid: Uuid,
        community_id: Uuid,
    ) -> Result<bool, String> {
        let removed = self
            .repo
            .delete_community_dismissal(user_uuid, community_id)
            .await
            .map_err(|e| e.to_string())?;
        if removed {
            self.recommendations.invalidate(user_uuid);
        }
        Ok(removed)
    }

    pub async fn dismissed_communities(&self, user_uuid: Uuid) -> Result<Value, String> {
        let ids = self
            .repo
            .dismissed_community_ids(user_uuid)
            .await
            .map_err(|e| e.to_string())?;
        let metas = self
            .repo
            .communities_by_ids(&ids)
            .await
            .map_err(|e| e.to_string())?;
        let by_id: std::collections::HashMap<Uuid, _> =
            metas.into_iter().map(|c| (c.community_id, c)).collect();
        // Сохраняем порядок «последние отклонённые сверху» из dismissed_community_ids.
        let items: Vec<Value> = ids
            .into_iter()
            .filter_map(|id| by_id.get(&id))
            .map(|c| {
                json!({
                    "communityId": c.community_id,
                    "name": c.name,
                    "slug": c.slug,
                    "avatarUuid": c.avatar_uuid,
                })
            })
            .collect();
        Ok(json!({ "items": items }))
    }
}

fn invalid_value(field: &str, raw: &str) -> FeedControlsError {
    FeedControlsError::Validation(format!("Недопустимое значение '{raw}' для поля '{field}'."))
}

pub(crate) fn preferences_from_row(row: &FeedSettingsRow) -> FeedPreferences {
    let d = FeedPreferences::default();
    FeedPreferences {
        freshness: FeedFreshness::parse(&row.freshness).unwrap_or(d.freshness),
        exploration: ExplorationLevel::parse(&row.exploration).unwrap_or(d.exploration),
        show_reposts: row.show_reposts,
        community_posts: row.community_posts,
        seen_posts: SeenPostsMode::parse(&row.seen_posts).unwrap_or(d.seen_posts),
        author_diversity: AuthorDiversity::parse(&row.author_diversity)
            .unwrap_or(d.author_diversity),
    }
}

fn row_from_preferences(
    prefs: &FeedPreferences,
    updated_at: chrono::DateTime<Utc>,
) -> FeedSettingsRow {
    FeedSettingsRow {
        freshness: prefs.freshness.as_str().to_string(),
        exploration: prefs.exploration.as_str().to_string(),
        show_reposts: prefs.show_reposts,
        community_posts: prefs.community_posts,
        seen_posts: prefs.seen_posts.as_str().to_string(),
        author_diversity: prefs.author_diversity.as_str().to_string(),
        updated_at,
    }
}

fn settings_json(prefs: &FeedPreferences, updated_at: Option<String>) -> Value {
    json!({
        "freshness": prefs.freshness.as_str(),
        "exploration": prefs.exploration.as_str(),
        "showReposts": prefs.show_reposts,
        "communityPosts": prefs.community_posts,
        "seenPosts": prefs.seen_posts.as_str(),
        "authorDiversity": prefs.author_diversity.as_str(),
        "updatedAt": updated_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn row_roundtrip_preserves_preferences() {
        let prefs = FeedPreferences {
            freshness: FeedFreshness::Fresh,
            exploration: ExplorationLevel::Off,
            show_reposts: false,
            community_posts: false,
            seen_posts: SeenPostsMode::Hide,
            author_diversity: AuthorDiversity::Strict,
        };
        let row = row_from_preferences(&prefs, Utc::now());
        assert_eq!(preferences_from_row(&row), prefs);
    }

    #[test]
    fn unknown_row_values_fall_back_to_defaults() {
        let row = FeedSettingsRow {
            freshness: "legacy-value".into(),
            exploration: "??".into(),
            show_reposts: false,
            community_posts: true,
            seen_posts: "".into(),
            author_diversity: "none".into(),
            updated_at: Utc::now(),
        };
        let prefs = preferences_from_row(&row);
        let d = FeedPreferences::default();
        assert_eq!(prefs.freshness, d.freshness);
        assert_eq!(prefs.exploration, d.exploration);
        assert_eq!(prefs.seen_posts, d.seen_posts);
        assert_eq!(prefs.author_diversity, d.author_diversity);
        assert!(!prefs.show_reposts);
        assert!(prefs.community_posts);
    }
}
