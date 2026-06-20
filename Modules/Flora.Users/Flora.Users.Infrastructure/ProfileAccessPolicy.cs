using Flora.Users.Contracts;
using Flora.Users.Domain;
using Microsoft.EntityFrameworkCore;

namespace Flora.Users.Infrastructure;

/// <summary>
/// «Друзья» = взаимная подписка (оба пользователя подписаны друг на друга).
/// </summary>
public sealed class ProfileAccessPolicy(
    UsersDbContext db,
    IFollowGraphReader followGraph,
    IUserBlocklistService blocklist) : IProfileAccessPolicy
{
    public async Task<bool> CanAccessAsync(
        Guid? viewerUserUuid,
        Guid ownerUserUuid,
        ProfileAccessField field,
        CancellationToken cancellationToken = default)
    {
        if (viewerUserUuid == ownerUserUuid)
            return true;

        if (viewerUserUuid.HasValue &&
            await blocklist.IsBlockedByAsync(ownerUserUuid, viewerUserUuid.Value, cancellationToken))
        {
            return false;
        }

        var settings = await db.UserPrivacySettings.AsNoTracking()
            .FirstOrDefaultAsync(s => s.UserUuid == ownerUserUuid, cancellationToken);
        settings ??= UserPrivacySettingsService.CreateDefaultEntity(ownerUserUuid);

        return field switch
        {
            ProfileAccessField.Friends => await EvaluateVisibilityAsync(viewerUserUuid, ownerUserUuid, settings.FriendsVisibility, cancellationToken),
            ProfileAccessField.Subscriptions => await EvaluateVisibilityAsync(viewerUserUuid, ownerUserUuid, settings.SubscriptionsVisibility, cancellationToken),
            ProfileAccessField.Posts => await EvaluateVisibilityAsync(viewerUserUuid, ownerUserUuid, settings.PostsVisibility, cancellationToken),
            ProfileAccessField.Likes => await EvaluateVisibilityAsync(viewerUserUuid, ownerUserUuid, settings.LikesVisibility, cancellationToken),
            ProfileAccessField.Reposts => await EvaluateVisibilityAsync(viewerUserUuid, ownerUserUuid, settings.RepostsVisibility, cancellationToken),
            ProfileAccessField.Comments => await EvaluateVisibilityAsync(viewerUserUuid, ownerUserUuid, settings.CommentsFrom, cancellationToken),
            ProfileAccessField.Messages => await EvaluateMessagesFromAsync(viewerUserUuid, ownerUserUuid, settings.MessagesFrom, cancellationToken),
            ProfileAccessField.OnlineStatus => await EvaluateOnlineAsync(viewerUserUuid, ownerUserUuid, settings, cancellationToken),
            _ => false,
        };
    }

    private async Task<bool> EvaluateVisibilityAsync(
        Guid? viewerUserUuid,
        Guid ownerUserUuid,
        ProfileVisibility visibility,
        CancellationToken cancellationToken)
    {
        return visibility switch
        {
            ProfileVisibility.All => true,
            ProfileVisibility.None => false,
            ProfileVisibility.Friends => viewerUserUuid.HasValue &&
                await followGraph.AreMutualFollowersAsync(viewerUserUuid.Value, ownerUserUuid, cancellationToken),
            _ => false,
        };
    }

    private async Task<bool> EvaluateMessagesFromAsync(
        Guid? viewerUserUuid,
        Guid ownerUserUuid,
        UserMessagesFrom messagesFrom,
        CancellationToken cancellationToken)
    {
        return messagesFrom switch
        {
            UserMessagesFrom.All => true,
            UserMessagesFrom.Friends => viewerUserUuid.HasValue &&
                await followGraph.AreMutualFollowersAsync(viewerUserUuid.Value, ownerUserUuid, cancellationToken),
            _ => false,
        };
    }

    private async Task<bool> EvaluateOnlineAsync(
        Guid? viewerUserUuid,
        Guid ownerUserUuid,
        UserPrivacySettings settings,
        CancellationToken cancellationToken)
    {
        if (!viewerUserUuid.HasValue)
            return settings.OnlineStrangers == OnlineVisibilitySetting.Visible;

        var isFriend = await followGraph.AreMutualFollowersAsync(viewerUserUuid.Value, ownerUserUuid, cancellationToken);
        return isFriend
            ? settings.OnlineFriends == OnlineVisibilitySetting.Visible
            : settings.OnlineStrangers == OnlineVisibilitySetting.Visible;
    }
}
