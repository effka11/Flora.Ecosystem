-- Лайки комментариев. Владелец — модуль Content. Forward-only, без down-скрипта.

CREATE TABLE IF NOT EXISTS flora_core.comment_likes (
    comment_uuid uuid        NOT NULL,
    user_uuid    uuid        NOT NULL,
    created_at   timestamptz NOT NULL,
    PRIMARY KEY (comment_uuid, user_uuid)
);
