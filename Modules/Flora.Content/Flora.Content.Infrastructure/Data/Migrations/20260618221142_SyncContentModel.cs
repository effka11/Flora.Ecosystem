using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Flora.Content.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class SyncContentModel : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "compatibility_content_type",
                schema: "flora_core",
                table: "post_videos",
                type: "character varying(100)",
                maxLength: 100,
                nullable: true);

            migrationBuilder.AddColumn<byte[]>(
                name: "compatibility_data",
                schema: "flora_core",
                table: "post_videos",
                type: "bytea",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "compatibility_content_type",
                schema: "flora_core",
                table: "post_videos");

            migrationBuilder.DropColumn(
                name: "compatibility_data",
                schema: "flora_core",
                table: "post_videos");
        }
    }
}
