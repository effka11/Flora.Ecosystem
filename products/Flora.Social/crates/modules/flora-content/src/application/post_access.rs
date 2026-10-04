//! Доступ к посту — паритет `ResolvePostAccessAsync`.

use std::sync::Arc;

use flora_users_contracts::{AccountSanctionStatus, BoxFuture, ProfileAccess, ProfileAccessField};
use uuid::Uuid;

use crate::infrastructure::repo::ContentRepo;

#[derive(Clone, Copy)]
struct PostAccessTarget {
    author_uuid: Uuid,
    community_id: Option<Uuid>,
}

trait PostAccessRepository: Send + Sync {
    fn post_author_and_community(
        &self,
        post_uuid: Uuid,
    ) -> BoxFuture<'_, Result<Option<PostAccessTarget>, String>>;

    fn is_community_private(&self, community_id: Uuid) -> BoxFuture<'_, Result<bool, String>>;

    fn is_community_member(
        &self,
        community_id: Uuid,
        user_uuid: Uuid,
    ) -> BoxFuture<'_, Result<bool, String>>;
}

impl PostAccessRepository for ContentRepo {
    fn post_author_and_community(
        &self,
        post_uuid: Uuid,
    ) -> BoxFuture<'_, Result<Option<PostAccessTarget>, String>> {
        Box::pin(async move {
            ContentRepo::post_author_and_community(self, post_uuid)
                .await
                .map(|target| {
                    target.map(|(author_uuid, community_id)| PostAccessTarget {
                        author_uuid,
                        community_id,
                    })
                })
                .map_err(|e| e.to_string())
        })
    }

    fn is_community_private(&self, community_id: Uuid) -> BoxFuture<'_, Result<bool, String>> {
        Box::pin(async move {
            ContentRepo::is_community_private(self, community_id)
                .await
                .map_err(|e| e.to_string())
        })
    }

    fn is_community_member(
        &self,
        community_id: Uuid,
        user_uuid: Uuid,
    ) -> BoxFuture<'_, Result<bool, String>> {
        Box::pin(async move {
            ContentRepo::is_community_member(self, community_id, user_uuid)
                .await
                .map_err(|e| e.to_string())
        })
    }
}

pub struct PostAccessService {
    repo: Arc<dyn PostAccessRepository>,
    profile_access: Arc<dyn ProfileAccess>,
    account_sanction_status: Arc<dyn AccountSanctionStatus>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PostReadAccess {
    Denied,
    Public,
    PrivateMember,
}

impl PostAccessService {
    pub fn new(
        repo: Arc<ContentRepo>,
        profile_access: Arc<dyn ProfileAccess>,
        account_sanction_status: Arc<dyn AccountSanctionStatus>,
    ) -> Self {
        let repo: Arc<dyn PostAccessRepository> = repo;
        Self {
            repo,
            profile_access,
            account_sanction_status,
        }
    }

    #[cfg(test)]
    fn with_repository(
        repo: Arc<dyn PostAccessRepository>,
        profile_access: Arc<dyn ProfileAccess>,
        account_sanction_status: Arc<dyn AccountSanctionStatus>,
    ) -> Self {
        Self {
            repo,
            profile_access,
            account_sanction_status,
        }
    }

    /// `viewer` — опциональный JWT sub (для приватных сообществ).
    pub async fn can_view(&self, post_uuid: Uuid, viewer: Option<Uuid>) -> Result<bool, String> {
        Ok(self.resolve(post_uuid, viewer).await? != PostReadAccess::Denied)
    }

