//! In-memory FSA-C host for community search. HTTP visibility stays in Content.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use chrono::Utc;
use fsa_core::communities::{CommunitiesQuery, CommunitiesSearch, CommunityDoc};
use uuid::Uuid;

use crate::infrastructure::repo::{CommunityRow, ContentRepo};

const TOMBSTONE_COMPACT_RATIO: f64 = 0.2;

#[derive(Clone)]
enum CommunityOp {
    Upsert(CommunityDoc),
    Remove(String),
}

pub(crate) fn community_visible_in_search(is_private: bool, viewer_is_owner: bool) -> bool {
    !is_private || viewer_is_owner
}

fn maybe_compact(engine: &mut CommunitiesSearch) {
    let len = engine.len().max(1) as f64;
    if engine.engine().tombstones() as f64 / len > TOMBSTONE_COMPACT_RATIO {
        engine.compact();
    }
}

fn apply_one(engine: &mut CommunitiesSearch, op: &CommunityOp) {
    match op {
        CommunityOp::Upsert(community) => {
            if let Err(error) = engine.upsert(community.clone()) {
                tracing::warn!(error = %error, "FSA-C upsert failed");
            }
        }
        CommunityOp::Remove(id) => {
            engine.remove(id);
        }
    }
}

pub(crate) fn community_doc_from_row(row: &CommunityRow, member_count: i32) -> CommunityDoc {
    CommunityDoc {
        id: row.community_id.to_string(),
        name: row.name.clone(),
        description: Some(row.slug.clone()),
        tags: Vec::new(),
        topic_id: None,
        lang: None,
        is_private: row.is_private,
        last_activity_at: row.created_at.timestamp(),
        size_rank: size_rank(member_count),
    }
}

fn size_rank(member_count: i32) -> f64 {
    let n = f64::from(member_count.max(0));
    n / (n + 10.0)
}

const SEARCH_BATCH: usize = 50;

/// Filter public-or-Owner, then skip/take — same order as the former SQL.
#[cfg(test)]
pub(crate) fn page_after_visibility_filter(
    ranked_ids: &[String],
    is_visible: impl Fn(&str) -> bool,
    skip: usize,
    take: usize,
) -> Vec<String> {
    ranked_ids
        .iter()
        .filter(|id| is_visible(id.as_str()))
        .skip(skip)
        .take(take)
        .cloned()
        .collect()
}

pub(crate) struct CommunitiesSearchIndex {
    engine: RwLock<CommunitiesSearch>,
    ready: AtomicBool,
    pending: Mutex<Option<Vec<CommunityOp>>>,
}

impl CommunitiesSearchIndex {
    pub(crate) fn new() -> Self {
        Self {
            engine: RwLock::new(CommunitiesSearch::new()),
            ready: AtomicBool::new(false),
            pending: Mutex::new(Some(Vec::new())),
        }
    }

    pub(crate) fn is_ready(&self) -> bool {
        self.ready.load(Ordering::Acquire)
    }

    fn apply(&self, op: CommunityOp) {
        let mut pending = self.pending.lock().expect("communities search pending");
        let mut engine = self.engine.write().expect("communities search engine");
        apply_one(&mut engine, &op);
        maybe_compact(&mut engine);
        if let Some(ops) = pending.as_mut() {
            ops.push(op);
        }
    }

    pub(crate) fn upsert(&self, community: CommunityDoc) {
        self.apply(CommunityOp::Upsert(community));
    }

    pub(crate) fn remove(&self, id: &str) {
        self.apply(CommunityOp::Remove(id.to_string()));
    }

    /// Ranked FSA walk (`offset`/`limit` of the engine). Visibility and HTTP
    /// skip/take are applied in `CommunitiesSearchHost::search` after this.
    pub(crate) fn search_ids(
        &self,
        query: &str,
        skip: usize,
        take: usize,
        now: i64,
    ) -> Vec<String> {
        if !self.is_ready() {
            return Vec::new();
        }
        let query = query.trim();
        if query.is_empty() {
            return Vec::new();
        }
        let engine = self.engine.read().expect("communities search engine");
        let mut communities_query = CommunitiesQuery::new(query, now);
        communities_query.limit = take;
        communities_query.offset = skip;
        engine
            .search(&communities_query, None)
            .hits
            .into_iter()
            .map(|hit| hit.id)
            .collect()
    }

    fn install_rebuilt(&self, mut built: CommunitiesSearch) {
        let mut pending = self.pending.lock().expect("communities search pending");
        if let Some(ops) = pending.as_ref() {
            for op in ops {
                apply_one(&mut built, op);
            }
        }
        maybe_compact(&mut built);
        let mut engine = self.engine.write().expect("communities search engine");
        *engine = built;
        *pending = None;
        self.ready.store(true, Ordering::Release);
    }

    #[cfg(test)]
    fn mark_ready(&self) {
        self.ready.store(true, Ordering::Release);
    }
}

pub struct CommunitiesSearchHost {
    index: CommunitiesSearchIndex,
    repo: Arc<ContentRepo>,
}

impl CommunitiesSearchHost {
    pub fn new(repo: Arc<ContentRepo>) -> Self {
        Self {
            index: CommunitiesSearchIndex::new(),
            repo,
        }
    }

    pub fn spawn_rebuild(self: &Arc<Self>) {
        let host = Arc::clone(self);
        drop(tokio::spawn(async move {
            if let Err(error) = host.rebuild().await {
                tracing::error!(error = %error, "FSA-C communities search rebuild failed");
            }
        }));
    }

