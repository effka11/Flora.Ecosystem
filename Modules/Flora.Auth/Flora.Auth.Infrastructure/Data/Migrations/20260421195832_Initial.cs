using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Flora.Auth.Infrastructure.Data.Migrations
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
                name: "user_accounts",
                schema: "flora_core",
                columns: table => new
                {
                    user_uuid = table.Column<Guid>(type: "uuid", nullable: false, defaultValueSql: "gen_random_uuid()"),
                    username = table.Column<string>(type: "character varying(50)", maxLength: 50, nullable: false),
                    phone = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    phone_verified = table.Column<bool>(type: "boolean", nullable: false, defaultValue: false),
                    password_hash = table.Column<string>(type: "text", nullable: false),
                    email = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: true),
                    email_verified = table.Column<bool>(type: "boolean", nullable: false, defaultValue: false),
                    two_factor_enabled = table.Column<bool>(type: "boolean", nullable: false, defaultValue: false),
                    status = table.Column<int>(type: "integer", nullable: false, defaultValue: 0),
                    last_login = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    services_mask = table.Column<decimal>(type: "numeric(20,0)", nullable: false, defaultValue: 0m),
                    privacy_accepted = table.Column<bool>(type: "boolean", nullable: false, defaultValue: false),
                    tos_accepted = table.Column<bool>(type: "boolean", nullable: false, defaultValue: false),
                    has_social_network = table.Column<bool>(type: "boolean", nullable: false, defaultValue: false),
                    has_email = table.Column<bool>(type: "boolean", nullable: false, defaultValue: false),
                    services_count = table.Column<byte>(type: "smallint", nullable: false, defaultValue: (byte)0),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    updated_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_accounts", x => x.user_uuid);
                });

            migrationBuilder.CreateTable(
                name: "user_security_logs",
                schema: "flora_core",
                columns: table => new
                {
                    user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    last_login = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    password_updated_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    login_failures = table.Column<byte>(type: "smallint", nullable: false, defaultValue: (byte)0),
                    login_locked_until = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    privacy_accepted_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    tos_accepted_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    updated_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_security_logs", x => x.user_uuid);
                    table.ForeignKey(
                        name: "fk_user_accounts_user_security_logs",
                        column: x => x.user_uuid,
                        principalSchema: "flora_core",
                        principalTable: "user_accounts",
                        principalColumn: "user_uuid",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "user_sessions",
                schema: "flora_core",
                columns: table => new
                {
                    session_id = table.Column<Guid>(type: "uuid", nullable: false, defaultValueSql: "gen_random_uuid()"),
                    user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    agent_hash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    ip_address = table.Column<string>(type: "character varying(45)", maxLength: 45, nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    expires_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    last_activity = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    jwt_id = table.Column<string>(type: "character varying(36)", maxLength: 36, nullable: false),
                    refresh_token = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: false),
                    rotation_id = table.Column<long>(type: "bigint", nullable: false, defaultValue: 0L),
                    status = table.Column<int>(type: "integer", nullable: false, defaultValue: 0),
                    country_code = table.Column<string>(type: "character varying(2)", maxLength: 2, nullable: true),
                    region = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    city = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    csrf_token = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    hmac_key = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_sessions", x => x.session_id);
                    table.ForeignKey(
                        name: "fk_user_accounts_user_sessions",
                        column: x => x.user_uuid,
                        principalSchema: "flora_core",
                        principalTable: "user_accounts",
                        principalColumn: "user_uuid",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_user_accounts_email",
                schema: "flora_core",
                table: "user_accounts",
                column: "email",
                unique: true,
                filter: "email IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "ix_user_accounts_phone",
                schema: "flora_core",
                table: "user_accounts",
                column: "phone",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_user_accounts_username",
                schema: "flora_core",
                table: "user_accounts",
                column: "username",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_user_sessions_active",
                schema: "flora_core",
                table: "user_sessions",
                columns: new[] { "user_uuid", "status", "expires_at" },
                filter: "status = 0");

            migrationBuilder.CreateIndex(
                name: "ix_user_sessions_jwt_id",
                schema: "flora_core",
                table: "user_sessions",
                column: "jwt_id",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_user_sessions_refresh_token",
                schema: "flora_core",
                table: "user_sessions",
                column: "refresh_token",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_user_sessions_user_uuid",
                schema: "flora_core",
                table: "user_sessions",
                column: "user_uuid");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "user_security_logs",
                schema: "flora_core");

            migrationBuilder.DropTable(
                name: "user_sessions",
                schema: "flora_core");

            migrationBuilder.DropTable(
                name: "user_accounts",
                schema: "flora_core");
        }
    }
}
