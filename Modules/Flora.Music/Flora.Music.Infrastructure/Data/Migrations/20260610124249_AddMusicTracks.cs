using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Flora.Music.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddMusicTracks : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.EnsureSchema(
                name: "flora_core");

            migrationBuilder.CreateTable(
                name: "music_tracks",
                schema: "flora_core",
                columns: table => new
                {
                    track_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    owner_user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    scope = table.Column<int>(type: "integer", nullable: false),
                    title = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    artist_display = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    tags = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: true),
                    genre_id = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    license_id = table.Column<string>(type: "character varying(50)", maxLength: 50, nullable: true),
                    cover_color_id = table.Column<string>(type: "character varying(50)", maxLength: 50, nullable: true),
                    track_kind_id = table.Column<string>(type: "character varying(50)", maxLength: 50, nullable: true),
                    cover_data = table.Column<byte[]>(type: "bytea", nullable: true),
                    cover_content_type = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    content_type = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    audio_data = table.Column<byte[]>(type: "bytea", nullable: false),
                    duration_ms = table.Column<int>(type: "integer", nullable: false),
                    file_size_bytes = table.Column<long>(type: "bigint", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_music_tracks", x => x.track_uuid);
                });

            migrationBuilder.CreateIndex(
                name: "ix_music_tracks_owner_created",
                schema: "flora_core",
                table: "music_tracks",
                columns: new[] { "owner_user_uuid", "created_at" },
                descending: new[] { false, true });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "music_tracks",
                schema: "flora_core");
        }
    }
}
