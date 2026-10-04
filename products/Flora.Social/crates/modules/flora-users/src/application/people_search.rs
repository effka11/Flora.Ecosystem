//! In-process FSA-P host for GET /api/auth/users/search.
//!
//! Users owns people documents. Auth usernames arrive through `AccountDirectory`.
//! Scores stay off the wire; the HTTP handler hydrates `UserSearchItem`.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use chrono::Utc;
use flora_auth_contracts::AccountDirectory;
use flora_users_contracts::{BidirectionalBlocklist, UserProfileProvisioner, UserProfileQueries};
use fsa_core::people::{PeopleQuery, PeopleSearch, PersonDoc};
use sqlx::PgPool;
use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;

use crate::infrastructure::people_index;

const TOMBSTONE_COMPACT_RATIO: f64 = 0.2;

#[derive(Clone)]
enum PersonOp {
    Upsert(PersonDoc),
    Remove(String),
}

#[derive(Clone)]
pub struct PeopleSearchHost {
    engine: Arc<RwLock<PeopleSearch>>,
    ready: Arc<AtomicBool>,
    pending: Arc<Mutex<Option<Vec<PersonOp>>>>,
    blocks: Arc<dyn BidirectionalBlocklist>,
}

impl PeopleSearchHost {
    pub fn new(blocks: Arc<dyn BidirectionalBlocklist>) -> Self {
        Self {
            engine: Arc::new(RwLock::new(PeopleSearch::new())),
            ready: Arc::new(AtomicBool::new(false)),
            pending: Arc::new(Mutex::new(Some(Vec::new()))),
            blocks,
        }
    }

    /// SQL rebuild without holding the live write lock. CRUD during rebuild is
    /// applied to the live engine and replayed onto the snapshot at install.
    pub async fn rebuild(&self, pool: PgPool, accounts: Arc<dyn AccountDirectory>) {
        match load_person_docs(&pool, accounts.as_ref()).await {
            Ok(docs) => {
                let mut fresh = PeopleSearch::new();
                for doc in docs {
                    if let Err(error) = fresh.upsert(doc) {
                        tracing::warn!(%error, "people search rebuild upsert failed");
                    }
                }
                self.install_rebuilt(fresh).await;
            }
            Err(error) => {
                tracing::warn!(%error, "people search rebuild failed");
            }
        }
    }

    async fn install_rebuilt(&self, mut built: PeopleSearch) {
        let mut pending = self.pending.lock().await;
        if let Some(ops) = pending.as_ref() {
            for op in ops {
                apply_one(&mut built, op);
            }
        }
        maybe_compact(&mut built);
        let mut engine = self.engine.write().await;
        *engine = built;
        *pending = None;
        drop(engine);
        self.ready.store(true, Ordering::Release);
    }

    async fn apply(&self, op: PersonOp) -> Result<(), String> {
        let mut pending = self.pending.lock().await;
        let mut engine = self.engine.write().await;
        apply_one(&mut engine, &op);
        maybe_compact(&mut engine);
        if let Some(ops) = pending.as_mut() {
            ops.push(op);
        }
        Ok(())
    }

    pub async fn upsert_person(
        &self,
        user_uuid: Uuid,
        username: String,
        display_name: String,
        status: String,
    ) -> Result<(), String> {
        self.apply(PersonOp::Upsert(person_doc(
            user_uuid,
            username,
            display_name,
            status,
        )))
        .await
    }

    pub async fn remove_person(&self, user_uuid: Uuid) -> Result<(), String> {
        self.apply(PersonOp::Remove(user_uuid.to_string())).await
    }

    /// Application entry after a profile write: load stored fields and upsert.
    pub async fn sync_user(
        &self,
        user_uuid: Uuid,
        username: String,
        profiles: &dyn UserProfileQueries,
    ) -> Result<(), String> {
        let (display_name, status) = match profiles.get_profile(user_uuid).await? {
            Some(profile) => (profile.display_name, profile.status),
            None => (String::new(), String::new()),
        };
        self.upsert_person(user_uuid, username, display_name, status)
            .await
    }

