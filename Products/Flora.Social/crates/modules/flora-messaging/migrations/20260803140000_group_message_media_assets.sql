-- FSCP-G group opaque media (voice/image). Membership ACL; file keys stay in E2E wire.
-- Spec: Documents/fscp/groups-and-organizer.md (media extension).

CREATE TABLE flora_core.group_message_voice_assets (
    voice_asset_uuid UUID NOT NULL,
    conversation_uuid UUID NOT NULL,
    uploader_user_uuid UUID NOT NULL,
    content_type TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    encrypted_bytes BYTEA NOT NULL,
    message_uuid UUID NULL,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT pk_group_message_voice_assets PRIMARY KEY (voice_asset_uuid),
    CONSTRAINT fk_group_message_voice_assets_conversation
        FOREIGN KEY (conversation_uuid) REFERENCES flora_core.group_conversations (conversation_uuid)
        ON DELETE CASCADE,
    CONSTRAINT ck_group_message_voice_assets_duration CHECK (duration_ms > 0)
);

CREATE INDEX ix_group_message_voice_assets_conversation
    ON flora_core.group_message_voice_assets (conversation_uuid);

CREATE INDEX ix_group_message_voice_assets_message
    ON flora_core.group_message_voice_assets (message_uuid)
    WHERE message_uuid IS NOT NULL;

CREATE TABLE flora_core.group_message_image_assets (
    image_asset_uuid UUID NOT NULL,
    conversation_uuid UUID NOT NULL,
    uploader_user_uuid UUID NOT NULL,
    content_type TEXT NOT NULL,
    encrypted_bytes BYTEA NOT NULL,
    message_uuid UUID NULL,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT pk_group_message_image_assets PRIMARY KEY (image_asset_uuid),
    CONSTRAINT fk_group_message_image_assets_conversation
        FOREIGN KEY (conversation_uuid) REFERENCES flora_core.group_conversations (conversation_uuid)
        ON DELETE CASCADE
);

CREATE INDEX ix_group_message_image_assets_conversation
    ON flora_core.group_message_image_assets (conversation_uuid);

CREATE INDEX ix_group_message_image_assets_message
    ON flora_core.group_message_image_assets (message_uuid)
    WHERE message_uuid IS NOT NULL;
