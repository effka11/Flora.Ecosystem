using Flora.Content.Application.Feed;
using Flora.Content.Domain;
using Microsoft.EntityFrameworkCore;

namespace Flora.Content.Infrastructure;

public sealed class ContentFeedQueries(ContentDbContext db) : IContentFeedQueries
{
    // --- Существующие методы ---

    public async Task<List<FeedPostLite>> GetPostsByAuthorsSinceAsync(
        IReadOnlyCollection<Guid> authorIds,
        DateTime sinceUtc,
        int take,
        CancellationToken cancellationToken = default)
    {
        if (authorIds.Count == 0) return [];
        return await db.UserPosts.AsNoTracking()
            .Where(p => p.CreatedAt >= sinceUtc && authorIds.Contains(p.AuthorUserUuid) && !p.IsDeleted)
            .OrderByDescending(p => p.CreatedAt)
            .Take(take)
            .Select(p => new FeedPostLite(p.PostUuid, p.AuthorUserUuid, p.CreatedAt, p.Content))
            .ToListAsync(cancellationToken);
    }

    public async Task<List<FeedPostLite>> GetPostsByIdsAsync(
        IReadOnlyCollection<Guid> postIds,
        CancellationToken cancellationToken = default)
    {
        if (postIds.Count == 0) return [];
        return await db.UserPosts.AsNoTracking()
            .Where(p => postIds.Contains(p.PostUuid) && !p.IsDeleted)
            .Select(p => new FeedPostLite(p.PostUuid, p.AuthorUserUuid, p.CreatedAt, p.Content))
            .ToListAsync(cancellationToken);
    }

    public async Task<List<Guid>> GetOwnPostIdsAsync(
        Guid userUuid, DateTime sinceUtc, int take, CancellationToken cancellationToken = default)
    {
        return await db.UserPosts.AsNoTracking()
            .Where(p => p.AuthorUserUuid == userUuid
                     && !p.IsDeleted
                     && (sinceUtc == DateTime.MinValue || p.CreatedAt >= sinceUtc))
            .OrderByDescending(p => p.CreatedAt)
            .Take(take)
            .Select(p => p.PostUuid)
            .ToListAsync(cancellationToken);
    }

    public async Task<List<Guid>> GetLatestPostIdsAsync(
        int take, CancellationToken cancellationToken = default)
    {
        return await db.UserPosts.AsNoTracking()
            .Where(p => !p.IsDeleted)
            .OrderByDescending(p => p.CreatedAt)
            .Take(take)
            .Select(p => p.PostUuid)
            .ToListAsync(cancellationToken);
    }

    public async Task<List<Guid>> GetTrendingPostIdsAsync(
        DateTime sinceUtc,
        int limit,
        IReadOnlySet<Guid> excludeAuthors,
        CancellationToken cancellationToken = default)
    {
        var candidates = await db.UserPosts.AsNoTracking()
            .Where(p => p.CreatedAt >= sinceUtc && !excludeAuthors.Contains(p.AuthorUserUuid) && !p.IsDeleted)
            .Select(p => p.PostUuid)
            .ToListAsync(cancellationToken);

        if (candidates.Count == 0) return [];

        // Берём увеличенный пул для ранжирования
        var postIds = candidates.Take(limit * 3).ToList();

        var likes    = await db.PostLikes.AsNoTracking()
            .Where(l => postIds.Contains(l.PostUuid))
            .GroupBy(l => l.PostUuid)
            .Select(g => new { g.Key, Count = g.Count() })
            .ToListAsync(cancellationToken);

        var comments = await db.PostComments.AsNoTracking()
            .Where(c => postIds.Contains(c.PostUuid) && !c.IsDeleted)
            .GroupBy(c => c.PostUuid)
            .Select(g => new { g.Key, Count = g.Count() })
            .ToListAsync(cancellationToken);

        var reposts = await db.PostReposts.AsNoTracking()
            .Where(r => postIds.Contains(r.PostUuid))
            .GroupBy(r => r.PostUuid)
            .Select(g => new { g.Key, Count = g.Count() })
            .ToListAsync(cancellationToken);

        var likeDict    = likes.ToDictionary(x => x.Key, x => x.Count);
        var commentDict = comments.ToDictionary(x => x.Key, x => x.Count);
        var repostDict  = reposts.ToDictionary(x => x.Key, x => x.Count);

        return postIds
            .Select(pid =>
            {
                var l = likeDict.GetValueOrDefault(pid, 0);
                var c = commentDict.GetValueOrDefault(pid, 0);
                var r = repostDict.GetValueOrDefault(pid, 0);
                // Упрощённый engagement score для быстрого trending-ранжирования
                var score = l + c * 2.0 + r * 2.5;
                return (PostUuid: pid, Score: score);
            })
            .OrderByDescending(x => x.Score)
            .Take(limit)
            .Select(x => x.PostUuid)
            .ToList();
    }

