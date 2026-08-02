-- Client list overlay: folders (+ membership) and per-peer archive/mute flags.
-- No FSCP; metadata only. System "archived" folder remains virtual (no row).

CREATE TABLE flora_core.user_chat_folders (
    folder_id UUID NOT NULL,
    owner_user_uuid UUID NOT NULL,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    icon TEXT NULL,
    avatar_uri TEXT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT pk_user_chat_folders PRIMARY KEY (folder_id),
    CONSTRAINT ck_user_chat_folders_kind CHECK (kind IN ('folder', 'group')),
    CONSTRAINT ck_user_chat_folders_label CHECK (char_length(btrim(label)) BETWEEN 1 AND 80)
);

CREATE INDEX ix_user_chat_folders_owner_sort
    ON flora_core.user_chat_folders (owner_user_uuid, sort_order, created_at);

CREATE TABLE flora_core.user_chat_folder_members (
    folder_id UUID NOT NULL,
    owner_user_uuid UUID NOT NULL,
    other_user_uuid UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT pk_user_chat_folder_members PRIMARY KEY (folder_id, other_user_uuid),
    CONSTRAINT fk_user_chat_folder_members_folder
        FOREIGN KEY (folder_id) REFERENCES flora_core.user_chat_folders (folder_id)
        ON DELETE CASCADE,
    CONSTRAINT ck_user_chat_folder_members_peer
        CHECK (other_user_uuid <> owner_user_uuid)
);

CREATE INDEX ix_user_chat_folder_members_owner
    ON flora_core.user_chat_folder_members (owner_user_uuid, other_user_uuid);

CREATE TABLE flora_core.user_conversation_flags (
    owner_user_uuid UUID NOT NULL,
    other_user_uuid UUID NOT NULL,
    is_archived BOOLEAN NOT NULL DEFAULT FALSE,
    is_muted BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT pk_user_conversation_flags PRIMARY KEY (owner_user_uuid, other_user_uuid),
    CONSTRAINT ck_user_conversation_flags_peer
        CHECK (other_user_uuid <> owner_user_uuid),
    CONSTRAINT ck_user_conversation_flags_any
        CHECK (is_archived OR is_muted)
);

CREATE INDEX ix_user_conversation_flags_owner_archived
    ON flora_core.user_conversation_flags (owner_user_uuid)
    WHERE is_archived;
