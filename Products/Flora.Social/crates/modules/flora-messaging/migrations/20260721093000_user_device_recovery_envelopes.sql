-- D2D recovery transport (e2e-security.md §Devices recover-key):
-- сервер хранит opaque DeviceToDeviceRecoveryEnvelope для target-устройства
-- до истечения TTL. Ciphertext расшифровывается только target-устройством;
-- сервер сохраняет canonical JSON после структурной проверки и проверки подписи.
CREATE TABLE flora_core.user_device_recovery_envelopes (
    user_uuid UUID NOT NULL,
    key_epoch_id UUID NOT NULL,
    target_device_uuid UUID NOT NULL,
    source_device_uuid UUID NOT NULL,
    recovery_request_id UUID NOT NULL,
    transferred_key_epoch_ids UUID[] NOT NULL,
    envelope_canonical_json TEXT NOT NULL,
    request_body_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT pk_user_device_recovery_envelopes
        PRIMARY KEY (user_uuid, key_epoch_id, target_device_uuid),
    CONSTRAINT ck_user_device_recovery_envelopes_epoch_count
        CHECK (cardinality(transferred_key_epoch_ids) BETWEEN 1 AND 64),
    CONSTRAINT ck_user_device_recovery_envelopes_hash
        CHECK (request_body_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_user_device_recovery_envelopes_ttl
        CHECK (expires_at > created_at)
);

CREATE INDEX ix_user_device_recovery_envelopes_expires_at
    ON flora_core.user_device_recovery_envelopes (expires_at);
