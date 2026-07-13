using Flora.Content.Contracts;
using Flora.Users.Contracts;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;

namespace Flora.Content.Application.Feed;

/// <summary>
/// Реализация FIRA-F — Flora Individual Recommendation Algorithm (Feed component).
///
/// Pipeline (§FIRA-F.md):
///   Шаг 1  Генерация кандидатов из 5 источников
///   Шаг 2  Feature Extraction (engagement_48h, author follower count, author affinity, followed likers/reposters)
///   Шаг 3  Скоринг по формуле Score = α·IA + β·GR + γ·SP    (Phase 0: α=0, β=0.70, γ=0.30)
///   Шаг 4  Постобработка: разнообразие авторов + квота исследования (ε = 15 %)
///
/// Инварианты приватности (§12 FIRA.md): приватные сообщества отфильтрованы на уровне
/// каждого кандидатного запроса (IContentFeedQueries.VisiblePosts); блокировки в любом
/// направлении исключаются здесь — блоклистом владеет модуль Users (IUserBlocklistService).
///
/// Хронологическая лента «Подписки» реализована отдельно: посты подписок + репосты (позиция по первому репосту, без дублей).
/// </summary>
public sealed class FeedRecommendationService : IFeedRecommendationService
{
    private readonly IFollowGraphReader _followGraph;
    private readonly IUserBlocklistService _blocklist;
    private readonly IContentFeedQueries _feedQueries;
    private readonly IMemoryCache _cache;
    private readonly FiraFeedConfig _fira;
    private readonly FeedRecommendationOptions _subOptions;

    public FeedRecommendationService(
        IFollowGraphReader followGraph,
        IUserBlocklistService blocklist,
        IContentFeedQueries feedQueries,
        IMemoryCache cache,
        IOptions<FiraFeedConfig> firaOptions,
        IOptions<FeedRecommendationOptions> subOptions)
    {
        _followGraph = followGraph;
        _blocklist   = blocklist;
        _feedQueries = feedQueries;
        _cache       = cache;
        _fira        = firaOptions.Value;
        _subOptions  = subOptions.Value;
    }

    // Внутренняя запись, хранящаяся в кэше: набор постов + метка времени вычисления
    private sealed record FeedSnapshot(List<Guid> PostUuids, DateTime GeneratedAt);

    // ─── Рекомендованная лента (FIRA-F) ───────────────────────────────────────

    public async Task<FeedPage> GetRecommendedFeedAsync(
        Guid userUuid,
        int take = 20,
        string? cursor = null,
        bool forceRefresh = false,
        CancellationToken cancellationToken = default)
    {
        take = Math.Clamp(take, 1, 50);
        var offset = ParseCursor(cursor);
        var snapshot = forceRefresh && offset == 0
            ? await RefreshSnapshotAsync(userUuid, cancellationToken)
            : await GetOrComputeSnapshotAsync(userUuid, cancellationToken);
        var page       = snapshot.PostUuids.Skip(offset).Take(take).ToList();
        var nextCursor = offset + page.Count < snapshot.PostUuids.Count
            ? EncodeCursor(offset + take)
            : null;
        return new FeedPage
        {
            PostUuids   = page,
            NextCursor  = nextCursor,
            HasMore     = nextCursor is not null,
            GeneratedAt = snapshot.GeneratedAt,
            ExpiresAt   = snapshot.GeneratedAt.AddSeconds(_fira.CacheTtlSeconds)
        };
    }

    public async Task<bool> HasNewContentAsync(
        Guid userUuid,
        DateTime since,
        CancellationToken cancellationToken = default)
    {
        var blocked = await _blocklist.GetBlockedUserIdsBidirectionalAsync(userUuid, cancellationToken);
        var following = (await _followGraph.GetFollowingUserIdsAsync(userUuid, cancellationToken))
            .Where(id => !blocked.Contains(id))
            .ToList();
        if (following.Count == 0) return false;
        return await _feedQueries.HasNewerPostsAsync(following, since, userUuid, cancellationToken);
    }

    // ─── Подписки — хронологическая лента ────────────────────────────────────

