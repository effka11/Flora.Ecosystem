//! Inbox `DispatchAsync` + social aggregation apply/retract.

use std::sync::Arc;

use chrono::Utc;
use flora_notifications_contracts::{
    BoxFuture, CreateUserNotificationCommand, RealtimeNotificationRemovedSignal,
    RealtimeNotificationSignal, SocialActivityCommand, UserNotificationDispatcher,
};
use flora_shared::flora_uuid::new_uuid;

use crate::application::UserRealtimePublisher;
use crate::application::platform::{
    normalize_category, normalize_type, requires_social_aggregation,
};
use crate::application::realtime_publisher::SocialNotificationPush;
use crate::application::social::{
    SocialApplyPushDecision, SocialRetractPushDecision, actors_to_json, apply_actor_membership,
    apply_social_push_decision, audible_push_allowed, build_social_text, group_key,
    notification_type, parse_actors_json, post_uuid, retract_actor_membership,
    retract_social_push_decision, retract_updates_push_state,
    updates_push_state,
};
use crate::infrastructure::InboxRepo;

pub struct InboxNotificationDispatcher {
    repo: Arc<InboxRepo>,
    realtime: Arc<UserRealtimePublisher>,
}

impl InboxNotificationDispatcher {
    pub fn new(repo: Arc<InboxRepo>, realtime: Arc<UserRealtimePublisher>) -> Self {
        Self { repo, realtime }
    }

    async fn dispatch_inner(&self, command: CreateUserNotificationCommand) -> Result<(), String> {
        if command.recipient_user_uuid.is_nil() {
            return Ok(());
        }
        if let Some(actor) = command.actor_user_uuid
            && actor == command.recipient_user_uuid
        {
            return Ok(());
        }

        let text = command.text.trim();
        if text.is_empty() {
            return Ok(());
        }
        let text = if text.chars().count() <= 500 {
            text.to_string()
        } else {
            text.chars().take(500).collect()
        };

        let notification_type = normalize_type(&command.notification_type);
        // like/follow aggregation owns group_key / actors_json — never unkeyed INSERT via dispatch.
        if requires_social_aggregation(&notification_type) {
            return Err(
                "like/follow must use UserNotificationDispatcher::apply_social / retract_social"
                    .into(),
            );
        }
        let category = normalize_category(&command.category);
        let notification_uuid = new_uuid();
        let created_at = Utc::now();

        self.repo
            .insert(
                notification_uuid,
                command.recipient_user_uuid,
                command.actor_user_uuid,
                &notification_type,
                &category,
                &text,
                command.post_uuid,
                command.comment_uuid,
                created_at,
            )
            .await?;

        let signal = RealtimeNotificationSignal {
            notification_uuid,
            notification_type,
            category,
            text,
            actor_user_uuid: command.actor_user_uuid,
            post_uuid: command.post_uuid,
            comment_uuid: command.comment_uuid,
            created_at,
            update: None,
        };

        self.realtime
            .publish_notification(command.recipient_user_uuid, &signal, false)
            .await;
        Ok(())
    }

    async fn apply_social_inner(&self, command: SocialActivityCommand) -> Result<(), String> {
        if command.recipient_user_uuid.is_nil() {
            return Ok(());
        }
        if command.actor_user_uuid.is_nil()
            || command.actor_user_uuid == command.recipient_user_uuid
        {
            return Ok(());
        }

        let group_key = group_key(&command.kind);
        let notification_type = notification_type(&command.kind);
        let post_uuid = post_uuid(&command.kind);
        let category = "social";
        let now = Utc::now();

        let mut tx = self.repo.begin().await?;
        let existing = self
            .repo
            .find_by_group_for_update(&mut tx, command.recipient_user_uuid, &group_key)
            .await?;

        let current_actors = match &existing {
            Some(row) => parse_actors_json(&row.actors_json)?,
            None => Vec::new(),
        };

        let Some(actors) = apply_actor_membership(
            &current_actors,
            command.actor_user_uuid,
            &command.actor_label,
            now,
        ) else {
            // Idempotent: actor already in membership — full no-op.
            return Ok(());
        };

        let text = build_social_text(&command.kind, &actors);
        if text.is_empty() {
            return Ok(());
        }
        let text = if text.chars().count() <= 500 {
            text
        } else {
            text.chars().take(500).collect()
        };

        let actors_json = actors_to_json(&actors)?;
        let actor_count = i32::try_from(actors.len()).unwrap_or(i32::MAX);
        let newest_actor = actors
            .first()
            .map(|a| a.uuid)
            .unwrap_or(command.actor_user_uuid);

        let (notification_uuid, created_at, is_existing) = match &existing {
            Some(row) => (row.notification_uuid, now, true),
            None => (new_uuid(), now, false),
        };

        self.repo
            .upsert_group(
                &mut tx,
                notification_uuid,
                command.recipient_user_uuid,
                newest_actor,
                notification_type,
                category,
                &text,
                post_uuid,
                &group_key,
                actor_count,
                &actors_json,
                created_at,
                is_existing,
            )
            .await?;

        // Cool check + claim under group lock so concurrent apply cannot double-spend
        // the 15m audible budget (DoD: A+B in window → 1 audible).
        let previous_push_at = self
            .repo
            .get_push_state(&mut tx, command.recipient_user_uuid, &group_key)
            .await?;
        let allow_audible = audible_push_allowed(previous_push_at, now);
        let decision = apply_social_push_decision(allow_audible);
        if updates_push_state(decision) {
            self.repo
                .set_push_state(&mut tx, command.recipient_user_uuid, &group_key, now)
                .await?;
        }

        tx.commit().await.map_err(|e| e.to_string())?;

        let signal = RealtimeNotificationSignal {
            notification_uuid,
            notification_type: notification_type.to_string(),
            category: category.to_string(),
            text,
            actor_user_uuid: Some(newest_actor),
            post_uuid,
            comment_uuid: None,
            created_at,
            update: None,
        };

        let push = match decision {
            SocialApplyPushDecision::Audible => SocialNotificationPush::Audible {
                tag: group_key.clone(),
            },
            SocialApplyPushDecision::SseOnly => SocialNotificationPush::SseOnly,
        };

        let _ = self
            .realtime
            .publish_social_notification(command.recipient_user_uuid, &signal, push)
            .await;
        Ok(())
    }

