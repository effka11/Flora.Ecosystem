using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Flora.Messaging.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddMessagingE2EInfrastructure : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "device_uuid",
                schema: "flora_core",
                table: "user_e2e_keys",
                type: "uuid",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "key_epoch_public_identities",
                schema: "flora_core",
                columns: table => new
                {
                    user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    key_epoch_id = table.Column<Guid>(type: "uuid", nullable: false),
                    epoch_account_identity_public_key_base64url = table.Column<string>(type: "text", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    updated_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_key_epoch_public_identities", x => new { x.user_uuid, x.key_epoch_id });
                });

            migrationBuilder.CreateTable(
                name: "user_device_keys",
                schema: "flora_core",
                columns: table => new
                {
                    device_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    key_epoch_id = table.Column<Guid>(type: "uuid", nullable: false),
                    display_name = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    signing_public_key_base64url = table.Column<string>(type: "text", nullable: false),
                    agreement_public_key_base64url = table.Column<string>(type: "text", nullable: false),
                    signed_by_epoch_account_identity_base64url = table.Column<string>(type: "text", nullable: true),
                    status = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    last_seen_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    revoked_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_device_keys", x => x.device_uuid);
                });

            migrationBuilder.CreateTable(
                name: "user_e2e_account_states",
                schema: "flora_core",
                columns: table => new
                {
                    user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    state = table.Column<string>(type: "character varying(30)", maxLength: 30, nullable: false),
                    freeze = table.Column<bool>(type: "boolean", nullable: false, defaultValue: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    updated_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_e2e_account_states", x => x.user_uuid);
                });

            migrationBuilder.CreateTable(
                name: "user_e2e_idempotency_records",
                schema: "flora_core",
                columns: table => new
                {
                    idempotency_key = table.Column<Guid>(type: "uuid", nullable: false),
                    user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    operation = table.Column<string>(type: "character varying(50)", maxLength: 50, nullable: false),
                    request_body_hash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    expires_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_e2e_idempotency_records", x => x.idempotency_key);
                });

            migrationBuilder.CreateTable(
                name: "user_e2e_key_backups",
                schema: "flora_core",
                columns: table => new
                {
                    user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    version = table.Column<int>(type: "integer", nullable: false),
                    backup_revision = table.Column<int>(type: "integer", nullable: false),
                    backup_key_id = table.Column<Guid>(type: "uuid", nullable: false),
                    primary_key_epoch_id = table.Column<Guid>(type: "uuid", nullable: false),
                    epoch_set_revision = table.Column<int>(type: "integer", nullable: false),
                    epoch_set_hash_base64url = table.Column<string>(type: "text", nullable: false),
                    kdf_name = table.Column<string>(type: "character varying(50)", maxLength: 50, nullable: false),
                    kdf_memory_kib = table.Column<int>(type: "integer", nullable: false),
                    kdf_iterations = table.Column<int>(type: "integer", nullable: false),
                    kdf_parallelism = table.Column<int>(type: "integer", nullable: false),
                    kdf_salt_base64url = table.Column<string>(type: "text", nullable: false),
                    aead_name = table.Column<string>(type: "character varying(50)", maxLength: 50, nullable: false),
                    aead_nonce_base64url = table.Column<string>(type: "text", nullable: false),
                    ciphertext_base64url = table.Column<string>(type: "text", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    updated_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_e2e_key_backups", x => x.user_uuid);
                });

            migrationBuilder.CreateTable(
                name: "user_e2e_recovery_backups",
                schema: "flora_core",
                columns: table => new
                {
                    recovery_key_id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    version = table.Column<int>(type: "integer", nullable: false),
                    recovery_revision = table.Column<int>(type: "integer", nullable: false),
                    primary_key_epoch_id = table.Column<Guid>(type: "uuid", nullable: false),
                    epoch_set_revision = table.Column<int>(type: "integer", nullable: false),
                    epoch_set_hash_base64url = table.Column<string>(type: "text", nullable: false),
                    wordlist_id = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    words_count = table.Column<int>(type: "integer", nullable: false),
                    kdf_name = table.Column<string>(type: "character varying(50)", maxLength: 50, nullable: false),
                    kdf_memory_kib = table.Column<int>(type: "integer", nullable: false),
                    kdf_iterations = table.Column<int>(type: "integer", nullable: false),
                    kdf_parallelism = table.Column<int>(type: "integer", nullable: false),
                    kdf_salt_base64url = table.Column<string>(type: "text", nullable: false),
                    aead_name = table.Column<string>(type: "character varying(50)", maxLength: 50, nullable: false),
                    aead_nonce_base64url = table.Column<string>(type: "text", nullable: false),
                    ciphertext_base64url = table.Column<string>(type: "text", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    updated_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    used_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_e2e_recovery_backups", x => x.recovery_key_id);
                });

            migrationBuilder.CreateTable(
                name: "user_e2e_unlock_challenges",
                schema: "flora_core",
                columns: table => new
                {
                    challenge_id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    reset_request_id = table.Column<Guid>(type: "uuid", nullable: false),
                    canonical_payload_preview = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    expires_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    is_used = table.Column<bool>(type: "boolean", nullable: false, defaultValue: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_e2e_unlock_challenges", x => x.challenge_id);
                });

            migrationBuilder.CreateTable(
                name: "user_message_voice_assets",
                schema: "flora_core",
                columns: table => new
                {
                    voice_asset_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    sender_user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    receiver_user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    message_uuid = table.Column<Guid>(type: "uuid", nullable: true),
                    content_type = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    duration_ms = table.Column<int>(type: "integer", nullable: false),
                    encrypted_bytes = table.Column<byte[]>(type: "bytea", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_message_voice_assets", x => x.voice_asset_uuid);
                });

            migrationBuilder.CreateIndex(
                name: "ix_user_messages_conversation_cursor",
                schema: "flora_core",
                table: "user_messages",
                columns: new[] { "sender_user_uuid", "receiver_user_uuid", "created_at", "message_uuid" });

            migrationBuilder.CreateIndex(
                name: "ix_user_device_keys_user_epoch",
                schema: "flora_core",
                table: "user_device_keys",
                columns: new[] { "user_uuid", "key_epoch_id" });

            migrationBuilder.CreateIndex(
                name: "ix_user_device_keys_user_status",
                schema: "flora_core",
                table: "user_device_keys",
                columns: new[] { "user_uuid", "status" });

            migrationBuilder.CreateIndex(
                name: "ix_user_e2e_idempotency_records_expires_at",
                schema: "flora_core",
                table: "user_e2e_idempotency_records",
                column: "expires_at");

            migrationBuilder.CreateIndex(
                name: "ix_user_e2e_idempotency_records_user_operation",
                schema: "flora_core",
                table: "user_e2e_idempotency_records",
                columns: new[] { "user_uuid", "operation" });

            migrationBuilder.CreateIndex(
                name: "ix_user_e2e_recovery_backups_user_uuid",
                schema: "flora_core",
                table: "user_e2e_recovery_backups",
                column: "user_uuid");

            migrationBuilder.CreateIndex(
                name: "ix_user_e2e_unlock_challenges_expires_at",
                schema: "flora_core",
                table: "user_e2e_unlock_challenges",
                column: "expires_at");

            migrationBuilder.CreateIndex(
                name: "ix_user_e2e_unlock_challenges_user_reset",
                schema: "flora_core",
                table: "user_e2e_unlock_challenges",
                columns: new[] { "user_uuid", "reset_request_id" });

            migrationBuilder.CreateIndex(
                name: "ix_user_message_voice_assets_message_uuid",
                schema: "flora_core",
                table: "user_message_voice_assets",
                column: "message_uuid");

            migrationBuilder.CreateIndex(
                name: "ix_user_message_voice_assets_receiver_user_uuid",
                schema: "flora_core",
                table: "user_message_voice_assets",
                column: "receiver_user_uuid");

            migrationBuilder.CreateIndex(
                name: "ix_user_message_voice_assets_sender_user_uuid",
                schema: "flora_core",
                table: "user_message_voice_assets",
                column: "sender_user_uuid");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "key_epoch_public_identities",
                schema: "flora_core");

            migrationBuilder.DropTable(
                name: "user_device_keys",
                schema: "flora_core");

            migrationBuilder.DropTable(
                name: "user_e2e_account_states",
                schema: "flora_core");

            migrationBuilder.DropTable(
                name: "user_e2e_idempotency_records",
                schema: "flora_core");

            migrationBuilder.DropTable(
                name: "user_e2e_key_backups",
                schema: "flora_core");

            migrationBuilder.DropTable(
                name: "user_e2e_recovery_backups",
                schema: "flora_core");

            migrationBuilder.DropTable(
                name: "user_e2e_unlock_challenges",
                schema: "flora_core");

            migrationBuilder.DropTable(
                name: "user_message_voice_assets",
                schema: "flora_core");

            migrationBuilder.DropIndex(
                name: "ix_user_messages_conversation_cursor",
                schema: "flora_core",
                table: "user_messages");

            migrationBuilder.DropColumn(
                name: "device_uuid",
                schema: "flora_core",
                table: "user_e2e_keys");
        }
    }
}