    public async Task<FeedPage> GetSubscriptionsFeedAsync(
        Guid userUuid,
        int take = 20,
        string? cursor = null,
        CancellationToken cancellationToken = default)
    {
        take = Math.Clamp(take, 1, 50);
        // Блокировка в любом направлении скрывает контент и в хронологической ленте (§12 FIRA.md).
        var blocked = await _blocklist.GetBlockedUserIdsBidirectionalAsync(userUuid, cancellationToken);
        var following = (await _followGraph.GetFollowingUserIdsAsync(userUuid, cancellationToken))
            .Where(id => !blocked.Contains(id))
            .ToList();
        if (following.Count == 0)
            return new FeedPage { PostUuids = Array.Empty<Guid>() };

        var since         = SinceSubscriptionUtc(DateTime.UtcNow, SubscriptionWindowDays);
        var maxCandidates = SubscriptionPostsTakeLimit;

        // Посты от подписок (позиция = время публикации).
        var authorPosts = await _feedQueries.GetPostsByAuthorsSinceAsync(
            following, since, maxCandidates, userUuid, cancellationToken);
        var authorPostIds = authorPosts.Select(p => p.PostUuid).ToHashSet();

        // Репосты подписок: позиция = время первого репоста; уже опубликованные посты не дублируются.
        var firstReposts = await _feedQueries.GetFirstRepostsFromUsersAsync(
            following, since, maxCandidates, cancellationToken);
        var repostOnlyIds = firstReposts
            .Where(r => !authorPostIds.Contains(r.PostUuid))
            .Select(r => r.PostUuid)
            .ToList();

        var timeline = new Dictionary<Guid, DateTime>();
        foreach (var post in authorPosts)
            timeline[post.PostUuid] = post.CreatedAt;

        var firstRepostAt = firstReposts.ToDictionary(r => r.PostUuid, r => r.FirstRepostAt);
        if (repostOnlyIds.Count > 0)
        {
            var repostPosts = await _feedQueries.GetPostsByIdsAsync(repostOnlyIds, userUuid, cancellationToken);
            foreach (var post in repostPosts)
            {
                if (firstRepostAt.TryGetValue(post.PostUuid, out var repostedAt))
                    timeline[post.PostUuid] = repostedAt;
            }
        }

        var ordered = timeline
            .OrderByDescending(kv => kv.Value)
            .ThenBy(kv => kv.Key)
            .Select(kv => kv.Key)
            .ToList();

        var offset = ParseCursor(cursor);
        var page   = ordered.Skip(offset).Take(take).ToList();
        var nextCursor = offset + page.Count < ordered.Count
            ? EncodeCursor(offset + take)
            : null;
        return new FeedPage
        {
            PostUuids  = page,
            NextCursor = nextCursor,
            HasMore    = nextCursor is not null
        };
    }

    // ─── Инвалидация кэша ────────────────────────────────────────────────────

    public void InvalidateFeedCache(Guid userUuid) => _cache.Remove(FiraCacheKey(userUuid));

    // ─── Приватный pipeline FIRA-F ──────────────────────────────────────────

    private async Task<FeedSnapshot> GetOrComputeSnapshotAsync(Guid userUuid, CancellationToken ct)
    {
        if (_fira.EnableCache && _cache.TryGetValue(FiraCacheKey(userUuid), out FeedSnapshot? cached))
            return cached!;

        return await StoreSnapshotAsync(userUuid, await ComputeFiraFeedAsync(userUuid, ct), ct);
    }

    /// <summary>
    /// Явный refresh: пересборка FIRA-F + позиционный shuffle верхних постов относительно предыдущего snapshot.
    /// </summary>
    private async Task<FeedSnapshot> RefreshSnapshotAsync(Guid userUuid, CancellationToken ct)
    {
        var cacheKey = FiraCacheKey(userUuid);
        List<Guid>? previousTop = null;
        if (_fira.EnableCache && _cache.TryGetValue(cacheKey, out FeedSnapshot? cached))
        {
            var window = Math.Max(1, _fira.RefreshShuffleWindow);
            previousTop = cached!.PostUuids.Take(window).ToList();
        }

        var freshList = await ComputeFiraFeedAsync(userUuid, ct);
        if (previousTop is { Count: > 0 })
            await ApplyExplicitRefreshShuffleAsync(userUuid, previousTop, freshList, ct);

        return await StoreSnapshotAsync(userUuid, freshList, ct);
    }