    /// Возвращает не только разрешение, но и возможность безопасно кэшировать
    /// ответ в общем CDN. Медиа приватного сообщества нельзя помечать `public`.
    pub async fn resolve(
        &self,
        post_uuid: Uuid,
        viewer: Option<Uuid>,
    ) -> Result<PostReadAccess, String> {
        let Some(target) = self.repo.post_author_and_community(post_uuid).await? else {
            return Ok(PostReadAccess::Denied);
        };

        if self
            .account_sanction_status
            .is_blocked(target.author_uuid)
            .await?
        {
            return Ok(PostReadAccess::Denied);
        }

        if target.community_id.is_none() {
            let allowed = self
                .profile_access
                .can_access(viewer, target.author_uuid, ProfileAccessField::Posts)
                .await?;
            // ProfileAccess intentionally exposes only "can access", not the
            // underlying policy. Conservatively forbid shared caching even
            // when the current policy happens to be public.
            return Ok(if allowed {
                PostReadAccess::PrivateMember
            } else {
                PostReadAccess::Denied
            });
        }

        let cid = target.community_id.unwrap();

        let is_private = self.repo.is_community_private(cid).await?;

        if !is_private {
            return Ok(PostReadAccess::Public);
        }

        let Some(viewer) = viewer else {
            return Ok(PostReadAccess::Denied);
        };

        let is_member = self.repo.is_community_member(cid, viewer).await?;
        Ok(if is_member {
            PostReadAccess::PrivateMember
        } else {
            PostReadAccess::Denied
        })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    struct StubRepo {
        target: Option<PostAccessTarget>,
        community_private: bool,
        community_member: bool,
    }

    impl PostAccessRepository for StubRepo {
        fn post_author_and_community(
            &self,
            _post_uuid: Uuid,
        ) -> BoxFuture<'_, Result<Option<PostAccessTarget>, String>> {
            Box::pin(async move { Ok(self.target) })
        }

        fn is_community_private(&self, _community_id: Uuid) -> BoxFuture<'_, Result<bool, String>> {
            Box::pin(async move { Ok(self.community_private) })
        }

        fn is_community_member(
            &self,
            _community_id: Uuid,
            _user_uuid: Uuid,
        ) -> BoxFuture<'_, Result<bool, String>> {
            Box::pin(async move { Ok(self.community_member) })
        }
    }

    struct AllowProfiles;

    impl ProfileAccess for AllowProfiles {
        fn can_access(
            &self,
            _viewer_user_uuid: Option<Uuid>,
            _owner_user_uuid: Uuid,
            _field: ProfileAccessField,
        ) -> BoxFuture<'_, Result<bool, String>> {
            Box::pin(async { Ok(true) })
        }

        fn accessible_owners(
            &self,
            _viewer_user_uuid: Option<Uuid>,
            owner_user_uuids: &[Uuid],
            _field: ProfileAccessField,
        ) -> BoxFuture<'_, Result<Vec<Uuid>, String>> {
            let owners = owner_user_uuids.to_vec();
            Box::pin(async move { Ok(owners) })
        }
    }

    struct StubStatus {
        blocked: HashSet<Uuid>,
    }

    impl AccountSanctionStatus for StubStatus {
        fn is_blocked(&self, user_uuid: Uuid) -> BoxFuture<'_, Result<bool, String>> {
            Box::pin(async move { Ok(self.blocked.contains(&user_uuid)) })
        }

        fn blocked_among(&self, user_uuids: &[Uuid]) -> BoxFuture<'_, Result<Vec<Uuid>, String>> {
            let blocked = user_uuids
                .iter()
                .copied()
                .filter(|id| self.blocked.contains(id))
                .collect();
            Box::pin(async move { Ok(blocked) })
        }
    }

    fn service(author: Uuid, blocked: bool) -> PostAccessService {
        let community = Uuid::from_u128(20);
        PostAccessService::with_repository(
            Arc::new(StubRepo {
                target: Some(PostAccessTarget {
                    author_uuid: author,
                    community_id: Some(community),
                }),
                community_private: false,
                community_member: false,
            }),
            Arc::new(AllowProfiles),
            Arc::new(StubStatus {
                blocked: if blocked {
                    HashSet::from([author])
                } else {
                    HashSet::new()
                },
            }),
        )
    }

    #[tokio::test]
    async fn blocked_post_author_denies_like_comment_and_media_access() {
        let post = Uuid::from_u128(1);
        let viewer = Uuid::from_u128(2);
        let access = service(Uuid::from_u128(3), true);

        assert!(!access.can_view(post, Some(viewer)).await.unwrap());
        assert!(!access.can_view(post, Some(viewer)).await.unwrap());
        assert_eq!(
            access.resolve(post, Some(viewer)).await.unwrap(),
            PostReadAccess::Denied
        );
    }

    #[tokio::test]
    async fn unblocked_public_community_post_remains_public() {
        let access = service(Uuid::from_u128(3), false);

        assert_eq!(
            access.resolve(Uuid::from_u128(1), None).await.unwrap(),
            PostReadAccess::Public
        );
    }
}
