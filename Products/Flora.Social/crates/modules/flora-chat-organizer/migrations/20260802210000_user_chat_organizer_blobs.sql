-- FSCP-ORG v1: opaque E2E chat-organizer blob per owner.
-- Server stores (owner, revision, wire) only — never decrypts plaintext folders/mute.

CREATE TABLE flora_core.user_chat_organizer_blobs (
    owner_user_uuid UUID PRIMARY KEY,
    revision BIGINT NOT NULL CHECK (revision >= 1),
    wire TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
