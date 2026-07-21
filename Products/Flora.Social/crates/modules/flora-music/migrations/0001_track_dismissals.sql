-- §User Controls (FIRA-M v1.1): «не интересно» для треков Потока.
-- Владелец таблицы — модуль Music (next-architecture.md §11.1).

CREATE TABLE IF NOT EXISTS flora_core.music_track_dismissals (
    user_uuid  uuid        NOT NULL,
    track_uuid uuid        NOT NULL,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (user_uuid, track_uuid)
);
