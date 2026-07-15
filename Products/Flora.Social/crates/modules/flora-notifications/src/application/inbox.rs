//! Inbox list / unread / broadcast — паритет `NotificationInboxService`.

use std::collections::HashSet;
use std::sync::Arc;

use chrono::Utc;
use flora_auth_contracts::AccountDirectory;
use flora_notifications_contracts::RealtimeNotificationSignal;
use flora_shared::flora_uuid::new_uuid;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::application::platform::{
    normalize_category, normalize_category_filter, normalize_type, resolve_audience_platform,
};
use crate::application::time::format_utc;
use crate::application::{PushTokenService, UserRealtimePublisher};
use crate::infrastructure::{ClientPlatformRepo, InboxRepo, NotificationRow};

pub struct InboxService {
    repo: Arc<InboxRepo>,
    accounts: Arc<dyn AccountDirectory>,
    client_platforms: Arc<ClientPlatformRepo>,
    push_tokens: Arc<PushTokenService>,
    realtime: Arc<UserRealtimePublisher>,
}

impl InboxService {
    pub fn new(
        repo: Arc<InboxRepo>,
        accounts: Arc<dyn AccountDirectory>,
        client_platforms: Arc<ClientPlatformRepo>,
        push_tokens: Arc<PushTokenService>,
        realtime: Arc<UserRealtimePublisher>,
    ) -> Self {
        Self {
            repo,
            accounts,
            client_platforms,
            push_tokens,
            realtime,
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
        let search = search
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| format!("%{s}%"));

        let rows = self
            .repo
            .list(
                recipient,
                category.as_deref(),
                search.as_deref(),
                skip,
                take,
                client_platform,
            )
            .await?;

        Ok(rows.into_iter().map(row_to_json).collect())
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
        self.repo.mark_read(recipient, notification_uuid).await
    }

    pub async fn mark_all_read(
        &self,
        recipient: Uuid,
        client_platform: Option<&str>,
    ) -> Result<i64, String> {
        self.repo.mark_all_read(recipient, client_platform).await
    }

    pub async fn delete(
        &self,
        recipient: Uuid,
        notification_uuids: Vec<Uuid>,
    ) -> Result<i64, String> {
        let unique: HashSet<Uuid> = notification_uuids.into_iter().collect();
        let ids: Vec<Uuid> = unique.into_iter().collect();
        self.repo.delete(recipient, &ids).await
    }

    pub async fn delete_all(
        &self,
        recipient: Uuid,
        client_platform: Option<&str>,
    ) -> Result<i64, String> {
        self.repo.delete_all(recipient, client_platform).await
    }

    /// Паритет `NotificationInboxService.BroadcastAsync`.
    pub async fn broadcast(
        &self,
        notification_type: &str,
        category: &str,
        text: &str,
        audience_platform: Option<&str>,
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
            };
            self.realtime
                .publish_notification(*recipient, &signal, true)
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
