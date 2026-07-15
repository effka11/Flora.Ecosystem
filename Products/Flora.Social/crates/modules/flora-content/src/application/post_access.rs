//! Доступ к посту — паритет `ResolvePostAccessAsync`.

use std::sync::Arc;

use uuid::Uuid;

use crate::infrastructure::repo::ContentRepo;

pub struct PostAccessService {

    repo: Arc<ContentRepo>,

}

impl PostAccessService {

    pub fn new(repo: Arc<ContentRepo>) -> Self {

        Self { repo }

    }

    /// `viewer` — опциональный JWT sub (для приватных сообществ).

    pub async fn can_view(&self, post_uuid: Uuid, viewer: Option<Uuid>) -> Result<bool, String> {

        let Some(community_id) = self

            .repo

            .post_community_id(post_uuid)

            .await

            .map_err(|e| e.to_string())?

        else {

            return Ok(false);

        };

        if community_id.is_none() {

            return Ok(true);

        }

        let cid = community_id.unwrap();

        let is_private = self

            .repo

            .is_community_private(cid)

            .await

            .map_err(|e| e.to_string())?;

        if !is_private {

            return Ok(true);

        }

        let Some(viewer) = viewer else {

            return Ok(false);

        };

        self.repo

            .is_community_member(cid, viewer)

            .await

            .map_err(|e| e.to_string())

    }

}

