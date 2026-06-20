namespace Flora.Users.Contracts;

public enum ProfileAccessField
{
    Friends,
    Subscriptions,
    Posts,
    Likes,
    Reposts,
    Messages,
    Comments,
    OnlineStatus,
}

public sealed record UserPrivacySettingsDto(
    string FriendsVisibility,
    string SubscriptionsVisibility,
    string PostsVisibility,
    string LikesVisibility,
    string RepostsVisibility,
    string MessagesFrom,
    string CommentsFrom,
    string OnlineFriends,
    string OnlineStrangers);

public sealed record UpdateUserPrivacySettingsRequest(
    string? FriendsVisibility,
    string? SubscriptionsVisibility,
    string? PostsVisibility,
    string? LikesVisibility,
    string? RepostsVisibility,
    string? MessagesFrom,
    string? CommentsFrom,
    string? OnlineFriends,
    string? OnlineStrangers);

public interface IUserPrivacySettingsService
{
    Task<UserPrivacySettingsDto> GetAsync(Guid userUuid, CancellationToken cancellationToken = default);
    Task<UserPrivacySettingsDto> UpdateAsync(Guid userUuid, UpdateUserPrivacySettingsRequest request, CancellationToken cancellationToken = default);
}

public interface IProfileAccessPolicy
{
    Task<bool> CanAccessAsync(Guid? viewerUserUuid, Guid ownerUserUuid, ProfileAccessField field, CancellationToken cancellationToken = default);
}
