-- Retry-safe refresh: Auth-owned replay grants (plan §2).
-- Владелец таблицы — модуль Auth (next-architecture.md §11.1). Только additive:
-- схема user_sessions не меняется, старый refresh продолжает работать.
--
-- Одна replay-строка на session_id хранит spent hash (потраченный refresh R1),
-- replacement rotation/hash (выданный R2), fixed valid_until (граница grace),
-- версионированный AEAD payload, nonce и key id. Внутри grace повтор R1 и текущий
-- R2 отдают ровно R2 (rotation barrier); после grace старый R1 считается reuse.

CREATE TABLE IF NOT EXISTS flora_core.auth_refresh_replays (
    session_id              uuid        NOT NULL PRIMARY KEY,
    spent_hash              text        NOT NULL,
    replacement_hash        text        NOT NULL,
    replacement_rotation_id bigint      NOT NULL,
    refresh_expires_at      timestamptz NOT NULL,
    valid_until             timestamptz NOT NULL,
    key_id                  text        NOT NULL,
    nonce                   bytea       NOT NULL,
    ciphertext              bytea       NOT NULL,
    version                 integer     NOT NULL DEFAULT 1,
    created_at              timestamptz NOT NULL,
    updated_at              timestamptz NOT NULL
);

-- Concurrent loser после predicate recheck делает fallback по spent hash:
-- spent_hash глобально уникален (512-бит энтропия токена), поэтому индекс безопасен.
CREATE UNIQUE INDEX IF NOT EXISTS ux_auth_refresh_replays_spent_hash
    ON flora_core.auth_refresh_replays (spent_hash);

-- Bounded cleanup job пакетно уничтожает expired ciphertext по valid_until.
CREATE INDEX IF NOT EXISTS ix_auth_refresh_replays_valid_until
    ON flora_core.auth_refresh_replays (valid_until);
