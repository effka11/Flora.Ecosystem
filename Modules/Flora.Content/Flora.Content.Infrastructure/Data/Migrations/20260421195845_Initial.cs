using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Flora.Content.Infrastructure.Data.Migrations
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
                name: "communities",
                schema: "flora_core",
                columns: table => new
                {
                    community_id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    slug = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    is_private = table.Column<bool>(type: "boolean", nullable: false, defaultValue: true),
                    avatar_uuid = table.Column<Guid>(type: "uuid", nullable: true),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_communities", x => x.community_id);
                });

            migrationBuilder.CreateTable(
                name: "user_posts",
                schema: "flora_core",
                columns: table => new
                {
                    post_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    author_user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    community_id = table.Column<Guid>(type: "uuid", nullable: true),
                    content = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    is_deleted = table.Column<bool>(type: "boolean", nullable: false, defaultValue: false),
                    deleted_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_posts", x => x.post_uuid);
                });

            migrationBuilder.CreateTable(
                name: "community_avatars",
                schema: "flora_core",
                columns: table => new
                {
                    uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    community_id = table.Column<Guid>(type: "uuid", nullable: false),
                    content_type = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    data = table.Column<byte[]>(type: "bytea", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_community_avatars", x => x.uuid);
                    table.ForeignKey(
                        name: "fk_community_avatars_community",
                        column: x => x.community_id,
                        principalSchema: "flora_core",
                        principalTable: "communities",
                        principalColumn: "community_id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "user_communities",
                schema: "flora_core",
                columns: table => new
                {
                    user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    community_id = table.Column<Guid>(type: "uuid", nullable: false),
                    role = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false, defaultValue: "Member"),
                    joined_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_communities", x => new { x.user_uuid, x.community_id });
                    table.ForeignKey(
                        name: "fk_user_communities_community",
                        column: x => x.community_id,
                        principalSchema: "flora_core",
                        principalTable: "communities",
                        principalColumn: "community_id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "post_comments",
                schema: "flora_core",
                columns: table => new
                {
                    comment_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    post_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    author_user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    content = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    is_deleted = table.Column<bool>(type: "boolean", nullable: false, defaultValue: false),
                    deleted_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_post_comments", x => x.comment_uuid);
                    table.ForeignKey(
                        name: "fk_post_comments_post",
                        column: x => x.post_uuid,
                        principalSchema: "flora_core",
                        principalTable: "user_posts",
                        principalColumn: "post_uuid",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "post_images",
                schema: "flora_core",
                columns: table => new
                {
                    uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    post_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    content_type = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    data = table.Column<byte[]>(type: "bytea", nullable: false),
                    sort_order = table.Column<int>(type: "integer", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_post_images", x => x.uuid);
                    table.ForeignKey(
                        name: "fk_post_images_post",
                        column: x => x.post_uuid,
                        principalSchema: "flora_core",
                        principalTable: "user_posts",
                        principalColumn: "post_uuid",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "post_likes",
                schema: "flora_core",
                columns: table => new
                {
                    post_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_post_likes", x => new { x.post_uuid, x.user_uuid });
                    table.ForeignKey(
                        name: "fk_post_likes_post",
                        column: x => x.post_uuid,
                        principalSchema: "flora_core",
                        principalTable: "user_posts",
                        principalColumn: "post_uuid",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "post_reposts",
                schema: "flora_core",
                columns: table => new
                {
                    post_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_post_reposts", x => new { x.post_uuid, x.user_uuid });
                    table.ForeignKey(
                        name: "fk_post_reposts_post",
                        column: x => x.post_uuid,
                        principalSchema: "flora_core",
                        principalTable: "user_posts",
                        principalColumn: "post_uuid",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "post_views",
                schema: "flora_core",
                columns: table => new
                {
                    post_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    user_uuid = table.Column<Guid>(type: "uuid", nullable: false),
                    viewed_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_post_views", x => new { x.post_uuid, x.user_uuid });
                    table.ForeignKey(
                        name: "fk_post_views_post",
                        column: x => x.post_uuid,
                        principalSchema: "flora_core",
                        principalTable: "user_posts",
                        principalColumn: "post_uuid",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_communities_slug",
                schema: "flora_core",
                table: "communities",
                column: "slug",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_community_avatars_community_id",
                schema: "flora_core",
                table: "community_avatars",
                column: "community_id");

            migrationBuilder.CreateIndex(
                name: "ix_post_comments_author_user_uuid",
                schema: "flora_core",
                table: "post_comments",
                column: "author_user_uuid");

            migrationBuilder.CreateIndex(
                name: "ix_post_comments_post_uuid",
                schema: "flora_core",
                table: "post_comments",
                column: "post_uuid");

            migrationBuilder.CreateIndex(
                name: "ix_post_images_post_uuid",
                schema: "flora_core",
                table: "post_images",
                column: "post_uuid");

            migrationBuilder.CreateIndex(
                name: "ix_post_likes_post_uuid",
                schema: "flora_core",
                table: "post_likes",
                column: "post_uuid");

            migrationBuilder.CreateIndex(
                name: "ix_post_reposts_post_uuid",
                schema: "flora_core",
                table: "post_reposts",
                column: "post_uuid");

            migrationBuilder.CreateIndex(
                name: "ix_post_views_post_uuid",
                schema: "flora_core",
                table: "post_views",
                column: "post_uuid");

            migrationBuilder.CreateIndex(
                name: "ix_user_communities_community_id",
                schema: "flora_core",
                table: "user_communities",
                column: "community_id");

            migrationBuilder.CreateIndex(
                name: "ix_user_posts_author_user_uuid",
                schema: "flora_core",
                table: "user_posts",
                column: "author_user_uuid");

            migrationBuilder.CreateIndex(
                name: "ix_user_posts_community_id",
                schema: "flora_core",
                table: "user_posts",
                column: "community_id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "community_avatars",
                schema: "flora_core");

            migrationBuilder.DropTable(
                name: "post_comments",
                schema: "flora_core");

            migrationBuilder.DropTable(
                name: "post_images",
                schema: "flora_core");

            migrationBuilder.DropTable(
                name: "post_likes",
                schema: "flora_core");

            migrationBuilder.DropTable(
                name: "post_reposts",
                schema: "flora_core");

            migrationBuilder.DropTable(
                name: "post_views",
                schema: "flora_core");

            migrationBuilder.DropTable(
                name: "user_communities",
                schema: "flora_core");

            migrationBuilder.DropTable(
                name: "user_posts",
                schema: "flora_core");

            migrationBuilder.DropTable(
                name: "communities",
                schema: "flora_core");
        }
    }
}
