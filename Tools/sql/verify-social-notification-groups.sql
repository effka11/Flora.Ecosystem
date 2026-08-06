-- Post-migrate asserts for flora-notifications 0002_social_notification_groups.
-- Run after: flora-migrate (notifications module applied).
-- Usage:
--   pwsh ./Tools/verify-social-notification-groups.ps1 -Connection <url>
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f Tools/sql/verify-social-notification-groups.sql
--
-- Do not apply 0002 to prod without a DB snapshot (collapse DELETE is irreversible).

DO $$
DECLARE
  keyed_rows bigint;
  distinct_groups bigint;
  unkeyed_collapsible bigint;
  multi_actor_without_and bigint;
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
  WHERE type IN ('like', 'follow')
    AND group_key IS NULL
    AND NOT (type = 'like' AND post_uuid IS NULL);

  IF unkeyed_collapsible <> 0 THEN
    RAISE EXCEPTION
      'verify failed: unkeyed_collapsible = % (expected 0)',
      unkeyed_collapsible;
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

  -- Touch push_state so missing table fails loudly.
  PERFORM COUNT(*) FROM flora_core.social_notification_push_state;

  RAISE NOTICE
    'OK social notification groups: keyed_rows=%, distinct_groups=%, unkeyed=0, multi_text_ok=0',
    keyed_rows, distinct_groups;
END $$;
