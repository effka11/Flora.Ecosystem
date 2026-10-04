-- §User Controls (FIRA-F v1.1): настройки ленты + негативный фидбек.
-- Владелец таблиц — модуль Content (next-architecture.md §11.1).

CREATE TABLE IF NOT EXISTS flora_core.user_feed_settings (
    user_uuid        uuid        NOT NULL PRIMARY KEY,
    freshness        text        NOT NULL DEFAULT 'balanced'
        CONSTRAINT ck_user_feed_settings_freshness
        CHECK (freshness IN ('fresh', 'balanced', 'popular')),
    exploration      text        NOT NULL DEFAULT 'standard'
        CONSTRAINT ck_user_feed_settings_exploration
        CHECK (exploration IN ('off', 'low', 'standard', 'high')),
    show_reposts     boolean     NOT NULL DEFAULT true,
    community_posts  boolean     NOT NULL DEFAULT true,
    seen_posts       text        NOT NULL DEFAULT 'demote'
        CONSTRAINT ck_user_feed_settings_seen_posts
        CHECK (seen_posts IN ('show', 'demote', 'hide')),
    author_diversity text        NOT NULL DEFAULT 'standard'
        CONSTRAINT ck_user_feed_settings_author_diversity
        CHECK (author_diversity IN ('strict', 'standard', 'off')),
    updated_at       timestamptz NOT NULL
);

-- «Не интересно» для поста: жёсткое исключение поста из рекомендаций
-- + мягкий штраф Score по автору (окно interaction_history_days).
CREATE TABLE IF NOT EXISTS flora_core.user_feed_post_feedback (
    user_uuid        uuid        NOT NULL,
    post_uuid        uuid        NOT NULL,
    author_user_uuid uuid        NOT NULL,
    created_at       timestamptz NOT NULL,
    PRIMARY KEY (user_uuid, post_uuid)
);

CREATE INDEX IF NOT EXISTS ix_user_feed_post_feedback_user_author
    ON flora_core.user_feed_post_feedback (user_uuid, author_user_uuid, created_at);

-- «Скрыть автора»: исключение из рекомендательных пулов (подписки не трогаем).
CREATE TABLE IF NOT EXISTS flora_core.user_feed_hidden_authors (
    user_uuid        uuid        NOT NULL,
    author_user_uuid uuid        NOT NULL,
    created_at       timestamptz NOT NULL,
    PRIMARY KEY (user_uuid, author_user_uuid)
);

-- «Не интересно» для сообщества: исключение из рекомендаций FIRA-C.
CREATE TABLE IF NOT EXISTS flora_core.user_feed_community_dismissals (
    user_uuid    uuid        NOT NULL,
    community_id uuid        NOT NULL,
    created_at   timestamptz NOT NULL,
    PRIMARY KEY (user_uuid, community_id)
);
