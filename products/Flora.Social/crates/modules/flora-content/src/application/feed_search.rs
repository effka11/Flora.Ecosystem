//! In-memory FSA-F host for feed search. Visibility and blocklist stay in Content.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use chrono::{DateTime, Utc};
use flora_auth_contracts::AccountDirectory;
use flora_users_contracts::{BidirectionalBlocklist, FeedAuthorProfiles};
use fsa_core::feed::{FeedPost, FeedQuery, FeedSearch};
use serde_json::Value;
use uuid::Uuid;

use crate::application::serialize::FeedSerializer;
use crate::infrastructure::repo::ContentRepo;

const TOMBSTONE_COMPACT_RATIO: f64 = 0.2;

#[derive(Clone)]
enum FeedOp {
    Upsert(FeedPost),
    Remove(String),
}

pub(crate) fn should_index_feed_post(community_is_private: Option<bool>) -> bool {
    !matches!(community_is_private, Some(true))
}

pub(crate) fn extract_hashtags(content: &str) -> Vec<String> {
    let mut tags = Vec::new();
    let mut seen = HashSet::new();
    for token in content.split_whitespace() {
        let token = token.trim_matches(|c: char| c != '#' && !c.is_alphanumeric() && c != '_');
        let Some(tag) = token.strip_prefix('#') else {
            continue;
        };
        if tag.is_empty() || !tag.chars().all(|c| c.is_alphanumeric() || c == '_') {
            continue;
        }
        if seen.insert(tag.to_string()) {
            tags.push(tag.to_string());
        }
    }
    tags
}

pub(crate) fn drop_blocked_authors(items: Vec<Value>, blocked: &HashSet<Uuid>) -> Vec<Value> {
    items
        .into_iter()
        .filter(|item| match author_uuid_from_item(item) {
            Some(author) => !blocked.contains(&author),
            None => true,
        })
        .collect()
}

fn author_uuid_from_item(item: &Value) -> Option<Uuid> {
    item.get("authorUserUuid")
        .and_then(|value| serde_json::from_value(value.clone()).ok())
}

fn maybe_compact(engine: &mut FeedSearch) {
    let len = engine.len().max(1) as f64;
    if engine.engine().tombstones() as f64 / len > TOMBSTONE_COMPACT_RATIO {
        engine.compact();
    }
}

fn apply_one(engine: &mut FeedSearch, op: &FeedOp) {
    match op {
        FeedOp::Upsert(post) => {
            if let Err(error) = engine.upsert(post.clone()) {
                tracing::warn!(error = %error, "FSA-F upsert failed");
            }
        }
        FeedOp::Remove(id) => {
            engine.remove(id);
        }
    }
}

pub(crate) struct FeedSearchIndex {
    engine: RwLock<FeedSearch>,
    ready: AtomicBool,
    pending: Mutex<Option<Vec<FeedOp>>>,
}

impl FeedSearchIndex {
    pub(crate) fn new() -> Self {
        Self {
            engine: RwLock::new(FeedSearch::new()),
            ready: AtomicBool::new(false),
            pending: Mutex::new(Some(Vec::new())),
        }
    }

    pub(crate) fn is_ready(&self) -> bool {
        self.ready.load(Ordering::Acquire)
    }

    fn apply(&self, op: FeedOp) {
        let mut pending = self.pending.lock().expect("feed search pending");
        let mut engine = self.engine.write().expect("feed search engine");
        apply_one(&mut engine, &op);
        maybe_compact(&mut engine);
        if let Some(ops) = pending.as_mut() {
            ops.push(op);
        }
    }

    pub(crate) fn upsert(&self, post: FeedPost) {
        self.apply(FeedOp::Upsert(post));
    }