    private Task<FeedSnapshot> StoreSnapshotAsync(Guid userUuid, List<Guid> postUuids, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var generatedAt = DateTime.UtcNow;
        var snapshot    = new FeedSnapshot(postUuids, generatedAt);

        if (_fira.EnableCache)
        {
            _cache.Set(
                FiraCacheKey(userUuid),
                snapshot,
                TimeSpan.FromSeconds(Math.Max(10, _fira.CacheTtlSeconds)));
        }
        return Task.FromResult(snapshot);
    }

    private async Task ApplyExplicitRefreshShuffleAsync(
        Guid userUuid,
        IReadOnlyList<Guid> previousTop,
        List<Guid> freshList,
        CancellationToken ct)
    {
        if (freshList.Count == 0) return;

        var window = Math.Min(Math.Max(1, _fira.RefreshShuffleWindow), freshList.Count);
        var metaPosts = await _feedQueries.GetPostsByIdsAsync(freshList.Take(window).ToList(), userUuid, ct);
        var meta = metaPosts.ToDictionary(p => p.PostUuid);
        var probs = _fira.RefreshPositionSwapProbabilities ?? Array.Empty<double>();
        var nowUtc = DateTime.UtcNow;

        for (int i = 0; i < window; i++)
        {
            if (i > 0 && Random.Shared.NextDouble() >= GetRefreshSwapProbability(i, probs))
                continue;

            var prevId = i < previousTop.Count ? previousTop[i] : Guid.Empty;
            if (prevId == Guid.Empty || freshList[i] != prevId)
                continue;

            if (IsProtectedOwnPost(meta, freshList[i], userUuid, nowUtc))
                continue;

            int candidateIndex = freshList.FindIndex(i + 1, id => id != prevId);
            if (candidateIndex < 0)
                continue;

            (freshList[i], freshList[candidateIndex]) = (freshList[candidateIndex], freshList[i]);
        }
    }

    private static double GetRefreshSwapProbability(int index, double[] probs) =>
        index < probs.Length ? probs[index] : 0.0;

    private bool IsProtectedOwnPost(
        IReadOnlyDictionary<Guid, FeedPostLite> meta,
        Guid postId,
        Guid userUuid,
        DateTime nowUtc)
    {
        if (!meta.TryGetValue(postId, out var post))
            return false;

        return post.AuthorUserUuid == userUuid
            && (nowUtc - post.CreatedAt).TotalMinutes < _fira.RefreshOwnPostProtectMinutes;
    }

    private static string FiraCacheKey(Guid userUuid) => $"flora:fira-f:v4:{userUuid:N}";

    private int MinFeedSize =>
        Math.Clamp(_fira.MinFeedSize, 1, _fira.MaxCandidates);

    /// <summary>Окно подписного контента — единое для «Подписок» и FIRA-F (не короче 30 дней).</summary>
    private int SubscriptionWindowDays =>
        Math.Max(Math.Max(_fira.FollowingWindowDays, _subOptions.FollowingPostsDays), 30);

    private int SubscriptionPostsTakeLimit =>
        Math.Clamp(_subOptions.MaxCandidates, 50, 5000);

    private static DateTime SinceSubscriptionUtc(DateTime nowUtc, int subscriptionWindowDays) =>
        nowUtc.AddDays(-subscriptionWindowDays);

    private Task<List<FeedPostLite>> LoadSubscriptionPostsAsync(
        Guid userUuid,
        IReadOnlyList<Guid> following,
        DateTime sinceSubscription,
        CancellationToken ct) =>
        following.Count == 0
            ? Task.FromResult(new List<FeedPostLite>())
            : _feedQueries.GetPostsByAuthorsSinceAsync(
                following, sinceSubscription, SubscriptionPostsTakeLimit, userUuid, ct);

