//! Follow social notifications — application orchestration (not HTTP).
//!
//! Actor label resolution is intentionally local (same idea as Content `posts.rs`);
//! modules do not share presentation helpers across boundaries.

use std::sync::Arc;

use flora_auth_contracts::AccountDirectory;
use flora_notifications_contracts::{
    SocialActivityCommand, SocialActivityKind, UserNotificationDispatcher,
};
use flora_users_contracts::UserProfileQueries;
use uuid::Uuid;

/// Паритет `TryNotifyFollowAsync` — ошибки только в лог.
pub async fn try_notify_follow(
    notifications: &Arc<dyn UserNotificationDispatcher>,
    accounts: &Arc<dyn AccountDirectory>,
    profiles: &Arc<dyn UserProfileQueries>,
    follower_uuid: Uuid,
    following_uuid: Uuid,
    follower_username: &str,
) {
    if let Err(e) = notify_follow(
        notifications,
        accounts,
        profiles,
        follower_uuid,
        following_uuid,
    )
    .await
    {
        tracing::warn!(
            error = %e,
            follower = %follower_username,
            following = %following_uuid,
            "Не удалось создать уведомление о подписке"
        );
    }
}

/// Ошибки retract только в лог (как try_notify_follow).
pub async fn try_retract_follow(
    notifications: &Arc<dyn UserNotificationDispatcher>,
    accounts: &Arc<dyn AccountDirectory>,
    profiles: &Arc<dyn UserProfileQueries>,
    follower_uuid: Uuid,
    following_uuid: Uuid,
    follower_username: &str,
) {
    if let Err(e) = retract_follow(
        notifications,
        accounts,
        profiles,
        follower_uuid,
        following_uuid,
    )
    .await
    {
        tracing::warn!(
            error = %e,
            follower = %follower_username,
            following = %following_uuid,
            "Не удалось отозвать уведомление о подписке"
        );
    }
}

async fn notify_follow(
    notifications: &Arc<dyn UserNotificationDispatcher>,
    accounts: &Arc<dyn AccountDirectory>,
    profiles: &Arc<dyn UserProfileQueries>,
    follower_uuid: Uuid,
    following_uuid: Uuid,
) -> Result<(), String> {
    let command = social_follow_command(accounts, profiles, follower_uuid, following_uuid).await;
    notifications.apply_social(command).await
}

async fn retract_follow(
    notifications: &Arc<dyn UserNotificationDispatcher>,
    accounts: &Arc<dyn AccountDirectory>,
    profiles: &Arc<dyn UserProfileQueries>,
    follower_uuid: Uuid,
    following_uuid: Uuid,
) -> Result<(), String> {
    let command = social_follow_command(accounts, profiles, follower_uuid, following_uuid).await;
    notifications.retract_social(command).await
}

async fn social_follow_command(
    accounts: &Arc<dyn AccountDirectory>,
    profiles: &Arc<dyn UserProfileQueries>,
    follower_uuid: Uuid,
    following_uuid: Uuid,
) -> SocialActivityCommand {
    let (label, username) = resolve_actor_presentation(accounts, profiles, follower_uuid).await;
    let actor_label = if !username.is_empty() {
        format!("@{username}")
    } else {
        label
    };
    SocialActivityCommand {
        recipient_user_uuid: following_uuid,
        actor_user_uuid: follower_uuid,
        actor_label,
        kind: SocialActivityKind::Follow,
    }
}

async fn resolve_actor_presentation(
    accounts: &Arc<dyn AccountDirectory>,
    profiles: &Arc<dyn UserProfileQueries>,
    actor_user_uuid: Uuid,
) -> (String, String) {
    let username = match accounts.get_public(actor_user_uuid).await {
        Ok(Some(a)) => a.username,
        _ => String::new(),
    };
    let display_name = match profiles.get_profile(actor_user_uuid).await {
        Ok(Some(p)) => {
            let d = p.display_name.trim().to_string();
            if d.is_empty() { None } else { Some(d) }
        }
        _ => None,
    };
    let label = if let Some(d) = display_name {
        d
    } else if !username.is_empty() {
        format!("@{username}")
    } else {
        "Пользователь".into()
    };
    (label, username)
}
