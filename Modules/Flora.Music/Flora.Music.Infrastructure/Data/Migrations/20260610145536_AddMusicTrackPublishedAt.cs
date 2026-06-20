using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Flora.Music.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddMusicTrackPublishedAt : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTime>(
                name: "published_at",
                schema: "flora_core",
                table: "music_tracks",
                type: "timestamp with time zone",
                nullable: true);

            // Площадочные треки до миграции считаем уже опубликованными.
            migrationBuilder.Sql(
                """
                UPDATE flora_core.music_tracks
                SET published_at = created_at
                WHERE scope = 1 AND published_at IS NULL;
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "published_at",
                schema: "flora_core",
                table: "music_tracks");
        }
    }
}
