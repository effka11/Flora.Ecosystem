-- FSCP-FRANK product queue: exclusive-claim reports, blind receipts, E2E wraps.
-- Additive only; user_messages is not rewritten.
-- Rollback (flora-migrate is up-only; operator, in order):
--   DROP TRIGGER IF EXISTS tg_user_messages_franking_live ON flora_core.user_messages;
--   DROP TRIGGER IF EXISTS tg_user_messages_franking_live_truncate ON flora_core.user_messages;
--   DROP TRIGGER IF EXISTS tg_franking_reports_audit_cascade ON flora_core.franking_reports;
--   DROP TRIGGER IF EXISTS tg_franking_report_audit_append_only ON flora_core.franking_report_audit;
--   DROP TRIGGER IF EXISTS tg_franking_report_audit_no_truncate ON flora_core.franking_report_audit;
--   DROP FUNCTION IF EXISTS flora_core.tg_franking_block_live_message_delete();
--   DROP FUNCTION IF EXISTS flora_core.tg_franking_block_live_message_truncate();
--   DROP FUNCTION IF EXISTS flora_core.tg_franking_mark_audit_cascade();
--   DROP FUNCTION IF EXISTS flora_core.tg_franking_audit_append_only();
--   DROP FUNCTION IF EXISTS flora_core.tg_franking_audit_no_truncate();
--   DROP TABLE IF EXISTS flora_core.franking_report_audit;
--   DROP TABLE IF EXISTS flora_core.franking_disclosure_wraps;
--   DROP TABLE IF EXISTS flora_core.franking_reports;
--   DROP TABLE IF EXISTS flora_core.user_message_frank_receipts;
--   DROP TABLE IF EXISTS flora_core.franking_reviewers;

CREATE TABLE flora_core.franking_reviewers (
    user_uuid UUID NOT NULL,
    added_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    CONSTRAINT pk_franking_reviewers PRIMARY KEY (user_uuid)
);

CREATE TABLE flora_core.user_message_frank_receipts (
    message_uuid UUID NOT NULL,
    wire_message_uuid UUID NOT NULL,
    frank_tag BYTEA NOT NULL,
    receipt_payload TEXT NOT NULL,
    signature BYTEA NOT NULL,
    key_id UUID NOT NULL,
    server_received_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT pk_user_message_frank_receipts PRIMARY KEY (message_uuid),
    CONSTRAINT fk_user_message_frank_receipts_message
        FOREIGN KEY (message_uuid)
        REFERENCES flora_core.user_messages (message_uuid)
        ON DELETE CASCADE,
    CONSTRAINT ck_user_message_frank_receipts_tag
        CHECK (octet_length(frank_tag) = 32),
    CONSTRAINT ck_user_message_frank_receipts_sig
        CHECK (octet_length(signature) = 64)
);

CREATE TABLE flora_core.franking_reports (
    report_uuid UUID NOT NULL,
    persisted_message_uuid UUID NOT NULL,
    wire_message_uuid UUID NOT NULL,
    conversation_uuid UUID NOT NULL,
    reporter_user_uuid UUID NOT NULL,
    accused_user_uuid UUID NOT NULL,
    category TEXT NOT NULL,
    status TEXT NOT NULL,
    claimed_by UUID,
    claimed_at TIMESTAMPTZ,
    disclosure_ciphertext BYTEA NOT NULL,
    resolution_code TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT pk_franking_reports PRIMARY KEY (report_uuid),
    -- Live reports block DELETE via tg_user_messages_franking_live.
    -- Terminal rows CASCADE so resolved/rejected do not pin the DM forever
    -- (franking.md §4.7: RESTRICT is for a live queue item).
    CONSTRAINT fk_franking_reports_message
        FOREIGN KEY (persisted_message_uuid)
        REFERENCES flora_core.user_messages (message_uuid)
        ON DELETE CASCADE,
    CONSTRAINT ck_franking_reports_category
        CHECK (category IN ('abuse', 'threats', 'spam', 'csam', 'other')),
    CONSTRAINT ck_franking_reports_status
        CHECK (status IN (
            'open',
            'claimed',
            'claimed_awaiting_disclosure',
            'resolved',
            'rejected'
        )),
    CONSTRAINT ck_franking_reports_disclosure
        CHECK (
            octet_length(disclosure_ciphertext) > 0
            AND octet_length(disclosure_ciphertext) <= 262144
        ),
    CONSTRAINT uq_franking_reports_reporter_message
        UNIQUE (reporter_user_uuid, persisted_message_uuid)
);