    pub(crate) fn remove(&self, id: &str) {
        self.apply(FeedOp::Remove(id.to_string()));
    }

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
        let engine = self.engine.read().expect("feed search engine");
        let mut feed_query = FeedQuery::new(query, now);
        feed_query.limit = take;
        feed_query.offset = skip;
        engine
            .search(&feed_query, None)
            .hits
            .into_iter()
            .map(|hit| hit.id)
            .collect()
    }

    fn install_rebuilt(&self, mut built: FeedSearch) {
        let mut pending = self.pending.lock().expect("feed search pending");
        if let Some(ops) = pending.as_ref() {
            for op in ops {
                apply_one(&mut built, op);
            }
        }
        maybe_compact(&mut built);
        let mut engine = self.engine.write().expect("feed search engine");
        *engine = built;
        *pending = None;
        self.ready.store(true, Ordering::Release);
    }

    #[cfg(test)]
    fn mark_ready(&self) {
        self.ready.store(true, Ordering::Release);
    }
}

pub struct FeedSearchHost {
    index: FeedSearchIndex,
    repo: Arc<ContentRepo>,
    accounts: Arc<dyn AccountDirectory>,
    profiles: Arc<dyn FeedAuthorProfiles>,
    blocklist: Arc<dyn BidirectionalBlocklist>,
    serialize: Arc<FeedSerializer>,
}

impl FeedSearchHost {
    pub fn new(
        repo: Arc<ContentRepo>,
        accounts: Arc<dyn AccountDirectory>,
        profiles: Arc<dyn FeedAuthorProfiles>,
        blocklist: Arc<dyn BidirectionalBlocklist>,
        serialize: Arc<FeedSerializer>,
    ) -> Self {
        Self {
            index: FeedSearchIndex::new(),
            repo,
            accounts,
            profiles,
            blocklist,
            serialize,
        }
    }

    pub fn spawn_rebuild(self: &Arc<Self>) {
        let host = Arc::clone(self);
        drop(tokio::spawn(async move {
            if let Err(error) = host.rebuild().await {
                tracing::error!(error = %error, "FSA-F feed search rebuild failed");
            }
        }));
    }

