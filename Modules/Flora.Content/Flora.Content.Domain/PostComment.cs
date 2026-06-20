using Flora.Shared;

namespace Flora.Content.Domain;

public class PostComment
{
    public Guid CommentUuid { get; set; } = FloraUuid.NewGuid();
    public Guid PostUuid { get; set; }
    /// <summary>Корневой комментарий: <c>null</c>; ответ — UUID родительского комментария того же поста.</summary>
    public Guid? ParentCommentUuid { get; set; }
    public Guid AuthorUserUuid { get; set; }
    public string Content { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public bool IsDeleted { get; set; }
    public DateTime? DeletedAt { get; set; }
}