    async fn retract_social_inner(&self, command: SocialActivityCommand) -> Result<(), String> {
        if command.recipient_user_uuid.is_nil() || command.actor_user_uuid.is_nil() {
            return Ok(());
        }

        let group_key = group_key(&command.kind);
        let mut tx = self.repo.begin().await?;
        let Some(existing) = self
            .repo
            .find_by_group_for_update(&mut tx, command.recipient_user_uuid, &group_key)
            .await?
        else {
            return Ok(());
        };

        let current_actors = parse_actors_json(&existing.actors_json)?;
        if !current_actors
            .iter()
            .any(|a| a.uuid == command.actor_user_uuid)
        {
            return Ok(());
        }

        let actors = retract_actor_membership(&current_actors, command.actor_user_uuid);
        let retract_decision = retract_social_push_decision(actors.len());
        debug_assert!(!retract_updates_push_state(retract_decision));

        if matches!(retract_decision, SocialRetractPushDecision::Dismiss) {
            let notification_uuid = existing.notification_uuid;
            self.repo.delete_by_uuid(&mut tx, notification_uuid).await?;
            // push_state intentionally kept so like→unlike→like within 15m stays quiet.
            tx.commit().await.map_err(|e| e.to_string())?;

            let removed = RealtimeNotificationRemovedSignal {
                notification_uuid,
                group_key: Some(group_key),
            };
            self.realtime
                .publish_notification_removed(command.recipient_user_uuid, &removed)
                .await;
            return Ok(());
        }

        let text = build_social_text(&command.kind, &actors);
        let text = if text.chars().count() <= 500 {
            text
        } else {
            text.chars().take(500).collect()
        };
        let actors_json = actors_to_json(&actors)?;
        let actor_count = i32::try_from(actors.len()).unwrap_or(i32::MAX);
        let newest_actor = actors.first().map(|a| a.uuid);

        self.repo
            .update_group_membership(
                &mut tx,
                existing.notification_uuid,
                newest_actor,
                &text,
                actor_count,
                &actors_json,
            )
            .await?;
        // Do not update push_state on partial retract (QuietReplace).
        tx.commit().await.map_err(|e| e.to_string())?;

        let signal = RealtimeNotificationSignal {
            notification_uuid: existing.notification_uuid,
            notification_type: existing.notification_type,
            category: existing.category,
            text,
            actor_user_uuid: newest_actor,
            post_uuid: existing.post_uuid,
            comment_uuid: None,
            created_at: existing.created_at,
            update: None,
        };

        let _ = self
            .realtime
            .publish_social_notification(
                command.recipient_user_uuid,
                &signal,
                SocialNotificationPush::QuietReplace { tag: group_key },
            )
            .await;
        Ok(())
    }
}

impl UserNotificationDispatcher for InboxNotificationDispatcher {
    fn dispatch(
        &self,
        command: CreateUserNotificationCommand,
    ) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move { self.dispatch_inner(command).await })
    }

    fn apply_social(&self, command: SocialActivityCommand) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move { self.apply_social_inner(command).await })
    }

    fn retract_social(&self, command: SocialActivityCommand) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move { self.retract_social_inner(command).await })
    }
}
