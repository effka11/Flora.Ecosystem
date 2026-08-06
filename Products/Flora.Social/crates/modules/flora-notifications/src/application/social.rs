//! Social like/follow aggregation — text templates, membership, FCM audible budget.
//!
//! **Model B RU templates in [`build_social_text`] are the runtime source of truth.**
//! One-shot legacy collapse in `migrations/0002_social_notification_groups.sql` must
//! keep the same strings (SQL cannot call this module).

use chrono::{DateTime, Duration, Utc};
use flora_notifications_contracts::SocialActivityKind;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// TikTok-style audible push cooldown on `(recipient_user_uuid, group_key)`.
pub const SOCIAL_PUSH_COOLDOWN: Duration = Duration::minutes(15);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SocialActor {
    pub uuid: Uuid,
    pub label: String,
    pub joined_at: DateTime<Utc>,
}

pub fn group_key(kind: &SocialActivityKind) -> String {
    match kind {
        SocialActivityKind::Like { post_uuid } => format!("like:{post_uuid}"),
        SocialActivityKind::Follow => "follow".into(),
    }
}

pub fn notification_type(kind: &SocialActivityKind) -> &'static str {
    match kind {
        SocialActivityKind::Like { .. } => "like",
        SocialActivityKind::Follow => "follow",
    }
}

pub fn post_uuid(kind: &SocialActivityKind) -> Option<Uuid> {
    match kind {
        SocialActivityKind::Like { post_uuid } => Some(*post_uuid),
        SocialActivityKind::Follow => None,
    }
}

pub fn normalize_actor_label(label: &str) -> String {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        "Пользователь".into()
    } else {
        trimmed.to_string()
    }
}

/// RU inbox text from newest-first membership (top-2 labels only).
pub fn build_social_text(kind: &SocialActivityKind, actors: &[SocialActor]) -> String {
    let count = actors.len();
    let a = actors
        .first()
        .map(|x| x.label.as_str())
        .unwrap_or("Пользователь");
    let b = actors.get(1).map(|x| x.label.as_str());

    match kind {
        SocialActivityKind::Like { .. } => match count {
            0 => String::new(),
            1 => format!("{a} оценил ваш пост"),
            2 => format!("{a} и {} оценили ваш пост", b.unwrap_or("Пользователь")),
            n => format!(
                "{a}, {} и ещё {} оценили ваш пост",
                b.unwrap_or("Пользователь"),
                n - 2
            ),
        },
        SocialActivityKind::Follow => match count {
            0 => String::new(),
            1 => format!("Новый подписчик {a}"),
            2 => format!("{a} и {} подписались на вас", b.unwrap_or("Пользователь")),
            n => format!(
                "{a}, {} и ещё {} подписались на вас",
                b.unwrap_or("Пользователь"),
                n - 2
            ),
        },
    }
}

/// Prepend actor if not already a member. `None` = idempotent no-op.
pub fn apply_actor_membership(
    actors: &[SocialActor],
    actor_uuid: Uuid,
    label: &str,
    joined_at: DateTime<Utc>,
) -> Option<Vec<SocialActor>> {
    if actors.iter().any(|a| a.uuid == actor_uuid) {
        return None;
    }
    let mut next = Vec::with_capacity(actors.len() + 1);
    next.push(SocialActor {
        uuid: actor_uuid,
        label: normalize_actor_label(label),
        joined_at,
    });
    next.extend(actors.iter().cloned());
    Some(next)
}

/// Remove actor from membership (newest-first order preserved).
pub fn retract_actor_membership(actors: &[SocialActor], actor_uuid: Uuid) -> Vec<SocialActor> {
    actors
        .iter()
        .filter(|a| a.uuid != actor_uuid)
        .cloned()
        .collect()
}

/// Audible inbox push allowed when no prior push, or last audible ≥ 15m ago.
pub fn audible_push_allowed(last_push_at: Option<DateTime<Utc>>, now: DateTime<Utc>) -> bool {
    match last_push_at {
        None => true,
        Some(at) => now >= at + SOCIAL_PUSH_COOLDOWN,
    }
}

/// Apply-path FCM mode. Audible claims `last_push_at` under the group lock before FCM.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SocialApplyPushDecision {
    Audible,
    SseOnly,
}

