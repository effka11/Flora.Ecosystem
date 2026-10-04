//! Inbox list / unread / broadcast — паритет `NotificationInboxService`.

use std::collections::HashSet;
use std::sync::Arc;

use chrono::Utc;
use flora_auth_contracts::AccountDirectory;
use flora_notifications_contracts::{AppUpdatePayload, RealtimeNotificationSignal};
use flora_shared::flora_uuid::new_uuid;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::application::notifications_search::{NotificationSearchIndex, notification_doc};
use crate::application::platform::{
    normalize_category, normalize_category_filter, normalize_type, resolve_audience_platform,
};
use crate::application::time::format_utc;
use crate::application::{PushTokenService, UserRealtimePublisher};
use crate::infrastructure::{ClientPlatformRepo, InboxRepo, NotificationIndexRow, NotificationRow};

pub struct InboxService {
    repo: Arc<InboxRepo>,
    accounts: Arc<dyn AccountDirectory>,
    client_platforms: Arc<ClientPlatformRepo>,
    push_tokens: Arc<PushTokenService>,
    realtime: Arc<UserRealtimePublisher>,
    search_index: NotificationSearchIndex,
}

impl InboxService {
    pub fn new(
        repo: Arc<InboxRepo>,
        accounts: Arc<dyn AccountDirectory>,
        client_platforms: Arc<ClientPlatformRepo>,
        push_tokens: Arc<PushTokenService>,
        realtime: Arc<UserRealtimePublisher>,
        search_index: NotificationSearchIndex,
    ) -> Self {
        Self {
            repo,
            accounts,
            client_platforms,
            push_tokens,
            realtime,
            search_index,
        }
    }

    pub async fn list(
        &self,
        recipient: Uuid,
        category: Option<&str>,
        search: Option<&str>,
        skip: i32,
        take: i32,
        client_platform: Option<&str>,
    ) -> Result<Vec<Value>, String> {
        if take <= 0 {
            return Ok(Vec::new());
        }
        let take = take.min(100);
        let skip = skip.max(0);
        let category = normalize_category_filter(category);
        let q = search.map(str::trim).filter(|s| !s.is_empty());

        if let Some(q) = q {
            return self
                .list_search(
                    recipient,
                    q,
                    category.as_deref(),
                    skip,
                    take,
                    client_platform,
                )
                .await;
        }

        let rows = self
            .repo
            .list(recipient, category.as_deref(), skip, take, client_platform)
            .await?;

        Ok(rows.into_iter().map(row_to_json).collect())
    }

    async fn list_search(
        &self,
        recipient: Uuid,
        query: &str,
        category: Option<&str>,
        skip: i32,
        take: i32,
        client_platform: Option<&str>,
    ) -> Result<Vec<Value>, String> {
        const SEARCH_BATCH: i32 = 50;
        let take_n = take.max(0) as usize;
        let skip_n = skip.max(0) as usize;
        let need = skip_n + take_n;
        let mut visible: Vec<NotificationRow> = Vec::new();
        let mut fsa_offset = 0i32;
        loop {
            let Some(ids) =
                self.search_index
                    .search_ids(recipient, query, fsa_offset, SEARCH_BATCH)
            else {
                if fsa_offset == 0 {
                    self.spawn_lazy_rebuild(recipient);
                }
                break;
            };
            if ids.is_empty() {
                break;
            }
            let batch_len = ids.len();
            fsa_offset += i32::try_from(batch_len).unwrap_or(i32::MAX);
            let rows = self
                .repo
                .list_by_ids(recipient, &ids, category, client_platform)
                .await?;
            visible.extend(rows);
            if visible.len() >= need || batch_len < SEARCH_BATCH as usize {
                break;
            }
        }
        Ok(visible
            .into_iter()
            .skip(skip_n)
            .take(take_n)
            .map(row_to_json)
            .collect())
    }

    fn spawn_lazy_rebuild(&self, recipient: Uuid) {
        if !self.search_index.begin_lazy_rebuild(recipient) {
            return;
        }
        let repo = Arc::clone(&self.repo);
        let search_index = self.search_index.clone();
        tokio::spawn(async move {
            match repo.list_for_index(recipient).await {
                Ok(rows) => {
                    let docs = rows.into_iter().map(index_row_to_doc).collect();
                    search_index.finish_rebuild(recipient, docs);
                }
                Err(error) => {
                    tracing::warn!(
                        %error,
                        %recipient,
                        "notifications FSA-N lazy rebuild failed"
                    );
                    search_index.abandon_rebuild(recipient);
                }
            }
        });
    }

    pub async fn unread_count(
        &self,
        recipient: Uuid,
        client_platform: Option<&str>,
    ) -> Result<i64, String> {
        self.repo.unread_count(recipient, client_platform).await
    }

    pub async fn mark_read(
        &self,
        recipient: Uuid,
        notification_uuid: Uuid,
    ) -> Result<bool, String> {
        let found = self.repo.mark_read(recipient, notification_uuid).await?;
        if found
            && let Some(row) = self
                .repo
                .get_for_index(recipient, notification_uuid)
                .await?
        {
            self.search_index
                .upsert_if_present(recipient, index_row_to_doc(row));
        }
        Ok(found)
    }

    pub async fn mark_all_read(
        &self,
        recipient: Uuid,
        client_platform: Option<&str>,
    ) -> Result<i64, String> {
        let marked = self.repo.mark_all_read(recipient, client_platform).await?;
        if marked > 0 && self.search_index.has_slot(recipient) {
            match self.repo.list_for_index(recipient).await {
                Ok(rows) => {
                    for row in rows {
                        self.search_index
                            .upsert_if_present(recipient, index_row_to_doc(row));
                    }
                }
                Err(error) => {
                    tracing::warn!(
                        %error,
                        %recipient,
                        "notifications FSA-N mark-all-read reindex failed"
                    );
                }
            }
        }
        Ok(marked)
    }

