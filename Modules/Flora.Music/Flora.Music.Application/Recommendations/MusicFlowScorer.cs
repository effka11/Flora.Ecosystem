using Flora.Music.Contracts;

namespace Flora.Music.Application.Recommendations;

/// <summary>
/// Чистая функция скоринга FIRA-M as-built v1 «Music Flow» (§Implementation Status FIRA-M.md).
/// Референс числового паритета Rust-порта Фазы 1 — первый переносимый FIRA-компонент (§15 FIRA.md):
/// golden-вектора генерируются вызовом этой функции; формула заморожена до cutover.
/// </summary>
public static class MusicFlowScorer
{
    // Score = WeightAlpha × 0.0 + WeightBeta × globalRelevance + WeightGamma × genreAffinity
    //   globalRelevance = max(0, RecencyBoostDays − releaseAgeDays) / RecencyBoostDays (линейный)
    //   genreAffinity   = genreWeight(track.GenreId) / maxGenreWeight, иначе 0
    // Phase 0: α-слот намеренно 0 до появления listening-событий (v2).
    public static double Score(
        MusicFlowCandidateRow track,
        IReadOnlyDictionary<string, int> genreWeights,
        int maxGenreWeight,
        MusicRecommendationOptions options,
        DateTime nowUtc)
    {
        var recencyDays = Math.Max((nowUtc - track.PublishedAt).TotalDays, 0);
        var recencyWindow = Math.Max(options.RecencyBoostDays, 1);
        var globalRelevance = Math.Max(0, recencyWindow - recencyDays) / recencyWindow;

        var genreAffinity = 0.0;
        if (!string.IsNullOrWhiteSpace(track.GenreId)
            && genreWeights.TryGetValue(track.GenreId, out var weight)
            && maxGenreWeight > 0)
        {
            genreAffinity = weight / (double)maxGenreWeight;
        }

        return options.WeightAlpha * 0.0
            + options.WeightBeta * globalRelevance
            + options.WeightGamma * genreAffinity;
    }
}
