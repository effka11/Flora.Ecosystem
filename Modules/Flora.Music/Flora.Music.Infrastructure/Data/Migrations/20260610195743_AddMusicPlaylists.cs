using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Flora.Music.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddMusicPlaylists : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "music_favorites",
                schema: "flora_core",
                columns: table => new
                {
                    user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    track_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_music_favorites", x => new { x.user_uuid, x.track_uuid });
                    table.ForeignKey(
                        name: "fk_music_favorites_track",
                        column: x => x.track_uuid,
                        principalSchema: "flora_core",
                        principalTable: "music_tracks",
                        principalColumn: "track_uuid",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "music_playlists",
                schema: "flora_core",
                columns: table => new
                {
                    playlist_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    owner_user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    title = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    cover_color_id = table.Column<string>(type: "character varying(50)", maxLength: 50, nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_music_playlists", x => x.playlist_uuid);
                });

            migrationBuilder.CreateTable(
                name: "music_playlist_tracks",
                schema: "flora_core",
                columns: table => new
                {
                    playlist_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    track_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    position = table.Column<int>(type: "integer", nullable: false),
                    added_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_music_playlist_tracks", x => new { x.playlist_uuid, x.track_uuid });
                    table.ForeignKey(
                        name: "fk_music_playlist_tracks_playlist",
                        column: x => x.playlist_uuid,
                        principalSchema: "flora_core",
                        principalTable: "music_playlists",
                        principalColumn: "playlist_uuid",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_music_playlist_tracks_track",
                        column: x => x.track_uuid,
                        principalSchema: "flora_core",
                        principalTable: "music_tracks",
                        principalColumn: "track_uuid",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_music_favorites_track_uuid",
                schema: "flora_core",
                table: "music_favorites",
                column: "track_uuid");

            migrationBuilder.CreateIndex(
                name: "ix_music_favorites_user_created",
                schema: "flora_core",
                table: "music_favorites",
                columns: new[] { "user_uuid", "created_at" },
                descending: new[] { false, true });

            migrationBuilder.CreateIndex(
                name: "ix_music_playlist_tracks_playlist_position",
                schema: "flora_core",
                table: "music_playlist_tracks",
                columns: new[] { "playlist_uuid", "position" });

            migrationBuilder.CreateIndex(
                name: "IX_music_playlist_tracks_track_uuid",
                schema: "flora_core",
                table: "music_playlist_tracks",
                column: "track_uuid");

            migrationBuilder.CreateIndex(
                name: "ix_music_playlists_owner_created",
                schema: "flora_core",
                table: "music_playlists",
                columns: new[] { "owner_user_uuid", "created_at" },
                descending: new[] { false, true });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "music_favorites",
                schema: "flora_core");

            migrationBuilder.DropTable(
                name: "music_playlist_tracks",
                schema: "flora_core");

            migrationBuilder.DropTable(
                name: "music_playlists",
                schema: "flora_core");
        }
    }
}
