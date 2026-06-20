using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Flora.Auth.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddAccountSecurityFeatures : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "two_factor_secret",
                schema: "flora_core",
                table: "user_accounts",
                type: "character varying(128)",
                maxLength: 128,
                nullable: true);

            migrationBuilder.CreateTable(
                name: "pending_email_changes",
                schema: "flora_core",
                columns: table => new
                {
                    change_token = table.Column<Guid>(type: "uuid", nullable: false),
                    user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    new_email = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: false),
                    verification_code_hash = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    expires_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    updated_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_pending_email_changes", x => x.change_token);
                });

            migrationBuilder.CreateIndex(
                name: "ix_pending_email_changes_expires_at",
                schema: "flora_core",
                table: "pending_email_changes",
                column: "expires_at");

            migrationBuilder.CreateIndex(
                name: "ix_pending_email_changes_new_email",
                schema: "flora_core",
                table: "pending_email_changes",
                column: "new_email");

            migrationBuilder.CreateIndex(
                name: "ix_pending_email_changes_user_uuid",
                schema: "flora_core",
                table: "pending_email_changes",
                column: "user_uuid");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "pending_email_changes",
                schema: "flora_core");

            migrationBuilder.DropColumn(
                name: "two_factor_secret",
                schema: "flora_core",
                table: "user_accounts");
        }
    }
}
