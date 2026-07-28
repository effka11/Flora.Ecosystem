//! Hot presence + watch registry + throttled Postgres persist + SSE fan-out.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, SecondsFormat, Utc};
use flora_notifications_contracts::{
    PresenceRealtimePublisher, RealtimePresenceSignal, SseConnectionHooks,
};
use flora_users_contracts::{BoxFuture, LastSeenRow, OnlineStatusAccess, UserPresence};
use sqlx::PgPool;
use uuid::Uuid;

pub const ONLINE_THRESHOLD: Duration = Duration::from_millis(2500);
pub const SWEEPER_INTERVAL: Duration = Duration::from_millis(500);
pub const PERSIST_THROTTLE: Duration = Duration::from_secs(30);
pub const MAX_WATCH_UUIDS: usize = 100;
pub const WATCH_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Clone)]
struct HotEntry {
    touched_at: Instant,
    last_seen_at: DateTime<Utc>,
    reported_online: bool,
}

#[derive(Clone)]
struct WatchSlot {
    watched: HashSet<Uuid>,
    refreshed_at: Instant,
}

struct WatchRegistry {
    /// (watcher_user, connection_id) → watched set
    by_connection: HashMap<(Uuid, Uuid), WatchSlot>,
    /// watched_user → {(watcher_user, connection_id)}
    reverse: HashMap<Uuid, HashSet<(Uuid, Uuid)>>,
    /// Active SSE connections registered via on_subscribe.
    active: HashSet<(Uuid, Uuid)>,
}

impl WatchRegistry {
    fn new() -> Self {
        Self {
            by_connection: HashMap::new(),
            reverse: HashMap::new(),
            active: HashSet::new(),
        }
    }

    fn register_connection(&mut self, user: Uuid, connection: Uuid) {
        self.active.insert((user, connection));
    }

    fn clear_watch_only(&mut self, user: Uuid, connection: Uuid) {
        if let Some(slot) = self.by_connection.remove(&(user, connection)) {
            for watched in slot.watched {
                if let Some(set) = self.reverse.get_mut(&watched) {
                    set.remove(&(user, connection));
                    if set.is_empty() {
                        self.reverse.remove(&watched);
                    }
                }
            }
        }
    }

    fn clear_connection(&mut self, user: Uuid, connection: Uuid) {
        self.active.remove(&(user, connection));
        self.clear_watch_only(user, connection);
    }

    fn set_watch(
        &mut self,
        watcher: Uuid,
        connection: Uuid,
        watched: HashSet<Uuid>,
    ) -> Result<(), String> {
        if !self.active.contains(&(watcher, connection)) {
            return Err("unknown connectionId".into());
        }
        self.clear_watch_only(watcher, connection);
        for w in &watched {
            self.reverse
                .entry(*w)
                .or_default()
                .insert((watcher, connection));
        }
        self.by_connection.insert(
            (watcher, connection),
            WatchSlot {
                watched,
                refreshed_at: Instant::now(),
            },
        );
        Ok(())
    }

    fn expire_stale(&mut self, now: Instant) {
        let stale: Vec<(Uuid, Uuid)> = self
            .by_connection
            .iter()
            .filter(|(_, slot)| now.duration_since(slot.refreshed_at) > WATCH_TTL)
            .map(|(k, _)| *k)
            .collect();
        for (user, conn) in stale {
            self.clear_watch_only(user, conn);
        }
    }

    fn watchers_of(&self, subject: Uuid) -> Vec<(Uuid, Uuid)> {
        self.reverse
            .get(&subject)
            .map(|s| s.iter().copied().collect())
            .unwrap_or_default()
    }
}

pub struct PresenceService {
    pool: PgPool,
    hot: Mutex<HashMap<Uuid, HotEntry>>,
    last_persist: Mutex<HashMap<Uuid, Instant>>,
    watch: Mutex<WatchRegistry>,
    publisher: Arc<dyn PresenceRealtimePublisher>,
    online_access: Arc<dyn OnlineStatusAccess>,
}

