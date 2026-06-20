using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Flora.Notifications.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddUserPushTokens : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "user_push_tokens",
                schema: "flora_core",
                columns: table => new
                {
                    PushTokenUuid = table.Column<Guid>(type: "uuid", nullable: false),
                    UserUuid = table.Column<Guid>(type: "uuid", nullable: false),
                    Token = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: false),
                    Platform = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_push_tokens", x => x.PushTokenUuid);
                });

            migrationBuilder.CreateIndex(
                name: "ix_user_push_tokens_token",
                schema: "flora_core",
                table: "user_push_tokens",
                column: "Token",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_user_push_tokens_user_updated",
                schema: "flora_core",
                table: "user_push_tokens",
                columns: new[] { "UserUuid", "UpdatedAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "user_push_tokens",
                schema: "flora_core");
        }
    }
}
