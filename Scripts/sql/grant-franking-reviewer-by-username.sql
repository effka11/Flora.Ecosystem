-- Messaging-owned franking roster (Documents/fscp/franking.md).
-- Active reviewer <=> row in flora_core.franking_reviewers AND revoked_at IS NULL.
-- Do not add a boolean on Auth user_accounts.
--
-- psql -v username=egor -f Scripts/sql/grant-franking-reviewer-by-username.sql

INSERT INTO flora_core.franking_reviewers (user_uuid, added_at, revoked_at)
SELECT a.user_uuid, NOW(), NULL
FROM flora_core.user_accounts a
WHERE lower(a.username) = lower(:'username')
ON CONFLICT (user_uuid) DO UPDATE SET revoked_at = NULL
RETURNING user_uuid, added_at, revoked_at;