impl PresenceService {
    pub fn new(
        pool: PgPool,
        publisher: Arc<dyn PresenceRealtimePublisher>,
        online_access: Arc<dyn OnlineStatusAccess>,
    ) -> Arc<Self> {
        let svc = Arc::new(Self {
            pool,
            hot: Mutex::new(HashMap::new()),
            last_persist: Mutex::new(HashMap::new()),
            watch: Mutex::new(WatchRegistry::new()),
            publisher,
            online_access,
        });
        let weak = Arc::downgrade(&svc);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(SWEEPER_INTERVAL);
            loop {
                interval.tick().await;
                let Some(svc) = weak.upgrade() else {
                    break;
                };
                svc.sweep_offline().await;
            }
        });
        svc
    }

    pub fn as_presence(self: &Arc<Self>) -> Arc<dyn UserPresence> {
        self.clone()
    }

    pub fn as_sse_hooks(self: &Arc<Self>) -> Arc<dyn SseConnectionHooks> {
        self.clone()
    }

    pub fn clear_connection(&self, user_uuid: Uuid, connection_id: Uuid) {
        let mut watch = self.watch.lock().expect("presence watch lock");
        watch.clear_connection(user_uuid, connection_id);
    }

    /// Test helper: backdate hot touch so sweeper can emit offline.
    #[cfg(test)]
    fn force_stale_for_test(&self, user: Uuid) {
        let mut hot = self.hot.lock().expect("presence hot lock");
        if let Some(entry) = hot.get_mut(&user) {
            entry.touched_at = Instant::now() - ONLINE_THRESHOLD - Duration::from_millis(10);
            entry.reported_online = true;
        }
    }

    pub fn set_watch(
        &self,
        watcher: Uuid,
        connection_id: Uuid,
        user_uuids: &[Uuid],
    ) -> Result<(), String> {
        let mut set = HashSet::new();
        for u in user_uuids {
            if !u.is_nil() {
                set.insert(*u);
            }
        }
        if set.len() > MAX_WATCH_UUIDS {
            return Err("too many uuids".into());
        }
        let mut watch = self.watch.lock().expect("presence watch lock");
        watch.set_watch(watcher, connection_id, set)
    }

    pub async fn snapshot_for_viewer(
        &self,
        viewer: Uuid,
        subject_uuids: &[Uuid],
    ) -> Result<Vec<PresenceSnapshot>, String> {
        let mut subjects: Vec<Uuid> = subject_uuids
            .iter()
            .copied()
            .filter(|u| !u.is_nil())
            .collect();
        subjects.sort_unstable();
        subjects.dedup();
        if subjects.len() > MAX_WATCH_UUIDS {
            return Err("too many uuids".into());
        }

        let mut out = Vec::with_capacity(subjects.len());
        for subject in subjects {
            let can_see = self
                .online_access
                .can_see_online(viewer, subject)
                .await
                .unwrap_or(false);
            if !can_see {
                out.push(PresenceSnapshot {
                    user_uuid: subject,
                    is_online: false,
                    last_seen_at: None,
                });
                continue;
            }
            let (is_online, last_seen_at) = self.hot_status(subject);
            let last_seen_at = match last_seen_at {
                Some(dt) => Some(dt),
                None => self.cold_last_seen(subject).await?,
            };
            out.push(PresenceSnapshot {
                user_uuid: subject,
                is_online,
                last_seen_at,
            });
        }
        Ok(out)
    }

    fn hot_status(&self, user: Uuid) -> (bool, Option<DateTime<Utc>>) {
        let hot = self.hot.lock().expect("presence hot lock");
        match hot.get(&user) {
            Some(e) => {
                let online = e.touched_at.elapsed() <= ONLINE_THRESHOLD;
                (online, Some(e.last_seen_at))
            }
            None => (false, None),
        }
    }

    async fn cold_last_seen(&self, user: Uuid) -> Result<Option<DateTime<Utc>>, String> {
        let row: Option<(DateTime<Utc>,)> = sqlx::query_as(
            r#"
            SELECT last_seen_at_utc
            FROM flora_core.user_presence
            WHERE user_uuid = $1
            "#,
        )
        .bind(user)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(row.map(|r| r.0))
    }

    async fn maybe_persist(&self, user: Uuid, at: DateTime<Utc>, force: bool) {
        let should = {
            let mut map = self.last_persist.lock().expect("presence persist lock");
            let now = Instant::now();
            let due = match map.get(&user) {
                Some(prev) => force || now.duration_since(*prev) >= PERSIST_THROTTLE,
                None => true,
            };
            if due {
                map.insert(user, now);
            }
            due
        };
        if !should {
            return;
        }
        let pool = self.pool.clone();
        tokio::spawn(async move {
            if let Err(e) = sqlx::query(
                r#"
                INSERT INTO flora_core.user_presence (user_uuid, last_seen_at_utc)
                VALUES ($1, $2)
                ON CONFLICT (user_uuid) DO UPDATE SET last_seen_at_utc = EXCLUDED.last_seen_at_utc
                "#,
            )
            .bind(user)
            .bind(at)
            .execute(&pool)
            .await
            {
                tracing::warn!(error = %e, %user, "presence persist failed");
            }
        });
    }

    async fn fan_out_transition(
        &self,
        subject: Uuid,
        is_online: bool,
        last_seen_at: DateTime<Utc>,
    ) {
        let watchers = {
            let watch = self.watch.lock().expect("presence watch lock");
            watch.watchers_of(subject)
        };
        for (watcher, connection_id) in watchers {
            let can_see = self
                .online_access
                .can_see_online(watcher, subject)
                .await
                .unwrap_or(false);
            // Hidden online must push offline (null lastSeen) so clients drop stale badges.
            let signal = if can_see {
                RealtimePresenceSignal {
                    user_uuid: subject,
                    is_online,
                    last_seen_at: Some(last_seen_at),
                }
            } else {
                RealtimePresenceSignal {
                    user_uuid: subject,
                    is_online: false,
                    last_seen_at: None,
                }
            };
            self.publisher
                .publish_to_connection(watcher, connection_id, &signal);
        }
    }

    /// Re-evaluate `can_see` for all watchers of `subject` and push current (or hidden) state.
    /// Call after privacy / block changes that do not create a presence transition.
    pub async fn republish_for_subject(&self, subject: Uuid) {
        let watchers = {
            let watch = self.watch.lock().expect("presence watch lock");
            watch.watchers_of(subject)
        };
        if watchers.is_empty() {
            return;
        }
        let (is_online, last_seen_at) = self.hot_status(subject);
        for (watcher, connection_id) in watchers {
            let can_see = self
                .online_access
                .can_see_online(watcher, subject)
                .await
                .unwrap_or(false);
            let signal = if can_see {
                RealtimePresenceSignal {
                    user_uuid: subject,
                    is_online,
                    last_seen_at,
                }
            } else {
                RealtimePresenceSignal {
                    user_uuid: subject,
                    is_online: false,
                    last_seen_at: None,
                }
            };
            self.publisher
                .publish_to_connection(watcher, connection_id, &signal);
        }
    }

    async fn sweep_offline(&self) {
        {
            let mut watch = self.watch.lock().expect("presence watch lock");
            watch.expire_stale(Instant::now());
        }
        let expired: Vec<(Uuid, DateTime<Utc>)> = {
            let mut hot = self.hot.lock().expect("presence hot lock");
            let mut out = Vec::new();
            let mut prune = Vec::new();
            for (user, entry) in hot.iter_mut() {
                let online = entry.touched_at.elapsed() <= ONLINE_THRESHOLD;
                if entry.reported_online && !online {
                    entry.reported_online = false;
                    out.push((*user, entry.last_seen_at));
                }
                // Drop cold offline entries after 10 minutes to bound memory.
                if !entry.reported_online
                    && entry.touched_at.elapsed() > Duration::from_secs(10 * 60)
                {
                    prune.push(*user);
                }
            }
            for user in &prune {
                hot.remove(user);
            }
            if !prune.is_empty() {
                let mut persist = self.last_persist.lock().expect("presence persist lock");
                for user in &prune {
                    persist.remove(user);
                }
            }
            out
        };
        for (user, last_seen_at) in expired {
            self.maybe_persist(user, last_seen_at, true).await;
            self.fan_out_transition(user, false, last_seen_at).await;
        }
    }
}