CREATE INDEX ix_franking_reports_queue
    ON flora_core.franking_reports (created_at, report_uuid)
    WHERE status IN ('open', 'claimed', 'claimed_awaiting_disclosure');

CREATE INDEX ix_franking_reports_claimed_by
    ON flora_core.franking_reports (claimed_by)
    WHERE claimed_by IS NOT NULL;

CREATE TABLE flora_core.franking_disclosure_wraps (
    report_uuid UUID NOT NULL,
    user_uuid UUID NOT NULL,
    device_uuid UUID NOT NULL,
    wrapped_key BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT pk_franking_disclosure_wraps
        PRIMARY KEY (report_uuid, user_uuid, device_uuid),
    CONSTRAINT fk_franking_disclosure_wraps_report
        FOREIGN KEY (report_uuid)
        REFERENCES flora_core.franking_reports (report_uuid)
        ON DELETE CASCADE,
    CONSTRAINT ck_franking_disclosure_wraps_key
        CHECK (
            octet_length(wrapped_key) > 0
            AND octet_length(wrapped_key) <= 8192
        )
);

CREATE TABLE flora_core.franking_report_audit (
    audit_uuid UUID NOT NULL,
    report_uuid UUID NOT NULL,
    event TEXT NOT NULL,
    actor_user_uuid UUID NOT NULL,
    subject_user_uuid UUID,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT pk_franking_report_audit PRIMARY KEY (audit_uuid),
    CONSTRAINT fk_franking_report_audit_report
        FOREIGN KEY (report_uuid)
        REFERENCES flora_core.franking_reports (report_uuid)
        ON DELETE CASCADE,
    CONSTRAINT ck_franking_report_audit_event
        CHECK (event IN (
            'wrap_created',
            'wrap_destroyed',
            'claimed',
            'released',
            'forwarded',
            'disclosure_fetched',
            'resolved',
            'rejected'
        ))
);

CREATE INDEX ix_franking_report_audit_report
    ON flora_core.franking_report_audit (report_uuid, created_at);

CREATE FUNCTION flora_core.tg_franking_block_live_message_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM flora_core.franking_reports
        WHERE persisted_message_uuid = OLD.message_uuid
          AND status IN ('open', 'claimed', 'claimed_awaiting_disclosure')
    ) THEN
        RAISE EXCEPTION 'live franking report'
            USING ERRCODE = '23503',
                  CONSTRAINT = 'fk_franking_live_message';
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER tg_user_messages_franking_live
    BEFORE DELETE ON flora_core.user_messages
    FOR EACH ROW
    EXECUTE FUNCTION flora_core.tg_franking_block_live_message_delete();

CREATE FUNCTION flora_core.tg_franking_block_live_message_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM flora_core.franking_reports
        WHERE status IN ('open', 'claimed', 'claimed_awaiting_disclosure')
    ) THEN
        RAISE EXCEPTION 'live franking report'
            USING ERRCODE = '23503',
                  CONSTRAINT = 'fk_franking_live_message';
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER tg_user_messages_franking_live_truncate
    BEFORE TRUNCATE ON flora_core.user_messages
    FOR EACH STATEMENT
    EXECUTE FUNCTION flora_core.tg_franking_block_live_message_truncate();

CREATE FUNCTION flora_core.tg_franking_mark_audit_cascade()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM set_config('flora.franking_audit_cascade', '1', true);
    RETURN OLD;
END;
$$;

CREATE TRIGGER tg_franking_reports_audit_cascade
    BEFORE DELETE ON flora_core.franking_reports
    FOR EACH ROW
    EXECUTE FUNCTION flora_core.tg_franking_mark_audit_cascade();

CREATE FUNCTION flora_core.tg_franking_audit_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE'
       AND current_setting('flora.franking_audit_cascade', true) = '1' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'franking audit is append-only'
        USING ERRCODE = '27000';
END;
$$;

CREATE TRIGGER tg_franking_report_audit_append_only
    BEFORE UPDATE OR DELETE ON flora_core.franking_report_audit
    FOR EACH ROW
    EXECUTE FUNCTION flora_core.tg_franking_audit_append_only();

CREATE FUNCTION flora_core.tg_franking_audit_no_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'franking audit is append-only'
        USING ERRCODE = '27000';
END;
$$;

CREATE TRIGGER tg_franking_report_audit_no_truncate
    BEFORE TRUNCATE ON flora_core.franking_report_audit
    FOR EACH STATEMENT
    EXECUTE FUNCTION flora_core.tg_franking_audit_no_truncate();
