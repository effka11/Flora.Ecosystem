using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Flora.Users.Infrastructure.Data.Migrations
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
                name: "user_avatars",
                schema: "flora_core",
                columns: table => new
                {
                    uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    content_type = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    data = table.Column<byte[]>(type: "bytea", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_avatars", x => x.uuid);
                });

            migrationBuilder.CreateTable(
                name: "user_followers",
                schema: "flora_core",
                columns: table => new
                {
                    follower_user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    following_user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_followers", x => new { x.follower_user_uuid, x.following_user_uuid });
                });

            migrationBuilder.CreateTable(
                name: "user_profiles",
                schema: "flora_core",
                columns: table => new
                {
                    user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    avatar_uuid = table.Column<Guid>(type: "uuid", nullable: true),
                    display_name = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false, defaultValue: ""),
                    gender = table.Column<int>(type: "integer", nullable: true),
                    birth_date = table.Column<DateOnly>(type: "date", nullable: true),
                    status = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    updated_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_profiles", x => x.user_uuid);
                });

            migrationBuilder.CreateIndex(
                name: "ix_user_followers_following_user_uuid",
                schema: "flora_core",
                table: "user_followers",
                column: "following_user_uuid");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "user_avatars",
                schema: "flora_core");

            migrationBuilder.DropTable(
                name: "user_followers",
                schema: "flora_core");

            migrationBuilder.DropTable(
                name: "user_profiles",
                schema: "flora_core");
        }
    }
}