#[derive(Debug, Clone)]
pub struct PresenceSnapshot {
    pub user_uuid: Uuid,
    pub is_online: bool,
    pub last_seen_at: Option<DateTime<Utc>>,
}

impl PresenceSnapshot {
    pub fn last_seen_iso(&self) -> Option<String> {
        self.last_seen_at
            .map(|dt| dt.to_rfc3339_opts(SecondsFormat::Millis, true))
    }
}

impl UserPresence for PresenceService {
    fn touch(&self, user_uuid: Uuid) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let now_dt = Utc::now();
            let transition_online = {
                let mut hot = self.hot.lock().expect("presence hot lock");
                let entry = hot.entry(user_uuid).or_insert_with(|| HotEntry {
                    touched_at: Instant::now(),
                    last_seen_at: now_dt,
                    reported_online: false,
                });
                entry.touched_at = Instant::now();
                entry.last_seen_at = now_dt;
                let was = entry.reported_online;
                if !was {
                    entry.reported_online = true;
                    true
                } else {
                    false
                }
            };
            self.maybe_persist(user_uuid, now_dt, false).await;
            if transition_online {
                self.fan_out_transition(user_uuid, true, now_dt).await;
            }
            Ok(())
        })
    }

    fn last_seen_by_uuids(
        &self,
        user_uuids: &[Uuid],
    ) -> BoxFuture<'_, Result<Vec<LastSeenRow>, String>> {
        let ids = user_uuids.to_vec();
        Box::pin(async move {
            let mut out = Vec::with_capacity(ids.len());
            let mut missing = Vec::new();
            {
                let hot = self.hot.lock().expect("presence hot lock");
                for id in &ids {
                    if let Some(e) = hot.get(id) {
                        out.push((*id, e.last_seen_at));
                    } else {
                        missing.push(*id);
                    }
                }
            }
            if !missing.is_empty() {
                let rows: Vec<(Uuid, DateTime<Utc>)> = sqlx::query_as(
                    r#"
                    SELECT user_uuid, last_seen_at_utc
                    FROM flora_core.user_presence
                    WHERE user_uuid = ANY($1)
                    "#,
                )
                .bind(&missing)
                .fetch_all(&self.pool)
                .await
                .map_err(|e| e.to_string())?;
                out.extend(rows);
            }
            Ok(out)
        })
    }

    fn is_online_by_uuids(
        &self,
        user_uuids: &[Uuid],
    ) -> BoxFuture<'_, Result<Vec<(Uuid, bool)>, String>> {
        let ids = user_uuids.to_vec();
        Box::pin(async move {
            let hot = self.hot.lock().expect("presence hot lock");
            Ok(ids
                .into_iter()
                .map(|id| {
                    let online = hot
                        .get(&id)
                        .map(|e| e.touched_at.elapsed() <= ONLINE_THRESHOLD)
                        .unwrap_or(false);
                    (id, online)
                })
                .collect())
        })
    }
}

