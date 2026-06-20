namespace Flora.Content.Domain;

public class UserCommunity
{
    public Guid UserUuid { get; set; }
    public Guid CommunityId { get; set; }
    public string Role { get; set; } = "Member";
    public DateTime JoinedAt { get; set; } = DateTime.UtcNow;
}
