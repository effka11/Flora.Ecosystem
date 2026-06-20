namespace Flora.Users.Domain;

public enum ProfileVisibility
{
    All = 0,
    Friends = 1,
    None = 2,
}

public enum UserMessagesFrom
{
    All = 0,
    Friends = 1,
}

public enum OnlineVisibilitySetting
{
    Visible = 0,
    Hidden = 1,
}

public class UserPrivacySettings
{
    public Guid UserUuid { get; set; }
    public ProfileVisibility FriendsVisibility { get; set; } = ProfileVisibility.All;
    public ProfileVisibility SubscriptionsVisibility { get; set; } = ProfileVisibility.All;
    public ProfileVisibility PostsVisibility { get; set; } = ProfileVisibility.All;
    public ProfileVisibility LikesVisibility { get; set; } = ProfileVisibility.Friends;
    public ProfileVisibility RepostsVisibility { get; set; } = ProfileVisibility.All;
    public UserMessagesFrom MessagesFrom { get; set; } = UserMessagesFrom.All;
    public ProfileVisibility CommentsFrom { get; set; } = ProfileVisibility.All;
    public OnlineVisibilitySetting OnlineFriends { get; set; } = OnlineVisibilitySetting.Visible;
    public OnlineVisibilitySetting OnlineStrangers { get; set; } = OnlineVisibilitySetting.Hidden;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
