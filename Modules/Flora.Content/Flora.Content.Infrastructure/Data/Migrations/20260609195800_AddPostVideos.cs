using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Flora.Content.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddPostVideos : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "post_videos",
                schema: "flora_core",
                columns: table => new
                {
                    uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    post_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    status = table.Column<int>(type: "integer", nullable: false),
                    content_type = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    data = table.Column<byte[]>(type: "bytea", nullable: false),
                    poster_data = table.Column<byte[]>(type: "bytea", nullable: false),
                    poster_content_type = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    width = table.Column<int>(type: "integer", nullable: false),
                    height = table.Column<int>(type: "integer", nullable: false),
                    duration_ms = table.Column<int>(type: "integer", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_post_videos", x => x.uuid);
                    table.ForeignKey(
                        name: "fk_post_videos_post",
                        column: x => x.post_uuid,
                        principalSchema: "flora_core",
                        principalTable: "user_posts",
                        principalColumn: "post_uuid",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_post_videos_post_uuid",
                schema: "flora_core",
                table: "post_videos",
                column: "post_uuid");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "post_videos",
                schema: "flora_core");
        }
    }
}
