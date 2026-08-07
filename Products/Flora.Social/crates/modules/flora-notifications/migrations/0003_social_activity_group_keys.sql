-- Canonical social group_key: like / follow / repost (one slot per recipient per kind).
-- Collapses legacy like:{postUuid} (and unkeyed like) into "like".
-- Runtime SoT for like text: application/social.rs::build_social_text
-- Repost slots are created only at runtime (no legacy repost:% expected).
--
-- ROLLBACK: restore DB snapshot taken before apply (collapse DELETE is irreversible).
-- Do NOT apply to prod without a snapshot.
-- Ops: snapshot → flora-migrate → Tools/sql/verify-social-notification-groups.sql → binary.

-- Collapse keyed legacy like:{uuid} + unkeyed like into one "like" row per recipient.
WITH keyed AS (
    SELECT
        n.notification_uuid,
        n.recipient_user_uuid,
        n.actor_user_uuid,
        n.type,
        n.text,
        n.post_uuid,
        n.created_at,
        n.group_key,
        n.actors_json,
        n.actor_count,
        CASE
            WHEN n.type = 'like' AND (
                n.group_key LIKE 'like:%'
                OR n.group_key IS NULL
            ) THEN 'like'
            ELSE NULL
        END AS target_group_key
    FROM flora_core.user_notifications AS n
    WHERE n.type = 'like'
      AND (
          n.group_key LIKE 'like:%'
          OR (n.group_key IS NULL AND n.post_uuid IS NOT NULL)
      )
),
eligible AS (
    SELECT * FROM keyed WHERE target_group_key IS NOT NULL
),
-- Flatten actors from existing actors_json or single-actor rows.
actors_expanded AS (
    SELECT
        e.recipient_user_uuid,
        e.target_group_key,
        e.notification_uuid,
        e.created_at,
        e.post_uuid,
        COALESCE(
            (elem->>'uuid')::uuid,
            e.actor_user_uuid
        ) AS actor_uuid,
        COALESCE(
            NULLIF(btrim(elem->>'label'), ''),
            CASE
                WHEN e.text LIKE '% оценил ваш пост'
                    THEN left(e.text, char_length(e.text) - char_length(' оценил ваш пост'))
                ELSE NULL
            END,
            'Пользователь'
        ) AS label,
        COALESCE(
            (elem->>'joinedAt')::timestamptz,
            e.created_at
        ) AS joined_at
    FROM eligible AS e
    LEFT JOIN LATERAL jsonb_array_elements(
        CASE
            WHEN jsonb_typeof(COALESCE(e.actors_json, '[]'::jsonb)) = 'array'
                 AND jsonb_array_length(COALESCE(e.actors_json, '[]'::jsonb)) > 0
                THEN e.actors_json
            ELSE '[]'::jsonb
        END
    ) AS elem ON TRUE
    WHERE COALESCE(
        (elem->>'uuid')::uuid,
        e.actor_user_uuid
    ) IS NOT NULL
),
actors_ranked AS (
    SELECT DISTINCT ON (
        recipient_user_uuid,
        target_group_key,
        actor_uuid
    )
        recipient_user_uuid,
        target_group_key,
        actor_uuid,
        label,
        joined_at,
        post_uuid,
        notification_uuid
    FROM actors_expanded
    ORDER BY
        recipient_user_uuid,
        target_group_key,
        actor_uuid,
        joined_at DESC,
        notification_uuid DESC
),
actors_agg AS (
    SELECT
        ar.recipient_user_uuid,
        ar.target_group_key,
        jsonb_agg(
            jsonb_build_object(
                'uuid', ar.actor_uuid,
                'label', ar.label,
                'joinedAt', ar.joined_at
            )
            ORDER BY ar.joined_at DESC, ar.actor_uuid DESC
        ) AS actors_json,
        COUNT(*)::int AS actor_count,
        (ARRAY_AGG(ar.post_uuid ORDER BY ar.joined_at DESC, ar.actor_uuid DESC)
            FILTER (WHERE ar.post_uuid IS NOT NULL))[1] AS newest_post_uuid,
        (ARRAY_AGG(ar.actor_uuid ORDER BY ar.joined_at DESC, ar.actor_uuid DESC))[1]
            AS newest_actor_uuid
    FROM actors_ranked AS ar
    GROUP BY ar.recipient_user_uuid, ar.target_group_key
),
actors_with_text AS (
    SELECT
        a.recipient_user_uuid,
        a.target_group_key,
        a.actors_json,
        a.actor_count,
        a.newest_post_uuid,
        a.newest_actor_uuid,
        CASE
            WHEN a.actor_count < 1 THEN NULL
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
        END AS aggregated_text
    FROM actors_agg AS a
),
survivors AS (
    SELECT DISTINCT ON (e.recipient_user_uuid, e.target_group_key)
        e.notification_uuid,
        e.recipient_user_uuid,
        e.target_group_key
    FROM eligible AS e
    ORDER BY
        e.recipient_user_uuid,
        e.target_group_key,
        e.created_at DESC,
        e.notification_uuid DESC
),
updated AS (
    UPDATE flora_core.user_notifications AS n
    SET
        group_key = s.target_group_key,
        actor_count = COALESCE(a.actor_count, 1),
        actors_json = COALESCE(a.actors_json, '[]'::jsonb),
        actor_user_uuid = COALESCE(a.newest_actor_uuid, n.actor_user_uuid),
        post_uuid = COALESCE(a.newest_post_uuid, n.post_uuid),
        text = COALESCE(a.aggregated_text, n.text)
    FROM survivors AS s
    LEFT JOIN actors_with_text AS a
        ON a.recipient_user_uuid = s.recipient_user_uuid
       AND a.target_group_key = s.target_group_key
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
),
-- Rekey push_state like:% → like (keep max last_push_at per recipient).
push_src AS (
    SELECT
        recipient_user_uuid,
        MAX(last_push_at) AS last_push_at
    FROM flora_core.social_notification_push_state
    WHERE group_key LIKE 'like:%'
    GROUP BY recipient_user_uuid
),
push_upsert AS (
    INSERT INTO flora_core.social_notification_push_state
        (recipient_user_uuid, group_key, last_push_at)
    SELECT recipient_user_uuid, 'like', last_push_at
    FROM push_src
    ON CONFLICT (recipient_user_uuid, group_key)
    DO UPDATE SET last_push_at = GREATEST(
        flora_core.social_notification_push_state.last_push_at,
        EXCLUDED.last_push_at
    )
    RETURNING recipient_user_uuid
),
push_deleted AS (
    DELETE FROM flora_core.social_notification_push_state
    WHERE group_key LIKE 'like:%'
    RETURNING group_key
)
SELECT
    (SELECT COUNT(*)::bigint FROM updated) AS survivors_updated,
    (SELECT COUNT(*)::bigint FROM deleted) AS duplicates_deleted,
    (SELECT COUNT(*)::bigint FROM push_upsert) AS push_rekeyed,
    (SELECT COUNT(*)::bigint FROM push_deleted) AS push_legacy_deleted;
