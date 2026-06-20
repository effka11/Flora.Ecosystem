using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Flora.Messaging.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class Initial : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.EnsureSchema(
                name: "flora_core");

            migrationBuilder.CreateTable(
                name: "user_e2e_keys",
                schema: "flora_core",
                columns: table => new
                {
                    user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    public_key_base64 = table.Column<string>(type: "text", nullable: false),
                    updated_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_e2e_keys", x => x.user_uuid);
                });

            migrationBuilder.CreateTable(
                name: "user_messages",
                schema: "flora_core",
                columns: table => new
                {
                    message_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    sender_user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    receiver_user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    content = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    encrypted_for_receiver = table.Column<string>(type: "text", nullable: true),
                    encrypted_for_sender = table.Column<string>(type: "text", nullable: true),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    is_read = table.Column<bool>(type: "boolean", nullable: false, defaultValue: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_messages", x => x.message_uuid);
                });

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
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "user_e2e_keys",
                schema: "flora_core");

            migrationBuilder.DropTable(
                name: "user_messages",
                schema: "flora_core");
        }
    }
}
