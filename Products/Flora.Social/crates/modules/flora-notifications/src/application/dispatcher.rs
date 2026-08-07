//! Inbox `DispatchAsync` + social aggregation apply/retract.

use std::sync::Arc;

use chrono::Utc;
use flora_notifications_contracts::{
    BoxFuture, CreateUserNotificationCommand, RealtimeNotificationRemovedSignal,
    RealtimeNotificationSignal, SocialActivityCommand, SocialActivityKind,
    UserNotificationDispatcher,
};
use flora_shared::flora_uuid::new_uuid;

use crate::application::UserRealtimePublisher;
use crate::application::platform::{
    normalize_category, normalize_type, requires_social_aggregation,
};
use crate::application::realtime_publisher::SocialNotificationPush;
use crate::application::social::{
    LikeRetractOutcome, SocialApplyPushDecision, SocialRetractPushDecision, actors_to_json,
    apply_actor_membership, apply_like_membership, apply_social_push_decision,
    audible_push_allowed, build_social_text, group_key, membership_contains_actor,
    newest_tracked_post_uuid, notification_type, parse_actors_json, post_uuid,
    retract_actor_membership, retract_like_membership, retract_lookup_group_keys,
    retract_social_push_decision, retract_updates_push_state, updates_push_state,
};
use crate::infrastructure::{InboxRepo, SocialGroupRow};

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
        // like/follow/repost aggregation owns group_key / actors_json — never unkeyed INSERT.
        if requires_social_aggregation(&notification_type) {
            return Err(
                "like/follow/repost must use UserNotificationDispatcher::apply_social / retract_social"
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
        let was_member = membership_contains_actor(&current_actors, command.actor_user_uuid);

        let actors = match (&command.kind, post_uuid) {
            (SocialActivityKind::Like { .. }, Some(post)) => apply_like_membership(
                &current_actors,
                command.actor_user_uuid,
                &command.actor_label,
                now,
                post,
            ),
            _ => apply_actor_membership(
                &current_actors,
                command.actor_user_uuid,
                &command.actor_label,
                now,
            ),
        };

        let Some(actors) = actors else {
            // Unchanged membership: refresh deep-link post only — no SSE / FCM / budget.
            if let Some(row) = existing {
                self.repo
                    .refresh_group_post_uuid(
                        &mut tx,
                        row.notification_uuid,
                        command.actor_user_uuid,
                        post_uuid,
                    )
                    .await?;
                tx.commit().await.map_err(|e| e.to_string())?;
            }
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

        // Member adding another like post: QuietReplace, no audible / push_state.
        let decision = if was_member {
            SocialApplyPushDecision::QuietReplace
        } else {
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
            decision
        };

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
            SocialApplyPushDecision::QuietReplace => SocialNotificationPush::QuietReplace {
                tag: group_key.clone(),
            },
        };

        let _ = self
            .realtime
            .publish_social_notification(command.recipient_user_uuid, &signal, push)
            .await;
        Ok(())
    }

    /// Resolve live social row: canon group_key → legacy per-post → unkeyed (type, post).
    /// Follow has no legacy/unkeyed post path.
    async fn find_social_row_for_retract(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        command: &SocialActivityCommand,
    ) -> Result<Option<SocialGroupRow>, String> {
        for key in retract_lookup_group_keys(&command.kind) {
            if let Some(row) = self
                .repo
                .find_by_group_for_update(tx, command.recipient_user_uuid, &key)
                .await?
            {
                let actors = parse_actors_json(&row.actors_json)?;
                if membership_contains_actor(&actors, command.actor_user_uuid)
                    || row.actor_user_uuid == Some(command.actor_user_uuid)
                {
                    return Ok(Some(row));
                }
            }
        }
        if let Some(post) = post_uuid(&command.kind)
            && let Some(row) = self
                .repo
                .find_unkeyed_social_for_update(
                    tx,
                    command.recipient_user_uuid,
                    notification_type(&command.kind),
                    post,
                )
                .await?
        {
            let actors = parse_actors_json(&row.actors_json)?;
            if membership_contains_actor(&actors, command.actor_user_uuid)
                || row.actor_user_uuid == Some(command.actor_user_uuid)
                || actors.is_empty()
            {
                return Ok(Some(row));
            }
        }
        Ok(None)
    }

    async fn retract_social_inner(&self, command: SocialActivityCommand) -> Result<(), String> {
        if command.recipient_user_uuid.is_nil() || command.actor_user_uuid.is_nil() {
            return Ok(());
        }

        let canon_key = group_key(&command.kind);
        let mut tx = self.repo.begin().await?;
        let Some(existing) = self.find_social_row_for_retract(&mut tx, &command).await? else {
            return Ok(());
        };

        let current_actors = parse_actors_json(&existing.actors_json)?;
        let actors = match (&command.kind, post_uuid(&command.kind)) {
            (SocialActivityKind::Like { .. }, Some(post))
                if membership_contains_actor(&current_actors, command.actor_user_uuid) =>
            {
                match retract_like_membership(
                    &current_actors,
                    command.actor_user_uuid,
                    post,
                    command.partial,
                ) {
                    LikeRetractOutcome::NoOp => {
                        return Ok(());
                    }
                    LikeRetractOutcome::Updated(next) => next,
                }
            }
            _ if membership_contains_actor(&current_actors, command.actor_user_uuid) => {
                retract_actor_membership(&current_actors, command.actor_user_uuid)
            }
            _ if existing.actor_user_uuid == Some(command.actor_user_uuid)
                || current_actors.is_empty() =>
            {
                // Legacy single-actor row without actors_json membership.
                if command.partial {
                    return Ok(());
                }
                Vec::new()
            }
            _ => return Ok(()),
        };

        let retract_decision = retract_social_push_decision(actors.len());
        debug_assert!(!retract_updates_push_state(retract_decision));

        // FCM/SSE tag is always the canonical key (not empty legacy).
        let tag = canon_key.clone();

        if matches!(retract_decision, SocialRetractPushDecision::Dismiss) {
            let notification_uuid = existing.notification_uuid;
            self.repo.delete_by_uuid(&mut tx, notification_uuid).await?;
            tx.commit().await.map_err(|e| e.to_string())?;

            let removed = RealtimeNotificationRemovedSignal {
                notification_uuid,
                group_key: Some(tag),
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
        let deep_link = newest_tracked_post_uuid(&actors).or(existing.post_uuid);

        self.repo
            .update_group_membership(
                &mut tx,
                existing.notification_uuid,
                newest_actor,
                &text,
                actor_count,
                &actors_json,
                deep_link,
            )
            .await?;
        tx.commit().await.map_err(|e| e.to_string())?;

        let signal = RealtimeNotificationSignal {
            notification_uuid: existing.notification_uuid,
            notification_type: existing.notification_type,
            category: existing.category,
            text,
            actor_user_uuid: newest_actor,
            post_uuid: deep_link,
            comment_uuid: None,
            created_at: existing.created_at,
            update: None,
        };

        let _ = self
            .realtime
            .publish_social_notification(
                command.recipient_user_uuid,
                &signal,
                SocialNotificationPush::QuietReplace { tag },
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

#[cfg(test)]
mod tests {
    use flora_notifications_contracts::SocialActivityKind;
    use uuid::Uuid;

    use crate::application::social::retract_lookup_group_keys;

    #[test]
    fn retract_lookup_order_canon_then_legacy_follow_untouched() {
        let post = Uuid::parse_str("01900000-0000-7000-8000-000000000001").unwrap();
        assert_eq!(
            retract_lookup_group_keys(&SocialActivityKind::Like { post_uuid: post }),
            vec![
                "like".to_string(),
                "like:01900000-0000-7000-8000-000000000001".to_string()
            ]
        );
        assert_eq!(
            retract_lookup_group_keys(&SocialActivityKind::Repost { post_uuid: post }),
            vec![
                "repost".to_string(),
                "repost:01900000-0000-7000-8000-000000000001".to_string()
            ]
        );
        assert_eq!(
            retract_lookup_group_keys(&SocialActivityKind::Follow),
            vec!["follow".to_string()]
        );
    }
}