pub fn apply_social_push_decision(allow_audible: bool) -> SocialApplyPushDecision {
    if allow_audible {
        SocialApplyPushDecision::Audible
    } else {
        SocialApplyPushDecision::SseOnly
    }
}

/// Audible claims budget in-tx; SSE-only / quiet-replace never move `last_push_at`.
pub fn updates_push_state(decision: SocialApplyPushDecision) -> bool {
    matches!(decision, SocialApplyPushDecision::Audible)
}

/// Retract-path FCM/SSE mode after membership update.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SocialRetractPushDecision {
    /// Actors remain → quiet-replace tray (same tag), no `push_state` write.
    QuietReplace,
    /// Empty group → SSE `notification_removed` + data-only dismiss; keep `push_state`.
    Dismiss,
}

pub fn retract_social_push_decision(actors_remaining: usize) -> SocialRetractPushDecision {
    if actors_remaining == 0 {
        SocialRetractPushDecision::Dismiss
    } else {
        SocialRetractPushDecision::QuietReplace
    }
}

/// Partial retract and dismiss never move `last_push_at`.
pub fn retract_updates_push_state(_decision: SocialRetractPushDecision) -> bool {
    false
}

pub fn parse_actors_json(value: &serde_json::Value) -> Result<Vec<SocialActor>, String> {
    if value.is_null() {
        return Ok(Vec::new());
    }
    serde_json::from_value(value.clone()).map_err(|e| e.to_string())
}

