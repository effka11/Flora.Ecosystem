-- FSCP-G v1: server-issued group conversations, roster, single-wire messages, per-member reads.
-- Spec: Documents/fscp/groups-and-organizer.md. Bootstrap key epoch only.

CREATE TABLE flora_core.group_conversations (
    conversation_uuid UUID NOT NULL,
    title TEXT NOT NULL,
    created_by_user_uuid UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    current_key_epoch_id UUID NOT NULL,
    CONSTRAINT pk_group_conversations PRIMARY KEY (conversation_uuid),
    CONSTRAINT ck_group_conversations_title CHECK (char_length(btrim(title)) BETWEEN 1 AND 40)
);

CREATE TABLE flora_core.group_members (
    conversation_uuid UUID NOT NULL,
    user_uuid UUID NOT NULL,
    joined_at TIMESTAMPTZ NOT NULL,
    left_at TIMESTAMPTZ NULL,
    CONSTRAINT pk_group_members PRIMARY KEY (conversation_uuid, user_uuid),
    CONSTRAINT fk_group_members_conversation
        FOREIGN KEY (conversation_uuid) REFERENCES flora_core.group_conversations (conversation_uuid)
        ON DELETE CASCADE
);

CREATE UNIQUE INDEX uq_group_members_active
    ON flora_core.group_members (conversation_uuid, user_uuid)
    WHERE left_at IS NULL;

CREATE INDEX ix_group_members_user_active
    ON flora_core.group_members (user_uuid)
    WHERE left_at IS NULL;

CREATE TABLE flora_core.group_messages (
    message_uuid UUID NOT NULL,
    conversation_uuid UUID NOT NULL,
    sender_user_uuid UUID NOT NULL,
    encrypted_wire TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT pk_group_messages PRIMARY KEY (conversation_uuid, message_uuid),
    CONSTRAINT fk_group_messages_conversation
        FOREIGN KEY (conversation_uuid) REFERENCES flora_core.group_conversations (conversation_uuid)
        ON DELETE CASCADE
);

CREATE INDEX ix_group_messages_conversation_created
    ON flora_core.group_messages (conversation_uuid, created_at DESC);

CREATE TABLE flora_core.group_message_reads (
    conversation_uuid UUID NOT NULL,
    user_uuid UUID NOT NULL,
    last_read_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT pk_group_message_reads PRIMARY KEY (conversation_uuid, user_uuid),
    CONSTRAINT fk_group_message_reads_conversation
        FOREIGN KEY (conversation_uuid) REFERENCES flora_core.group_conversations (conversation_uuid)
        ON DELETE CASCADE
);
