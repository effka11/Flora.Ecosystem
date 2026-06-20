using Flora.Content.Contracts;
using Flora.Users.Contracts;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;

namespace Flora.Content.Application.Communities;

/// <summary>
/// FIRA-C — Community recommendations.
/// Кэшируется per-user с TTL = <see cref="CommunityRecommendationOptions.CacheTtlSeconds"/>.
/// Кэш хранит полный вычисленный список; .Take(take) применяется после чтения кэша —
/// разные значения take обслуживаются из одного snapshot (паттерн как в FIRA-F).
/// Инвалидация при join/leave сообщества (§13.2 FIRA.md).
/// </summary>
public sealed class CommunityRecommendationService : ICommunityRecommendationService
{
    private readonly IFollowGraphReader _followGraph;
    private readonly ICommunityRecommendationQueries _queries;
    private readonly CommunityRecommendationOptions _options;
    private readonly IMemoryCache _cache;

    // Внутренний snapshot: полный список + метка вычисления (§13.3 FIRA.md)
    private sealed record CommunitySnapshot(IReadOnlyList<RecommendedCommunityDto> FullList, DateTime GeneratedAt);

    public CommunityRecommendationService(
        IFollowGraphReader followGraph,
        ICommunityRecommendationQueries queries,
        IOptions<CommunityRecommendationOptions> options,
        IMemoryCache cache)
    {
        _followGraph = followGraph;
        _queries     = queries;
        _options     = options.Value;
        _cache       = cache;
    }

    public async Task<IReadOnlyList<RecommendedCommunityDto>> GetRecommendedAsync(
        Guid userUuid,
        int take = 30,
        CancellationToken cancellationToken = default)
    {
        take = Math.Clamp(take, 1, 100);
        var snapshot = await GetOrComputeSnapshotAsync(userUuid, cancellationToken);
        return snapshot.FullList.Take(take).ToList();
    }

    public DateTime? GetCacheGeneratedAt(Guid userUuid) =>
        _cache.TryGetValue(CacheKey(userUuid), out CommunitySnapshot? s) ? s!.GeneratedAt : null;

    public DateTime? GetCacheExpiresAt(Guid userUuid) =>
        _cache.TryGetValue(CacheKey(userUuid), out CommunitySnapshot? s)
            ? s!.GeneratedAt.AddSeconds(_options.CacheTtlSeconds)
            : null;

    public void InvalidateCache(Guid userUuid) => _cache.Remove(CacheKey(userUuid));

    // ─── Приватный pipeline ─────────────────────────────────────────────────

    private async Task<CommunitySnapshot> GetOrComputeSnapshotAsync(Guid userUuid, CancellationToken ct)
    {
        if (_cache.TryGetValue(CacheKey(userUuid), out CommunitySnapshot? cached))
            return cached!;

        var following        = await _followGraph.GetFollowingUserIdsAsync(userUuid, ct);
        var activitySinceUtc = DateTime.UtcNow.AddDays(-Math.Max(_options.ActivityDays, 1));
        var candidates       = await _queries.GetCandidatesAsync(
            userUuid, following, activitySinceUtc, ct);

        var fullList = candidates
            .Select(c => (Candidate: c, Score: ScoreCandidate(c)))
            .OrderByDescending(x => x.Score)
            .ThenBy(x => x.Candidate.Name, StringComparer.OrdinalIgnoreCase)
            .Select(x => new RecommendedCommunityDto
            {
                CommunityId = x.Candidate.CommunityId,
                Name        = x.Candidate.Name,
                Slug        = x.Candidate.Slug,
                MemberCount = x.Candidate.MemberCount,
                AvatarUuid  = x.Candidate.AvatarUuid,
            })
            .ToList();

        var snapshot = new CommunitySnapshot(fullList, DateTime.UtcNow);
        _cache.Set(CacheKey(userUuid), snapshot,
            TimeSpan.FromSeconds(Math.Max(10, _options.CacheTtlSeconds)));

        return snapshot;
    }

    private double ScoreCandidate(CommunityRecommendationCandidate candidate)
    {
        var memberScore   = Math.Log10(Math.Max(candidate.MemberCount, 0) + 1)     * _options.WeightMembers;
        var activityScore = Math.Log10(Math.Max(candidate.RecentPostCount, 0) + 1)  * _options.WeightActivity;
        var socialScore   = Math.Log10(Math.Max(candidate.FollowedMembersCount, 0) + 1) * _options.WeightSocial;

        var ageDays      = Math.Max((DateTime.UtcNow - candidate.CreatedAt).TotalDays, 0);
        var boostWindow  = Math.Max(_options.NewCommunityBoostDays, 1);
        var recencyScore = Math.Max(0, boostWindow - ageDays) / boostWindow * _options.WeightRecency;

        return memberScore + activityScore + socialScore + recencyScore;
    }

    private static string CacheKey(Guid userUuid) => $"flora:fira-c:v1:{userUuid:N}";
}