    pub async fn search(
        &self,
        viewer: Uuid,
        query: &str,
        skip: i32,
        take: i32,
    ) -> Result<Vec<Value>, String> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let take = take.clamp(1, 50) as usize;
        let skip = skip.max(0) as usize;
        let ids = self
            .index
            .search_ids(query, skip, take, Utc::now().timestamp());
        let post_uuids: Vec<Uuid> = ids
            .iter()
            .filter_map(|id| Uuid::parse_str(id).ok())
            .collect();
        if post_uuids.is_empty() {
            return Ok(Vec::new());
        }
        let items = self
            .serialize
            .serialize_feed_post_dtos(viewer, &post_uuids)
            .await?;
        let blocked: HashSet<Uuid> = self
            .blocklist
            .blocked_user_ids_bidirectional(viewer)
            .await?
            .into_iter()
            .collect();
        Ok(drop_blocked_authors(items, &blocked))
    }

    pub async fn on_post_created(
        &self,
        post_uuid: Uuid,
        author: Uuid,
        content: &str,
        community_id: Option<Uuid>,
        created_at: DateTime<Utc>,
    ) {
        match self
            .feed_post_for(post_uuid, author, content, community_id, created_at)
            .await
        {
            Ok(Some(post)) => self.index.upsert(post),
            Ok(None) => {}
            Err(error) => tracing::warn!(error = %error, %post_uuid, "FSA-F index create skipped"),
        }
    }

    pub fn on_post_deleted(&self, post_uuid: Uuid) {
        self.index.remove(&post_uuid.to_string());
    }

    pub fn remove_posts(&self, post_uuids: &[Uuid]) {
        for post_uuid in post_uuids {
            self.index.remove(&post_uuid.to_string());
        }
    }

    pub async fn reindex_community_posts(
        &self,
        community_id: Uuid,
        is_private: bool,
        community_name: &str,
    ) {
        let posts = match self.repo.posts_in_community(community_id).await {
            Ok(posts) => posts,
            Err(error) => {
                tracing::warn!(error = %error, %community_id, "FSA-F community reindex load failed");
                return;
            }
        };
        if is_private {
            for post in posts {
                self.index.remove(&post.post_uuid.to_string());
            }
            return;
        }
        let author_ids: Vec<Uuid> = posts
            .iter()
            .map(|post| post.author_user_uuid)
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let names = match self.author_names(&author_ids).await {
            Ok(names) => names,
            Err(error) => {
                tracing::warn!(error = %error, %community_id, "FSA-F community reindex names failed");
                return;
            }
        };
        for post in posts {
            let author_name = names
                .get(&post.author_user_uuid)
                .cloned()
                .unwrap_or_default();
            self.index.upsert(feed_post(
                post.post_uuid,
                &post.content,
                post.author_user_uuid,
                &author_name,
                Some(community_id),
                Some(community_name),
                post.created_at,
            ));
        }
    }

    async fn rebuild(&self) -> Result<(), String> {
        let rows = self
            .repo
            .list_indexable_feed_posts()
            .await
            .map_err(|e| e.to_string())?;
        let author_ids: Vec<Uuid> = rows
            .iter()
            .map(|row| row.author_user_uuid)
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let names = self.author_names(&author_ids).await?;
        let mut built = FeedSearch::new();
        for row in rows {
            let author_name = names
                .get(&row.author_user_uuid)
                .cloned()
                .unwrap_or_default();
            let post = feed_post(
                row.post_uuid,
                &row.content,
                row.author_user_uuid,
                &author_name,
                row.community_id,
                row.community_name.as_deref(),
                row.created_at,
            );
            if let Err(error) = built.upsert(post) {
                tracing::warn!(error = %error, "FSA-F rebuild upsert failed");
            }
        }
        self.index.install_rebuilt(built);
        Ok(())
    }

    async fn feed_post_for(
        &self,
        post_uuid: Uuid,
        author: Uuid,
        content: &str,
        community_id: Option<Uuid>,
        created_at: DateTime<Utc>,
    ) -> Result<Option<FeedPost>, String> {
        let (community_id, community_name, community_private) =
            if let Some(community_id) = community_id {
                let Some(community) = self
                    .repo
                    .community_by_id(community_id)
                    .await
                    .map_err(|e| e.to_string())?
                else {
                    return Ok(None);
                };
                (
                    Some(community.community_id),
                    Some(community.name),
                    Some(community.is_private),
                )
            } else {
                (None, None, None)
            };
        if !should_index_feed_post(community_private) {
            return Ok(None);
        }
        let names = self.author_names(&[author]).await?;
        let author_name = names.get(&author).cloned().unwrap_or_default();
        Ok(Some(feed_post(
            post_uuid,
            content,
            author,
            &author_name,
            community_id,
            community_name.as_deref(),
            created_at,
        )))
    }

    async fn author_names(&self, user_uuids: &[Uuid]) -> Result<HashMap<Uuid, String>, String> {
        if user_uuids.is_empty() {
            return Ok(HashMap::new());
        }
        let usernames: HashMap<Uuid, String> = self
            .accounts
            .usernames_by_uuids(user_uuids)
            .await?
            .into_iter()
            .collect();
        let profiles = self
            .profiles
            .by_uuids(user_uuids)
            .await?
            .into_iter()
            .map(|profile| (profile.user_uuid, profile.display_name))
            .collect::<HashMap<_, _>>();
        Ok(user_uuids
            .iter()
            .copied()
            .map(|id| {
                let username = usernames.get(&id).cloned().unwrap_or_default();
                let name = profiles
                    .get(&id)
                    .map(|display| display.trim())
                    .filter(|display| !display.is_empty())
                    .map(|display| display.to_string())
                    .unwrap_or(username);
                (id, name)
            })
            .collect())
    }
}

