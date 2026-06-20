using Flora.Users.Contracts;
using Flora.Users.Domain;
using Microsoft.EntityFrameworkCore;

namespace Flora.Users.Infrastructure;

public sealed class UserPrivacySettingsService(UsersDbContext db) : IUserPrivacySettingsService
{
    public async Task<UserPrivacySettingsDto> GetAsync(Guid userUuid, CancellationToken cancellationToken = default)
    {
        var entity = await db.UserPrivacySettings.AsNoTracking()
            .FirstOrDefaultAsync(s => s.UserUuid == userUuid, cancellationToken);
        return ToDto(entity ?? CreateDefaultEntity(userUuid));
    }

    public async Task<UserPrivacySettingsDto> UpdateAsync(
        Guid userUuid,
        UpdateUserPrivacySettingsRequest request,
        CancellationToken cancellationToken = default)
    {
        var entity = await db.UserPrivacySettings.FirstOrDefaultAsync(s => s.UserUuid == userUuid, cancellationToken);
        if (entity is null)
        {
            entity = CreateDefaultEntity(userUuid);
            db.UserPrivacySettings.Add(entity);
        }

        if (request.FriendsVisibility is not null)
            entity.FriendsVisibility = ParseVisibility(request.FriendsVisibility, nameof(request.FriendsVisibility));
        if (request.SubscriptionsVisibility is not null)
            entity.SubscriptionsVisibility = ParseVisibility(request.SubscriptionsVisibility, nameof(request.SubscriptionsVisibility));
        if (request.PostsVisibility is not null)
            entity.PostsVisibility = ParseVisibility(request.PostsVisibility, nameof(request.PostsVisibility));
        if (request.LikesVisibility is not null)
            entity.LikesVisibility = ParseVisibility(request.LikesVisibility, nameof(request.LikesVisibility));
        if (request.RepostsVisibility is not null)
            entity.RepostsVisibility = ParseVisibility(request.RepostsVisibility, nameof(request.RepostsVisibility));
        if (request.MessagesFrom is not null)
            entity.MessagesFrom = ParseMessagesFrom(request.MessagesFrom);
        if (request.CommentsFrom is not null)
            entity.CommentsFrom = ParseVisibility(request.CommentsFrom, nameof(request.CommentsFrom));
        if (request.OnlineFriends is not null)
            entity.OnlineFriends = ParseOnlineVisibility(request.OnlineFriends, nameof(request.OnlineFriends));
        if (request.OnlineStrangers is not null)
            entity.OnlineStrangers = ParseOnlineVisibility(request.OnlineStrangers, nameof(request.OnlineStrangers));

        entity.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(cancellationToken);
        return ToDto(entity);
    }

    internal static UserPrivacySettings CreateDefaultEntity(Guid userUuid) => new()
    {
        UserUuid = userUuid,
    };

    internal static UserPrivacySettingsDto ToDto(UserPrivacySettings entity) => new(
        VisibilityToString(entity.FriendsVisibility),
        VisibilityToString(entity.SubscriptionsVisibility),
        VisibilityToString(entity.PostsVisibility),
        VisibilityToString(entity.LikesVisibility),
        VisibilityToString(entity.RepostsVisibility),
        MessagesFromToString(entity.MessagesFrom),
        VisibilityToString(entity.CommentsFrom),
        OnlineToString(entity.OnlineFriends),
        OnlineToString(entity.OnlineStrangers));

    private static ProfileVisibility ParseVisibility(string raw, string fieldName)
    {
        return raw.Trim().ToLowerInvariant() switch
        {
            "all" => ProfileVisibility.All,
            "friends" => ProfileVisibility.Friends,
            "none" => ProfileVisibility.None,
            _ => throw new ArgumentException($"Недопустимое значение {fieldName}.", fieldName),
        };
    }

    private static UserMessagesFrom ParseMessagesFrom(string raw) =>
        raw.Trim().ToLowerInvariant() switch
        {
            "all" => UserMessagesFrom.All,
            "friends" => UserMessagesFrom.Friends,
            _ => throw new ArgumentException("Недопустимое значение messagesFrom.", nameof(raw)),
        };

    private static OnlineVisibilitySetting ParseOnlineVisibility(string raw, string fieldName) =>
        raw.Trim().ToLowerInvariant() switch
        {
            "visible" => OnlineVisibilitySetting.Visible,
            "hidden" => OnlineVisibilitySetting.Hidden,
            _ => throw new ArgumentException($"Недопустимое значение {fieldName}.", fieldName),
        };

    private static string VisibilityToString(ProfileVisibility value) => value switch
    {
        ProfileVisibility.Friends => "friends",
        ProfileVisibility.None => "none",
        _ => "all",
    };

    private static string MessagesFromToString(UserMessagesFrom value) =>
        value == UserMessagesFrom.Friends ? "friends" : "all";

    private static string OnlineToString(OnlineVisibilitySetting value) =>
        value == OnlineVisibilitySetting.Hidden ? "hidden" : "visible";
}