    // --- FIRA-F: новые методы ---

    public async Task<List<FeedPostLite>> GetCommunityPostsForUserAsync(
        Guid userUuid,
        DateTime sinceUtc,
        int take,
        CancellationToken cancellationToken = default)
    {
        // Посты из публичных и закрытых сообществ, в которых состоит пользователь
        var communityIds = await db.UserCommunities.AsNoTracking()
            .Where(uc => uc.UserUuid == userUuid)
            .Select(uc => uc.CommunityId)
            .ToListAsync(cancellationToken);

        if (communityIds.Count == 0) return [];

        return await db.UserPosts.AsNoTracking()
            .Where(p => p.CommunityId != null
                     && communityIds.Contains(p.CommunityId!.Value)
                     && p.CreatedAt >= sinceUtc
                     && !p.IsDeleted)
            .OrderByDescending(p => p.CreatedAt)
            .Take(take)
            .Select(p => new FeedPostLite(p.PostUuid, p.AuthorUserUuid, p.CreatedAt, p.Content))
            .ToListAsync(cancellationToken);
    }

    public async Task<List<(Guid PostUuid, Guid ReposterUserUuid)>> GetRepostsFromUsersAsync(
        IReadOnlyCollection<Guid> userIds,
        DateTime sinceUtc,
        int limit,
        CancellationToken cancellationToken = default)
    {
        if (userIds.Count == 0) return [];
        return await db.PostReposts.AsNoTracking()
            .Where(r => userIds.Contains(r.UserUuid) && r.CreatedAt >= sinceUtc)
            .OrderByDescending(r => r.CreatedAt)
            .Take(limit)
            .Select(r => new ValueTuple<Guid, Guid>(r.PostUuid, r.UserUuid))
            .ToListAsync(cancellationToken);
    }

    public async Task<List<(Guid PostUuid, DateTime FirstRepostAt)>> GetFirstRepostsFromUsersAsync(
        IReadOnlyCollection<Guid> userIds,
        DateTime sinceUtc,
        int limit,
        CancellationToken cancellationToken = default)
    {
        if (userIds.Count == 0) return [];
        var rows = await db.PostReposts.AsNoTracking()
            .Where(r => userIds.Contains(r.UserUuid) && r.CreatedAt >= sinceUtc)
            .GroupBy(r => r.PostUuid)
            .Select(g => new { PostUuid = g.Key, FirstRepostAt = g.Min(r => r.CreatedAt) })
            .OrderByDescending(x => x.FirstRepostAt)
            .Take(limit)
            .ToListAsync(cancellationToken);
        return rows.Select(x => (x.PostUuid, x.FirstRepostAt)).ToList();
    }

    public async Task<List<FeedPostLite>> GetExplorationPostsAsync(
        DateTime sinceUtc,
        IReadOnlySet<Guid> excludePostIds,
        int limit,
        CancellationToken cancellationToken = default)
    {
        // ORDER BY random() достаточно для v1 при небольших БД.
        // При масштабировании > 1M постов заменить на materialized random sample.
        return await db.UserPosts.AsNoTracking()
            .Where(p => (sinceUtc == DateTime.MinValue || p.CreatedAt >= sinceUtc)
                     && !p.IsDeleted
                     && !excludePostIds.Contains(p.PostUuid))
            .OrderBy(_ => EF.Functions.Random())
            .Take(limit)
            .Select(p => new FeedPostLite(p.PostUuid, p.AuthorUserUuid, p.CreatedAt, p.Content))
            .ToListAsync(cancellationToken);
    }

