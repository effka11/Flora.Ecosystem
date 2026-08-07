-- Optional pre-migrate snapshot (informational). Spec: COUNT like/follow before collapse.
-- Safe to run before or after 0002; does not fail the session.

\echo 'snapshot: like/follow rows'
SELECT COUNT(*) AS like_follow_rows
FROM flora_core.user_notifications
WHERE type IN ('like', 'follow');

\echo 'snapshot: distinct computed groups (like with post / follow)'
SELECT COUNT(*) AS distinct_groups
FROM (
  SELECT recipient_user_uuid,
         CASE
           WHEN type = 'like' AND post_uuid IS NOT NULL THEN 'like:' || post_uuid::text
           WHEN type = 'follow' THEN 'follow'
         END AS group_key
  FROM flora_core.user_notifications
  WHERE type IN ('like', 'follow')
    AND (type = 'follow' OR post_uuid IS NOT NULL)
  GROUP BY 1, 2
) g;
