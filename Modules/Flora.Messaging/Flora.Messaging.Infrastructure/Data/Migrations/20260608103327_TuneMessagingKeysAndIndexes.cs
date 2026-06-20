using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Flora.Messaging.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class TuneMessagingKeysAndIndexes : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "ix_user_messages_conversation_cursor",
                schema: "flora_core",
                table: "user_messages");

            migrationBuilder.DropIndex(
                name: "ix_user_messages_receiver_user_uuid",
                schema: "flora_core",
                table: "user_messages");

            migrationBuilder.DropIndex(
                name: "ix_user_messages_sender_receiver",
                schema: "flora_core",
                table: "user_messages");

            migrationBuilder.DropIndex(
                name: "ix_user_messages_sender_user_uuid",
                schema: "flora_core",
                table: "user_messages");

            migrationBuilder.DropIndex(
                name: "ix_user_e2e_recovery_backups_user_uuid",
                schema: "flora_core",
                table: "user_e2e_recovery_backups");

            migrationBuilder.DropIndex(
                name: "ix_user_e2e_idempotency_records_user_operation",
                schema: "flora_core",
                table: "user_e2e_idempotency_records");

            migrationBuilder.DropIndex(
                name: "ix_user_device_keys_user_epoch",
                schema: "flora_core",
                table: "user_device_keys");

            migrationBuilder.DropIndex(
                name: "ix_user_device_keys_user_status",
                schema: "flora_core",
                table: "user_device_keys");

            migrationBuilder.CreateIndex(
                name: "ix_user_messages_conversation_cursor",
                schema: "flora_core",
                table: "user_messages",
                columns: new[] { "sender_user_uuid", "receiver_user_uuid", "created_at", "message_uuid" },
                descending: new[] { false, false, true, false });

            migrationBuilder.CreateIndex(
                name: "ix_user_messages_conversation_cursor_rev",
                schema: "flora_core",
                table: "user_messages",
                columns: new[] { "receiver_user_uuid", "sender_user_uuid", "created_at", "message_uuid" },
                descending: new[] { false, false, true, false });

            migrationBuilder.CreateIndex(
                name: "ix_user_messages_receiver_timeline",
                schema: "flora_core",
                table: "user_messages",
                columns: new[] { "receiver_user_uuid", "created_at", "message_uuid" },
                descending: new[] { false, true, false });

            migrationBuilder.CreateIndex(
                name: "ix_user_messages_sender_timeline",
                schema: "flora_core",
                table: "user_messages",
                columns: new[] { "sender_user_uuid", "created_at", "message_uuid" },
                descending: new[] { false, true, false });

            migrationBuilder.CreateIndex(
                name: "ix_user_messages_unread_peer",
                schema: "flora_core",
                table: "user_messages",
                columns: new[] { "receiver_user_uuid", "sender_user_uuid" },
                filter: "is_read = false");

            migrationBuilder.CreateIndex(
                name: "ix_user_message_voice_assets_peer_created",
                schema: "flora_core",
                table: "user_message_voice_assets",
                columns: new[] { "sender_user_uuid", "receiver_user_uuid", "created_at" },
                descending: new[] { false, false, true });

            migrationBuilder.CreateIndex(
                name: "ix_user_e2e_unlock_challenges_user_active",
                schema: "flora_core",
                table: "user_e2e_unlock_challenges",
                columns: new[] { "user_uuid", "is_used", "expires_at" });

            migrationBuilder.CreateIndex(
                name: "ix_user_e2e_unlock_challenges_user_challenge",
                schema: "flora_core",
                table: "user_e2e_unlock_challenges",
                columns: new[] { "user_uuid", "challenge_id" });

            migrationBuilder.CreateIndex(
                name: "ix_user_e2e_recovery_backups_user_created",
                schema: "flora_core",
                table: "user_e2e_recovery_backups",
                columns: new[] { "user_uuid", "created_at" },
                descending: new[] { false, true });

            migrationBuilder.CreateIndex(
                name: "ix_user_e2e_recovery_backups_user_recovery_key",
                schema: "flora_core",
                table: "user_e2e_recovery_backups",
                columns: new[] { "user_uuid", "recovery_key_id" });

            migrationBuilder.CreateIndex(
                name: "ux_user_e2e_keys_device_uuid",
                schema: "flora_core",
                table: "user_e2e_keys",
                column: "device_uuid",
                unique: true,
                filter: "device_uuid IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "ix_user_e2e_idempotency_records_user_operation_created",
                schema: "flora_core",
                table: "user_e2e_idempotency_records",
                columns: new[] { "user_uuid", "operation", "created_at" },
                descending: new[] { false, false, true });

            migrationBuilder.CreateIndex(
                name: "ix_user_device_keys_user_epoch_created",
                schema: "flora_core",
                table: "user_device_keys",
                columns: new[] { "user_uuid", "key_epoch_id", "created_at" });

            migrationBuilder.CreateIndex(
                name: "ix_user_device_keys_user_epoch_status",
                schema: "flora_core",
                table: "user_device_keys",
                columns: new[] { "user_uuid", "key_epoch_id", "status" });

            migrationBuilder.Sql(
                """
                UPDATE flora_core.user_message_voice_assets va
                SET message_uuid = NULL
                WHERE message_uuid IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1
                    FROM flora_core.user_messages m
                    WHERE m.message_uuid = va.message_uuid
                  );
                """);

            migrationBuilder.AddForeignKey(
                name: "fk_user_message_voice_assets_message",
                schema: "flora_core",
                table: "user_message_voice_assets",
                column: "message_uuid",
                principalSchema: "flora_core",
                principalTable: "user_messages",
                principalColumn: "message_uuid",
                onDelete: ReferentialAction.SetNull);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "fk_user_message_voice_assets_message",
                schema: "flora_core",
                table: "user_message_voice_assets");

            migrationBuilder.DropIndex(
                name: "ix_user_messages_conversation_cursor",
                schema: "flora_core",
                table: "user_messages");

            migrationBuilder.DropIndex(
                name: "ix_user_messages_conversation_cursor_rev",
                schema: "flora_core",
                table: "user_messages");

            migrationBuilder.DropIndex(
                name: "ix_user_messages_receiver_timeline",
                schema: "flora_core",
                table: "user_messages");

            migrationBuilder.DropIndex(
                name: "ix_user_messages_sender_timeline",
                schema: "flora_core",
                table: "user_messages");

            migrationBuilder.DropIndex(
                name: "ix_user_messages_unread_peer",
                schema: "flora_core",
                table: "user_messages");

            migrationBuilder.DropIndex(
                name: "ix_user_message_voice_assets_peer_created",
                schema: "flora_core",
                table: "user_message_voice_assets");

            migrationBuilder.DropIndex(
                name: "ix_user_e2e_unlock_challenges_user_active",
                schema: "flora_core",
                table: "user_e2e_unlock_challenges");

            migrationBuilder.DropIndex(
                name: "ix_user_e2e_unlock_challenges_user_challenge",
                schema: "flora_core",
                table: "user_e2e_unlock_challenges");

            migrationBuilder.DropIndex(
                name: "ix_user_e2e_recovery_backups_user_created",
                schema: "flora_core",
                table: "user_e2e_recovery_backups");

            migrationBuilder.DropIndex(
                name: "ix_user_e2e_recovery_backups_user_recovery_key",
                schema: "flora_core",
                table: "user_e2e_recovery_backups");

            migrationBuilder.DropIndex(
                name: "ux_user_e2e_keys_device_uuid",
                schema: "flora_core",
                table: "user_e2e_keys");

            migrationBuilder.DropIndex(
                name: "ix_user_e2e_idempotency_records_user_operation_created",
                schema: "flora_core",
                table: "user_e2e_idempotency_records");

            migrationBuilder.DropIndex(
                name: "ix_user_device_keys_user_epoch_created",
                schema: "flora_core",
                table: "user_device_keys");

            migrationBuilder.DropIndex(
                name: "ix_user_device_keys_user_epoch_status",
                schema: "flora_core",
                table: "user_device_keys");

            migrationBuilder.CreateIndex(
                name: "ix_user_messages_conversation_cursor",
                schema: "flora_core",
                table: "user_messages",
                columns: new[] { "sender_user_uuid", "receiver_user_uuid", "created_at", "message_uuid" });

            migrationBuilder.CreateIndex(
                name: "ix_user_messages_receiver_user_uuid",
                schema: "flora_core",
                table: "user_messages",
                column: "receiver_user_uuid");

            migrationBuilder.CreateIndex(
                name: "ix_user_messages_sender_receiver",
                schema: "flora_core",
                table: "user_messages",
                columns: new[] { "sender_user_uuid", "receiver_user_uuid" });

            migrationBuilder.CreateIndex(
                name: "ix_user_messages_sender_user_uuid",
                schema: "flora_core",
                table: "user_messages",
                column: "sender_user_uuid");

            migrationBuilder.CreateIndex(
                name: "ix_user_e2e_recovery_backups_user_uuid",
                schema: "flora_core",
                table: "user_e2e_recovery_backups",
                column: "user_uuid");

            migrationBuilder.CreateIndex(
                name: "ix_user_e2e_idempotency_records_user_operation",
                schema: "flora_core",
                table: "user_e2e_idempotency_records",
                columns: new[] { "user_uuid", "operation" });

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
        }
    }
}