    pub async fn search(
        &self,
        viewer: Uuid,
        query: &str,
        skip: i32,
        take: i32,
    ) -> Result<Vec<CommunityRow>, String> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let take = take.clamp(1, 50) as usize;
        let skip = skip.max(0) as usize;
        let need = skip + take;
        let now = Utc::now().timestamp();
        let mut visible: Vec<CommunityRow> = Vec::new();
        let mut fsa_offset = 0;
        loop {
            let ids = self.index.search_ids(query, fsa_offset, SEARCH_BATCH, now);
            if ids.is_empty() {
                break;
            }
            fsa_offset += ids.len();
            let community_ids: Vec<Uuid> = ids
                .iter()
                .filter_map(|id| Uuid::parse_str(id).ok())
                .collect();
            if community_ids.is_empty() {
                if ids.len() < SEARCH_BATCH {
                    break;
                }
                continue;
            }
            let rows = self
                .repo
                .community_rows_by_ids(&community_ids)
                .await
                .map_err(|e| e.to_string())?;
            let mut by_id: HashMap<Uuid, CommunityRow> = rows
                .into_iter()
                .map(|row| (row.community_id, row))
                .collect();
            let ordered: Vec<CommunityRow> = community_ids
                .iter()
                .filter_map(|id| by_id.remove(id))
                .collect();
            let roles = self
                .repo
                .user_roles_in_communities(viewer, &community_ids)
                .await
                .map_err(|e| e.to_string())?;
            visible.extend(ordered.into_iter().filter(|row| {
                community_visible_in_search(
                    row.is_private,
                    roles.get(&row.community_id).map(String::as_str) == Some("Owner"),
                )
            }));
            if visible.len() >= need || ids.len() < SEARCH_BATCH {
                break;
            }
        }
        Ok(visible.into_iter().skip(skip).take(take).collect())
    }

    pub fn on_community_upsert(&self, row: &CommunityRow, member_count: i32) {
        self.index.upsert(community_doc_from_row(row, member_count));
    }

    pub fn on_community_deleted(&self, community_id: Uuid) {
        self.index.remove(&community_id.to_string());
    }

    async fn rebuild(&self) -> Result<(), String> {
        let rows = self
            .repo
            .list_all_communities()
            .await
            .map_err(|e| e.to_string())?;
        let ids: Vec<Uuid> = rows.iter().map(|row| row.community_id).collect();
        let counts = self
            .repo
            .member_counts(&ids)
            .await
            .map_err(|e| e.to_string())?;
        let mut built = CommunitiesSearch::new();
        for row in rows {
            let member_count = counts.get(&row.community_id).copied().unwrap_or(0);
            if let Err(error) = built.upsert(community_doc_from_row(&row, member_count)) {
                tracing::warn!(error = %error, "FSA-C rebuild upsert failed");
            }
        }
        self.index.install_rebuilt(built);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    fn sample_doc(id: &str, name: &str, is_private: bool) -> CommunityDoc {
        CommunityDoc {
            id: id.into(),
            name: name.into(),
            description: Some(format!("{id}-slug")),
            tags: Vec::new(),
            topic_id: None,
            lang: None,
            is_private,
            last_activity_at: 1_700_000_000,
            size_rank: 0.0,
        }
    }

    fn filter_hits(
        ids: &[String],
        privacy: &HashMap<String, bool>,
        owner_of: &HashSet<String>,
    ) -> Vec<String> {
        ids.iter()
            .filter(|id| {
                let is_private = privacy.get(*id).copied().unwrap_or(false);
                community_visible_in_search(is_private, owner_of.contains(*id))
            })
            .cloned()
            .collect()
    }

    #[test]
    fn communities_search_empty_before_ready() {
        let index = CommunitiesSearchIndex::new();
        index.upsert(sample_doc("pub", "Открытый клуб", false));
        assert!(index.search_ids("клуб", 0, 20, 1_700_000_100).is_empty());
    }

    #[test]
    fn private_community_not_found_for_non_owner() {
        let index = CommunitiesSearchIndex::new();
        index.upsert(sample_doc("pub", "Клуб гитаристов", false));
        index.upsert(sample_doc("priv", "Клуб гитаристов", true));
        index.mark_ready();
        let ids = index.search_ids("клуб", 0, 20, 1_700_000_100);
        assert!(ids.contains(&"pub".to_string()));
        assert!(
            ids.contains(&"priv".to_string()),
            "FSA-C may hold private cards; HTTP filter hides them"
        );

        let privacy = HashMap::from([("pub".into(), false), ("priv".into(), true)]);
        let visible = filter_hits(&ids, &privacy, &HashSet::new());
        assert_eq!(visible, vec!["pub".to_string()]);
        assert!(
            !visible.iter().any(|id| id == "priv"),
            "private community must not be returned to a non-Owner"
        );
        assert_eq!(
            page_after_visibility_filter(&["priv".into(), "pub".into()], |id| id != "priv", 0, 1,),
            vec!["pub".to_string()],
            "non-Owner take=1 must skip a leading private card and return the next public hit"
        );
    }

    #[test]
    fn private_community_visible_to_owner() {
        let index = CommunitiesSearchIndex::new();
        index.upsert(sample_doc("priv", "Тайный клуб", true));
        index.mark_ready();
        let ids = index.search_ids("клуб", 0, 20, 1_700_000_100);
        let privacy = HashMap::from([("priv".into(), true)]);
        let owner_of = HashSet::from(["priv".to_string()]);
        let visible = filter_hits(&ids, &privacy, &owner_of);
        assert_eq!(visible, vec!["priv".to_string()]);
    }
}
