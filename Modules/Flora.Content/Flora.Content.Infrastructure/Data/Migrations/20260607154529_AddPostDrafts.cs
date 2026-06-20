using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Flora.Content.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddPostDrafts : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "post_drafts",
                schema: "flora_core",
                columns: table => new
                {
                    draft_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    author_user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    community_id = table.Column<Guid>(type: "uuid", nullable: true),
                    label = table.Column<string>(type: "character varying(50)", maxLength: 50, nullable: false),
                    content = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    updated_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_post_drafts", x => x.draft_uuid);
                });

            migrationBuilder.CreateIndex(
                name: "ix_post_drafts_author_community",
                schema: "flora_core",
                table: "post_drafts",
                columns: new[] { "author_user_uuid", "community_id" });

            migrationBuilder.CreateIndex(
                name: "ix_post_drafts_author_user_uuid",
                schema: "flora_core",
                table: "post_drafts",
                column: "author_user_uuid");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "post_drafts",
                schema: "flora_core");
        }
    }
}