    pub async fn search(
        &self,
        query: &str,
        viewer: Uuid,
        skip: i32,
        take: i32,
    ) -> Result<Vec<Uuid>, String> {
        if query.trim().is_empty() || !self.ready.load(Ordering::Acquire) {
            return Ok(Vec::new());
        }
        let take = take.clamp(1, 50) as usize;
        let skip = skip.max(0) as usize;
        let need = skip + take;
        let blocked: HashSet<Uuid> = self
            .blocks
            .blocked_user_ids_bidirectional(viewer)
            .await?
            .into_iter()
            .collect();

        const SEARCH_BATCH: usize = 50;
        let now = Utc::now().timestamp();
        let mut visible = Vec::new();
        let mut fsa_offset = 0;
        loop {
            let mut people_query = PeopleQuery::new(query, now);
            people_query.limit = SEARCH_BATCH;
            people_query.offset = fsa_offset;
            let hits = {
                let engine = self.engine.read().await;
                engine.search(&people_query, None).hits
            };
            let batch_len = hits.len();
            if batch_len == 0 {
                break;
            }
            fsa_offset += batch_len;
            visible.extend(
                hits.into_iter()
                    .filter_map(|hit| Uuid::parse_str(&hit.id).ok())
                    .filter(|id| *id != viewer && !blocked.contains(id)),
            );
            if visible.len() >= need || batch_len < SEARCH_BATCH {
                break;
            }
        }
        Ok(visible.into_iter().skip(skip).take(take).collect())
    }
}

/// Auth registration writes the empty profile through this wrapper so FSA-P
/// sees the new user without Users reading Auth tables.
pub struct SearchAwareProfileProvisioner {
    inner: Arc<dyn UserProfileProvisioner>,
    people_search: Arc<PeopleSearchHost>,
}

impl SearchAwareProfileProvisioner {
    pub fn new(
        inner: Arc<dyn UserProfileProvisioner>,
        people_search: Arc<PeopleSearchHost>,
    ) -> Self {
        Self {
            inner,
            people_search,
        }
    }
}

impl UserProfileProvisioner for SearchAwareProfileProvisioner {
    fn ensure_initial_profile(
        &self,
        user_uuid: Uuid,
        display_name: &str,
        username: &str,
    ) -> flora_users_contracts::BoxFuture<'_, Result<(), String>> {
        let display_name = display_name.to_string();
        let username = username.to_string();
        let inner = Arc::clone(&self.inner);
        let people_search = Arc::clone(&self.people_search);
        Box::pin(async move {
            inner
                .ensure_initial_profile(user_uuid, &display_name, &username)
                .await?;
            if let Err(error) = people_search
                .upsert_person(user_uuid, username, display_name, String::new())
                .await
            {
                tracing::warn!(
                    %error,
                    %user_uuid,
                    "people search upsert after profile provision failed"
                );
            }
            Ok(())
        })
    }

    fn forget_user(
        &self,
        user_uuid: Uuid,
    ) -> flora_users_contracts::BoxFuture<'_, Result<(), String>> {
        let inner = Arc::clone(&self.inner);
        let people_search = Arc::clone(&self.people_search);
        Box::pin(async move {
            inner.forget_user(user_uuid).await?;
            if let Err(error) = people_search.remove_person(user_uuid).await {
                tracing::warn!(
                    %error,
                    %user_uuid,
                    "people search remove after account delete failed"
                );
            }
            Ok(())
        })
    }
}

pub fn person_doc(
    user_uuid: Uuid,
    username: String,
    display_name: String,
    status: String,
) -> PersonDoc {
    let bio = {
        let trimmed = status.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    };
    PersonDoc {
        id: user_uuid.to_string(),
        display_name,
        username,
        bio,
        interests: Vec::new(),
        topic_ids: Vec::new(),
        community_ids: Vec::new(),
        city: None,
        verified: false,
        last_active_at: 0,
        profile_rank: 0.0,
    }
}

fn apply_one(engine: &mut PeopleSearch, op: &PersonOp) {
    match op {
        PersonOp::Upsert(person) => {
            if let Err(error) = engine.upsert(person.clone()) {
                tracing::warn!(%error, "people search upsert failed");
            }
        }
        PersonOp::Remove(id) => {
            engine.remove(id);
        }
    }
}

fn maybe_compact(engine: &mut PeopleSearch) {
    let tombstones = engine.engine().tombstones();
    let len = engine.len().max(1);
    if tombstones as f64 / (len as f64) > TOMBSTONE_COMPACT_RATIO {
        engine.compact();
    }
}

