using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Flora.Notifications.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddClientPlatformsAndNotificationTargetPlatform : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "target_platform",
                schema: "flora_core",
                table: "user_notifications",
                type: "character varying(16)",
                maxLength: 16,
                nullable: true);

            migrationBuilder.CreateTable(
                name: "user_client_platforms",
                schema: "flora_core",
                columns: table => new
                {
                    user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    platform = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    updated_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_client_platforms", x => new { x.user_uuid, x.platform });
                });

            migrationBuilder.CreateIndex(
                name: "ix_user_client_platforms_platform_user",
                schema: "flora_core",
                table: "user_client_platforms",
                columns: new[] { "platform", "user_uuid" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "user_client_platforms",
                schema: "flora_core");

            migrationBuilder.DropColumn(
                name: "target_platform",
                schema: "flora_core",
                table: "user_notifications");
        }
    }
}
