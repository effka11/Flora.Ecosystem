using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Flora.Notifications.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddUserNotifications : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.EnsureSchema(
                name: "flora_core");

            migrationBuilder.CreateTable(
                name: "user_notifications",
                schema: "flora_core",
                columns: table => new
                {
                    notification_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    recipient_user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    actor_user_uuid = table.Column<Guid>(type: "uuid", nullable: true),
                    type = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    category = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    text = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    post_uuid = table.Column<Guid>(type: "uuid", nullable: true),
                    comment_uuid = table.Column<Guid>(type: "uuid", nullable: true),
                    is_read = table.Column<bool>(type: "boolean", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_notifications", x => x.notification_uuid);
                });

            migrationBuilder.CreateIndex(
                name: "ix_user_notifications_recipient_created",
                schema: "flora_core",
                table: "user_notifications",
                columns: new[] { "recipient_user_uuid", "created_at" });

            migrationBuilder.CreateIndex(
                name: "ix_user_notifications_recipient_read",
                schema: "flora_core",
                table: "user_notifications",
                columns: new[] { "recipient_user_uuid", "is_read" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "user_notifications",
                schema: "flora_core");
        }
    }
}