pub fn actors_to_json(actors: &[SocialActor]) -> Result<serde_json::Value, String> {
    serde_json::to_value(actors).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn actor(label: &str, minutes_ago: i64) -> SocialActor {
        SocialActor {
            uuid: Uuid::now_v7(),
            label: label.into(),
            joined_at: Utc::now() - Duration::minutes(minutes_ago),
        }
    }

    #[test]
    fn group_key_like_and_follow() {
        let post = Uuid::parse_str("01900000-0000-7000-8000-000000000001").unwrap();
        assert_eq!(
            group_key(&SocialActivityKind::Like { post_uuid: post }),
            format!("like:{post}")
        );
        assert_eq!(group_key(&SocialActivityKind::Follow), "follow");
    }

    #[test]
    fn social_text_like_one_two_n() {
        let kind = SocialActivityKind::Like {
            post_uuid: Uuid::now_v7(),
        };
        let a = actor("Алиса", 0);
        let b = actor("Боб", 1);
        let c = actor("Кира", 2);
        let d = actor("Дана", 3);

        assert_eq!(
            build_social_text(&kind, std::slice::from_ref(&a)),
            "Алиса оценил ваш пост"
        );
        assert_eq!(
            build_social_text(&kind, &[a.clone(), b.clone()]),
            "Алиса и Боб оценили ваш пост"
        );
        assert_eq!(
            build_social_text(&kind, &[a.clone(), b.clone(), c.clone()]),
            "Алиса, Боб и ещё 1 оценили ваш пост"
        );
        assert_eq!(
            build_social_text(&kind, &[a, b, c, d]),
            "Алиса, Боб и ещё 2 оценили ваш пост"
        );
    }

    #[test]
    fn social_text_follow_one_two_n() {
        let kind = SocialActivityKind::Follow;
        let a = actor("Алиса", 0);
        let b = actor("Боб", 1);
        let c = actor("Кира", 2);

        assert_eq!(
            build_social_text(&kind, std::slice::from_ref(&a)),
            "Новый подписчик Алиса"
        );
        assert_eq!(
            build_social_text(&kind, &[a.clone(), b.clone()]),
            "Алиса и Боб подписались на вас"
        );
        assert_eq!(
            build_social_text(&kind, &[a, b, c]),
            "Алиса, Боб и ещё 1 подписались на вас"
        );
    }

    #[test]
    fn apply_same_actor_twice_is_noop() {
        let uuid = Uuid::now_v7();
        let now = Utc::now();
        let once = apply_actor_membership(&[], uuid, "Алиса", now).expect("first apply");
        assert_eq!(once.len(), 1);
        assert!(apply_actor_membership(&once, uuid, "Алиса", now).is_none());
        assert_eq!(once.len(), 1);
    }

    #[test]
    fn retract_actor_membership_removes_actor_and_empties_after_last() {
        let a = actor("Алиса", 0);
        let b = actor("Боб", 1);
        let two = vec![a.clone(), b.clone()];

        let without_a = retract_actor_membership(&two, a.uuid);
        assert_eq!(without_a.len(), 1);
        assert_eq!(without_a[0].uuid, b.uuid);

        let empty = retract_actor_membership(&without_a, b.uuid);
        assert!(empty.is_empty());

        assert!(retract_actor_membership(&[], a.uuid).is_empty());
    }

    #[test]
    fn audible_budget_within_window_skips_after_delete_recreate() {
        let now = Utc::now();
        assert!(audible_push_allowed(None, now));

        let last = now - Duration::minutes(14);
        assert!(!audible_push_allowed(Some(last), now));

        let last = now - Duration::minutes(15);
        assert!(audible_push_allowed(Some(last), now));

        // like→unlike→like: push_state survives DELETE → still within window → skip
        let last_survives_delete = now - Duration::minutes(5);
        assert!(!audible_push_allowed(Some(last_survives_delete), now));
    }

    #[test]
    fn apply_in_window_is_sse_only_and_does_not_update_push_state() {
        let now = Utc::now();
        let allow = audible_push_allowed(Some(now - Duration::minutes(1)), now);
        let decision = apply_social_push_decision(allow);
        assert_eq!(decision, SocialApplyPushDecision::SseOnly);
        assert!(!updates_push_state(decision));
    }

    #[test]
    fn apply_budget_free_is_audible_and_claims_push_state() {
        let decision = apply_social_push_decision(true);
        assert_eq!(decision, SocialApplyPushDecision::Audible);
        assert!(updates_push_state(decision));
        assert!(!updates_push_state(SocialApplyPushDecision::SseOnly));
    }

    #[test]
    fn model_b_templates_lockstep_for_migration_0002() {
        // One-shot SQL in 0002_social_notification_groups.sql must emit these exact strings.
        let like = SocialActivityKind::Like {
            post_uuid: Uuid::nil(),
        };
        let follow = SocialActivityKind::Follow;
        let a = SocialActor {
            uuid: Uuid::nil(),
            label: "Алиса".into(),
            joined_at: Utc::now(),
        };
        let b = SocialActor {
            uuid: Uuid::now_v7(),
            label: "Боб".into(),
            joined_at: Utc::now(),
        };
        let c = SocialActor {
            uuid: Uuid::now_v7(),
            label: "Кира".into(),
            joined_at: Utc::now(),
        };
        let like_1 = build_social_text(&like, std::slice::from_ref(&a));
        let like_2 = build_social_text(&like, &[a.clone(), b.clone()]);
        let like_n = build_social_text(&like, &[a.clone(), b.clone(), c.clone()]);
        let follow_1 = build_social_text(&follow, std::slice::from_ref(&a));
        let follow_2 = build_social_text(&follow, &[a.clone(), b.clone()]);
        let follow_n = build_social_text(&follow, &[a, b, c]);
        assert_eq!(like_1, "Алиса оценил ваш пост");
        assert_eq!(like_2, "Алиса и Боб оценили ваш пост");
        assert_eq!(like_n, "Алиса, Боб и ещё 1 оценили ваш пост");
        assert_eq!(follow_1, "Новый подписчик Алиса");
        assert_eq!(follow_2, "Алиса и Боб подписались на вас");
        assert_eq!(follow_n, "Алиса, Боб и ещё 1 подписались на вас");

        // Fail CI if SQL collapse templates drift from runtime SoT.
        let sql = include_str!("../../migrations/0002_social_notification_groups.sql");
        assert!(
            sql.contains("application/social.rs::build_social_text"),
            "migration must cite runtime SoT"
        );
        for fragment in [
            " оценил ваш пост",
            " оценили ваш пост",
            "Новый подписчик ",
            " подписались на вас",
            " и ещё ",
        ] {
            assert!(
                sql.contains(fragment),
                "migration 0002 missing Model B fragment {fragment:?}"
            );
        }
    }

    #[test]
    fn quiet_replace_path_does_not_use_audible_push_decision() {
        // Partial retract uses QuietReplace (realtime), not SocialApplyPushDecision —
        // only Audible updates push_state.
        assert!(!updates_push_state(SocialApplyPushDecision::SseOnly));
        assert!(updates_push_state(SocialApplyPushDecision::Audible));
    }

    /// Plan DoD: A like, B like in window → 1 audible; retract A → quiet replace, budget intact;
    /// unlike last → dismiss, push_state kept; recreate in window → no second audible.
    #[test]
    fn scenario_ab_like_retract_budget_and_dismiss() {
        let kind = SocialActivityKind::Like {
            post_uuid: Uuid::now_v7(),
        };
        let t0 = Utc::now();
        let a_uuid = Uuid::now_v7();
        let b_uuid = Uuid::now_v7();

        // A apply — budget free → Audible; claim last_push under lock before FCM.
        let d0 = apply_social_push_decision(audible_push_allowed(None, t0));
        assert_eq!(d0, SocialApplyPushDecision::Audible);
        assert!(updates_push_state(d0));
        let last_push = t0; // claimed in-tx

        let mut actors = apply_actor_membership(&[], a_uuid, "Алиса", t0).expect("A joins");
        assert_eq!(actors.len(), 1);

        // B apply within 15m (after A's claim visible) → SSE-only; no push_state write.
        let t1 = t0 + Duration::minutes(1);
        let d1 = apply_social_push_decision(audible_push_allowed(Some(last_push), t1));
        assert_eq!(d1, SocialApplyPushDecision::SseOnly);
        assert!(!updates_push_state(d1));
        actors = apply_actor_membership(&actors, b_uuid, "Боб", t1).expect("B joins");
        assert_eq!(actors.len(), 2);
        assert_eq!(
            build_social_text(&kind, &actors),
            "Боб и Алиса оценили ваш пост"
        );

        // Retract A → QuietReplace; last_push_at unchanged.
        actors = retract_actor_membership(&actors, a_uuid);
        let r_partial = retract_social_push_decision(actors.len());
        assert_eq!(r_partial, SocialRetractPushDecision::QuietReplace);
        assert!(!retract_updates_push_state(r_partial));
        assert_eq!(build_social_text(&kind, &actors), "Боб оценил ваш пост");
        assert!(!audible_push_allowed(Some(last_push), t1)); // budget still held

        // Retract B (last) → Dismiss; push_state row would survive in DB.
        actors = retract_actor_membership(&actors, b_uuid);
        assert!(actors.is_empty());
        let r_empty = retract_social_push_decision(actors.len());
        assert_eq!(r_empty, SocialRetractPushDecision::Dismiss);
        assert!(!retract_updates_push_state(r_empty));

        // like→unlike→like inside window: surviving last_push → no second audible.
        let t2 = t0 + Duration::minutes(5);
        let d_recreate = apply_social_push_decision(audible_push_allowed(Some(last_push), t2));
        assert_eq!(d_recreate, SocialApplyPushDecision::SseOnly);
        assert!(!updates_push_state(d_recreate));
    }

    #[test]
    fn scenario_audible_claim_holds_budget_even_if_fcm_fails() {
        // Pre-claim under lock: FCM miss must not reopen the 15m window (closes race /
        // retry-spam). Tradeoff: no-token recipients stay quiet until cooldown elapses.
        let t0 = Utc::now();
        let d0 = apply_social_push_decision(audible_push_allowed(None, t0));
        assert_eq!(d0, SocialApplyPushDecision::Audible);
        assert!(updates_push_state(d0));
        let claimed = t0;
        let t1 = t0 + Duration::minutes(1);
        assert_eq!(
            apply_social_push_decision(audible_push_allowed(Some(claimed), t1)),
            SocialApplyPushDecision::SseOnly
        );
    }

    #[test]
    fn scenario_apply_same_actor_twice_stays_one_member() {
        let uuid = Uuid::now_v7();
        let now = Utc::now();
        let once = apply_actor_membership(&[], uuid, "Алиса", now).unwrap();
        assert!(apply_actor_membership(&once, uuid, "Алиса", now).is_none());
        assert_eq!(once.len(), 1);
        // Idempotent apply would not re-evaluate FCM (dispatcher returns before push).
    }
}
