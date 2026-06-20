using Flora.Users.Contracts;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;

namespace Flora.Users.Application.People;

/// <summary>
/// FIRA-P — People recommendations.
/// Кэшируется per-user с TTL = <see cref="UserRecommendationOptions.CacheTtlSeconds"/>.
/// Кэш хранит полный вычисленный список; .Take(take) применяется после чтения кэша —
/// разные значения take обслуживаются из одного snapshot (паттерн как в FIRA-F).
/// Инвалидация при follow/unfollow (§13.2 FIRA.md).
/// </summary>
public sealed class UserRecommendationService : IUserRecommendationService
{
    private readonly IFollowGraphReader _followGraph;
    private readonly IUserRecommendationQueries _queries;
    private readonly UserRecommendationOptions _options;
    private readonly IMemoryCache _cache;

    // Внутренний snapshot: полный список + метка вычисления (§13.3 FIRA.md)
    private sealed record PeopleSnapshot(IReadOnlyList<RecommendedUserDto> FullList, DateTime GeneratedAt);

    public UserRecommendationService(
        IFollowGraphReader followGraph,
        IUserRecommendationQueries queries,
        IOptions<UserRecommendationOptions> options,
        IMemoryCache cache)
    {
        _followGraph = followGraph;
        _queries     = queries;
        _options     = options.Value;
        _cache       = cache;
    }

    public async Task<IReadOnlyList<RecommendedUserDto>> GetRecommendedAsync(
        Guid userUuid,
        int take = 30,
        CancellationToken cancellationToken = default)
    {
        take = Math.Clamp(take, 1, 100);
        var snapshot = await GetOrComputeSnapshotAsync(userUuid, cancellationToken);
        return snapshot.FullList.Take(take).ToList();
    }

    public DateTime? GetCacheGeneratedAt(Guid userUuid) =>
        _cache.TryGetValue(CacheKey(userUuid), out PeopleSnapshot? s) ? s!.GeneratedAt : null;

    public DateTime? GetCacheExpiresAt(Guid userUuid) =>
        _cache.TryGetValue(CacheKey(userUuid), out PeopleSnapshot? s)
            ? s!.GeneratedAt.AddSeconds(_options.CacheTtlSeconds)
            : null;

    public void InvalidateCache(Guid userUuid) => _cache.Remove(CacheKey(userUuid));

    // ─── Приватный pipeline ─────────────────────────────────────────────────

    private async Task<PeopleSnapshot> GetOrComputeSnapshotAsync(Guid userUuid, CancellationToken ct)
    {
        if (_cache.TryGetValue(CacheKey(userUuid), out PeopleSnapshot? cached))
            return cached!;

        var following  = await _followGraph.GetFollowingUserIdsAsync(userUuid, ct);
        var candidates = await _queries.GetCandidatesAsync(userUuid, following, ct);

        var fullList = candidates
            .Select(c => (Candidate: c, Score: ScoreCandidate(c)))
            .OrderByDescending(x => x.Score)
            .ThenBy(x => x.Candidate.DisplayName, StringComparer.OrdinalIgnoreCase)
            .Select(x => new RecommendedUserDto
            {
                UserUuid      = x.Candidate.UserUuid,
                DisplayName   = x.Candidate.DisplayName,
                AvatarUuid    = x.Candidate.AvatarUuid,
                FollowerCount = x.Candidate.FollowerCount,
            })
            .ToList();

        var snapshot = new PeopleSnapshot(fullList, DateTime.UtcNow);
        _cache.Set(CacheKey(userUuid), snapshot,
            TimeSpan.FromSeconds(Math.Max(10, _options.CacheTtlSeconds)));

        return snapshot;
    }

    private double ScoreCandidate(UserRecommendationCandidate candidate)
    {
        var followerScore = Math.Log10(Math.Max(candidate.FollowerCount, 0) + 1) * _options.WeightFollowers;
        var socialScore   = Math.Log10(Math.Max(candidate.FollowedByFollowingCount, 0) + 1) * _options.WeightSocial;

        var ageDays      = Math.Max((DateTime.UtcNow - candidate.UpdatedAt).TotalDays, 0);
        var boostWindow  = Math.Max(_options.RecencyBoostDays, 1);
        var recencyScore = Math.Max(0, boostWindow - ageDays) / boostWindow * _options.WeightRecency;

        return followerScore + socialScore + recencyScore;
    }

    private static string CacheKey(Guid userUuid) => $"flora:fira-p:v1:{userUuid:N}";
}
