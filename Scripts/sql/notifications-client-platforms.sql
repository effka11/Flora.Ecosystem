-- Notifications: AddClientPlatformsAndNotificationTargetPlatform (20260625120000)
SET search_path TO flora_core;
ALTER TABLE flora_core.user_notifications
  ADD COLUMN IF NOT EXISTS target_platform character varying(16);

CREATE TABLE IF NOT EXISTS flora_core.user_client_platforms (
  user_uuid uuid NOT NULL,
  platform character varying(16) NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_user_client_platforms PRIMARY KEY (user_uuid, platform)
);

CREATE INDEX IF NOT EXISTS ix_user_client_platforms_platform_user
  ON flora_core.user_client_platforms (platform, user_uuid);

INSERT INTO "__EFMigrationsHistory" (migration_id, product_version)
VALUES ('20260625120000_AddClientPlatformsAndNotificationTargetPlatform', '10.0.0')
ON CONFLICT DO NOTHING;