    public async Task<Dictionary<Guid, double>> GetAuthorInteractionScoresAsync(
        Guid userUuid,
        IReadOnlyCollection<Guid> authorIds,
        DateTime sinceUtc,
        CancellationToken cancellationToken = default)
    {
        if (authorIds.Count == 0) return [];

        // Лайки пользователя по постам данных авторов (+1.0 за каждый)
        var likedPostAuthors = await db.PostLikes.AsNoTracking()
            .Join(db.UserPosts.AsNoTracking(),
                  l => l.PostUuid,
                  p => p.PostUuid,
                  (l, p) => new { l.UserUuid, p.AuthorUserUuid, l.CreatedAt })
            .Where(x => x.UserUuid == userUuid
                     && authorIds.Contains(x.AuthorUserUuid)
                     && x.CreatedAt >= sinceUtc)
            .GroupBy(x => x.AuthorUserUuid)
            .Select(g => new { AuthorId = g.Key, Score = (double)g.Count() * 1.0 })
            .ToListAsync(cancellationToken);

        // Комментарии пользователя по постам данных авторов (+2.0 за каждый)
        var commentedPostAuthors = await db.PostComments.AsNoTracking()
            .Join(db.UserPosts.AsNoTracking(),
                  c => c.PostUuid,
                  p => p.PostUuid,
                  (c, p) => new { CommentAuthor = c.AuthorUserUuid, p.AuthorUserUuid, c.CreatedAt })
            .Where(x => x.CommentAuthor == userUuid
                     && authorIds.Contains(x.AuthorUserUuid)
                     && x.CreatedAt >= sinceUtc)
            .GroupBy(x => x.AuthorUserUuid)
            .Select(g => new { AuthorId = g.Key, Score = (double)g.Count() * 2.0 })
            .ToListAsync(cancellationToken);

        // Репосты пользователя (+2.5 за каждый)
        var repostedPostAuthors = await db.PostReposts.AsNoTracking()
            .Join(db.UserPosts.AsNoTracking(),
                  r => r.PostUuid,
                  p => p.PostUuid,
                  (r, p) => new { r.UserUuid, p.AuthorUserUuid, r.CreatedAt })
            .Where(x => x.UserUuid == userUuid
                     && authorIds.Contains(x.AuthorUserUuid)
                     && x.CreatedAt >= sinceUtc)
            .GroupBy(x => x.AuthorUserUuid)
            .Select(g => new { AuthorId = g.Key, Score = (double)g.Count() * 2.5 })
            .ToListAsync(cancellationToken);

        // Суммируем все три источника в одном словаре
        var result = new Dictionary<Guid, double>();
        foreach (var x in likedPostAuthors)
            result[x.AuthorId] = result.GetValueOrDefault(x.AuthorId) + x.Score;
        foreach (var x in commentedPostAuthors)
            result[x.AuthorId] = result.GetValueOrDefault(x.AuthorId) + x.Score;
        foreach (var x in repostedPostAuthors)
            result[x.AuthorId] = result.GetValueOrDefault(x.AuthorId) + x.Score;

        return result;
    }

    public async Task<Dictionary<Guid, int>> GetFollowedLikerCountsAsync(
        IReadOnlyCollection<Guid> postIds,
        IReadOnlySet<Guid> followedUserIds,
        CancellationToken cancellationToken = default)
    {
        if (postIds.Count == 0 || followedUserIds.Count == 0) return [];

        // EF Core транслирует это как:
        // SELECT post_uuid, COUNT(*) FROM post_likes WHERE post_uuid IN (...) AND user_uuid IN (...) GROUP BY post_uuid
        var followedList = followedUserIds.ToList();
        return await db.PostLikes.AsNoTracking()
            .Where(l => postIds.Contains(l.PostUuid) && followedList.Contains(l.UserUuid))
            .GroupBy(l => l.PostUuid)
            .Select(g => new { PostUuid = g.Key, Count = g.Count() })
            .ToDictionaryAsync(x => x.PostUuid, x => x.Count, cancellationToken);
    }

