-- Soft-revoke a franking reviewer (Documents/fscp/franking.md).
-- psql -v username=egor -f Scripts/sql/revoke-franking-reviewer-by-username.sql

UPDATE flora_core.franking_reviewers AS r
SET revoked_at = NOW()
FROM flora_core.user_accounts AS a
WHERE r.user_uuid = a.user_uuid
  AND lower(a.username) = lower(:'username')
  AND r.revoked_at IS NULL
RETURNING r.user_uuid, r.added_at, r.revoked_at;
