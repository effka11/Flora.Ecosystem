namespace Flora.Content.Application.Feed;

public sealed record FeedPostLite(Guid PostUuid, Guid AuthorUserUuid, DateTime CreatedAt, string Content);

public interface IContentFeedQueries
{
    // --- Существующие методы ---

    Task<List<FeedPostLite>> GetPostsByAuthorsSinceAsync(
        IReadOnlyCollection<Guid> authorIds,
        DateTime sinceUtc,
        int take,
        CancellationToken cancellationToken = default);

    Task<List<FeedPostLite>> GetPostsByIdsAsync(
        IReadOnlyCollection<Guid> postIds,
        CancellationToken cancellationToken = default);

    Task<List<Guid>> GetOwnPostIdsAsync(
        Guid userUuid,
        DateTime sinceUtc,
        int take,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Последние публичные посты без окна по дате — ultimate fallback для пустой ленты.
    /// </summary>
    Task<List<Guid>> GetLatestPostIdsAsync(
        int take,
        CancellationToken cancellationToken = default);

    Task<List<Guid>> GetTrendingPostIdsAsync(
        DateTime sinceUtc,
        int limit,
        IReadOnlySet<Guid> excludeAuthors,
        CancellationToken cancellationToken = default);

    // --- FIRA-F: новые методы ---

    /// <summary>
    /// Посты из сообществ, в которых состоит пользователь.
    /// Источник кандидатов §Шаг 1 FIRA-F: начальный вес 0.6.
    /// </summary>
    Task<List<FeedPostLite>> GetCommunityPostsForUserAsync(
        Guid userUuid,
        DateTime sinceUtc,
        int take,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Репосты от заданных пользователей начиная с <paramref name="sinceUtc"/>.
    /// Возвращает пары (PostUuid, ReposterUserUuid).
    /// Используется для правила тандема (§Repost Signal FIRA-F.md) и как источник кандидатов.
    /// </summary>
    Task<List<(Guid PostUuid, Guid ReposterUserUuid)>> GetRepostsFromUsersAsync(
        IReadOnlyCollection<Guid> userIds,
        DateTime sinceUtc,
        int limit,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Первый репост каждого поста от пользователей <paramref name="userIds"/> не раньше <paramref name="sinceUtc"/>.
    /// Для хронологической ленты «Подписки»: позиция поста = время первого репоста; последующие репосты не меняют порядок.
    /// </summary>
    Task<List<(Guid PostUuid, DateTime FirstRepostAt)>> GetFirstRepostsFromUsersAsync(
        IReadOnlyCollection<Guid> userIds,
        DateTime sinceUtc,
        int limit,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Случайная выборка свежих публичных постов для квоты исследования (exploration quota).
    /// §Постобработка FIRA-F.md: минимум ε = 15 % позиций.
    /// </summary>
    Task<List<FeedPostLite>> GetExplorationPostsAsync(
        DateTime sinceUtc,
        IReadOnlySet<Guid> excludePostIds,
        int limit,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Суммарный взвешенный балл взаимодействий пользователя <paramref name="userUuid"/>
    /// с постами каждого из авторов <paramref name="authorIds"/> за окно <paramref name="sinceUtc"/>.
    ///
    /// Веса: like = +1.0, comment = +2.0, repost = +2.5 (§2.2 FIRA.md).
    /// Используется для вычисления authorAffinity = tanh(max(0, score) / affinityScale).
    /// </summary>
    Task<Dictionary<Guid, double>> GetAuthorInteractionScoresAsync(
        Guid userUuid,
        IReadOnlyCollection<Guid> authorIds,
        DateTime sinceUtc,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Для каждого поста — количество лайков от пользователей, входящих в <paramref name="followedUserIds"/>.
    /// § SocialProximity: ln(followedLikers + 1) × 3.0.
    /// </summary>
    Task<Dictionary<Guid, int>> GetFollowedLikerCountsAsync(
        IReadOnlyCollection<Guid> postIds,
        IReadOnlySet<Guid> followedUserIds,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Счётчики вовлечённости за последние 48 часов.
    /// § GlobalRelevance FIRA-F.md: все переменные с суффиксом _48h.
    /// </summary>
    Task<Dictionary<Guid, (int Likes, int Comments, int Reposts, int Views)>> GetEngagement48hAsync(
        IReadOnlyCollection<Guid> postIds,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Проверяет, появились ли новые публичные посты от авторов <paramref name="followedUserIds"/> позже <paramref name="sinceUtc"/>.
    /// Используется в FIRA-F endpoint `has-new` (§13.4 FIRA.md) — лёгкая проверка без пересчёта ленты.
    /// </summary>
    Task<bool> HasNewerPostsAsync(
        IReadOnlyCollection<Guid> followedUserIds,
        DateTime sinceUtc,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Для каждого поста — UUID подписок, репостнувших его (по убыванию даты репоста, без дублей).
    /// Используется для индикатора «репост от подписки» в ленте.
    /// </summary>
    Task<Dictionary<Guid, IReadOnlyList<Guid>>> GetFollowedReposterIdsByPostsAsync(
        IReadOnlyCollection<Guid> postIds,
        IReadOnlySet<Guid> followedUserIds,
        CancellationToken cancellationToken = default);
}
