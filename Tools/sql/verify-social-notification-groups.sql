-- Post-migrate asserts for flora-notifications 0002 + 0003 social group keys.
-- Run after: flora-migrate (notifications module applied).
-- Usage:
--   pwsh ./Tools/verify-social-notification-groups.ps1 -Connection <url>
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f Tools/sql/verify-social-notification-groups.sql
--
-- Do not apply collapse migrations to prod without a DB snapshot.

DO $$
DECLARE
  keyed_rows bigint;
  distinct_groups bigint;
  unkeyed_collapsible bigint;
  multi_actor_without_and bigint;
  legacy_like_keys bigint;
  legacy_repost_keys bigint;
  bad_canon bigint;
BEGIN
  SELECT COUNT(*), COUNT(DISTINCT (recipient_user_uuid, group_key))
  INTO keyed_rows, distinct_groups
  FROM flora_core.user_notifications
  WHERE group_key IS NOT NULL;

  IF keyed_rows <> distinct_groups THEN
    RAISE EXCEPTION
      'verify failed: keyed rows (%) <> distinct groups (%)',
      keyed_rows, distinct_groups;
  END IF;

  SELECT COUNT(*) INTO unkeyed_collapsible
  FROM flora_core.user_notifications
  WHERE type IN ('like', 'follow', 'repost')
    AND group_key IS NULL
    AND NOT (type IN ('like', 'repost') AND post_uuid IS NULL);

  IF unkeyed_collapsible <> 0 THEN
    RAISE EXCEPTION
      'verify failed: unkeyed_collapsible = % (expected 0)',
      unkeyed_collapsible;
  END IF;

  SELECT COUNT(*) INTO legacy_like_keys
  FROM flora_core.user_notifications
  WHERE group_key LIKE 'like:%';

  IF legacy_like_keys <> 0 THEN
    RAISE EXCEPTION
      'verify failed: legacy like:%% keys = % (expected 0 after 0003)',
      legacy_like_keys;
  END IF;

  SELECT COUNT(*) INTO legacy_repost_keys
  FROM flora_core.user_notifications
  WHERE group_key LIKE 'repost:%';

  IF legacy_repost_keys <> 0 THEN
    RAISE EXCEPTION
      'verify failed: legacy repost:%% keys = % (expected 0)',
      legacy_repost_keys;
  END IF;

  SELECT COUNT(*) INTO bad_canon
  FROM flora_core.user_notifications
  WHERE group_key IS NOT NULL
    AND group_key NOT IN ('like', 'follow', 'repost');

  IF bad_canon <> 0 THEN
    RAISE EXCEPTION
      'verify failed: non-canonical group_key rows = % (expected like|follow|repost only)',
      bad_canon;
  END IF;

  SELECT COUNT(*) INTO multi_actor_without_and
  FROM flora_core.user_notifications
  WHERE group_key IS NOT NULL
    AND actor_count >= 2
    AND text NOT LIKE '% и %';

  IF multi_actor_without_and <> 0 THEN
    RAISE EXCEPTION
      'verify failed: multi_actor_without_and = % (expected 0)',
      multi_actor_without_and;
  END IF;

  -- Touch push_state so missing table fails loudly; no legacy like:% push keys.
  IF EXISTS (
    SELECT 1 FROM flora_core.social_notification_push_state WHERE group_key LIKE 'like:%'
  ) THEN
    RAISE EXCEPTION 'verify failed: push_state still has like:%% keys';
  END IF;

  RAISE NOTICE
    'OK social notification groups: keyed_rows=%, distinct_groups=%, unkeyed=0, canon=like|follow|repost',
    keyed_rows, distinct_groups;
END $$;