    public async Task<bool> HasNewerPostsAsync(
        IReadOnlyCollection<Guid> followedUserIds,
        DateTime sinceUtc,
        CancellationToken cancellationToken = default)
    {
        if (followedUserIds.Count == 0) return false;
        return await db.UserPosts.AsNoTracking()
            .AnyAsync(p => followedUserIds.Contains(p.AuthorUserUuid)
                        && p.CreatedAt > sinceUtc
                        && !p.IsDeleted,
                      cancellationToken);
    }

    public async Task<Dictionary<Guid, (int Likes, int Comments, int Reposts, int Views)>> GetEngagement48hAsync(
        IReadOnlyCollection<Guid> postIds,
        CancellationToken cancellationToken = default)
    {
        if (postIds.Count == 0) return [];

        var cutoff = DateTime.UtcNow.AddHours(-48);

        var likes = await db.PostLikes.AsNoTracking()
            .Where(l => postIds.Contains(l.PostUuid) && l.CreatedAt >= cutoff)
            .GroupBy(l => l.PostUuid)
            .Select(g => new { g.Key, Count = g.Count() })
            .ToListAsync(cancellationToken);

        var comments = await db.PostComments.AsNoTracking()
            .Where(c => postIds.Contains(c.PostUuid) && !c.IsDeleted && c.CreatedAt >= cutoff)
            .GroupBy(c => c.PostUuid)
            .Select(g => new { g.Key, Count = g.Count() })
            .ToListAsync(cancellationToken);

        var reposts = await db.PostReposts.AsNoTracking()
            .Where(r => postIds.Contains(r.PostUuid) && r.CreatedAt >= cutoff)
            .GroupBy(r => r.PostUuid)
            .Select(g => new { g.Key, Count = g.Count() })
            .ToListAsync(cancellationToken);

        var views = await db.PostViews.AsNoTracking()
            .Where(v => postIds.Contains(v.PostUuid) && v.ViewedAt >= cutoff)
            .GroupBy(v => v.PostUuid)
            .Select(g => new { g.Key, Count = g.Count() })
            .ToListAsync(cancellationToken);

        var likeDict    = likes.ToDictionary(x => x.Key, x => x.Count);
        var commentDict = comments.ToDictionary(x => x.Key, x => x.Count);
        var repostDict  = reposts.ToDictionary(x => x.Key, x => x.Count);
        var viewDict    = views.ToDictionary(x => x.Key, x => x.Count);

        return postIds.ToDictionary(
            pid => pid,
            pid => (
                likeDict.GetValueOrDefault(pid, 0),
                commentDict.GetValueOrDefault(pid, 0),
                repostDict.GetValueOrDefault(pid, 0),
                viewDict.GetValueOrDefault(pid, 0)));
    }

    public async Task<Dictionary<Guid, IReadOnlyList<Guid>>> GetFollowedReposterIdsByPostsAsync(
        IReadOnlyCollection<Guid> postIds,
        IReadOnlySet<Guid> followedUserIds,
        CancellationToken cancellationToken = default)
    {
        if (postIds.Count == 0 || followedUserIds.Count == 0)
            return new Dictionary<Guid, IReadOnlyList<Guid>>();

        var rows = await db.PostReposts.AsNoTracking()
            .Where(r => postIds.Contains(r.PostUuid) && followedUserIds.Contains(r.UserUuid))
            .OrderByDescending(r => r.CreatedAt)
            .Select(r => new { r.PostUuid, r.UserUuid })
            .ToListAsync(cancellationToken);

        var result = new Dictionary<Guid, IReadOnlyList<Guid>>();
        foreach (var row in rows)
        {
            if (!result.TryGetValue(row.PostUuid, out var list))
            {
                list = new List<Guid>();
                result[row.PostUuid] = list;
            }

            if (list is List<Guid> mutable && !mutable.Contains(row.UserUuid))
                mutable.Add(row.UserUuid);
        }

        return result;
    }
}
