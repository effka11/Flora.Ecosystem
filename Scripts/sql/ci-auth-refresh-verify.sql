-- CI assertions after flora-migrate has run against the disposable cutover
-- fixture. Fail fast on a wrong schema/history table or a breaking migration.

DO $$
BEGIN
    IF current_schema() IS DISTINCT FROM 'flora_core' THEN
        RAISE EXCEPTION
            'expected flora_core first in search_path, got %',
            current_setting('search_path');
    END IF;

    IF to_regclass('__flora_migrations_auth')
        IS DISTINCT FROM to_regclass('flora_core.__flora_migrations_auth')
    THEN
        RAISE EXCEPTION
            'Auth history table is not resolved through flora_core search_path';
    END IF;

    IF to_regclass('flora_core.auth_refresh_replays') IS NULL THEN
        RAISE EXCEPTION 'Auth replay migration was not applied';
    END IF;

    IF to_regclass('flora_core.ux_auth_refresh_replays_spent_hash') IS NULL
        OR to_regclass('flora_core.ix_auth_refresh_replays_valid_until') IS NULL
    THEN
        RAISE EXCEPTION 'Auth replay indexes are missing';
    END IF;

    IF (SELECT count(*) FROM flora_core.__flora_migrations_auth) <> 3 THEN
        RAISE EXCEPTION 'expected exactly three recorded Auth migrations';
    END IF;

    IF to_regclass('flora_core.pending_password_resets') IS NULL
        OR to_regclass('flora_core.password_reset_grants') IS NULL
    THEN
        RAISE EXCEPTION 'Auth password-reset migration was not applied';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM user_sessions
        WHERE session_id = '00000000-0000-0000-0000-000000000101'
          AND refresh_token = 'legacy-refresh'
          AND rotation_id = 0
          AND status = 0
    ) THEN
        RAISE EXCEPTION 'pre-migration legacy session was changed';
    END IF;
END
$$;

-- These unqualified, old-column-only writes model the old API after the
-- additive migration. They also prove that the role search_path is effective.
INSERT INTO user_sessions (
    session_id, user_uuid, agent_hash, ip_address,
    created_at, expires_at, last_activity,
    jwt_id, refresh_token, rotation_id, status,
    csrf_token, hmac_key
) VALUES (
    '00000000-0000-0000-0000-000000000102',
    '00000000-0000-0000-0000-000000000202',
    'post-migration-legacy-agent',
    '127.0.0.2',
    now(),
    now() + interval '7 days',
    now(),
    'post-migration-legacy-jti',
    'post-migration-legacy-refresh',
    0,
    0,
    'post-migration-legacy-csrf',
    'post-migration-legacy-hmac'
);

INSERT INTO user_push_tokens (
    "PushTokenUuid", "UserUuid", "Token", "Platform", "UpdatedAt"
) VALUES (
    '00000000-0000-0000-0000-000000000301',
    '00000000-0000-0000-0000-000000000202',
    'legacy-push-token',
    'android',
    now()
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM user_sessions
        WHERE session_id = '00000000-0000-0000-0000-000000000102'
    ) THEN
        RAISE EXCEPTION 'old API session write failed after migration';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM user_push_tokens
        WHERE "PushTokenUuid" = '00000000-0000-0000-0000-000000000301'
          AND "Provider" IS NULL
          AND "InstallationUuid" IS NULL
    ) THEN
        RAISE EXCEPTION 'old API push-token write failed after additive migration';
    END IF;

    IF to_regclass('flora_core.user_messages') IS NULL THEN
        RAISE EXCEPTION 'cutover user_messages stub missing after migrate';
    END IF;

    IF to_regclass('flora_core.franking_reports') IS NULL
        OR to_regclass('flora_core.user_message_frank_receipts') IS NULL
        OR to_regclass('flora_core.franking_disclosure_wraps') IS NULL
        OR to_regclass('flora_core.franking_report_audit') IS NULL
        OR to_regclass('flora_core.franking_reviewers') IS NULL
    THEN
        RAISE EXCEPTION 'messaging franking migration 20260816120000 was not applied';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'flora_core'
          AND c.relname = 'user_messages'
          AND t.tgname = 'tg_user_messages_franking_live'
          AND NOT t.tgisinternal
    ) THEN
        RAISE EXCEPTION 'franking live-DELETE trigger missing on user_messages';
    END IF;

    IF to_regclass('flora_core.user_notifications') IS NULL THEN
        RAISE EXCEPTION 'cutover user_notifications stub missing after migrate';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'flora_core'
          AND table_name = 'user_notifications'
          AND column_name = 'group_key'
    ) THEN
        RAISE EXCEPTION 'notifications migration 0002 did not add group_key';
    END IF;

    IF to_regclass('flora_core.social_notification_push_state') IS NULL THEN
        RAISE EXCEPTION 'notifications migration 0002 did not create social_notification_push_state';
    END IF;

    IF to_regclass('flora_core.user_posts') IS NULL
        OR to_regclass('flora_core.post_images') IS NULL
        OR to_regclass('flora_core.post_videos') IS NULL
    THEN
        RAISE EXCEPTION 'cutover content media stubs missing after migrate';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'flora_core'
          AND table_name = 'user_posts'
          AND column_name = 'is_edited'
    ) OR NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'flora_core'
          AND table_name = 'user_posts'
          AND column_name = 'edited_at'
    ) THEN
        RAISE EXCEPTION 'content migration 0002 did not add user_posts.is_edited / edited_at';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'flora_core'
          AND table_name = 'post_images'
          AND column_name = 'is_current'
    ) THEN
        RAISE EXCEPTION 'content migration 0002 did not add post_images.is_current';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'flora_core'
          AND table_name = 'post_videos'
          AND column_name = 'is_current'
    ) THEN
        RAISE EXCEPTION 'content migration 0002 did not add post_videos.is_current';
    END IF;

    IF to_regclass('flora_core.post_revisions') IS NULL THEN
        RAISE EXCEPTION 'content migration 0002 did not create post_revisions';
    END IF;

    IF to_regclass('flora_core.ux_post_videos_current_post') IS NULL THEN
        RAISE EXCEPTION 'content migration 0002 did not create ux_post_videos_current_post';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_class t ON c.conrelid = t.oid
        JOIN pg_namespace n ON t.relnamespace = n.oid
        WHERE n.nspname = 'flora_core'
          AND t.relname = 'post_videos'
          AND c.contype = 'u'
          AND pg_get_constraintdef(c.oid) ILIKE '%post_uuid%'
          AND pg_get_constraintdef(c.oid) NOT ILIKE '%is_current%'
    ) THEN
        RAISE EXCEPTION
            'content migration 0002 left a non-partial unique on post_videos.post_uuid';
    END IF;
END
$$;
