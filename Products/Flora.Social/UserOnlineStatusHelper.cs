namespace Flora.Social;

internal static class UserOnlineStatusHelper
{
  private static readonly TimeSpan OnlineThreshold = TimeSpan.FromMinutes(5);

  public static bool IsOnline(DateTime? lastSeenUtc, DateTime utcNow) =>
    lastSeenUtc.HasValue && utcNow - lastSeenUtc.Value <= OnlineThreshold;

  public static (bool IsOnline, DateTime? LastSeenUtc) ResolveForViewer(
    Guid viewerUserUuid,
    Guid subjectUserUuid,
    bool canSeeOnlineStatus,
    IReadOnlyDictionary<Guid, DateTime?> lastSeenByUser,
    DateTime utcNow)
  {
    if (!canSeeOnlineStatus)
      return (false, null);

    if (!lastSeenByUser.TryGetValue(subjectUserUuid, out var lastSeen))
      return (false, null);

    return (IsOnline(lastSeen, utcNow), lastSeen);
  }
}