    private async Task<List<Guid>> ComputeFiraFeedAsync(Guid userUuid, CancellationToken ct)
    {
        var nowUtc              = DateTime.UtcNow;
        var subscriptionWindow  = SubscriptionWindowDays;
        var sinceSubscription   = SinceSubscriptionUtc(nowUtc, subscriptionWindow);
        var sinceTrending       = nowUtc.AddDays(-_fira.TrendingWindowDays);
        var sinceInteraction    = nowUtc.AddDays(-_fira.InteractionHistoryDays);

        // ═════════════════════════════════════════════════════════════════
        // Шаг 1 — Генерация кандидатов (5 источников §FIRA-F.md)
        // ═════════════════════════════════════════════════════════════════

        // Блокировка в любом направлении исключает из пула (§12 FIRA.md, инвариант 2).
        var blocked = await _blocklist.GetBlockedUserIdsBidirectionalAsync(userUuid, ct);

        var following = (await _followGraph.GetFollowingUserIdsAsync(userUuid, ct))
            .Where(id => !blocked.Contains(id))
            .ToList();
        var followingSet = following.ToHashSet();
        var subscriptionPosts = await LoadSubscriptionPostsAsync(userUuid, following, sinceSubscription, ct);

        // Граф второй степени (подписки подписок)
        var secondDegree = (await _followGraph
            .GetFollowingUserIdsForFollowersAsync(followingSet, userUuid, ct))
            .Where(id => !blocked.Contains(id))
            .ToList();

        var pool = new Dictionary<Guid, (FeedPostLite Post, double PoolWeight)>();

        // Источник 1: посты 1-й степени (вес 1.0) — окно как у вкладки «Подписки»
        if (subscriptionPosts.Count > 0)
            MergePool(pool, subscriptionPosts.Take(PoolLimit(0.50)), 1.0, blocked);

        // Источник 2: посты 2-й степени (вес 0.4)
        if (secondDegree.Count > 0)
        {
            var from2nd = await _feedQueries.GetPostsByAuthorsSinceAsync(
                secondDegree, sinceSubscription, PoolLimit(0.15), userUuid, ct);
            MergePool(pool, from2nd, 0.4, blocked);
        }

        // Источник 3: тренды глобальные (вес 0.25)
        var trendingIds = await _feedQueries.GetTrendingPostIdsAsync(
            sinceTrending, PoolLimit(0.15), followingSet, userUuid, ct);
        // На маленьких инсталляциях trending-окно (2 д) часто пустое — расширяем до окна подписок, затем до 30 д.
        if (trendingIds.Count == 0)
        {
            trendingIds = await _feedQueries.GetTrendingPostIdsAsync(
                sinceSubscription, PoolLimit(0.15), followingSet, userUuid, ct);
        }
        if (trendingIds.Count == 0)
        {
            trendingIds = await _feedQueries.GetTrendingPostIdsAsync(
                nowUtc.AddDays(-30), PoolLimit(0.15), followingSet, userUuid, ct);
        }
        if (trendingIds.Count > 0)
        {
            var trending = await _feedQueries.GetPostsByIdsAsync(trendingIds, userUuid, ct);
            MergePool(pool, trending, 0.25, blocked);
        }

        // Источник 4: посты из сообществ пользователя (вес 0.6)
        var communityPosts = await _feedQueries.GetCommunityPostsForUserAsync(
            userUuid, sinceSubscription, PoolLimit(0.20), ct);
        MergePool(pool, communityPosts, 0.6, blocked);

        // Репосты от подписок → новые кандидаты (вес 0.6) + сигнал для SocialProximity
        var followedReposts = await _feedQueries.GetRepostsFromUsersAsync(
            following, sinceSubscription, PoolLimit(0.10), ct);

        var repostPostIds = followedReposts
            .Select(r => r.PostUuid)
            .Where(id => !pool.ContainsKey(id))
            .Distinct()
            .ToList();
        if (repostPostIds.Count > 0)
        {
            var repostPosts = await _feedQueries.GetPostsByIdsAsync(repostPostIds, userUuid, ct);
            MergePool(pool, repostPosts, 0.6, blocked);
        }

        // Словарь «пост → кол-во подписок, репостнувших его»
        var repostedByFollowedCounts = followedReposts
            .GroupBy(r => r.PostUuid)
            .ToDictionary(g => g.Key, g => g.Count());

        if (pool.Count < MinFeedSize)
            BackfillSparsePoolFromCache(subscriptionPosts, pool, blocked);

        if (pool.Count < MinFeedSize)
            await BackfillSparsePoolWithExplorationAsync(userUuid, sinceSubscription, pool, blocked, ct);

        if (pool.Count == 0)
            return await BuildColdStartFeedAsync(userUuid, sinceSubscription, blocked, ct);

        // ═════════════════════════════════════════════════════════════════
        // Шаг 2 — Feature Extraction
        // ═════════════════════════════════════════════════════════════════

        var postIds   = pool.Keys.ToList();
        var authorIds = pool.Values.Select(x => x.Post.AuthorUserUuid).Distinct().ToList();

        // 48-часовые счётчики вовлечённости (§GlobalRelevance: переменные _48h)
        var engagement48h = await _feedQueries.GetEngagement48hAsync(postIds, ct);

        // Количество подписчиков авторов (для нормировки виральности)
        var followerCounts = await _followGraph.GetFollowerCountsAsync(authorIds, ct);

        // Сырой балл взаимодействия с каждым автором (likes×1 + comments×2 + reposts×2.5)
        var authorInteractionScores = await _feedQueries.GetAuthorInteractionScoresAsync(
            userUuid, authorIds, sinceInteraction, ct);

        // Кол-во подписок, лайкнувших каждый пост
        var followedLikerCounts = followingSet.Count > 0
            ? await _feedQueries.GetFollowedLikerCountsAsync(postIds, followingSet, ct)
            : new Dictionary<Guid, int>();

        // ═════════════════════════════════════════════════════════════════
        // Шаг 3 — Скоринг
        // ═════════════════════════════════════════════════════════════════

        var candidates = pool.Select(kv =>
        {
            var (post, poolWeight) = kv.Value;
            engagement48h.TryGetValue(kv.Key, out var eng);

            // authorAffinity = tanh(max(0, rawInteraction) / affinityScale)
            var rawInteraction = authorInteractionScores.GetValueOrDefault(post.AuthorUserUuid, 0.0);
            var authorAffinity = FiraFeedScorer.AuthorAffinity(rawInteraction, _fira.AuthorAffinityScale);

            return new FeedCandidate(
                PostUuid:             kv.Key,
                AuthorUserUuid:       post.AuthorUserUuid,
                CreatedAt:            post.CreatedAt,
                Likes48h:             eng.Likes,
                Comments48h:          eng.Comments,
                Reposts48h:           eng.Reposts,
                Views48h:             eng.Views,
                AuthorFollowerCount:  followerCounts.GetValueOrDefault(post.AuthorUserUuid, 0),
                AuthorAffinity:       authorAffinity,
                FollowedLikersCount:  followedLikerCounts.GetValueOrDefault(kv.Key, 0),
                FollowedRepostersCount: repostedByFollowedCounts.GetValueOrDefault(kv.Key, 0),
                PoolWeight:           poolWeight);
        }).ToList();

        var scored = FiraFeedScorer.Rank(candidates, _fira, nowUtc);

        // ═════════════════════════════════════════════════════════════════
        // Шаг 4 — Постобработка
        // ═════════════════════════════════════════════════════════════════

        // 4a. Ограничение разнообразия: не более MaxConsecutiveSameAuthor подряд
        var diversified = FiraFeedPostProcessing.ApplyAuthorDiversity(scored, _fira.MaxConsecutiveSameAuthor);

        // 4b. Квота исследования (ε = ExplorationQuota)
        int totalSlots       = _fira.MaxCandidates;
        int explorationSlots = (int)(totalSlots * _fira.ExplorationQuota);
        int mainSlots        = totalSlots - explorationSlots;

        var mainPostIds  = diversified.Take(mainSlots).Select(c => c.PostUuid).ToList();
        var excludedSet  = mainPostIds.ToHashSet();

        var explorationIds = (await GetExplorationIdsWithFallbackAsync(
            userUuid, sinceSubscription, excludedSet, blocked, explorationSlots * 2, ct))
            .Take(explorationSlots)
            .ToList();

        // Перемежаем exploration-посты с основными равномерно
        var merged = FiraFeedPostProcessing.InterleaveExploration(mainPostIds, explorationIds, _fira.ExplorationQuota);

        // Собственные посты пользователя — в начало (независимо от алгоритма; без окна по дате).
        var ownPostUuids = await _feedQueries.GetOwnPostIdsAsync(userUuid, DateTime.MinValue, 100, ct);
        var ownSet       = ownPostUuids.ToHashSet();

        var result = ownPostUuids.Concat(merged.Where(id => !ownSet.Contains(id))).ToList();
        return await EnsureMinFeedSizeAsync(userUuid, result, subscriptionPosts, sinceSubscription, blocked, ct);
    }

