-- Правка опубликованных постов: флаг is_edited, история, мягкое снятие медиа.
-- Владелец — модуль Content. Forward-only.

ALTER TABLE flora_core.user_posts
    ADD COLUMN IF NOT EXISTS is_edited boolean NOT NULL DEFAULT false;

ALTER TABLE flora_core.user_posts
    ADD COLUMN IF NOT EXISTS edited_at timestamptz NULL;

ALTER TABLE flora_core.post_images
    ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true;

ALTER TABLE flora_core.post_videos
    ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS flora_core.post_revisions (
    revision_uuid    uuid        NOT NULL PRIMARY KEY,
    post_uuid        uuid        NOT NULL,
    revision_no      integer     NOT NULL,
    editor_user_uuid uuid        NOT NULL,
    created_at       timestamptz NOT NULL,
    content          text        NOT NULL,
    image_uuids      uuid[]      NOT NULL DEFAULT '{}',
    video_uuid       uuid        NULL,
    CONSTRAINT uq_post_revisions_post_no UNIQUE (post_uuid, revision_no)
);

CREATE INDEX IF NOT EXISTS ix_post_revisions_post_created
    ON flora_core.post_revisions (post_uuid, created_at DESC);

-- Исторические ролики не должны ломать UNIQUE(post_uuid), если он был.
DO $$
DECLARE
    obj text;
BEGIN
    FOR obj IN
        SELECT c.conname
        FROM pg_constraint c
        JOIN pg_class t ON c.conrelid = t.oid
        JOIN pg_namespace n ON t.relnamespace = n.oid
        WHERE n.nspname = 'flora_core'
          AND t.relname = 'post_videos'
          AND c.contype = 'u'
          AND pg_get_constraintdef(c.oid) ILIKE '%post_uuid%'
          AND pg_get_constraintdef(c.oid) NOT ILIKE '%is_current%'
    LOOP
        EXECUTE format('ALTER TABLE flora_core.post_videos DROP CONSTRAINT %I', obj);
    END LOOP;

    FOR obj IN
        SELECT i.relname
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
        JOIN pg_class t ON t.oid = x.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'flora_core'
          AND t.relname = 'post_videos'
          AND x.indisunique
          AND NOT x.indisprimary
          AND pg_get_indexdef(x.indexrelid) ILIKE '%(post_uuid)%'
          AND pg_get_indexdef(x.indexrelid) NOT ILIKE '%is_current%'
    LOOP
        EXECUTE format('DROP INDEX IF EXISTS flora_core.%I', obj);
    END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_post_videos_current_post
    ON flora_core.post_videos (post_uuid)
    WHERE is_current;
