-- Soft-revoke a franking reviewer (Documents/fscp/franking.md).
-- psql -v user_uuid=019f178d-0a7f-75d0-a00a-2dab78cf8fa8 -f Scripts/sql/revoke-franking-reviewer-by-uuid.sql

UPDATE flora_core.franking_reviewers
SET revoked_at = NOW()
WHERE user_uuid = :'user_uuid'::uuid
  AND revoked_at IS NULL
RETURNING user_uuid, added_at, revoked_at;