    // ─── Вспомогательные методы ──────────────────────────────────────────────

    private int PoolLimit(double ratio) =>
        (int)(_fira.MaxCandidates * ratio);

    /// <summary>
    /// Cold start: собственные посты (§FIRA-F) + exploration, когда алгоритмический пул пуст.
    /// </summary>
    private async Task<List<Guid>> BuildColdStartFeedAsync(
        Guid userUuid,
        DateTime sinceSubscription,
        IReadOnlySet<Guid> blocked,
        CancellationToken ct)
    {
        var ownPostUuids = await _feedQueries.GetOwnPostIdsAsync(userUuid, DateTime.MinValue, 100, ct);
        var explorationTake = Math.Clamp(PoolLimit(0.15), 20, 100);
        var explorationIds = await GetExplorationIdsWithFallbackAsync(
            userUuid,
            sinceSubscription,
            ownPostUuids.ToHashSet(),
            blocked,
            explorationTake,
            ct);
        if (ownPostUuids.Count == 0 && explorationIds.Count == 0)
            return await GetLatestVisibleIdsAsync(userUuid, blocked, Math.Min(_fira.MaxCandidates, 50), ct);

        var ownSet = ownPostUuids.ToHashSet();
        var merged = ownPostUuids.Concat(explorationIds.Where(id => !ownSet.Contains(id))).ToList();
        return await EnsureMinFeedSizeAsync(userUuid, merged, [], sinceSubscription, blocked, ct);
    }

