using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Flora.Users.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddUserPrivacyBlocksAndPresence : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "user_privacy_settings",
                schema: "flora_core",
                columns: table => new
                {
                    user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    friends_visibility = table.Column<int>(type: "integer", nullable: false, defaultValue: 0),
                    subscriptions_visibility = table.Column<int>(type: "integer", nullable: false, defaultValue: 0),
                    posts_visibility = table.Column<int>(type: "integer", nullable: false, defaultValue: 0),
                    likes_visibility = table.Column<int>(type: "integer", nullable: false, defaultValue: 1),
                    reposts_visibility = table.Column<int>(type: "integer", nullable: false, defaultValue: 0),
                    messages_from = table.Column<int>(type: "integer", nullable: false, defaultValue: 0),
                    comments_from = table.Column<int>(type: "integer", nullable: false, defaultValue: 0),
                    online_friends = table.Column<int>(type: "integer", nullable: false, defaultValue: 0),
                    online_strangers = table.Column<int>(type: "integer", nullable: false, defaultValue: 1),
                    updated_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_privacy_settings", x => x.user_uuid);
                });

            migrationBuilder.CreateTable(
                name: "user_blocks",
                schema: "flora_core",
                columns: table => new
                {
                    owner_user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    blocked_user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_blocks", x => new { x.owner_user_uuid, x.blocked_user_uuid });
                });

            migrationBuilder.CreateIndex(
                name: "ix_user_blocks_blocked_user_uuid",
                schema: "flora_core",
                table: "user_blocks",
                column: "blocked_user_uuid");

            migrationBuilder.CreateTable(
                name: "user_presence",
                schema: "flora_core",
                columns: table => new
                {
                    user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    last_seen_at_utc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_presence", x => x.user_uuid);
                });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "user_presence",
                schema: "flora_core");

            migrationBuilder.DropTable(
                name: "user_blocks",
                schema: "flora_core");

            migrationBuilder.DropTable(
                name: "user_privacy_settings",
                schema: "flora_core");
        }
    }
}
