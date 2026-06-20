namespace Flora.Users.Domain;

public class UserFollower
{
    public Guid FollowerUserUuid { get; set; }
    public Guid FollowingUserUuid { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
