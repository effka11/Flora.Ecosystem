//! Social like/repost/follow aggregation — text templates, membership, FCM audible budget.
//!
//! **Model B RU templates in [`build_social_text`] are the runtime source of truth.**
//! One-shot legacy collapse in `migrations/0002_social_notification_groups.sql` /
//! `0003_social_activity_group_keys.sql` must keep the same like strings (SQL cannot call this module).

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
    /// Unique posts this actor contributed for Like aggregation. Empty = legacy row.
    #[serde(default)]
    pub post_uuids: Vec<Uuid>,
}

/// Canonical group keys: one slot per recipient per activity kind (`like` / `repost` / `follow`).
pub fn group_key(kind: &SocialActivityKind) -> String {
    match kind {
        SocialActivityKind::Like { .. } => "like".into(),
        SocialActivityKind::Repost { .. } => "repost".into(),
        SocialActivityKind::Follow => "follow".into(),
    }
}

/// Legacy per-post key used before 0003 (`like:{uuid}` / `repost:{uuid}`).
pub fn legacy_per_post_group_key(kind: &SocialActivityKind) -> Option<String> {
    match kind {
        SocialActivityKind::Like { post_uuid } => Some(format!("like:{post_uuid}")),
        SocialActivityKind::Repost { post_uuid } => Some(format!("repost:{post_uuid}")),
        SocialActivityKind::Follow => None,
    }
}

pub fn notification_type(kind: &SocialActivityKind) -> &'static str {
    match kind {
        SocialActivityKind::Like { .. } => "like",
        SocialActivityKind::Repost { .. } => "repost",
        SocialActivityKind::Follow => "follow",
    }
}

pub fn post_uuid(kind: &SocialActivityKind) -> Option<Uuid> {
    match kind {
        SocialActivityKind::Like { post_uuid } | SocialActivityKind::Repost { post_uuid } => {
            Some(*post_uuid)
        }
        SocialActivityKind::Follow => None,
    }
}

/// Ordered retract lookup keys: canon → legacy per-post (follow has no legacy).
pub fn retract_lookup_group_keys(kind: &SocialActivityKind) -> Vec<String> {
    let mut keys = vec![group_key(kind)];
    if let Some(legacy) = legacy_per_post_group_key(kind) {
        keys.push(legacy);
    }
    keys
}

pub fn normalize_actor_label(label: &str) -> String {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        "Пользователь".into()
    } else {
        trimmed.to_string()
    }
}

/// Russian genitive plural for «N ваших …» (N ≥ 2).
pub fn russian_posts_word(n: usize) -> &'static str {
    let n100 = n % 100;
    let n10 = n % 10;
    if (11..=14).contains(&n100) {
        "постов"
    } else if n10 == 1 {
        "пост"
    } else if (2..=4).contains(&n10) {
        "поста"
    } else {
        "постов"
    }
}

fn like_post_count(actor: &SocialActor) -> usize {
    actor.post_uuids.len().max(1)
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
            1 => {
                let n = like_post_count(&actors[0]);
                if n == 1 {
                    format!("{a} оценил ваш пост")
                } else {
                    format!("{a} оценил {n} ваших {}", russian_posts_word(n))
                }
            }
            2 => format!("{a} и {} оценили ваш пост", b.unwrap_or("Пользователь")),
            n => format!(
                "{a}, {} и ещё {} оценили ваш пост",
                b.unwrap_or("Пользователь"),
                n - 2
            ),
        },
        SocialActivityKind::Repost { .. } => match count {
            0 => String::new(),
            1 => format!("{a} сделал репост"),
            2 => format!("{a} и {} сделали репост", b.unwrap_or("Пользователь")),
            n => format!(
                "{a}, {} и ещё {} сделали репост",
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

/// Prepend actor if not already a member. `None` = already member (caller may refresh post_uuid).
/// Used for Follow / Repost (no post-set tracking).
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
        post_uuids: Vec::new(),
    });
    next.extend(actors.iter().cloned());
    Some(next)
}