    pub async fn delete(
        &self,
        recipient: Uuid,
        notification_uuids: Vec<Uuid>,
    ) -> Result<i64, String> {
        let unique: HashSet<Uuid> = notification_uuids.into_iter().collect();
        let ids: Vec<Uuid> = unique.into_iter().collect();
        let deleted = self.repo.delete(recipient, &ids).await?;
        for id in ids {
            self.search_index.remove_if_present(recipient, id);
        }
        Ok(deleted)
    }

    pub async fn delete_all(
        &self,
        recipient: Uuid,
        client_platform: Option<&str>,
    ) -> Result<i64, String> {
        let deleted = self.repo.delete_all(recipient, client_platform).await?;
        if client_platform.is_none() {
            self.search_index.drop_user(recipient);
        } else if deleted > 0 && self.search_index.has_slot(recipient) {
            match self.repo.list_for_index(recipient).await {
                Ok(rows) => self.search_index.finish_rebuild(recipient, {
                    rows.into_iter().map(index_row_to_doc).collect()
                }),
                Err(error) => {
                    tracing::warn!(
                        %error,
                        %recipient,
                        "notifications FSA-N delete-all reindex failed"
                    );
                    self.search_index.drop_user(recipient);
                }
            }
        }
        Ok(deleted)
    }

    /// Паритет `NotificationInboxService.BroadcastAsync`.
    ///
    /// For `app_update`, FCM is sent (`skip_push=false`) with optional sideload metadata.
    pub async fn broadcast(
        &self,
        notification_type: &str,
        category: &str,
        text: &str,
        audience_platform: Option<&str>,
        update: Option<AppUpdatePayload>,
    ) -> Result<i32, String> {
        let text = text.trim();
        if text.is_empty() {
            return Ok(0);
        }

        let notification_type = normalize_type(notification_type);
        let category = normalize_category(category);
        let body = if text.chars().count() <= 500 {
            text.to_string()
        } else {
            text.chars().take(500).collect()
        };
        let target_platform = resolve_audience_platform(&notification_type, audience_platform);
        let skip_push = notification_type != "app_update";

        // Sideload auto-update needs structured update{} on the wire (FCM/SSE).
        if notification_type == "app_update" && update.is_none() {
            return Err(
                "app_update broadcast requires update{version,versionCode,apkUrl,sha256}".into(),
            );
        }

        let recipient_uuids = self
            .resolve_broadcast_recipients(target_platform.as_deref())
            .await?;
        if recipient_uuids.is_empty() {
            return Ok(0);
        }

        let mut rows = Vec::with_capacity(recipient_uuids.len());
        for recipient in recipient_uuids {
            let notification_uuid = new_uuid();
            let created_at = Utc::now();
            self.repo
                .insert_with_target(
                    notification_uuid,
                    recipient,
                    None,
                    &notification_type,
                    &category,
                    &body,
                    None,
                    None,
                    target_platform.as_deref(),
                    created_at,
                )
                .await?;
            rows.push((notification_uuid, recipient, created_at));
            self.search_index.upsert_if_present(
                recipient,
                notification_doc(
                    notification_uuid,
                    body.clone(),
                    None,
                    None,
                    notification_type.clone(),
                    false,
                    created_at,
                ),
            );
        }

        for (notification_uuid, recipient, created_at) in &rows {
            let signal = RealtimeNotificationSignal {
                notification_uuid: *notification_uuid,
                notification_type: notification_type.clone(),
                category: category.clone(),
                text: body.clone(),
                actor_user_uuid: None,
                post_uuid: None,
                comment_uuid: None,
                created_at: *created_at,
                update: update.clone(),
            };
            self.realtime
                .publish_notification(*recipient, &signal, skip_push)
                .await;
        }

        Ok(i32::try_from(rows.len()).unwrap_or(i32::MAX))
    }

    /// Паритет `ResolveBroadcastRecipientsAsync`.
    async fn resolve_broadcast_recipients(
        &self,
        audience_platform: Option<&str>,
    ) -> Result<Vec<Uuid>, String> {
        let active = self.accounts.list_active_user_uuids().await?;
        if active.is_empty() {
            return Ok(Vec::new());
        }

        let Some(platform) = audience_platform else {
            return Ok(active);
        };

        let mut audience = HashSet::new();
        for uuid in self.client_platforms.list_user_uuids(platform).await? {
            audience.insert(uuid);
        }
        for uuid in self
            .push_tokens
            .list_user_uuids_by_platform(platform)
            .await?
        {
            audience.insert(uuid);
        }

        Ok(active
            .into_iter()
            .filter(|u| audience.contains(u))
            .collect())
    }
}

fn row_to_json(row: NotificationRow) -> Value {
    json!({
        "notificationUuid": row.notification_uuid,
        "type": row.notification_type,
        "category": row.category,
        "text": row.text,
        "createdAt": format_utc(row.created_at),
        "isRead": row.is_read,
        "postUuid": row.post_uuid,
        "commentUuid": row.comment_uuid,
    })
}

fn index_row_to_doc(row: NotificationIndexRow) -> fsa_core::notifications::NotificationDoc {
    notification_doc(
        row.notification_uuid,
        row.text,
        row.actor_user_uuid,
        None,
        row.notification_type,
        row.is_read,
        row.created_at,
    )
}
