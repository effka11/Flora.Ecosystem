using Flora.Content.Application.Feed;
using Flora.Content.Contracts;
using Flora.Users.Contracts;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;
using Xunit;

namespace Flora.Content.Application.Tests.Feed;

public sealed class FeedRecommendationServiceTests
{
    private static readonly Guid ViewerId = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid FollowedAuthorId = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid DiscoveryAuthorId = Guid.Parse("33333333-3333-3333-3333-333333333333");

    [Fact]
    public async Task Regression_followed_posts_8_to_30_days_not_replaced_by_single_discovery_post()
    {
        var followedPosts = Enumerable.Range(0, 6)
            .Select(i => Post(FollowedAuthorId, daysAgo: 8 + i * 3))
            .ToList();
        var discoveryPost = Post(DiscoveryAuthorId, daysAgo: 1);

        var fake = new FakeFeedDependencies(ViewerId, [FollowedAuthorId])
        {
            PostsByAuthor = { [FollowedAuthorId] = followedPosts },
            TrendingPostIds = [discoveryPost.PostUuid],
        };
        fake.PostsById[discoveryPost.PostUuid] = discoveryPost;
        foreach (var post in followedPosts)
            fake.PostsById[post.PostUuid] = post;

        var service = CreateService(fake, minFeedSize: 5);
        var recommendations = await service.GetRecommendedFeedAsync(ViewerId, take: 30, forceRefresh: true);
        Assert.Equal(1, fake.SubscriptionPostsQueryCount);

        var subscriptions = await service.GetSubscriptionsFeedAsync(ViewerId, take: 30);

        Assert.True(recommendations.PostUuids.Count >= 5);
        Assert.Contains(followedPosts[0].PostUuid, recommendations.PostUuids);
        Assert.Contains(discoveryPost.PostUuid, recommendations.PostUuids);
        Assert.Contains(followedPosts[0].PostUuid, subscriptions.PostUuids);
    }

    [Fact]
    public async Task Subscription_posts_loaded_once_per_snapshot()
    {
        var followedPosts = Enumerable.Range(0, 12)
            .Select(i => Post(FollowedAuthorId, daysAgo: 5 + i))
            .ToList();

        var fake = new FakeFeedDependencies(ViewerId, [FollowedAuthorId])
        {
            PostsByAuthor = { [FollowedAuthorId] = followedPosts },
        };
        foreach (var post in followedPosts)
            fake.PostsById[post.PostUuid] = post;

        var service = CreateService(fake, minFeedSize: 20);
        _ = await service.GetRecommendedFeedAsync(ViewerId, take: 30, forceRefresh: true);

        Assert.Equal(1, fake.SubscriptionPostsQueryCount);
    }

    [Fact]
    public async Task Recommendations_include_followed_posts_older_than_fira_following_window()
    {
        var subscriptionPost = Post(FollowedAuthorId, daysAgo: 15);
        var fake = new FakeFeedDependencies(ViewerId, [FollowedAuthorId])
        {
            PostsByAuthor = { [FollowedAuthorId] = [subscriptionPost] },
        };

        var service = CreateService(fake, minFeedSize: 5);
        var page = await service.GetRecommendedFeedAsync(ViewerId, take: 30, forceRefresh: true);

        Assert.Contains(subscriptionPost.PostUuid, page.PostUuids);
    }

    [Fact]
    public async Task Sparse_pool_with_only_trending_backfills_to_min_feed_size()
    {
        var trendingPost = Post(DiscoveryAuthorId, daysAgo: 1);
        var explorationPosts = Enumerable.Range(0, 25)
            .Select(i => Post(Guid.Parse($"aaaaaaaa-aaaa-aaaa-aaaa-{i:D12}"), daysAgo: 3 + i))
            .ToList();

        var fake = new FakeFeedDependencies(ViewerId, following: [])
        {
            TrendingPostIds = [trendingPost.PostUuid],
            PostsById =
            {
                [trendingPost.PostUuid] = trendingPost,
            },
        };
        foreach (var post in explorationPosts)
            fake.PostsById[post.PostUuid] = post;

        fake.ExplorationPostsBySinceUtc[DateTime.MinValue] = explorationPosts;

        var service = CreateService(fake, minFeedSize: 20);
        var page = await service.GetRecommendedFeedAsync(ViewerId, take: 30, forceRefresh: true);

        Assert.True(page.PostUuids.Count >= 20);
        Assert.Contains(trendingPost.PostUuid, page.PostUuids);
    }

