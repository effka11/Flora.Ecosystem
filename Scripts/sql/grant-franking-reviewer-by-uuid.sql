-- Messaging-owned franking roster (Documents/fscp/franking.md).
-- psql -v user_uuid=019f178d-0a7f-75d0-a00a-2dab78cf8fa8 -f Scripts/sql/grant-franking-reviewer-by-uuid.sql

INSERT INTO flora_core.franking_reviewers (user_uuid, added_at, revoked_at)
VALUES (:'user_uuid'::uuid, NOW(), NULL)
ON CONFLICT (user_uuid) DO UPDATE SET revoked_at = NULL
RETURNING user_uuid, added_at, revoked_at;