async fn load_person_docs(
    pool: &PgPool,
    accounts: &dyn AccountDirectory,
) -> Result<Vec<PersonDoc>, String> {
    let uuids = accounts.list_active_user_uuids().await?;
    let usernames = accounts.usernames_by_uuids(&uuids).await?;
    let profiles = people_index::load_profiles(pool)
        .await
        .map_err(|e| e.to_string())?;
    let profile_by: HashMap<Uuid, (String, String)> = profiles
        .into_iter()
        .map(|p| (p.user_uuid, (p.display_name, p.status)))
        .collect();
    Ok(usernames
        .into_iter()
        .filter(|(_, name)| !name.is_empty())
        .map(|(id, username)| {
            let (display_name, status) = profile_by.get(&id).cloned().unwrap_or_default();
            person_doc(id, username, display_name, status)
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use flora_users_contracts::BoxFuture;

    struct FakeBlocklist {
        blocked: Vec<Uuid>,
    }

    impl BidirectionalBlocklist for FakeBlocklist {
        fn blocked_user_ids_bidirectional(
            &self,
            _user_uuid: Uuid,
        ) -> BoxFuture<'_, Result<Vec<Uuid>, String>> {
            let blocked = self.blocked.clone();
            Box::pin(async move { Ok(blocked) })
        }
    }

    fn host(blocked: Vec<Uuid>) -> PeopleSearchHost {
        PeopleSearchHost::new(Arc::new(FakeBlocklist { blocked }))
    }

    async fn upsert(host: &PeopleSearchHost, user_uuid: Uuid, display_name: &str, username: &str) {
        host.upsert_person(
            user_uuid,
            username.to_string(),
            display_name.to_string(),
            String::new(),
        )
        .await
        .expect("upsert");
    }

    #[tokio::test]
    async fn search_returns_empty_before_index_ready() {
        let viewer = Uuid::now_v7();
        let host = host(Vec::new());
        upsert(&host, viewer, "Alice", "alice").await;
        let ids = host.search("alice", viewer, 0, 20).await.expect("search");
        assert!(ids.is_empty());
    }

    #[tokio::test]
    async fn search_excludes_viewer_self() {
        let viewer = Uuid::now_v7();
        let other = Uuid::now_v7();
        let host = host(Vec::new());
        upsert(&host, viewer, "Alice", "alice").await;
        upsert(&host, other, "Alicia", "alicia").await;
        host.ready.store(true, Ordering::Release);
        let ids = host.search("ali", viewer, 0, 20).await.expect("search");
        assert!(!ids.contains(&viewer));
        assert!(ids.contains(&other));
    }

    #[tokio::test]
    async fn search_excludes_bidirectional_blocklist_user() {
        let viewer = Uuid::now_v7();
        let blocked = Uuid::now_v7();
        let other = Uuid::now_v7();
        let host = host(vec![blocked]);
        upsert(&host, blocked, "Boris", "boris").await;
        upsert(&host, other, "Bob", "bobby").await;
        host.ready.store(true, Ordering::Release);
        let ids = host.search("bo", viewer, 0, 20).await.expect("search");
        assert!(!ids.contains(&blocked));
        assert!(ids.contains(&other));
    }

    #[tokio::test]
    async fn remove_person_drops_from_ready_index() {
        let viewer = Uuid::now_v7();
        let other = Uuid::now_v7();
        let host = host(Vec::new());
        upsert(&host, other, "Carol", "carol").await;
        host.ready.store(true, Ordering::Release);
        assert!(
            host.search("carol", viewer, 0, 20)
                .await
                .expect("search")
                .contains(&other)
        );
        host.remove_person(other).await.expect("remove");
        assert!(
            !host
                .search("carol", viewer, 0, 20)
                .await
                .expect("search")
                .contains(&other)
        );
    }

    #[tokio::test]
    async fn install_rebuilt_replays_pending_upsert() {
        let viewer = Uuid::now_v7();
        let other = Uuid::now_v7();
        let host = host(Vec::new());
        upsert(&host, other, "Daisy", "daisy").await;
        host.install_rebuilt(PeopleSearch::new()).await;
        let ids = host.search("daisy", viewer, 0, 20).await.expect("search");
        assert!(ids.contains(&other));
    }
}
