using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Flora.Auth.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddPendingRegistrations : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "pending_registrations",
                schema: "flora_core",
                columns: table => new
                {
                    verification_token = table.Column<Guid>(type: "uuid", nullable: false),
                    email = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: false),
                    username = table.Column<string>(type: "character varying(50)", maxLength: 50, nullable: false),
                    password_hash = table.Column<string>(type: "text", nullable: false),
                    verification_code_hash = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    expires_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    updated_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_pending_registrations", x => x.verification_token);
                });

            migrationBuilder.CreateIndex(
                name: "ix_pending_registrations_email",
                schema: "flora_core",
                table: "pending_registrations",
                column: "email");

            migrationBuilder.CreateIndex(
                name: "ix_pending_registrations_expires_at",
                schema: "flora_core",
                table: "pending_registrations",
                column: "expires_at");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "pending_registrations",
                schema: "flora_core");
        }
    }
}
