using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Flora.Music.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddMusicArtistCovers : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "cover_content_type",
                schema: "flora_core",
                table: "music_artists",
                type: "character varying(100)",
                maxLength: 100,
                nullable: true);

            migrationBuilder.AddColumn<byte[]>(
                name: "cover_data",
                schema: "flora_core",
                table: "music_artists",
                type: "bytea",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "cover_content_type",
                schema: "flora_core",
                table: "music_artists");

            migrationBuilder.DropColumn(
                name: "cover_data",
                schema: "flora_core",
                table: "music_artists");
        }
    }
}
