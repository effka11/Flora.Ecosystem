using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Flora.Music.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddMusicArtists : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "music_artists",
                schema: "flora_core",
                columns: table => new
                {
                    artist_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    display_name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    normalized_display_name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    tracks_count = table.Column<int>(type: "integer", nullable: false),
                    linked_user_uuid = table.Column<Guid>(type: "uuid", nullable: true),
                    created_by_user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_music_artists", x => x.artist_uuid);
                });

            migrationBuilder.CreateTable(
                name: "music_track_artists",
                schema: "flora_core",
                columns: table => new
                {
                    music_track_artist_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    track_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    artist_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    role = table.Column<int>(type: "integer", nullable: false),
                    joiner_before = table.Column<int>(type: "integer", nullable: false),
                    sort_order = table.Column<int>(type: "integer", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_music_track_artists", x => x.music_track_artist_uuid);
                    table.ForeignKey(
                        name: "fk_music_track_artists_artist",
                        column: x => x.artist_uuid,
                        principalSchema: "flora_core",
                        principalTable: "music_artists",
                        principalColumn: "artist_uuid",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_music_track_artists_track",
                        column: x => x.track_uuid,
                        principalSchema: "flora_core",
                        principalTable: "music_tracks",
                        principalColumn: "track_uuid",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_music_artists_linked_user",
                schema: "flora_core",
                table: "music_artists",
                column: "linked_user_uuid",
                unique: true,
                filter: "linked_user_uuid IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "ix_music_artists_normalized_display_name",
                schema: "flora_core",
                table: "music_artists",
                column: "normalized_display_name");

            migrationBuilder.CreateIndex(
                name: "ix_music_track_artists_artist",
                schema: "flora_core",
                table: "music_track_artists",
                column: "artist_uuid");

            migrationBuilder.CreateIndex(
                name: "ix_music_track_artists_track",
                schema: "flora_core",
                table: "music_track_artists",
                column: "track_uuid");

            migrationBuilder.CreateIndex(
                name: "ix_music_track_artists_track_artist",
                schema: "flora_core",
                table: "music_track_artists",
                columns: new[] { "track_uuid", "artist_uuid" });

            migrationBuilder.CreateIndex(
                name: "uq_music_track_artists_track_sort",
                schema: "flora_core",
                table: "music_track_artists",
                columns: new[] { "track_uuid", "sort_order" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "music_track_artists",
                schema: "flora_core");

            migrationBuilder.DropTable(
                name: "music_artists",
                schema: "flora_core");
        }
    }
}
