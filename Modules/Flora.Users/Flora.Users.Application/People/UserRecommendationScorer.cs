using Flora.Users.Contracts;

namespace Flora.Users.Application.People;

/// <summary>
/// Чистая функция скоринга FIRA-P as-built v1 (§Implementation Status FIRA-P.md).
/// Референс числового паритета Rust-порта Фазы 2b (§15 FIRA.md): golden-вектора
/// генерируются вызовом этой функции; формула заморожена до cutover.
/// </summary>
public static class UserRecommendationScorer
{
    // Score = followerScore + socialScore + recencyScore
    //   followerScore = log10(max(followerCount, 0) + 1)       × WeightFollowers
    //   socialScore   = log10(max(followedByFollowing, 0) + 1) × WeightSocial
    //   recencyScore  = max(0, BoostDays − ageDays) / BoostDays × WeightRecency
    //   ageDays — от UpdatedAt профиля (недавно активные), не от даты регистрации.
    public static double Score(
        UserRecommendationCandidate candidate,
        UserRecommendationOptions options,
        DateTime nowUtc)
    {
        var followerScore = Math.Log10(Math.Max(candidate.FollowerCount, 0) + 1) * options.WeightFollowers;
        var socialScore   = Math.Log10(Math.Max(candidate.FollowedByFollowingCount, 0) + 1) * options.WeightSocial;

        var ageDays      = Math.Max((nowUtc - candidate.UpdatedAt).TotalDays, 0);
        var boostWindow  = Math.Max(options.RecencyBoostDays, 1);
        var recencyScore = Math.Max(0, boostWindow - ageDays) / boostWindow * options.WeightRecency;

        return followerScore + socialScore + recencyScore;
    }
}