    [Fact]
    public async Task Exploration_fallback_widens_window_when_recent_slice_is_empty()
    {
        var olderPosts = Enumerable.Range(0, 10)
            .Select(i => Post(Guid.Parse($"bbbbbbbb-bbbb-bbbb-bbbb-{i:D12}"), daysAgo: 20 + i))
            .ToList();

        var fake = new FakeFeedDependencies(ViewerId, [FollowedAuthorId])
        {
            PostsByAuthor = { [FollowedAuthorId] = olderPosts },
            ExplorationPostsBySinceUtc =
            {
                [DateTime.UtcNow.AddDays(-30)] = [],
                [DateTime.MinValue] = olderPosts,
            },
        };
        foreach (var post in olderPosts)
            fake.PostsById[post.PostUuid] = post;

        var service = CreateService(fake, minFeedSize: 5);
        _ = await service.GetRecommendedFeedAsync(ViewerId, take: 30, forceRefresh: true);

        Assert.True(fake.ExplorationSinceValues.Count >= 2);
        Assert.Contains(DateTime.MinValue, fake.ExplorationSinceValues);
    }

    [Fact]
    public async Task Recommendations_do_not_replace_followed_posts_with_discovery_only_page()
    {
        var followedPosts = Enumerable.Range(0, 8)
            .Select(i => Post(FollowedAuthorId, daysAgo: 10 + i))
            .ToList();
        var discoveryPost = Post(DiscoveryAuthorId, daysAgo: 1);

        var postsById = followedPosts.ToDictionary(p => p.PostUuid);
        postsById[discoveryPost.PostUuid] = discoveryPost;

        var fake = new FakeFeedDependencies(ViewerId, [FollowedAuthorId])
        {
            PostsByAuthor = { [FollowedAuthorId] = followedPosts },
            TrendingPostIds = [discoveryPost.PostUuid],
        };
        foreach (var kv in postsById)
            fake.PostsById[kv.Key] = kv.Value;

        var service = CreateService(fake, minFeedSize: 5);
        var page = await service.GetRecommendedFeedAsync(ViewerId, take: 30, forceRefresh: true);

        Assert.Contains(followedPosts[0].PostUuid, page.PostUuids);
        Assert.True(page.PostUuids.Count >= 5);
    }

    private static FeedRecommendationService CreateService(
        FakeFeedDependencies fake,
        int minFeedSize = 20)
    {
        var fira = new FiraFeedConfig
        {
            EnableCache = false,
            MinFeedSize = minFeedSize,
            FollowingWindowDays = 7,
            TrendingWindowDays = 2,
            MaxCandidates = 1000,
        };
        var sub = new FeedRecommendationOptions
        {
            FollowingPostsDays = 30,
            MaxCandidates = 2000,
        };

        return new FeedRecommendationService(
            fake,
            fake,
            new MemoryCache(new MemoryCacheOptions()),
            Options.Create(fira),
            Options.Create(sub));
    }

    private static FeedPostLite Post(Guid authorId, int daysAgo) =>
        new(Guid.NewGuid(), authorId, DateTime.UtcNow.AddDays(-daysAgo), "content");

    private sealed class FakeFeedDependencies : IFollowGraphReader, IContentFeedQueries
    {
        private readonly Guid _viewerId;
        private readonly IReadOnlyList<Guid> _following;

        public FakeFeedDependencies(Guid viewerId, IReadOnlyList<Guid> following)
        {
            _viewerId = viewerId;
            _following = following;
        }

        public Dictionary<Guid, List<FeedPostLite>> PostsByAuthor { get; } = [];
        public Dictionary<Guid, FeedPostLite> PostsById { get; } = [];
        public List<Guid> TrendingPostIds { get; set; } = [];
        public Dictionary<DateTime, List<FeedPostLite>> ExplorationPostsBySinceUtc { get; } = [];
        public List<DateTime> ExplorationSinceValues { get; } = [];
        public int SubscriptionPostsQueryCount { get; private set; }

        public Task<IReadOnlyList<Guid>> GetFollowingUserIdsAsync(Guid followerUserUuid, CancellationToken cancellationToken = default) =>
            Task.FromResult<IReadOnlyList<Guid>>(followerUserUuid == _viewerId ? _following : []);

        public Task<IReadOnlySet<Guid>> GetFollowingUserIdsForFollowersAsync(
            IReadOnlyCollection<Guid> followerUserUuids,
            Guid excludeUserUuid,
            CancellationToken cancellationToken = default) =>
            Task.FromResult<IReadOnlySet<Guid>>(new HashSet<Guid>());

        public Task<bool> IsFollowingAsync(Guid followerUserUuid, Guid followingUserUuid, CancellationToken cancellationToken = default) =>
            Task.FromResult(_following.Contains(followingUserUuid));

        public Task<bool> AreMutualFollowersAsync(Guid userA, Guid userB, CancellationToken cancellationToken = default) =>
            Task.FromResult(false);

        public Task<Dictionary<Guid, int>> GetFollowerCountsAsync(
            IReadOnlyCollection<Guid> userIds,
            CancellationToken cancellationToken = default) =>
            Task.FromResult(userIds.ToDictionary(id => id, _ => 1));

