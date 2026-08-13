//! Per-user in-memory FSA-N index for `GET /api/auth/notifications?search=`.
//!
//! Each recipient owns a slot (`NotificationsSearch` + ready + last_used).
//! Empty search stays on SQL. Scores stay off the wire.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use fsa_core::notifications::{NotificationDoc, NotificationsQuery, NotificationsSearch};
use uuid::Uuid;

const IDLE_EVICT: Duration = Duration::from_secs(15 * 60);
const TOMBSTONE_COMPACT_RATIO: f64 = 0.2;

enum NotifOp {
    Upsert(NotificationDoc),
    Remove(String),
}

pub struct UserNotifIndex {
    search: NotificationsSearch,
    ready: bool,
    last_used: Instant,
    pending: Option<Vec<NotifOp>>,
}

#[derive(Clone)]
pub struct NotificationSearchIndex {
    users: Arc<RwLock<HashMap<Uuid, UserNotifIndex>>>,
}

impl NotificationSearchIndex {
    pub fn new() -> Self {
        Self {
            users: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Ranked ids for `recipient` only. `None` → slot missing or !ready (caller returns `[]`).
    pub fn search_ids(
        &self,
        recipient: Uuid,
        query: &str,
        skip: i32,
        take: i32,
    ) -> Option<Vec<Uuid>> {
        let mut users = self.users.write().expect("notifications search index");
        evict_idle(&mut users);
        let slot = users.get_mut(&recipient)?;
        if !slot.ready {
            return None;
        }
        slot.last_used = Instant::now();
        let mut q = NotificationsQuery::new(query, Utc::now().timestamp());
        q.limit = usize::try_from(take).unwrap_or(0);
        q.offset = usize::try_from(skip).unwrap_or(0);
        Some(
            slot.search
                .search(&q, None)
                .hits
                .into_iter()
                .filter_map(|hit| Uuid::parse_str(&hit.id).ok())
                .collect(),
        )
    }

    /// Insert a !ready slot if missing. `true` = caller should spawn a lazy rebuild.
    pub fn begin_lazy_rebuild(&self, recipient: Uuid) -> bool {
        let mut users = self.users.write().expect("notifications search index");
        evict_idle(&mut users);
        if users.contains_key(&recipient) {
            return false;
        }
        users.insert(
            recipient,
            UserNotifIndex {
                search: NotificationsSearch::new(),
                ready: false,
                last_used: Instant::now(),
                pending: Some(Vec::new()),
            },
        );
        true
    }

    pub fn finish_rebuild(&self, recipient: Uuid, docs: Vec<NotificationDoc>) {
        let mut users = self.users.write().expect("notifications search index");
        evict_idle(&mut users);
        let Some(slot) = users.get_mut(&recipient) else {
            return;
        };
        let mut fresh = NotificationsSearch::new();
        for doc in docs {
            if let Err(error) = fresh.upsert(doc) {
                tracing::warn!(%error, %recipient, "notifications FSA-N rebuild upsert failed");
            }
        }
        if let Some(ops) = slot.pending.as_ref() {
            for op in ops {
                apply_one(&mut fresh, op);
            }
        }
        maybe_compact(&mut fresh);
        slot.search = fresh;
        slot.pending = None;
        slot.ready = true;
        slot.last_used = Instant::now();
    }

    pub fn abandon_rebuild(&self, recipient: Uuid) {
        let mut users = self.users.write().expect("notifications search index");
        if users.get(&recipient).is_some_and(|slot| !slot.ready) {
            users.remove(&recipient);
        }
    }

    pub fn upsert_if_present(&self, recipient: Uuid, doc: NotificationDoc) {
        let mut users = self.users.write().expect("notifications search index");
        evict_idle(&mut users);
        let Some(slot) = users.get_mut(&recipient) else {
            return;
        };
        slot.last_used = Instant::now();
        apply_one(&mut slot.search, &NotifOp::Upsert(doc.clone()));
        maybe_compact(&mut slot.search);
        if let Some(ops) = slot.pending.as_mut() {
            ops.push(NotifOp::Upsert(doc));
        }
    }

    pub fn remove_if_present(&self, recipient: Uuid, notification_uuid: Uuid) {
        let mut users = self.users.write().expect("notifications search index");
        evict_idle(&mut users);
        let Some(slot) = users.get_mut(&recipient) else {
            return;
        };
        slot.last_used = Instant::now();
        let op = NotifOp::Remove(notification_uuid.to_string());
        apply_one(&mut slot.search, &op);
        maybe_compact(&mut slot.search);
        if let Some(ops) = slot.pending.as_mut() {
            ops.push(op);
        }
    }

    pub fn has_slot(&self, recipient: Uuid) -> bool {
        let mut users = self.users.write().expect("notifications search index");
        evict_idle(&mut users);
        users.contains_key(&recipient)
    }

    pub fn drop_user(&self, recipient: Uuid) {
        let mut users = self.users.write().expect("notifications search index");
        users.remove(&recipient);
    }
}

impl Default for NotificationSearchIndex {
    fn default() -> Self {
        Self::new()
    }
}

pub fn notification_doc(
    notification_uuid: Uuid,
    text: impl Into<String>,
    actor_user_uuid: Option<Uuid>,
    actor_name: Option<String>,
    kind: impl Into<String>,
    read: bool,
    created_at: DateTime<Utc>,
) -> NotificationDoc {
    NotificationDoc {
        id: notification_uuid.to_string(),
        text: text.into(),
        actor_id: actor_user_uuid.map(|id| id.to_string()),
        actor_name,
        kind: Some(kind.into()),
        read,
        created_at: created_at.timestamp(),
    }
}

/// Filter (category / platform) first, then skip/take — same order as the former SQL.
#[cfg(test)]
fn page_after_filter<T>(
    ranked: impl IntoIterator<Item = T>,
    keep: impl Fn(&T) -> bool,
    skip: usize,
    take: usize,
) -> Vec<T> {
    ranked
        .into_iter()
        .filter(keep)
        .skip(skip)
        .take(take)
        .collect()
}

fn apply_one(search: &mut NotificationsSearch, op: &NotifOp) {
    match op {
        NotifOp::Upsert(doc) => {
            if let Err(error) = search.upsert(doc.clone()) {
                tracing::warn!(%error, "notifications FSA-N upsert failed");
            }
        }
        NotifOp::Remove(id) => {
            search.remove(id);
        }
    }
}

fn evict_idle(users: &mut HashMap<Uuid, UserNotifIndex>) {
    let now = Instant::now();
    users.retain(|_, slot| now.saturating_duration_since(slot.last_used) < IDLE_EVICT);
}

fn maybe_compact(search: &mut NotificationsSearch) {
    let tombs = search.engine().tombstones();
    if tombs == 0 {
        return;
    }
    let alive = search.len();
    let ratio = if alive == 0 {
        f64::INFINITY
    } else {
        tombs as f64 / alive as f64
    };
    if ratio > TOMBSTONE_COMPACT_RATIO {
        search.compact();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(secs: i64) -> DateTime<Utc> {
        DateTime::<Utc>::from_timestamp(secs, 0).expect("timestamp")
    }

    fn doc(id: Uuid, text: &str, created_at: i64) -> NotificationDoc {
        notification_doc(id, text, None, None, "like", false, at(created_at))
    }

    #[test]
    fn search_returns_empty_before_index_ready() {
        let index = NotificationSearchIndex::new();
        let viewer = Uuid::from_u128(1);
        let n1 = Uuid::from_u128(11);
        index.upsert_if_present(viewer, doc(n1, "лайк на пост", 100));
        assert!(
            index.search_ids(viewer, "лайк", 0, 20).is_none(),
            "no slot → treat as not ready"
        );
        assert!(index.begin_lazy_rebuild(viewer));
        index.upsert_if_present(viewer, doc(n1, "лайк на пост", 100));
        assert!(
            index.search_ids(viewer, "лайк", 0, 20).is_none(),
            "!ready slot returns no hits"
        );
        assert!(
            !index.begin_lazy_rebuild(viewer),
            "rebuild already in flight"
        );
    }

    #[test]
    fn search_returns_only_viewer_inbox() {
        let index = NotificationSearchIndex::new();
        let viewer = Uuid::from_u128(1);
        let other = Uuid::from_u128(2);
        let mine = Uuid::from_u128(21);
        let theirs = Uuid::from_u128(22);
        assert!(index.begin_lazy_rebuild(viewer));
        assert!(index.begin_lazy_rebuild(other));
        index.finish_rebuild(viewer, vec![doc(mine, "лайк на ваш пост", 200)]);
        index.finish_rebuild(other, vec![doc(theirs, "лайк на ваш пост", 300)]);
        let ids = index
            .search_ids(viewer, "лайк", 0, 20)
            .expect("viewer index ready");
        assert_eq!(ids, vec![mine]);
        assert!(!ids.contains(&theirs));
        let other_ids = index
            .search_ids(other, "лайк", 0, 20)
            .expect("other index ready");
        assert_eq!(other_ids, vec![theirs]);
    }

    #[test]
    fn equal_text_newer_created_at_ranks_first() {
        let index = NotificationSearchIndex::new();
        let viewer = Uuid::from_u128(1);
        let older = Uuid::from_u128(31);
        let newer = Uuid::from_u128(32);
        let text = "лайк на ваш пост";
        assert!(index.begin_lazy_rebuild(viewer));
        index.finish_rebuild(viewer, vec![doc(older, text, 100), doc(newer, text, 200)]);
        let ids = index.search_ids(viewer, "лайк", 0, 20).expect("ready");
        assert_eq!(
            ids,
            vec![newer, older],
            "recency-first: newer created_at first"
        );
    }

    #[test]
    fn finish_rebuild_replays_pending_upsert() {
        let index = NotificationSearchIndex::new();
        let viewer = Uuid::from_u128(1);
        let from_sql = Uuid::from_u128(41);
        let live = Uuid::from_u128(42);
        assert!(index.begin_lazy_rebuild(viewer));
        index.upsert_if_present(viewer, doc(live, "лайк во время rebuild", 300));
        index.finish_rebuild(viewer, vec![doc(from_sql, "лайк из sql", 200)]);
        let ids = index.search_ids(viewer, "лайк", 0, 20).expect("ready");
        assert!(ids.contains(&from_sql));
        assert!(
            ids.contains(&live),
            "CRUD during lazy rebuild must survive finish_rebuild"
        );
    }

    #[test]
    fn category_filter_then_take_skips_leading_other_tab() {
        let social = Uuid::from_u128(51);
        let developer = Uuid::from_u128(52);
        let ranked = [developer, social];
        let page = page_after_filter(ranked, |id| *id == social, 0, 1);
        assert_eq!(
            page,
            vec![social],
            "take=1 on Social must skip a leading Developer hit"
        );
    }
}