/// Like membership: seed on join, merge post on repeat. `None` = post already tracked.
pub fn apply_like_membership(
    actors: &[SocialActor],
    actor_uuid: Uuid,
    label: &str,
    joined_at: DateTime<Utc>,
    post: Uuid,
) -> Option<Vec<SocialActor>> {
    if let Some(idx) = actors.iter().position(|a| a.uuid == actor_uuid) {
        if actors[idx].post_uuids.contains(&post) {
            return None;
        }
        let mut next = actors.to_vec();
        next[idx].post_uuids.push(post);
        next[idx].label = normalize_actor_label(label);
        return Some(next);
    }
    let mut next = Vec::with_capacity(actors.len() + 1);
    next.push(SocialActor {
        uuid: actor_uuid,
        label: normalize_actor_label(label),
        joined_at,
        post_uuids: vec![post],
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

/// Outcome of Like retract against membership.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LikeRetractOutcome {
    /// `partial` + legacy empty `post_uuids` — keep slot unchanged.
    NoOp,
    /// Updated membership (may be empty → dismiss).
    Updated(Vec<SocialActor>),
}

/// Like retract using Content's `partial` flag.
pub fn retract_like_membership(
    actors: &[SocialActor],
    actor_uuid: Uuid,
    post: Uuid,
    partial: bool,
) -> LikeRetractOutcome {
    let Some(idx) = actors.iter().position(|a| a.uuid == actor_uuid) else {
        return LikeRetractOutcome::NoOp;
    };

    if partial {
        if actors[idx].post_uuids.is_empty() {
            return LikeRetractOutcome::NoOp;
        }
        if !actors[idx].post_uuids.contains(&post) {
            // Keep slot — no QuietReplace when P was never tracked.
            return LikeRetractOutcome::NoOp;
        }
        let mut next = actors.to_vec();
        next[idx].post_uuids.retain(|p| *p != post);
        if next[idx].post_uuids.is_empty() {
            next.remove(idx);
        }
        return LikeRetractOutcome::Updated(next);
    }

    // Full remove path (last like / Content says no remaining).
    let mut next = actors.to_vec();
    if next[idx].post_uuids.is_empty() {
        next.remove(idx);
    } else {
        next[idx].post_uuids.retain(|p| *p != post);
        if next[idx].post_uuids.is_empty() {
            next.remove(idx);
        }
    }
    LikeRetractOutcome::Updated(next)
}

/// Deep-link post: newest post on newest actor, if any.
pub fn newest_tracked_post_uuid(actors: &[SocialActor]) -> Option<Uuid> {
    actors.first().and_then(|a| a.post_uuids.last().copied())
}

/// True when `actors_json` or column actor matches the retracting user.
pub fn membership_contains_actor(actors: &[SocialActor], actor_uuid: Uuid) -> bool {
    actors.iter().any(|a| a.uuid == actor_uuid)
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
    /// Same tray tag, silent replace — used when member adds another like post.
    QuietReplace,
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
            post_uuids: Vec::new(),
        }
    }

    fn actor_with_posts(label: &str, posts: &[Uuid]) -> SocialActor {
        SocialActor {
            uuid: Uuid::now_v7(),
            label: label.into(),
            joined_at: Utc::now(),
            post_uuids: posts.to_vec(),
        }
    }

    #[test]
    fn group_key_like_repost_follow_are_canonical() {
        let post = Uuid::parse_str("01900000-0000-7000-8000-000000000001").unwrap();
        assert_eq!(
            group_key(&SocialActivityKind::Like { post_uuid: post }),
            "like"
        );
        assert_eq!(
            group_key(&SocialActivityKind::Repost { post_uuid: post }),
            "repost"
        );
        assert_eq!(group_key(&SocialActivityKind::Follow), "follow");
        assert_eq!(
            legacy_per_post_group_key(&SocialActivityKind::Like { post_uuid: post }).as_deref(),
            Some("like:01900000-0000-7000-8000-000000000001")
        );
        assert_eq!(
            retract_lookup_group_keys(&SocialActivityKind::Like { post_uuid: post }),
            vec![
                "like".to_string(),
                "like:01900000-0000-7000-8000-000000000001".to_string()
            ]
        );
        assert_eq!(
            retract_lookup_group_keys(&SocialActivityKind::Follow),
            vec!["follow".to_string()]
        );
    }

    #[test]
    fn social_text_like_one_two_n_actors() {
        let kind = SocialActivityKind::Like {
            post_uuid: Uuid::now_v7(),
        };
        let a = actor("Алиса", 0);
        let b = actor("Боб", 1);
        let c = actor("Кира", 2);

        assert_eq!(
            build_social_text(&kind, std::slice::from_ref(&a)),
            "Алиса оценил ваш пост"
        );
        assert_eq!(
            build_social_text(&kind, &[a.clone(), b.clone()]),
            "Алиса и Боб оценили ваш пост"
        );
        assert_eq!(
            build_social_text(&kind, &[a, b, c]),
            "Алиса, Боб и ещё 1 оценили ваш пост"
        );
    }

    #[test]
    fn social_text_like_single_actor_post_counts() {
        let kind = SocialActivityKind::Like {
            post_uuid: Uuid::now_v7(),
        };
        let p1 = Uuid::now_v7();
        let p2 = Uuid::now_v7();
        let posts_10: Vec<Uuid> = (0..10).map(|_| Uuid::now_v7()).collect();
        let posts_21: Vec<Uuid> = (0..21).map(|_| Uuid::now_v7()).collect();

        assert_eq!(
            build_social_text(&kind, &[actor_with_posts("Алиса", &[p1])]),
            "Алиса оценил ваш пост"
        );
        assert_eq!(
            build_social_text(&kind, &[actor_with_posts("Алиса", &[p1, p2])]),
            "Алиса оценил 2 ваших поста"
        );
        assert_eq!(
            build_social_text(&kind, &[actor_with_posts("Алиса", &posts_10)]),
            "Алиса оценил 10 ваших постов"
        );
        assert_eq!(
            build_social_text(&kind, &[actor_with_posts("Алиса", &posts_21)]),
            "Алиса оценил 21 ваших пост"
        );
    }

    #[test]
    fn russian_posts_word_declension() {
        assert_eq!(russian_posts_word(2), "поста");
        assert_eq!(russian_posts_word(3), "поста");
        assert_eq!(russian_posts_word(4), "поста");
        assert_eq!(russian_posts_word(5), "постов");
        assert_eq!(russian_posts_word(10), "постов");
        assert_eq!(russian_posts_word(21), "пост");
        assert_eq!(russian_posts_word(22), "поста");
        assert_eq!(russian_posts_word(11), "постов");
    }

    #[test]
    fn social_text_repost_one_two_n() {
        let kind = SocialActivityKind::Repost {
            post_uuid: Uuid::now_v7(),
        };
        let a = actor("Алиса", 0);
        let b = actor("Боб", 1);
        let c = actor("Кира", 2);
        assert_eq!(
            build_social_text(&kind, std::slice::from_ref(&a)),
            "Алиса сделал репост"
        );
        assert_eq!(
            build_social_text(&kind, &[a.clone(), b.clone()]),
            "Алиса и Боб сделали репост"
        );
        assert_eq!(
            build_social_text(&kind, &[a, b, c]),
            "Алиса, Боб и ещё 1 сделали репост"
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
    fn apply_same_actor_twice_is_noop_membership() {
        let uuid = Uuid::now_v7();
        let now = Utc::now();
        let once = apply_actor_membership(&[], uuid, "Алиса", now).unwrap();
        assert!(apply_actor_membership(&once, uuid, "Алиса", now).is_none());
    }

    #[test]
    fn apply_like_seeds_and_merges_posts() {
        let uuid = Uuid::now_v7();
        let p1 = Uuid::now_v7();
        let p2 = Uuid::now_v7();
        let now = Utc::now();
        let once = apply_like_membership(&[], uuid, "Алиса", now, p1).unwrap();
        assert_eq!(once[0].post_uuids, vec![p1]);
        let twice = apply_like_membership(&once, uuid, "Алиса", now, p2).unwrap();
        assert_eq!(twice[0].post_uuids, vec![p1, p2]);
        assert!(apply_like_membership(&twice, uuid, "Алиса", now, p1).is_none());
    }

    #[test]
    fn retract_like_partial_legacy_empty_is_noop() {
        let uuid = Uuid::now_v7();
        let post = Uuid::now_v7();
        let actors = vec![SocialActor {
            uuid,
            label: "Алиса".into(),
            joined_at: Utc::now(),
            post_uuids: Vec::new(),
        }];
        assert_eq!(
            retract_like_membership(&actors, uuid, post, true),
            LikeRetractOutcome::NoOp
        );
        assert_eq!(
            retract_like_membership(&actors, uuid, post, false),
            LikeRetractOutcome::Updated(Vec::new())
        );
    }

    #[test]
    fn retract_like_partial_unknown_post_is_noop() {
        let uuid = Uuid::now_v7();
        let p1 = Uuid::now_v7();
        let p2 = Uuid::now_v7();
        let unknown = Uuid::now_v7();
        let actors = vec![SocialActor {
            uuid,
            label: "Алиса".into(),
            joined_at: Utc::now(),
            post_uuids: vec![p1, p2],
        }];
        assert_eq!(
            retract_like_membership(&actors, uuid, unknown, true),
            LikeRetractOutcome::NoOp
        );
    }

    #[test]
    fn retract_like_partial_removes_post_keeps_actor() {
        let uuid = Uuid::now_v7();
        let p1 = Uuid::now_v7();
        let p2 = Uuid::now_v7();
        let actors = vec![SocialActor {
            uuid,
            label: "Алиса".into(),
            joined_at: Utc::now(),
            post_uuids: vec![p1, p2],
        }];
        let LikeRetractOutcome::Updated(next) = retract_like_membership(&actors, uuid, p1, true)
        else {
            panic!("expected Updated");
        };
        assert_eq!(next.len(), 1);
        assert_eq!(next[0].post_uuids, vec![p2]);
    }

    #[test]
    fn retract_actor_membership_removes_actor_and_empties_after_last() {
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        let now = Utc::now();
        let mut actors = apply_actor_membership(&[], a, "A", now).unwrap();
        actors = apply_actor_membership(&actors, b, "B", now).unwrap();
        actors = retract_actor_membership(&actors, a);
        assert_eq!(actors.len(), 1);
        assert!(membership_contains_actor(&actors, b));
        actors = retract_actor_membership(&actors, b);
        assert!(actors.is_empty());
        assert_eq!(
            retract_social_push_decision(actors.len()),
            SocialRetractPushDecision::Dismiss
        );
    }

    #[test]
    fn audible_budget_within_window_skips_after_delete_recreate() {
        let now = Utc::now();
        let last = now - Duration::minutes(5);
        assert!(!audible_push_allowed(Some(last), now));
        assert!(audible_push_allowed(Some(last), now + SOCIAL_PUSH_COOLDOWN));
    }

    #[test]
    fn apply_in_window_is_sse_only_and_does_not_update_push_state() {
        let now = Utc::now();
        let allow = audible_push_allowed(Some(now - Duration::minutes(1)), now);
        let decision = apply_social_push_decision(allow);
        assert_eq!(decision, SocialApplyPushDecision::SseOnly);
        assert!(!updates_push_state(decision));
        assert!(!updates_push_state(SocialApplyPushDecision::QuietReplace));
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
        let like = SocialActivityKind::Like {
            post_uuid: Uuid::nil(),
        };
        let follow = SocialActivityKind::Follow;
        let a = SocialActor {
            uuid: Uuid::nil(),
            label: "Алиса".into(),
            joined_at: Utc::now(),
            post_uuids: Vec::new(),
        };
        let b = SocialActor {
            uuid: Uuid::now_v7(),
            label: "Боб".into(),
            joined_at: Utc::now(),
            post_uuids: Vec::new(),
        };
        let c = SocialActor {
            uuid: Uuid::now_v7(),
            label: "Кира".into(),
            joined_at: Utc::now(),
            post_uuids: Vec::new(),
        };
        assert_eq!(
            build_social_text(&like, std::slice::from_ref(&a)),
            "Алиса оценил ваш пост"
        );
        assert_eq!(
            build_social_text(&like, &[a.clone(), b.clone()]),
            "Алиса и Боб оценили ваш пост"
        );
        assert_eq!(
            build_social_text(&like, &[a.clone(), b.clone(), c.clone()]),
            "Алиса, Боб и ещё 1 оценили ваш пост"
        );
        assert_eq!(
            build_social_text(&follow, std::slice::from_ref(&a)),
            "Новый подписчик Алиса"
        );
        assert_eq!(
            build_social_text(&follow, &[a.clone(), b.clone()]),
            "Алиса и Боб подписались на вас"
        );
        assert_eq!(
            build_social_text(&follow, &[a, b, c]),
            "Алиса, Боб и ещё 1 подписались на вас"
        );

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
        assert!(!updates_push_state(SocialApplyPushDecision::SseOnly));
        assert!(updates_push_state(SocialApplyPushDecision::Audible));
        assert!(!updates_push_state(SocialApplyPushDecision::QuietReplace));
    }

    /// A likes P1 then P2 → same group; second apply merges post (membership Some).
    #[test]
    fn scenario_same_actor_two_posts_one_membership() {
        let a_uuid = Uuid::now_v7();
        let p1 = Uuid::now_v7();
        let p2 = Uuid::now_v7();
        let t0 = Utc::now();
        let actors = apply_like_membership(&[], a_uuid, "Алиса", t0, p1).expect("join");
        assert_eq!(actors.len(), 1);
        assert_eq!(actors[0].post_uuids, vec![p1]);
        let merged = apply_like_membership(&actors, a_uuid, "Алиса", t0 + Duration::seconds(1), p2)
            .expect("merge");
        assert_eq!(merged[0].post_uuids, vec![p1, p2]);
        assert_eq!(
            build_social_text(&SocialActivityKind::Like { post_uuid: p2 }, &merged),
            "Алиса оценил 2 ваших поста"
        );
        assert!(apply_like_membership(&merged, a_uuid, "Алиса", t0, p1).is_none());
        assert_eq!(
            group_key(&SocialActivityKind::Like {
                post_uuid: Uuid::now_v7()
            }),
            "like"
        );
    }

    #[test]
    fn scenario_ab_like_retract_budget_and_dismiss() {
        let kind = SocialActivityKind::Like {
            post_uuid: Uuid::now_v7(),
        };
        let t0 = Utc::now();
        let a_uuid = Uuid::now_v7();
        let b_uuid = Uuid::now_v7();

        let d0 = apply_social_push_decision(audible_push_allowed(None, t0));
        assert_eq!(d0, SocialApplyPushDecision::Audible);
        assert!(updates_push_state(d0));
        let last_push = t0;

        let mut actors = apply_actor_membership(&[], a_uuid, "Алиса", t0).expect("A joins");
        let t1 = t0 + Duration::minutes(1);
        let d1 = apply_social_push_decision(audible_push_allowed(Some(last_push), t1));
        assert_eq!(d1, SocialApplyPushDecision::SseOnly);
        actors = apply_actor_membership(&actors, b_uuid, "Боб", t1).expect("B joins");
        assert_eq!(
            build_social_text(&kind, &actors),
            "Боб и Алиса оценили ваш пост"
        );

        actors = retract_actor_membership(&actors, a_uuid);
        assert_eq!(
            retract_social_push_decision(actors.len()),
            SocialRetractPushDecision::QuietReplace
        );
        assert!(!audible_push_allowed(Some(last_push), t1));

        actors = retract_actor_membership(&actors, b_uuid);
        assert_eq!(
            retract_social_push_decision(actors.len()),
            SocialRetractPushDecision::Dismiss
        );
        let t2 = t0 + Duration::minutes(5);
        assert_eq!(
            apply_social_push_decision(audible_push_allowed(Some(last_push), t2)),
            SocialApplyPushDecision::SseOnly
        );
    }

    #[test]
    fn scenario_audible_claim_holds_budget_even_if_fcm_fails() {
        let t0 = Utc::now();
        let d0 = apply_social_push_decision(audible_push_allowed(None, t0));
        assert!(updates_push_state(d0));
        let t1 = t0 + Duration::minutes(1);
        assert_eq!(
            apply_social_push_decision(audible_push_allowed(Some(t0), t1)),
            SocialApplyPushDecision::SseOnly
        );
    }
}
