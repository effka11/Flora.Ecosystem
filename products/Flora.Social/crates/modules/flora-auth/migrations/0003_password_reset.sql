-- Password reset: pending email challenges + short-lived completion grants.
-- Владелец — модуль Auth (next-architecture.md §11.1). Только additive.

CREATE TABLE IF NOT EXISTS flora_core.pending_password_resets (
    reset_token   uuid        NOT NULL PRIMARY KEY,
    user_uuid     uuid        NOT NULL,
    email         text        NOT NULL,
    expires_at    timestamptz NOT NULL,
    created_at    timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_pending_password_resets_user_uuid
    ON flora_core.pending_password_resets (user_uuid);

CREATE INDEX IF NOT EXISTS ix_pending_password_resets_email
    ON flora_core.pending_password_resets (email);

CREATE INDEX IF NOT EXISTS ix_pending_password_resets_expires_at
    ON flora_core.pending_password_resets (expires_at);

CREATE TABLE IF NOT EXISTS flora_core.password_reset_grants (
    completion_token uuid        NOT NULL PRIMARY KEY,
    user_uuid        uuid        NOT NULL,
    expires_at       timestamptz NOT NULL,
    created_at       timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_password_reset_grants_user_uuid
    ON flora_core.password_reset_grants (user_uuid);

CREATE INDEX IF NOT EXISTS ix_password_reset_grants_expires_at
    ON flora_core.password_reset_grants (expires_at);