impl SseConnectionHooks for PresenceService {
    fn on_subscribe(&self, user_uuid: Uuid, connection_id: Uuid) {
        let mut watch = self.watch.lock().expect("presence watch lock");
        watch.register_connection(user_uuid, connection_id);
    }

    fn on_unsubscribe(&self, user_uuid: Uuid, connection_id: Uuid) {
        self.clear_connection(user_uuid, connection_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flora_notifications_contracts::NoopPresenceRealtimePublisher;
    use std::sync::Mutex as StdMutex;

    struct AllowAllOnline;

    impl OnlineStatusAccess for AllowAllOnline {
        fn can_see_online(
            &self,
            _viewer_user_uuid: Uuid,
            _subject_user_uuid: Uuid,
        ) -> BoxFuture<'_, Result<bool, String>> {
            Box::pin(async { Ok(true) })
        }
    }

    struct DenyAllOnline;

    impl OnlineStatusAccess for DenyAllOnline {
        fn can_see_online(
            &self,
            _viewer_user_uuid: Uuid,
            _subject_user_uuid: Uuid,
        ) -> BoxFuture<'_, Result<bool, String>> {
            Box::pin(async { Ok(false) })
        }
    }

    #[derive(Default)]
    struct RecordingPublisher {
        calls: StdMutex<Vec<(Uuid, Uuid, bool)>>,
    }

    impl PresenceRealtimePublisher for RecordingPublisher {
        fn publish_to_connection(
            &self,
            recipient_user_uuid: Uuid,
            connection_id: Uuid,
            signal: &RealtimePresenceSignal,
        ) {
            self.calls
                .lock()
                .unwrap()
                .push((recipient_user_uuid, connection_id, signal.is_online));
        }
    }

    fn lazy_pool() -> Option<PgPool> {
        PgPool::connect_lazy("postgres://unused").ok()
    }

    #[tokio::test]
    async fn watch_requires_active_connection() {
        let Some(pool) = lazy_pool() else {
            return;
        };
        let svc = PresenceService::new(
            pool,
            Arc::new(NoopPresenceRealtimePublisher),
            Arc::new(AllowAllOnline),
        );
        let user = Uuid::now_v7();
        let conn = Uuid::now_v7();
        let peer = Uuid::now_v7();
        assert!(svc.set_watch(user, conn, &[peer]).is_err());
        svc.on_subscribe(user, conn);
        assert!(svc.set_watch(user, conn, &[peer]).is_ok());
        svc.on_unsubscribe(user, conn);
        assert!(svc.set_watch(user, conn, &[peer]).is_err());
    }