    /// <summary>Дозаполняет пул оставшимися постами подписок из уже загруженного среза (без повторного запроса к БД).</summary>
    private static void BackfillSparsePoolFromCache(
        IReadOnlyList<FeedPostLite> subscriptionPosts,
        Dictionary<Guid, (FeedPostLite Post, double PoolWeight)> pool,
        IReadOnlySet<Guid> blocked)
    {
        if (subscriptionPosts.Count == 0)
            return;

        MergePool(pool, subscriptionPosts, 1.0, blocked);
    }

    private async Task BackfillSparsePoolWithExplorationAsync(
        Guid userUuid,
        DateTime sinceSubscription,
        Dictionary<Guid, (FeedPostLite Post, double PoolWeight)> pool,
        IReadOnlySet<Guid> blocked,
        CancellationToken ct)
    {
        if (pool.Count >= MinFeedSize)
            return;

        var excludeIds = pool.Keys.ToHashSet();
        var explorationIds = await GetExplorationIdsWithFallbackAsync(
            userUuid,
            sinceSubscription,
            excludeIds,
            blocked,
            MinFeedSize - pool.Count,
            ct);
        if (explorationIds.Count == 0)
            return;

        var explorationPosts = await _feedQueries.GetPostsByIdsAsync(explorationIds, userUuid, ct);
        MergePool(pool, explorationPosts, 0.15, blocked);
    }

