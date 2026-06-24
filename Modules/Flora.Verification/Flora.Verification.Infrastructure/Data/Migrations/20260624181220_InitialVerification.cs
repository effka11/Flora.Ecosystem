using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Flora.Verification.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class InitialVerification : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.EnsureSchema(
                name: "flora_core");

            migrationBuilder.CreateTable(
                name: "verification_challenges",
                schema: "flora_core",
                columns: table => new
                {
                    token = table.Column<Guid>(type: "uuid", nullable: false),
                    kind = table.Column<int>(type: "integer", nullable: false),
                    target = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: false),
                    subject_user_uuid = table.Column<Guid>(type: "uuid", nullable: true),
                    code_hash = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    expires_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    updated_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    attempts = table.Column<int>(type: "integer", nullable: false, defaultValue: 0)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_verification_challenges", x => x.token);
                });

            migrationBuilder.CreateIndex(
                name: "ix_verification_challenges_expires_at",
                schema: "flora_core",
                table: "verification_challenges",
                column: "expires_at");

            migrationBuilder.CreateIndex(
                name: "ix_verification_challenges_subject_user_uuid",
                schema: "flora_core",
                table: "verification_challenges",
                column: "subject_user_uuid");

            migrationBuilder.CreateIndex(
                name: "ix_verification_challenges_target",
                schema: "flora_core",
                table: "verification_challenges",
                column: "target");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "verification_challenges",
                schema: "flora_core");
        }
    }
}
