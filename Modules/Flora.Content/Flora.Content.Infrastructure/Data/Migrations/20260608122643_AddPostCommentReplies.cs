using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Flora.Content.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddPostCommentReplies : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "parent_comment_uuid",
                schema: "flora_core",
                table: "post_comments",
                type: "uuid",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "ix_post_comments_parent_comment_uuid",
                schema: "flora_core",
                table: "post_comments",
                column: "parent_comment_uuid");

            migrationBuilder.CreateIndex(
                name: "ix_post_comments_post_parent_created",
                schema: "flora_core",
                table: "post_comments",
                columns: new[] { "post_uuid", "parent_comment_uuid", "created_at" });

            migrationBuilder.AddForeignKey(
                name: "fk_post_comments_parent",
                schema: "flora_core",
                table: "post_comments",
                column: "parent_comment_uuid",
                principalSchema: "flora_core",
                principalTable: "post_comments",
                principalColumn: "comment_uuid",
                onDelete: ReferentialAction.Cascade);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "fk_post_comments_parent",
                schema: "flora_core",
                table: "post_comments");

            migrationBuilder.DropIndex(
                name: "ix_post_comments_parent_comment_uuid",
                schema: "flora_core",
                table: "post_comments");

            migrationBuilder.DropIndex(
                name: "ix_post_comments_post_parent_created",
                schema: "flora_core",
                table: "post_comments");

            migrationBuilder.DropColumn(
                name: "parent_comment_uuid",
                schema: "flora_core",
                table: "post_comments");
        }
    }
}
