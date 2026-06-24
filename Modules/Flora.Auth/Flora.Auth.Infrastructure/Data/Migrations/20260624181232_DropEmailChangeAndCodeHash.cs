using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Flora.Auth.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class DropEmailChangeAndCodeHash : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "pending_email_changes",
                schema: "flora_core");

            migrationBuilder.DropColumn(
                name: "verification_code_hash",
                schema: "flora_core",
                table: "pending_registrations");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "verification_code_hash",
                schema: "flora_core",
                table: "pending_registrations",
                type: "character varying(128)",
                maxLength: 128,
                nullable: false,
                defaultValue: "");

            migrationBuilder.CreateTable(
                name: "pending_email_changes",
                schema: "flora_core",
                columns: table => new
                {
                    change_token = table.Column<Guid>(type: "uuid", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    expires_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    new_email = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: false),
                    updated_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    verification_code_hash = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false)
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
    }
}