    #[tokio::test]
    async fn touch_marks_online() {
        let Some(pool) = lazy_pool() else {
            return;
        };
        let svc = PresenceService::new(
            pool,
            Arc::new(NoopPresenceRealtimePublisher),
            Arc::new(AllowAllOnline),
        );
        let user = Uuid::now_v7();
        let _ = svc.touch(user).await;
        let online = svc.is_online_by_uuids(&[user]).await.unwrap();
        assert_eq!(online, vec![(user, true)]);
    }

    #[tokio::test]
    async fn unsubscribe_clears_watch_interest() {
        let Some(pool) = lazy_pool() else {
            return;
        };
        let publisher = Arc::new(RecordingPublisher::default());
        let svc = PresenceService::new(pool, publisher.clone(), Arc::new(AllowAllOnline));
        let watcher = Uuid::now_v7();
        let conn = Uuid::now_v7();
        let peer = Uuid::now_v7();
        svc.on_subscribe(watcher, conn);
        assert!(svc.set_watch(watcher, conn, &[peer]).is_ok());
        svc.on_unsubscribe(watcher, conn);
        let _ = svc.touch(peer).await;
        assert!(publisher.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn privacy_fans_out_hidden_as_offline() {
        let Some(pool) = lazy_pool() else {
            return;
        };
        let publisher = Arc::new(RecordingPublisher::default());
        let svc = PresenceService::new(pool, publisher.clone(), Arc::new(DenyAllOnline));
        let watcher = Uuid::now_v7();
        let conn = Uuid::now_v7();
        let peer = Uuid::now_v7();
        svc.on_subscribe(watcher, conn);
        assert!(svc.set_watch(watcher, conn, &[peer]).is_ok());
        let _ = svc.touch(peer).await;
        let calls = publisher.calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 1);
        assert!(!calls[0].2, "privacy hide must publish is_online=false");
    }

    #[tokio::test]
    async fn republish_for_subject_pushes_without_transition() {
        let Some(pool) = lazy_pool() else {
            return;
        };
        let publisher = Arc::new(RecordingPublisher::default());
        let svc = PresenceService::new(pool, publisher.clone(), Arc::new(DenyAllOnline));
        let watcher = Uuid::now_v7();
        let conn = Uuid::now_v7();
        let peer = Uuid::now_v7();
        svc.on_subscribe(watcher, conn);
        assert!(svc.set_watch(watcher, conn, &[peer]).is_ok());
        let _ = svc.touch(peer).await;
        publisher.calls.lock().unwrap().clear();
        // Still online in hot; no transition — privacy revoke path.
        svc.republish_for_subject(peer).await;
        let calls = publisher.calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 1);
        assert!(!calls[0].2);
        assert_eq!(calls[0].0, watcher);
        assert_eq!(calls[0].1, conn);
    }

    #[tokio::test]
    async fn sweeper_fans_out_offline() {
        let Some(pool) = lazy_pool() else {
            return;
        };
        let publisher = Arc::new(RecordingPublisher::default());
        let svc = PresenceService::new(pool, publisher.clone(), Arc::new(AllowAllOnline));
        let watcher = Uuid::now_v7();
        let conn = Uuid::now_v7();
        let peer = Uuid::now_v7();
        svc.on_subscribe(watcher, conn);
        assert!(svc.set_watch(watcher, conn, &[peer]).is_ok());
        let _ = svc.touch(peer).await;
        assert_eq!(publisher.calls.lock().unwrap().len(), 1);
        assert!(publisher.calls.lock().unwrap()[0].2);
        publisher.calls.lock().unwrap().clear();

        svc.force_stale_for_test(peer);
        svc.sweep_offline().await;
        let calls = publisher.calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, watcher);
        assert_eq!(calls[0].1, conn);
        assert!(!calls[0].2);
    }

    #[tokio::test]
    async fn fan_out_targets_connection_not_all_user_tabs() {
        let Some(pool) = lazy_pool() else {
            return;
        };
        let publisher = Arc::new(RecordingPublisher::default());
        let svc = PresenceService::new(pool, publisher.clone(), Arc::new(AllowAllOnline));
        let watcher = Uuid::now_v7();
        let conn_a = Uuid::now_v7();
        let conn_b = Uuid::now_v7();
        let peer = Uuid::now_v7();
        svc.on_subscribe(watcher, conn_a);
        svc.on_subscribe(watcher, conn_b);
        assert!(svc.set_watch(watcher, conn_a, &[peer]).is_ok());
        // conn_b has no watch
        let _ = svc.touch(peer).await;
        let calls = publisher.calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].1, conn_a);
    }
}
