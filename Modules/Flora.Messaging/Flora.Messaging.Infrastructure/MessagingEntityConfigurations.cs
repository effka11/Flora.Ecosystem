using Flora.Messaging.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Flora.Messaging.Infrastructure;

public class UserMessageConfiguration : IEntityTypeConfiguration<UserMessage>
{
    public void Configure(EntityTypeBuilder<UserMessage> builder)
    {
        builder.ToTable("user_messages", "flora_core");
        builder.HasKey(e => e.MessageUuid).HasName("pk_user_messages");
        builder.Property(e => e.MessageUuid).HasColumnName("message_uuid");
        builder.Property(e => e.SenderUserUuid).HasColumnName("sender_user_uuid");
        builder.Property(e => e.ReceiverUserUuid).HasColumnName("receiver_user_uuid");
        builder.Property(e => e.Content).HasColumnName("content").HasMaxLength(2000);
        builder.Property(e => e.EncryptedForReceiver).HasColumnName("encrypted_for_receiver");
        builder.Property(e => e.EncryptedForSender).HasColumnName("encrypted_for_sender");
        builder.Property(e => e.CreatedAt).HasColumnName("created_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.Property(e => e.IsRead).HasColumnName("is_read").HasDefaultValue(false);

        // Inbox / peer list: WHERE sender|receiver = user ORDER BY created_at DESC.
        builder.HasIndex(e => new { e.SenderUserUuid, e.CreatedAt, e.MessageUuid })
               .IsDescending(false, true, false)
               .HasDatabaseName("ix_user_messages_sender_timeline");
        builder.HasIndex(e => new { e.ReceiverUserUuid, e.CreatedAt, e.MessageUuid })
               .IsDescending(false, true, false)
               .HasDatabaseName("ix_user_messages_receiver_timeline");

        // Thread page (sender → receiver) and mark-read on unread incoming rows.
        builder.HasIndex(e => new { e.SenderUserUuid, e.ReceiverUserUuid, e.CreatedAt, e.MessageUuid })
               .IsDescending(false, false, true, false)
               .HasDatabaseName("ix_user_messages_conversation_cursor");
        builder.HasIndex(e => new { e.ReceiverUserUuid, e.SenderUserUuid, e.CreatedAt, e.MessageUuid })
               .IsDescending(false, false, true, false)
               .HasDatabaseName("ix_user_messages_conversation_cursor_rev");
        builder.HasIndex(e => new { e.ReceiverUserUuid, e.SenderUserUuid })
               .HasDatabaseName("ix_user_messages_unread_peer")
               .HasFilter("is_read = false");
    }
}

public class UserE2EKeyConfiguration : IEntityTypeConfiguration<UserE2EKey>
{
    public void Configure(EntityTypeBuilder<UserE2EKey> builder)
    {
        builder.ToTable("user_e2e_keys", "flora_core");
        builder.HasKey(e => e.UserUuid).HasName("pk_user_e2e_keys");
        builder.Property(e => e.UserUuid).HasColumnName("user_uuid");
        builder.Property(e => e.PublicKeyBase64).HasColumnName("public_key_base64").IsRequired();
        builder.Property(e => e.DeviceUuid).HasColumnName("device_uuid");
        builder.Property(e => e.UpdatedAt).HasColumnName("updated_at").HasDefaultValueSql("CURRENT_TIMESTAMP");

        builder.HasIndex(e => e.DeviceUuid)
               .IsUnique()
               .HasFilter("device_uuid IS NOT NULL")
               .HasDatabaseName("ux_user_e2e_keys_device_uuid");
    }
}

public class UserMessageVoiceAssetConfiguration : IEntityTypeConfiguration<UserMessageVoiceAsset>
{
    public void Configure(EntityTypeBuilder<UserMessageVoiceAsset> builder)
    {
        builder.ToTable("user_message_voice_assets", "flora_core");
        builder.HasKey(e => e.VoiceAssetUuid).HasName("pk_user_message_voice_assets");
        builder.Property(e => e.VoiceAssetUuid).HasColumnName("voice_asset_uuid");
        builder.Property(e => e.SenderUserUuid).HasColumnName("sender_user_uuid");
        builder.Property(e => e.ReceiverUserUuid).HasColumnName("receiver_user_uuid");
        builder.Property(e => e.MessageUuid).HasColumnName("message_uuid");
        builder.Property(e => e.ContentType).HasColumnName("content_type").HasMaxLength(100).IsRequired();
        builder.Property(e => e.DurationMs).HasColumnName("duration_ms");
        builder.Property(e => e.EncryptedBytes).HasColumnName("encrypted_bytes").IsRequired();
        builder.Property(e => e.CreatedAt).HasColumnName("created_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.HasIndex(e => e.SenderUserUuid).HasDatabaseName("ix_user_message_voice_assets_sender_user_uuid");
        builder.HasIndex(e => e.ReceiverUserUuid).HasDatabaseName("ix_user_message_voice_assets_receiver_user_uuid");
        builder.HasIndex(e => e.MessageUuid).HasDatabaseName("ix_user_message_voice_assets_message_uuid");
        builder.HasIndex(e => new { e.SenderUserUuid, e.ReceiverUserUuid, e.CreatedAt })
               .IsDescending(false, false, true)
               .HasDatabaseName("ix_user_message_voice_assets_peer_created");

        builder.HasOne<UserMessage>()
               .WithMany()
               .HasForeignKey(e => e.MessageUuid)
               .OnDelete(DeleteBehavior.SetNull)
               .HasConstraintName("fk_user_message_voice_assets_message");
    }
}

public class UserMessageImageAssetConfiguration : IEntityTypeConfiguration<UserMessageImageAsset>
{
    public void Configure(EntityTypeBuilder<UserMessageImageAsset> builder)
    {
        builder.ToTable("user_message_image_assets", "flora_core");
        builder.HasKey(e => e.ImageAssetUuid).HasName("pk_user_message_image_assets");
        builder.Property(e => e.ImageAssetUuid).HasColumnName("image_asset_uuid");
        builder.Property(e => e.SenderUserUuid).HasColumnName("sender_user_uuid");
        builder.Property(e => e.ReceiverUserUuid).HasColumnName("receiver_user_uuid");
        builder.Property(e => e.MessageUuid).HasColumnName("message_uuid");
        builder.Property(e => e.ContentType).HasColumnName("content_type").HasMaxLength(100).IsRequired();
        builder.Property(e => e.EncryptedBytes).HasColumnName("encrypted_bytes").IsRequired();
        builder.Property(e => e.CreatedAt).HasColumnName("created_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.HasIndex(e => e.SenderUserUuid).HasDatabaseName("ix_user_message_image_assets_sender_user_uuid");
        builder.HasIndex(e => e.ReceiverUserUuid).HasDatabaseName("ix_user_message_image_assets_receiver_user_uuid");
        builder.HasIndex(e => e.MessageUuid).HasDatabaseName("ix_user_message_image_assets_message_uuid");
        builder.HasIndex(e => new { e.SenderUserUuid, e.ReceiverUserUuid, e.CreatedAt })
               .IsDescending(false, false, true)
               .HasDatabaseName("ix_user_message_image_assets_peer_created");

        builder.HasOne<UserMessage>()
               .WithMany()
               .HasForeignKey(e => e.MessageUuid)
               .OnDelete(DeleteBehavior.SetNull)
               .HasConstraintName("fk_user_message_image_assets_message");
    }
}

public class UserMessageVideoAssetConfiguration : IEntityTypeConfiguration<UserMessageVideoAsset>
{
    public void Configure(EntityTypeBuilder<UserMessageVideoAsset> builder)
    {
        builder.ToTable("user_message_video_assets", "flora_core");
        builder.HasKey(e => e.VideoAssetUuid).HasName("pk_user_message_video_assets");
        builder.Property(e => e.VideoAssetUuid).HasColumnName("video_asset_uuid");
        builder.Property(e => e.SenderUserUuid).HasColumnName("sender_user_uuid");
        builder.Property(e => e.ReceiverUserUuid).HasColumnName("receiver_user_uuid");
        builder.Property(e => e.MessageUuid).HasColumnName("message_uuid");
        builder.Property(e => e.ContentType).HasColumnName("content_type").HasMaxLength(100).IsRequired();
        builder.Property(e => e.DurationMs).HasColumnName("duration_ms");
        builder.Property(e => e.EncryptedBytes).HasColumnName("encrypted_bytes").IsRequired();
        builder.Property(e => e.CreatedAt).HasColumnName("created_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.HasIndex(e => e.SenderUserUuid).HasDatabaseName("ix_user_message_video_assets_sender_user_uuid");
        builder.HasIndex(e => e.ReceiverUserUuid).HasDatabaseName("ix_user_message_video_assets_receiver_user_uuid");
        builder.HasIndex(e => e.MessageUuid).HasDatabaseName("ix_user_message_video_assets_message_uuid");
        builder.HasIndex(e => new { e.SenderUserUuid, e.ReceiverUserUuid, e.CreatedAt })
               .IsDescending(false, false, true)
               .HasDatabaseName("ix_user_message_video_assets_peer_created");

        builder.HasOne<UserMessage>()
               .WithMany()
               .HasForeignKey(e => e.MessageUuid)
               .OnDelete(DeleteBehavior.SetNull)
               .HasConstraintName("fk_user_message_video_assets_message");
    }
}

public class UserE2EAccountStateConfiguration : IEntityTypeConfiguration<UserE2EAccountState>
{
    public void Configure(EntityTypeBuilder<UserE2EAccountState> builder)
    {
        builder.ToTable("user_e2e_account_states", "flora_core");
        builder.HasKey(e => e.UserUuid).HasName("pk_user_e2e_account_states");
        builder.Property(e => e.UserUuid).HasColumnName("user_uuid");
        builder.Property(e => e.State).HasColumnName("state")
               .HasConversion<string>().HasMaxLength(30).IsRequired();
        builder.Property(e => e.Freeze).HasColumnName("freeze").HasDefaultValue(false);
        builder.Property(e => e.CreatedAt).HasColumnName("created_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.Property(e => e.UpdatedAt).HasColumnName("updated_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
    }
}

public class UserE2EKeyBackupConfiguration : IEntityTypeConfiguration<UserE2EKeyBackup>
{
    public void Configure(EntityTypeBuilder<UserE2EKeyBackup> builder)
    {
        builder.ToTable("user_e2e_key_backups", "flora_core");
        builder.HasKey(e => e.UserUuid).HasName("pk_user_e2e_key_backups");
        builder.Property(e => e.UserUuid).HasColumnName("user_uuid");
        builder.Property(e => e.Version).HasColumnName("version");
        builder.Property(e => e.BackupRevision).HasColumnName("backup_revision");
        builder.Property(e => e.BackupKeyId).HasColumnName("backup_key_id");
        builder.Property(e => e.PrimaryKeyEpochId).HasColumnName("primary_key_epoch_id");
        builder.Property(e => e.EpochSetRevision).HasColumnName("epoch_set_revision");
        builder.Property(e => e.EpochSetHashBase64Url).HasColumnName("epoch_set_hash_base64url").IsRequired();
        builder.Property(e => e.KdfName).HasColumnName("kdf_name").HasMaxLength(50).IsRequired();
        builder.Property(e => e.KdfMemoryKiB).HasColumnName("kdf_memory_kib");
        builder.Property(e => e.KdfIterations).HasColumnName("kdf_iterations");
        builder.Property(e => e.KdfParallelism).HasColumnName("kdf_parallelism");
        builder.Property(e => e.KdfSaltBase64Url).HasColumnName("kdf_salt_base64url").IsRequired();
        builder.Property(e => e.AeadName).HasColumnName("aead_name").HasMaxLength(50).IsRequired();
        builder.Property(e => e.AeadNonceBase64Url).HasColumnName("aead_nonce_base64url").IsRequired();
        builder.Property(e => e.CiphertextBase64Url).HasColumnName("ciphertext_base64url").IsRequired();
        builder.Property(e => e.CreatedAt).HasColumnName("created_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.Property(e => e.UpdatedAt).HasColumnName("updated_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
    }
}

public class UserE2ERecoveryBackupConfiguration : IEntityTypeConfiguration<UserE2ERecoveryBackup>
{
    public void Configure(EntityTypeBuilder<UserE2ERecoveryBackup> builder)
    {
        builder.ToTable("user_e2e_recovery_backups", "flora_core");
        builder.HasKey(e => e.RecoveryKeyId).HasName("pk_user_e2e_recovery_backups");
        builder.Property(e => e.RecoveryKeyId).HasColumnName("recovery_key_id");
        builder.Property(e => e.UserUuid).HasColumnName("user_uuid");
        builder.Property(e => e.Version).HasColumnName("version");
        builder.Property(e => e.RecoveryRevision).HasColumnName("recovery_revision");
        builder.Property(e => e.PrimaryKeyEpochId).HasColumnName("primary_key_epoch_id");
        builder.Property(e => e.EpochSetRevision).HasColumnName("epoch_set_revision");
        builder.Property(e => e.EpochSetHashBase64Url).HasColumnName("epoch_set_hash_base64url").IsRequired();
        builder.Property(e => e.WordlistId).HasColumnName("wordlist_id").HasMaxLength(100).IsRequired();
        builder.Property(e => e.WordsCount).HasColumnName("words_count");
        builder.Property(e => e.KdfName).HasColumnName("kdf_name").HasMaxLength(50).IsRequired();
        builder.Property(e => e.KdfMemoryKiB).HasColumnName("kdf_memory_kib");
        builder.Property(e => e.KdfIterations).HasColumnName("kdf_iterations");
        builder.Property(e => e.KdfParallelism).HasColumnName("kdf_parallelism");
        builder.Property(e => e.KdfSaltBase64Url).HasColumnName("kdf_salt_base64url").IsRequired();
        builder.Property(e => e.AeadName).HasColumnName("aead_name").HasMaxLength(50).IsRequired();
        builder.Property(e => e.AeadNonceBase64Url).HasColumnName("aead_nonce_base64url").IsRequired();
        builder.Property(e => e.CiphertextBase64Url).HasColumnName("ciphertext_base64url").IsRequired();
        builder.Property(e => e.CreatedAt).HasColumnName("created_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.Property(e => e.UpdatedAt).HasColumnName("updated_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.Property(e => e.UsedAt).HasColumnName("used_at");
        builder.HasIndex(e => new { e.UserUuid, e.CreatedAt })
               .IsDescending(false, true)
               .HasDatabaseName("ix_user_e2e_recovery_backups_user_created");
        builder.HasIndex(e => new { e.UserUuid, e.RecoveryKeyId })
               .HasDatabaseName("ix_user_e2e_recovery_backups_user_recovery_key");
    }
}

public class KeyEpochPublicIdentityConfiguration : IEntityTypeConfiguration<KeyEpochPublicIdentity>
{
    public void Configure(EntityTypeBuilder<KeyEpochPublicIdentity> builder)
    {
        builder.ToTable("key_epoch_public_identities", "flora_core");
        builder.HasKey(e => new { e.UserUuid, e.KeyEpochId }).HasName("pk_key_epoch_public_identities");
        builder.Property(e => e.UserUuid).HasColumnName("user_uuid");
        builder.Property(e => e.KeyEpochId).HasColumnName("key_epoch_id");
        builder.Property(e => e.EpochAccountIdentityPublicKeyBase64Url)
               .HasColumnName("epoch_account_identity_public_key_base64url").IsRequired();
        builder.Property(e => e.CreatedAt).HasColumnName("created_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.Property(e => e.UpdatedAt).HasColumnName("updated_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
    }
}

// ── Phase 3 entities ─────────────────────────────────────────────────────────

public class UserDeviceKeyConfiguration : IEntityTypeConfiguration<UserDeviceKey>
{
    public void Configure(EntityTypeBuilder<UserDeviceKey> builder)
    {
        builder.ToTable("user_device_keys", "flora_core");
        builder.HasKey(e => e.DeviceUuid).HasName("pk_user_device_keys");
        builder.Property(e => e.DeviceUuid).HasColumnName("device_uuid");
        builder.Property(e => e.UserUuid).HasColumnName("user_uuid");
        builder.Property(e => e.KeyEpochId).HasColumnName("key_epoch_id");
        builder.Property(e => e.DisplayName).HasColumnName("display_name").HasMaxLength(100);
        builder.Property(e => e.SigningPublicKeyBase64Url)
               .HasColumnName("signing_public_key_base64url").IsRequired();
        builder.Property(e => e.AgreementPublicKeyBase64Url)
               .HasColumnName("agreement_public_key_base64url").IsRequired();
        builder.Property(e => e.SignedByEpochAccountIdentityBase64Url)
               .HasColumnName("signed_by_epoch_account_identity_base64url");
        builder.Property(e => e.Status).HasColumnName("status")
               .HasConversion<string>().HasMaxLength(20).IsRequired();
        builder.Property(e => e.CreatedAt).HasColumnName("created_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.Property(e => e.LastSeenAt).HasColumnName("last_seen_at");
        builder.Property(e => e.RevokedAt).HasColumnName("revoked_at");

        builder.HasIndex(e => new { e.UserUuid, e.KeyEpochId, e.CreatedAt })
               .HasDatabaseName("ix_user_device_keys_user_epoch_created");
        builder.HasIndex(e => new { e.UserUuid, e.KeyEpochId, e.Status })
               .HasDatabaseName("ix_user_device_keys_user_epoch_status");
    }
}

public class UserE2EUnlockChallengeConfiguration : IEntityTypeConfiguration<UserE2EUnlockChallenge>
{
    public void Configure(EntityTypeBuilder<UserE2EUnlockChallenge> builder)
    {
        builder.ToTable("user_e2e_unlock_challenges", "flora_core");
        builder.HasKey(e => e.ChallengeId).HasName("pk_user_e2e_unlock_challenges");
        builder.Property(e => e.ChallengeId).HasColumnName("challenge_id");
        builder.Property(e => e.UserUuid).HasColumnName("user_uuid");
        builder.Property(e => e.ResetRequestId).HasColumnName("reset_request_id");
        builder.Property(e => e.CanonicalPayloadPreview)
               .HasColumnName("canonical_payload_preview").HasMaxLength(2000).IsRequired();
        builder.Property(e => e.ExpiresAt).HasColumnName("expires_at");
        builder.Property(e => e.IsUsed).HasColumnName("is_used").HasDefaultValue(false);
        builder.Property(e => e.CreatedAt).HasColumnName("created_at").HasDefaultValueSql("CURRENT_TIMESTAMP");

        builder.HasIndex(e => new { e.UserUuid, e.ChallengeId })
               .HasDatabaseName("ix_user_e2e_unlock_challenges_user_challenge");
        builder.HasIndex(e => new { e.UserUuid, e.ResetRequestId })
               .HasDatabaseName("ix_user_e2e_unlock_challenges_user_reset");
        builder.HasIndex(e => new { e.UserUuid, e.IsUsed, e.ExpiresAt })
               .HasDatabaseName("ix_user_e2e_unlock_challenges_user_active");
        builder.HasIndex(e => e.ExpiresAt)
               .HasDatabaseName("ix_user_e2e_unlock_challenges_expires_at");
    }
}

public class UserE2EIdempotencyRecordConfiguration : IEntityTypeConfiguration<UserE2EIdempotencyRecord>
{
    public void Configure(EntityTypeBuilder<UserE2EIdempotencyRecord> builder)
    {
        builder.ToTable("user_e2e_idempotency_records", "flora_core");
        builder.HasKey(e => e.IdempotencyKey).HasName("pk_user_e2e_idempotency_records");
        builder.Property(e => e.IdempotencyKey).HasColumnName("idempotency_key");
        builder.Property(e => e.UserUuid).HasColumnName("user_uuid");
        builder.Property(e => e.Operation).HasColumnName("operation").HasMaxLength(50).IsRequired();
        builder.Property(e => e.RequestBodyHash).HasColumnName("request_body_hash").HasMaxLength(64).IsRequired();
        builder.Property(e => e.CreatedAt).HasColumnName("created_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.Property(e => e.ExpiresAt).HasColumnName("expires_at");

        builder.HasIndex(e => new { e.UserUuid, e.Operation, e.CreatedAt })
               .IsDescending(false, false, true)
               .HasDatabaseName("ix_user_e2e_idempotency_records_user_operation_created");
        builder.HasIndex(e => e.ExpiresAt)
               .HasDatabaseName("ix_user_e2e_idempotency_records_expires_at");
    }
}