fn feed_post(
    post_uuid: Uuid,
    content: &str,
    author_id: Uuid,
    author_name: &str,
    community_id: Option<Uuid>,
    community_name: Option<&str>,
    created_at: DateTime<Utc>,
) -> FeedPost {
    FeedPost {
        id: post_uuid.to_string(),
        text: content.to_string(),
        tags: extract_hashtags(content),
        author_id: author_id.to_string(),
        author_name: author_name.to_string(),
        community_id: community_id.map(|id| id.to_string()),
        community_name: community_name.map(ToString::to_string),
        lang: None,
        is_repost: false,
        created_at: created_at.timestamp(),
        engagement_rank: 0.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flora_users_contracts::BoxFuture;
    use serde_json::json;

    fn sample_post(id: &str, text: &str, author: &str, community_id: Option<&str>) -> FeedPost {
        FeedPost {
            id: id.into(),
            text: text.into(),
            tags: extract_hashtags(text),
            author_id: author.into(),
            author_name: format!("Author {author}"),
            community_id: community_id.map(str::to_string),
            community_name: community_id.map(|id| format!("Community {id}")),
            lang: None,
            is_repost: false,
            created_at: 1_700_000_000,
            engagement_rank: 0.0,
        }
    }

    struct FakeBlocklist {
        blocked: HashSet<Uuid>,
    }

    impl BidirectionalBlocklist for FakeBlocklist {
        fn blocked_user_ids_bidirectional(
            &self,
            _user_uuid: Uuid,
        ) -> BoxFuture<'_, Result<Vec<Uuid>, String>> {
            let ids: Vec<Uuid> = self.blocked.iter().copied().collect();
            Box::pin(async move { Ok(ids) })
        }
    }

    #[test]
    fn feed_search_empty_before_ready() {
        let index = FeedSearchIndex::new();
        index.upsert(sample_post(
            "p-public",
            "visible rust post",
            "author-1",
            None,
        ));
        assert!(
            index.search_ids("rust", 0, 20, 1_700_000_100).is_empty(),
            "search must be empty until the feed index is ready"
        );
    }

    #[test]
    fn private_community_post_is_not_found() {
        let index = FeedSearchIndex::new();
        if should_index_feed_post(None) {
            index.upsert(sample_post(
                "p-public",
                "visible rust post",
                "author-1",
                None,
            ));
        }
        if should_index_feed_post(Some(true)) {
            index.upsert(sample_post(
                "p-private",
                "visible rust post",
                "author-2",
                Some("comm-private"),
            ));
        }
        index.mark_ready();
        let ids = index.search_ids("rust", 0, 20, 1_700_000_100);
        assert_eq!(ids, vec!["p-public".to_string()]);
        assert!(
            !ids.iter().any(|id| id == "p-private"),
            "posts of a private community must not be indexed"
        );
    }

    #[tokio::test]
    async fn blocked_author_not_in_feed_search() {
        let viewer = Uuid::from_u128(1);
        let blocked_author = Uuid::from_u128(2);
        let other_author = Uuid::from_u128(3);
        let index = FeedSearchIndex::new();
        index.upsert(sample_post(
            "p-blocked",
            "shared rust topic",
            &blocked_author.to_string(),
            None,
        ));
        index.upsert(sample_post(
            "p-ok",
            "shared rust topic",
            &other_author.to_string(),
            None,
        ));
        index.mark_ready();
        let ids = index.search_ids("rust", 0, 20, 1_700_000_100);
        assert!(ids.contains(&"p-blocked".to_string()));
        assert!(ids.contains(&"p-ok".to_string()));

        let blocklist = FakeBlocklist {
            blocked: HashSet::from([blocked_author]),
        };
        let blocked: HashSet<Uuid> = blocklist
            .blocked_user_ids_bidirectional(viewer)
            .await
            .expect("blocklist")
            .into_iter()
            .collect();
        let items = vec![
            json!({
                "postUuid": "p-blocked",
                "authorUserUuid": blocked_author,
            }),
            json!({
                "postUuid": "p-ok",
                "authorUserUuid": other_author,
            }),
        ];
        let kept = drop_blocked_authors(items, &blocked);
        let kept_ids: Vec<&str> = kept
            .iter()
            .filter_map(|item| item.get("postUuid").and_then(Value::as_str))
            .collect();
        assert_eq!(kept_ids, vec!["p-ok"]);
    }
}
