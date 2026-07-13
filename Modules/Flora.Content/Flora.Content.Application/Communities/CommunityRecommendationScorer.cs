using Flora.Content.Contracts;

namespace Flora.Content.Application.Communities;

/// <summary>
/// Чистая функция скоринга FIRA-C as-built v1 (§Implementation Status FIRA-C.md).
/// Референс числового паритета Rust-порта Фазы 3 (§15 FIRA.md): golden-вектора
/// генерируются вызовом этой функции; формула заморожена до cutover.
/// </summary>
public static class CommunityRecommendationScorer
{
    // Score = memberScore + activityScore + socialScore + recencyScore
    //   memberScore   = log10(max(memberCount, 0) + 1)      × WeightMembers
    //   activityScore = log10(max(recentPostCount, 0) + 1)  × WeightActivity
    //   socialScore   = log10(max(followedMembers, 0) + 1)  × WeightSocial
    //   recencyScore  = max(0, BoostDays − ageDays) / BoostDays × WeightRecency  (линейный new-community boost)
    public static double Score(
        CommunityRecommendationCandidate candidate,
        CommunityRecommendationOptions options,
        DateTime nowUtc)
    {
        var memberScore   = Math.Log10(Math.Max(candidate.MemberCount, 0) + 1)          * options.WeightMembers;
        var activityScore = Math.Log10(Math.Max(candidate.RecentPostCount, 0) + 1)      * options.WeightActivity;
        var socialScore   = Math.Log10(Math.Max(candidate.FollowedMembersCount, 0) + 1) * options.WeightSocial;

        var ageDays      = Math.Max((nowUtc - candidate.CreatedAt).TotalDays, 0);
        var boostWindow  = Math.Max(options.NewCommunityBoostDays, 1);
        var recencyScore = Math.Max(0, boostWindow - ageDays) / boostWindow * options.WeightRecency;

        return memberScore + activityScore + socialScore + recencyScore;
    }
}
