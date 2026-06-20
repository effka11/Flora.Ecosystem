using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Flora.Messaging.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddUserMessageImageAssets : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "user_message_image_assets",
                schema: "flora_core",
                columns: table => new
                {
                    image_asset_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    sender_user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    receiver_user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    message_uuid = table.Column<Guid>(type: "uuid", nullable: true),
                    content_type = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    encrypted_bytes = table.Column<byte[]>(type: "bytea", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_message_image_assets", x => x.image_asset_uuid);
                    table.ForeignKey(
                        name: "fk_user_message_image_assets_message",
                        column: x => x.message_uuid,
                        principalSchema: "flora_core",
                        principalTable: "user_messages",
                        principalColumn: "message_uuid",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateIndex(
                name: "ix_user_message_image_assets_message_uuid",
                schema: "flora_core",
                table: "user_message_image_assets",
                column: "message_uuid");

            migrationBuilder.CreateIndex(
                name: "ix_user_message_image_assets_peer_created",
                schema: "flora_core",
                table: "user_message_image_assets",
                columns: new[] { "sender_user_uuid", "receiver_user_uuid", "created_at" },
                descending: new[] { false, false, true });

            migrationBuilder.CreateIndex(
                name: "ix_user_message_image_assets_receiver_user_uuid",
                schema: "flora_core",
                table: "user_message_image_assets",
                column: "receiver_user_uuid");

            migrationBuilder.CreateIndex(
                name: "ix_user_message_image_assets_sender_user_uuid",
                schema: "flora_core",
                table: "user_message_image_assets",
                column: "sender_user_uuid");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "user_message_image_assets",
                schema: "flora_core");
        }
    }
}