        public Task<List<FeedPostLite>> GetPostsByAuthorsSinceAsync(
            IReadOnlyCollection<Guid> authorIds,
            DateTime sinceUtc,
            int take,
            CancellationToken cancellationToken = default)
        {
            SubscriptionPostsQueryCount++;
            var posts = authorIds
                .SelectMany(id => PostsByAuthor.GetValueOrDefault(id) ?? [])
                .Where(p => p.CreatedAt >= sinceUtc)
                .OrderByDescending(p => p.CreatedAt)
                .Take(take)
                .ToList();
            return Task.FromResult(posts);
        }

        public Task<List<FeedPostLite>> GetPostsByIdsAsync(
            IReadOnlyCollection<Guid> postIds,
            CancellationToken cancellationToken = default)
        {
            var posts = postIds
                .Where(PostsById.ContainsKey)
                .Select(id => PostsById[id])
                .ToList();
            return Task.FromResult(posts);
        }

        public Task<List<Guid>> GetOwnPostIdsAsync(
            Guid userUuid, DateTime sinceUtc, int take, CancellationToken cancellationToken = default) =>
            Task.FromResult(new List<Guid>());

        public Task<List<Guid>> GetLatestPostIdsAsync(int take, CancellationToken cancellationToken = default) =>
            Task.FromResult(PostsById.Keys.Take(take).ToList());

        public Task<List<Guid>> GetTrendingPostIdsAsync(
            DateTime sinceUtc,
            int limit,
            IReadOnlySet<Guid> excludeAuthors,
            CancellationToken cancellationToken = default) =>
            Task.FromResult(TrendingPostIds
                .Where(id => PostsById.TryGetValue(id, out var p)
                          && p.CreatedAt >= sinceUtc
                          && !excludeAuthors.Contains(p.AuthorUserUuid))
                .Take(limit)
                .ToList());

        public Task<List<FeedPostLite>> GetCommunityPostsForUserAsync(
            Guid userUuid, DateTime sinceUtc, int take, CancellationToken cancellationToken = default) =>
            Task.FromResult(new List<FeedPostLite>());

        public Task<List<(Guid PostUuid, Guid ReposterUserUuid)>> GetRepostsFromUsersAsync(
            IReadOnlyCollection<Guid> userIds, DateTime sinceUtc, int limit, CancellationToken cancellationToken = default) =>
            Task.FromResult(new List<(Guid, Guid)>());

        public Task<List<(Guid PostUuid, DateTime FirstRepostAt)>> GetFirstRepostsFromUsersAsync(
            IReadOnlyCollection<Guid> userIds, DateTime sinceUtc, int limit, CancellationToken cancellationToken = default) =>
            Task.FromResult(new List<(Guid, DateTime)>());

        public Task<List<FeedPostLite>> GetExplorationPostsAsync(
            DateTime sinceUtc,
            IReadOnlySet<Guid> excludePostIds,
            int limit,
            CancellationToken cancellationToken = default)
        {
            ExplorationSinceValues.Add(sinceUtc);
            var exact = ExplorationPostsBySinceUtc
                .Where(kv => kv.Key == sinceUtc)
                .SelectMany(kv => kv.Value)
                .Where(p => (sinceUtc == DateTime.MinValue || p.CreatedAt >= sinceUtc)
                         && !excludePostIds.Contains(p.PostUuid))
                .Take(limit)
                .ToList();
            if (exact.Count > 0)
                return Task.FromResult(exact);

            var fallback = PostsById.Values
                .Where(p => (sinceUtc == DateTime.MinValue || p.CreatedAt >= sinceUtc)
                         && !excludePostIds.Contains(p.PostUuid))
                .Take(limit)
                .ToList();
            return Task.FromResult(fallback);
        }

        public Task<Dictionary<Guid, double>> GetAuthorInteractionScoresAsync(
            Guid userUuid, IReadOnlyCollection<Guid> authorIds, DateTime sinceUtc, CancellationToken cancellationToken = default) =>
            Task.FromResult(new Dictionary<Guid, double>());

        public Task<Dictionary<Guid, int>> GetFollowedLikerCountsAsync(
            IReadOnlyCollection<Guid> postIds, IReadOnlySet<Guid> followedUserIds, CancellationToken cancellationToken = default) =>
            Task.FromResult(new Dictionary<Guid, int>());

        public Task<Dictionary<Guid, (int Likes, int Comments, int Reposts, int Views)>> GetEngagement48hAsync(
            IReadOnlyCollection<Guid> postIds, CancellationToken cancellationToken = default) =>
            Task.FromResult(postIds.ToDictionary(id => id, _ => (0, 0, 0, 0)));

        public Task<bool> HasNewerPostsAsync(
            IReadOnlyCollection<Guid> followedUserIds, DateTime sinceUtc, CancellationToken cancellationToken = default) =>
            Task.FromResult(false);

        public Task<Dictionary<Guid, IReadOnlyList<Guid>>> GetFollowedReposterIdsByPostsAsync(
            IReadOnlyCollection<Guid> postIds, IReadOnlySet<Guid> followedUserIds, CancellationToken cancellationToken = default) =>
            Task.FromResult(new Dictionary<Guid, IReadOnlyList<Guid>>());
    }
}
