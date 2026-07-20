//! Доступ к посту — паритет `ResolvePostAccessAsync`.

use std::sync::Arc;

use flora_users_contracts::{ProfileAccess, ProfileAccessField};
use uuid::Uuid;

use crate::infrastructure::repo::ContentRepo;

pub struct PostAccessService {
    repo: Arc<ContentRepo>,
    profile_access: Arc<dyn ProfileAccess>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PostReadAccess {
    Denied,
    Public,
    PrivateMember,
}

impl PostAccessService {
    pub fn new(repo: Arc<ContentRepo>, profile_access: Arc<dyn ProfileAccess>) -> Self {
        Self {
            repo,
            profile_access,
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
        let Some(community_id) = self
            .repo
            .post_community_id(post_uuid)
            .await
            .map_err(|e| e.to_string())?
        else {
            return Ok(PostReadAccess::Denied);
        };

        if community_id.is_none() {
            let Some(author_uuid) = self
                .repo
                .post_author_uuid(post_uuid)
                .await
                .map_err(|e| e.to_string())?
            else {
                return Ok(PostReadAccess::Denied);
            };
            let allowed = self
                .profile_access
                .can_access(viewer, author_uuid, ProfileAccessField::Posts)
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

        let cid = community_id.unwrap();

        let is_private = self
            .repo
            .is_community_private(cid)
            .await
            .map_err(|e| e.to_string())?;

        if !is_private {
            return Ok(PostReadAccess::Public);
        }

        let Some(viewer) = viewer else {
            return Ok(PostReadAccess::Denied);
        };

        let is_member = self
            .repo
            .is_community_member(cid, viewer)
            .await
            .map_err(|e| e.to_string())?;
        Ok(if is_member {
            PostReadAccess::PrivateMember
        } else {
            PostReadAccess::Denied
        })
    }
}
