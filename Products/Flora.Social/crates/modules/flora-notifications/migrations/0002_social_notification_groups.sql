-- Social inbox aggregation + FCM push cooldown state (notifications module owns schema).
--
-- Column naming: snake_case unquoted — matches flora_core.user_notifications as used by
-- flora-notifications/src/infrastructure/repo.rs (notification_uuid, recipient_user_uuid, …).
-- Do NOT use quoted PascalCase here; that style is only for legacy flora_core.user_push_tokens
-- columns added in 0001_secure_push_previews.sql.
--
-- actors_json shape (full membership, newest-first):
--   [{"uuid":"<uuid>","label":"<display>","joinedAt":"<timestamptz>"}]
--
-- ---------------------------------------------------------------------------
-- VERIFY (manual / staging after flora-migrate apply)
-- ---------------------------------------------------------------------------
-- Snapshot counts before apply (optional):
--   SELECT COUNT(*) AS like_follow_rows
--   FROM flora_core.user_notifications
--   WHERE type IN ('like', 'follow')
--
--   SELECT COUNT(*) AS distinct_groups
--   FROM (
--     SELECT recipient_user_uuid,
--            CASE
--              WHEN type = 'like' AND post_uuid IS NOT NULL THEN 'like:' || post_uuid::text
--              WHEN type = 'follow' THEN 'follow'
--            END AS group_key
--     FROM flora_core.user_notifications
--     WHERE type IN ('like', 'follow')
--       AND (type = 'follow' OR post_uuid IS NOT NULL)
--     GROUP BY 1, 2
--   ) g
--
-- After apply - remaining keyed rows must equal distinct (recipient, group_key):
--   SELECT COUNT(*) AS rows,
--          COUNT(DISTINCT (recipient_user_uuid, group_key)) AS distinct_groups
--   FROM flora_core.user_notifications
--   WHERE group_key IS NOT NULL
--   -- Assert: rows = distinct_groups
--
--   SELECT COUNT(*) AS unkeyed_collapsible
--   FROM flora_core.user_notifications
--   WHERE type IN ('like', 'follow')
--     AND group_key IS NULL
--     AND NOT (type = 'like' AND post_uuid IS NULL)
--   -- Assert: unkeyed_collapsible = 0
--
-- After apply — multi-actor groups must not keep single-actor survivor text:
--   SELECT notification_uuid, actor_count, text
--   FROM flora_core.user_notifications
--   WHERE group_key IS NOT NULL AND actor_count >= 2
--     AND text NOT LIKE '% и %'
--   -- Assert: 0 rows
--
-- Runnable helper (ops) — apply + assert in one shot:
--   pwsh ./Tools/verify-social-notification-groups.ps1 -Migrate -Connection "Host=...;Database=...;Username=...;Password=..."
-- Assert only:
--   pwsh ./Tools/verify-social-notification-groups.ps1 -Connection "..."
-- Pre-count snapshot (optional): Tools/sql/snapshot-social-notification-groups-before.sql
--
-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- No sqlx down-migration. Rollback = restore DB snapshot / backup taken before apply.
-- Legacy collapse DELETEs duplicate like/follow rows and is irreversible without backup.
-- Do NOT apply this migration to prod without a snapshot.

ALTER TABLE flora_core.user_notifications
    ADD COLUMN IF NOT EXISTS group_key TEXT NULL,
    ADD COLUMN IF NOT EXISTS actor_count INT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS actors_json JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS flora_core.social_notification_push_state (
    recipient_user_uuid UUID NOT NULL,
    group_key TEXT NOT NULL,
    last_push_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT pk_social_notification_push_state
        PRIMARY KEY (recipient_user_uuid, group_key)
);

