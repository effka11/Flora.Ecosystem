-- §User Controls (FIRA-P v1.1): «не интересно» для рекомендаций людей.
-- Владелец таблицы — модуль Users (next-architecture.md §11.1).

CREATE TABLE IF NOT EXISTS flora_core.user_people_dismissals (
    user_uuid           uuid        NOT NULL,
    dismissed_user_uuid uuid        NOT NULL,
    created_at          timestamptz NOT NULL,
    PRIMARY KEY (user_uuid, dismissed_user_uuid)
);
