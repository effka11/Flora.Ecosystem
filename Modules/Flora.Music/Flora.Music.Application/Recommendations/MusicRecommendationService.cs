using Flora.Music.Application.Tracks;
using Flora.Music.Contracts;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;

namespace Flora.Music.Application.Recommendations;

/// <summary>
/// FIRA-M — Music Recommendations (Phase 0): публичные треки площадки с global relevance,
/// слабым жанровым сигналом пользователя и exploration-квотой.
/// </summary>
public sealed class MusicRecommendationService : IMusicRecommendationService
{
    private readonly IMusicRecommendationRepository _repo;
    private readonly MusicTrackDtoMapper _trackMapper;
    private readonly MusicRecommendationOptions _options;
    private readonly IMemoryCache _cache;

    private sealed record FlowSnapshot(IReadOnlyList<ScoredCandidate> Ranked, DateTime GeneratedAt);

    private sealed record ScoredCandidate(MusicFlowCandidateRow Track, double Score);

    public MusicRecommendationService(
        IMusicRecommendationRepository repo,
        MusicTrackDtoMapper trackMapper,
        IOptions<MusicRecommendationOptions> options,
        IMemoryCache cache)
    {
        _repo = repo;
        _trackMapper = trackMapper;
        _options = options.Value;
        _cache = cache;
    }

    public async Task<MusicFlowWaveDto> GetFlowWaveAsync(
        Guid userUuid,
        MusicFlowWaveRequest request,
        CancellationToken cancellationToken = default)
    {
        var take = Math.Clamp(request.Take, 1, 50);
        var exclude = request.ExcludeTrackUuids?.ToHashSet() ?? [];
        var snapshot = await GetOrComputeSnapshotAsync(
            userUuid,
            request.GenreId,
            request.SubgenreId,
            cancellationToken);
        var available = snapshot.Ranked
            .Where(x => !exclude.Contains(x.Track.TrackUuid))
            .ToList();

        var picked = PickWaveBatch(available, take);
        var tracks = await _trackMapper.MapFlowRowsAsync(
            picked.Select(x => x.Track).ToList(),
            userUuid,
            cancellationToken);

        return new MusicFlowWaveDto(
            tracks,
            snapshot.GeneratedAt,
            snapshot.GeneratedAt.AddSeconds(Math.Max(10, _options.CacheTtlSeconds)));
    }

    public DateTime? GetCacheGeneratedAt(Guid userUuid) =>
        _cache.TryGetValue(CacheKey(userUuid), out FlowSnapshot? snapshot) ? snapshot!.GeneratedAt : null;

    public DateTime? GetCacheExpiresAt(Guid userUuid) =>
        _cache.TryGetValue(CacheKey(userUuid), out FlowSnapshot? snapshot)
            ? snapshot!.GeneratedAt.AddSeconds(Math.Max(10, _options.CacheTtlSeconds))
            : null;

    private async Task<FlowSnapshot> GetOrComputeSnapshotAsync(
        Guid userUuid,
        string? genreId,
        string? subgenreId,
        CancellationToken ct)
    {
        var cacheKey = CacheKey(userUuid, genreId, subgenreId);
        if (_cache.TryGetValue(cacheKey, out FlowSnapshot? cached))
            return cached!;

        var candidates = string.IsNullOrWhiteSpace(genreId) && string.IsNullOrWhiteSpace(subgenreId)
            ? await _repo.ListPublishedPlatformCandidatesAsync(_options.MaxCandidates, ct)
            : await _repo.ListPublishedPlatformCandidatesByScopeAsync(genreId, subgenreId, _options.MaxCandidates, ct);
        var genreWeights = await _repo.GetUserGenreWeightsAsync(userUuid, ct);
        var maxGenreWeight = genreWeights.Values.DefaultIfEmpty(0).Max();
        var nowUtc = DateTime.UtcNow;

        var ranked = candidates
            .Select(c => new ScoredCandidate(c, ScoreCandidate(c, genreWeights, maxGenreWeight, nowUtc)))
            .OrderByDescending(x => x.Score)
            .ThenByDescending(x => x.Track.PublishedAt)
            .ThenBy(x => x.Track.Title, StringComparer.OrdinalIgnoreCase)
            .ToList();

        var snapshot = new FlowSnapshot(ranked, nowUtc);
        _cache.Set(cacheKey, snapshot, TimeSpan.FromSeconds(Math.Max(10, _options.CacheTtlSeconds)));
        return snapshot;
    }

    private double ScoreCandidate(
        MusicFlowCandidateRow track,
        IReadOnlyDictionary<string, int> genreWeights,
        int maxGenreWeight,
        DateTime nowUtc)
    {
        var recencyDays = Math.Max((nowUtc - track.PublishedAt).TotalDays, 0);
        var recencyWindow = Math.Max(_options.RecencyBoostDays, 1);
        var globalRelevance = Math.Max(0, recencyWindow - recencyDays) / recencyWindow;

        var genreAffinity = 0.0;
        if (!string.IsNullOrWhiteSpace(track.GenreId)
            && genreWeights.TryGetValue(track.GenreId, out var weight)
            && maxGenreWeight > 0)
        {
            genreAffinity = weight / (double)maxGenreWeight;
        }

        // Phase 0: alpha is intentionally 0 until listening events are implemented.
        return _options.WeightAlpha * 0.0
            + _options.WeightBeta * globalRelevance
            + _options.WeightGamma * genreAffinity;
    }

    private List<ScoredCandidate> PickWaveBatch(IReadOnlyList<ScoredCandidate> ranked, int take)
    {
        if (ranked.Count <= take)
            return ranked.ToList();

        var explorationCount = (int)Math.Round(take * Math.Clamp(_options.ExplorationQuota, 0, 0.5));
        var mainCount = Math.Max(0, take - explorationCount);
        var main = ranked.Take(mainCount).ToList();

        if (explorationCount <= 0)
            return main;

        var mainIds = main.Select(x => x.Track.TrackUuid).ToHashSet();
        var exploration = ranked
            .Skip(mainCount)
            .Where(x => !mainIds.Contains(x.Track.TrackUuid))
            .OrderBy(_ => Random.Shared.Next())
            .Take(explorationCount);

        return main.Concat(exploration).ToList();
    }

    private static string CacheKey(Guid userUuid, string? genreId = null, string? subgenreId = null)
    {
        var genrePart = string.IsNullOrWhiteSpace(genreId) ? "_" : genreId.Trim().ToLowerInvariant();
        var subgenrePart = string.IsNullOrWhiteSpace(subgenreId) ? "_" : subgenreId.Trim().ToLowerInvariant();
        return $"flora:fira-m:v1:{userUuid:N}:{genrePart}:{subgenrePart}";
    }
}