    /// <summary>
    /// Гарантирует минимальный размер snapshot. Дописывает в конец посты подписок (по дате),
    /// затем exploration и latest — без пересчёта score у уже ранжированной «головы» ленты.
    /// </summary>
    private async Task<List<Guid>> EnsureMinFeedSizeAsync(
        Guid userUuid,
        List<Guid> feed,
        IReadOnlyList<FeedPostLite> subscriptionPosts,
        DateTime sinceSubscription,
        IReadOnlySet<Guid> blocked,
        CancellationToken ct)
    {
        if (feed.Count >= MinFeedSize)
            return feed;

        var result = feed.ToList();
        var seen   = result.ToHashSet();

        foreach (var post in subscriptionPosts.OrderByDescending(p => p.CreatedAt))
        {
            if (blocked.Contains(post.AuthorUserUuid))
                continue;
            if (seen.Add(post.PostUuid))
                result.Add(post.PostUuid);
            if (result.Count >= MinFeedSize)
                return result;
        }

        var explorationIds = await GetExplorationIdsWithFallbackAsync(
            userUuid,
            sinceSubscription,
            seen,
            blocked,
            MinFeedSize - result.Count,
            ct);
        foreach (var postId in explorationIds)
        {
            if (seen.Add(postId))
                result.Add(postId);
            if (result.Count >= MinFeedSize)
                return result;
        }

        if (result.Count == 0)
            return await GetLatestVisibleIdsAsync(userUuid, blocked, Math.Min(_fira.MaxCandidates, 50), ct);

        if (result.Count < MinFeedSize)
        {
            var latest = await GetLatestVisibleIdsAsync(userUuid, blocked, Math.Min(_fira.MaxCandidates, 50), ct);
            foreach (var postId in latest)
            {
                if (seen.Add(postId))
                    result.Add(postId);
                if (result.Count >= MinFeedSize)
                    break;
            }
        }

        return result;
    }

    private async Task<List<Guid>> GetLatestVisibleIdsAsync(
        Guid userUuid,
        IReadOnlySet<Guid> blocked,
        int take,
        CancellationToken ct)
    {
        var latest = await _feedQueries.GetLatestPostsAsync(take, userUuid, ct);
        return latest
            .Where(p => !blocked.Contains(p.AuthorUserUuid))
            .Select(p => p.PostUuid)
            .ToList();
    }

    private async Task<List<Guid>> GetExplorationIdsWithFallbackAsync(
        Guid userUuid,
        DateTime primarySince,
        IReadOnlySet<Guid> excludePostIds,
        IReadOnlySet<Guid> blocked,
        int limit,
        CancellationToken ct)
    {
        var windows = new[]
        {
            primarySince,
            primarySince.AddDays(-23),
            DateTime.MinValue,
        };
        foreach (var since in windows)
        {
            var posts = await _feedQueries.GetExplorationPostsAsync(since, excludePostIds, limit, userUuid, ct);
            var visible = posts
                .Where(p => !blocked.Contains(p.AuthorUserUuid))
                .Select(p => p.PostUuid)
                .ToList();
            if (visible.Count > 0)
                return visible;
        }
        return [];
    }

    /// <summary>
    /// Добавляет посты в пул; при дублировании оставляет вариант с бо́льшим начальным весом.
    /// Авторы с блокировкой в любом направлении не попадают в пул (§12 FIRA.md).
    /// </summary>
    private static void MergePool(
        Dictionary<Guid, (FeedPostLite Post, double PoolWeight)> pool,
        IEnumerable<FeedPostLite> posts,
        double weight,
        IReadOnlySet<Guid> blocked)
    {
        foreach (var post in posts)
        {
            if (blocked.Contains(post.AuthorUserUuid))
                continue;

            if (pool.TryGetValue(post.PostUuid, out var existing))
            {
                if (weight > existing.PoolWeight)
                    pool[post.PostUuid] = (post, weight);
            }
            else
            {
                pool[post.PostUuid] = (post, weight);
            }
        }
    }

    private static int ParseCursor(string? cursor) =>
        string.IsNullOrWhiteSpace(cursor) ? 0
        : int.TryParse(cursor, out var n) && n >= 0 ? n : 0;

    private static string EncodeCursor(int offset) => offset.ToString();
}
