-- CI-only disposable cutover fixture for the Auth replay migration.
-- This is not a production migration. It models only the legacy tables that
-- existing module migrations and the mandatory Auth PostgreSQL test require.

CREATE SCHEMA IF NOT EXISTS flora_core AUTHORIZATION flora;
GRANT ALL ON SCHEMA flora_core TO flora;
ALTER ROLE flora IN DATABASE flora_core
    SET search_path TO flora_core, public;
SET search_path TO flora_core, public;

-- Stub for Auth data migrations that touch cutover-owned tables
-- (e.g. 0002_lowercase_usernames). Not a full production shape.
CREATE TABLE flora_core.user_accounts (
    user_uuid  uuid        NOT NULL PRIMARY KEY,
    username   text        NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE flora_core.user_sessions (
    session_id     uuid        NOT NULL PRIMARY KEY,
    user_uuid      uuid        NOT NULL,
    agent_hash     text        NOT NULL,
    ip_address     inet        NOT NULL,
    city           text        NULL,
    country_code   text        NULL,
    created_at     timestamptz NOT NULL,
    expires_at     timestamptz NOT NULL,
    last_activity  timestamptz NOT NULL,
    jwt_id         text        NOT NULL,
    refresh_token  text        NOT NULL,
    rotation_id    bigint      NOT NULL,
    status         integer     NOT NULL,
    csrf_token     text        NOT NULL,
    hmac_key       text        NOT NULL
);

CREATE TABLE flora_core.user_push_tokens (
    "PushTokenUuid" uuid        NOT NULL PRIMARY KEY,
    "UserUuid"      uuid        NOT NULL,
    "Token"         text        NOT NULL,
    "Platform"      text        NOT NULL,
    "UpdatedAt"     timestamptz NOT NULL
);

-- Stub for messaging franking migration (FK + live-DELETE triggers on user_messages).
-- Cutover-owned; not created by flora-migrate. PK is the only shape the migration needs.
CREATE TABLE flora_core.user_messages (
    message_uuid         uuid        NOT NULL PRIMARY KEY,
    sender_user_uuid     uuid        NOT NULL,
    receiver_user_uuid   uuid        NOT NULL,
    content              text        NULL,
    encrypted_for_receiver text      NULL,
    encrypted_for_sender text        NULL,
    created_at           timestamptz NOT NULL DEFAULT now(),
    is_read              boolean     NOT NULL DEFAULT false
);

-- Stub for Content migration 0002 (ALTER user_posts / post_images / post_videos).
-- Cutover-owned; not created by flora-migrate. UNIQUE(post_uuid) on post_videos
-- models the live unique that 0002 replaces with ux_post_videos_current_post.
CREATE TABLE flora_core.user_posts (
    post_uuid        uuid        NOT NULL PRIMARY KEY,
    author_user_uuid uuid        NOT NULL,
    community_id     uuid        NULL,
    content          text        NOT NULL DEFAULT '',
    created_at       timestamptz NOT NULL DEFAULT now(),
    is_deleted       boolean     NOT NULL DEFAULT false,
    deleted_at       timestamptz NULL
);

CREATE TABLE flora_core.post_images (
    uuid         uuid    NOT NULL PRIMARY KEY,
    post_uuid    uuid    NOT NULL,
    content_type text    NOT NULL,
    data         bytea   NOT NULL,
    sort_order   integer NOT NULL DEFAULT 0
);

CREATE TABLE flora_core.post_videos (
    uuid                uuid        NOT NULL PRIMARY KEY,
    post_uuid           uuid        NOT NULL,
    status              integer     NOT NULL DEFAULT 0,
    content_type        text        NOT NULL DEFAULT 'video/mp4',
    data                bytea       NOT NULL DEFAULT ''::bytea,
    poster_data         bytea       NOT NULL DEFAULT ''::bytea,
    poster_content_type text        NOT NULL DEFAULT 'image/avif',
    width               integer     NOT NULL DEFAULT 0,
    height              integer     NOT NULL DEFAULT 0,
    duration_ms         integer     NOT NULL DEFAULT 0,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ux_post_videos_post UNIQUE (post_uuid)
);

-- Stub for notifications migrations 0002/0003 (ALTER + legacy collapse).
-- Shape matches cutover inbox columns used by flora-notifications repo (snake_case);
-- group_key / actor_count / actors_json are added by module migration 0002.
CREATE TABLE flora_core.user_notifications (
    notification_uuid   uuid        NOT NULL PRIMARY KEY,
    recipient_user_uuid uuid        NOT NULL,
    actor_user_uuid     uuid        NULL,
    type                text        NOT NULL,
    category            text        NOT NULL,
    text                text        NOT NULL,
    post_uuid           uuid        NULL,
    comment_uuid        uuid        NULL,
    target_platform     varchar(16) NULL,
    is_read             boolean     NOT NULL DEFAULT false,
    created_at          timestamptz NOT NULL DEFAULT now()
);

-- A row written by the old API before migration must remain usable afterward.
INSERT INTO flora_core.user_sessions (
    session_id, user_uuid, agent_hash, ip_address,
    created_at, expires_at, last_activity,
    jwt_id, refresh_token, rotation_id, status,
    csrf_token, hmac_key
) VALUES (
    '00000000-0000-0000-0000-000000000101',
    '00000000-0000-0000-0000-000000000201',
    'legacy-agent',
    '127.0.0.1',
    now(),
    now() + interval '7 days',
    now(),
    'legacy-jti',
    'legacy-refresh',
    0,
    0,
    'legacy-csrf',
    'legacy-hmac'
);

DO $$
BEGIN
    IF to_regclass('flora_core.auth_refresh_replays') IS NOT NULL THEN
        RAISE EXCEPTION 'Auth replay table already exists before migration';
    END IF;
END
$$;
