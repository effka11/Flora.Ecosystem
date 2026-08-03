-- Per-owner archive/mute projection for FSCP-G groups (badge / folder-icon LIMIT).
-- E2E organizer remains UX SoT; this table mirrors archivedByConversation for SQL.

CREATE TABLE flora_core.user_group_conversation_flags (
    owner_user_uuid UUID NOT NULL,
    conversation_uuid UUID NOT NULL,
    is_archived BOOLEAN NOT NULL DEFAULT FALSE,
    is_muted BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT pk_user_group_conversation_flags
        PRIMARY KEY (owner_user_uuid, conversation_uuid),
    CONSTRAINT fk_user_group_conversation_flags_conversation
        FOREIGN KEY (conversation_uuid)
        REFERENCES flora_core.group_conversations (conversation_uuid)
        ON DELETE CASCADE,
    CONSTRAINT ck_user_group_conversation_flags_any
        CHECK (is_archived OR is_muted)
);

CREATE INDEX ix_user_group_conversation_flags_owner_archived
    ON flora_core.user_group_conversation_flags (owner_user_uuid)
    WHERE is_archived;