-- Mandatory legacy collapse: one survivor row per (recipient_user_uuid, group_key)
-- for existing like/follow rows that lack group_key.
WITH keyed AS (
    SELECT
        n.notification_uuid,
        n.recipient_user_uuid,
        n.actor_user_uuid,
        n.type,
        n.text,
        n.post_uuid,
        n.created_at,
        CASE
            WHEN n.type = 'like' AND n.post_uuid IS NOT NULL
                THEN 'like:' || n.post_uuid::text
            WHEN n.type = 'follow'
                THEN 'follow'
            ELSE NULL
        END AS computed_group_key,
        CASE
            WHEN n.type = 'like' AND n.text LIKE '% оценил ваш пост'
                THEN left(
                    n.text,
                    char_length(n.text) - char_length(' оценил ваш пост')
                )
            WHEN n.type = 'follow' AND n.text LIKE 'Новый подписчик %'
                THEN substring(n.text FROM (char_length('Новый подписчик ') + 1))
            ELSE NULLIF(btrim(n.text), '')
        END AS actor_label
    FROM flora_core.user_notifications AS n
    WHERE n.type IN ('like', 'follow')
      AND n.group_key IS NULL
),
eligible AS (
    SELECT *
    FROM keyed
    WHERE computed_group_key IS NOT NULL
),
-- Distinct actors per group; keep newest row per actor_user_uuid.
actors_ranked AS (
    SELECT DISTINCT ON (
        e.recipient_user_uuid,
        e.computed_group_key,
        e.actor_user_uuid
    )
        e.recipient_user_uuid,
        e.computed_group_key,
        e.actor_user_uuid,
        e.created_at AS joined_at,
        COALESCE(NULLIF(btrim(e.actor_label), ''), 'Пользователь') AS label
    FROM eligible AS e
    WHERE e.actor_user_uuid IS NOT NULL
    ORDER BY
        e.recipient_user_uuid,
        e.computed_group_key,
        e.actor_user_uuid,
        e.created_at DESC,
        e.notification_uuid DESC
),
actors_agg AS (
    SELECT
        ar.recipient_user_uuid,
        ar.computed_group_key,
        jsonb_agg(
            jsonb_build_object(
                'uuid', ar.actor_user_uuid,
                'label', ar.label,
                'joinedAt', ar.joined_at
            )
            ORDER BY ar.joined_at DESC, ar.actor_user_uuid DESC
        ) AS actors_json,
        COUNT(*)::int AS actor_count
    FROM actors_ranked AS ar
    GROUP BY ar.recipient_user_uuid, ar.computed_group_key
),
-- Model B text from newest-first actors_json.
-- SoT for these strings at runtime: application/social.rs::build_social_text —
-- keep this SQL in lockstep (one-shot collapse only).
actors_with_text AS (
    SELECT
        a.recipient_user_uuid,
        a.computed_group_key,
        a.actors_json,
        a.actor_count,
        CASE
            WHEN a.actor_count < 1 THEN NULL
            WHEN a.computed_group_key = 'follow' THEN
                CASE
                    WHEN a.actor_count = 1 THEN
                        'Новый подписчик '
                        || COALESCE(NULLIF(btrim(a.actors_json->0->>'label'), ''), 'Пользователь')
                    WHEN a.actor_count = 2 THEN
                        COALESCE(NULLIF(btrim(a.actors_json->0->>'label'), ''), 'Пользователь')
                        || ' и '
                        || COALESCE(NULLIF(btrim(a.actors_json->1->>'label'), ''), 'Пользователь')
                        || ' подписались на вас'
                    ELSE
                        COALESCE(NULLIF(btrim(a.actors_json->0->>'label'), ''), 'Пользователь')
                        || ', '
                        || COALESCE(NULLIF(btrim(a.actors_json->1->>'label'), ''), 'Пользователь')
                        || ' и ещё '
                        || (a.actor_count - 2)::text
                        || ' подписались на вас'
                END
            ELSE
                CASE
                    WHEN a.actor_count = 1 THEN
                        COALESCE(NULLIF(btrim(a.actors_json->0->>'label'), ''), 'Пользователь')
                        || ' оценил ваш пост'
                    WHEN a.actor_count = 2 THEN
                        COALESCE(NULLIF(btrim(a.actors_json->0->>'label'), ''), 'Пользователь')
                        || ' и '
                        || COALESCE(NULLIF(btrim(a.actors_json->1->>'label'), ''), 'Пользователь')
                        || ' оценили ваш пост'
                    ELSE
                        COALESCE(NULLIF(btrim(a.actors_json->0->>'label'), ''), 'Пользователь')
                        || ', '
                        || COALESCE(NULLIF(btrim(a.actors_json->1->>'label'), ''), 'Пользователь')
                        || ' и ещё '
                        || (a.actor_count - 2)::text
                        || ' оценили ваш пост'
                END
        END AS aggregated_text
    FROM actors_agg AS a
),
survivors AS (
    SELECT DISTINCT ON (e.recipient_user_uuid, e.computed_group_key)
        e.notification_uuid,
        e.recipient_user_uuid,
        e.computed_group_key,
        e.actor_user_uuid AS newest_actor_user_uuid
    FROM eligible AS e
    ORDER BY
        e.recipient_user_uuid,
        e.computed_group_key,
        e.created_at DESC,
        e.notification_uuid DESC
),
updated AS (
    UPDATE flora_core.user_notifications AS n
    SET
        group_key = s.computed_group_key,
        actor_count = COALESCE(a.actor_count, 1),
        actors_json = COALESCE(a.actors_json, '[]'::jsonb),
        actor_user_uuid = COALESCE(s.newest_actor_user_uuid, n.actor_user_uuid),
        -- Rewrite copy to Model B aggregate (do not leave single-actor survivor text).
        text = COALESCE(a.aggregated_text, n.text)
    FROM survivors AS s
    LEFT JOIN actors_with_text AS a
        ON a.recipient_user_uuid = s.recipient_user_uuid
       AND a.computed_group_key = s.computed_group_key
    WHERE n.notification_uuid = s.notification_uuid
    RETURNING n.notification_uuid
),
deleted AS (
    DELETE FROM flora_core.user_notifications AS n
    USING eligible AS e
    WHERE n.notification_uuid = e.notification_uuid
      AND NOT EXISTS (
          SELECT 1
          FROM survivors AS s
          WHERE s.notification_uuid = e.notification_uuid
      )
    RETURNING n.notification_uuid
)
-- Reference both modifying CTEs so the planner cannot drop them as unused.
SELECT
    (SELECT COUNT(*)::bigint FROM updated) AS survivors_updated,
    (SELECT COUNT(*)::bigint FROM deleted) AS duplicates_deleted;

-- Partial unique AFTER collapse so legacy duplicates cannot violate it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_notifications_recipient_group_key
    ON flora_core.user_notifications (recipient_user_uuid, group_key)
    WHERE group_key IS NOT NULL;
