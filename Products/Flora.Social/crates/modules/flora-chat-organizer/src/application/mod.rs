//! Application: get/put opaque FSCP-ORG blob with optimistic concurrency.

use std::sync::Arc;

use chrono::Utc;
use flora_chat_organizer_contracts::ChatOrganizerBlobDto;
use uuid::Uuid;

use crate::infrastructure::OrganizerRepo;

#[derive(Debug)]
pub enum PutOrganizerError {
    BadRequest(String),
    Conflict(String),
    Internal(String),
}

#[derive(Clone)]
pub struct OrganizerService {
    repo: Arc<OrganizerRepo>,
}

impl OrganizerService {
    pub fn new(repo: Arc<OrganizerRepo>) -> Self {
        Self { repo }
    }

    pub async fn get(&self, owner: Uuid) -> Result<Option<ChatOrganizerBlobDto>, String> {
        let Some(stored) = self.repo.get(owner).await.map_err(|e| e.to_string())? else {
            return Ok(None);
        };
        Ok(Some(ChatOrganizerBlobDto {
            revision: stored.revision,
            wire: stored.wire,
            updated_at: stored.updated_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        }))
    }

    pub async fn put(&self, owner: Uuid, wire: &str) -> Result<(), PutOrganizerError> {
        let summary = fscp_core::try_validate_organizer_wire(wire, owner)
            .map_err(PutOrganizerError::BadRequest)?;
        fscp_core::verify_organizer_signature(wire).map_err(PutOrganizerError::BadRequest)?;

        let written = self
            .repo
            .put_if_next_revision(owner, summary.revision, wire, Utc::now())
            .await
            .map_err(|e| PutOrganizerError::Internal(e.to_string()))?;

        if !written {
            let current = self
                .repo
                .get(owner)
                .await
                .map_err(|e| PutOrganizerError::Internal(e.to_string()))?;
            let current_rev = current.map(|b| b.revision).unwrap_or(0);
            return Err(PutOrganizerError::Conflict(format!(
                "Chat organizer revision conflict: expected {}, have {}.",
                current_rev + 1,
                summary.revision
            )));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    #[test]
    fn bad_wire_rejected_by_fscp_core_before_persist() {
        let owner = Uuid::nil();
        let err = fscp_core::try_validate_organizer_wire("fscp1:not-org", owner).unwrap_err();
        assert!(
            err.contains("fscporg1") || err.contains("префикс"),
            "unexpected: {err}"
        );
    }

    #[test]
    fn verify_signature_rejects_garbage_org_prefix_payload() {
        // Structurally invalid — signature verify fails after prefix check or parse.
        let err = fscp_core::verify_organizer_signature("fscporg1:AAAA").unwrap_err();
        assert!(!err.is_empty());
    }
}
