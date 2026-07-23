ALTER TABLE flora_core.user_push_tokens
    ADD COLUMN IF NOT EXISTS "Provider" text NULL,
    ADD COLUMN IF NOT EXISTS "InstallationUuid" uuid NULL,
    ADD COLUMN IF NOT EXISTS "SecurePreviewVersion" integer NULL,
    ADD COLUMN IF NOT EXISTS "PreviewKeyId" uuid NULL,
    ADD COLUMN IF NOT EXISTS "PreviewPublicKey" text NULL;

CREATE INDEX IF NOT EXISTS "IX_user_push_tokens_UserUuid_InstallationUuid"
    ON flora_core.user_push_tokens ("UserUuid", "InstallationUuid")
    WHERE "InstallationUuid" IS NOT NULL;
