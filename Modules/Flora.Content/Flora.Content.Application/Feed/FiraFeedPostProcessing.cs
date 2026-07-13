namespace Flora.Content.Application.Feed;

/// <summary>
/// Чистые функции постобработки FIRA-F (§Шаг 4 FIRA-F.md). Детерминированы, без побочных
/// эффектов — референс числового/позиционного паритета Rust-порта (§15 FIRA.md):
/// golden-вектора постобработки генерируются вызовом именно этих функций.
/// </summary>
public static class FiraFeedPostProcessing
{
    /// <summary>
    /// Гарантирует, что никакой автор не занимает более <paramref name="maxConsecutive"/> позиций подряд.
    /// Первый проход уважает ограничение, вытесняя лишние посты; второй проход (v1.1, строгий)
    /// дописывает вытесненные, продолжая соблюдать лимит серий. Неизбежные серии (остались посты
    /// только одного автора) допускаются в самом конце.
    /// </summary>
    public static List<FeedCandidate> ApplyAuthorDiversity(
        IReadOnlyList<FeedCandidate> sorted, int maxConsecutive)
    {
        var result   = new List<FeedCandidate>(sorted.Count);
        var deferred = new List<FeedCandidate>();
        int streak   = 0;
        Guid? lastAuthor = null;

        foreach (var c in sorted)
        {
            if (c.AuthorUserUuid == lastAuthor)
            {
                if (streak >= maxConsecutive)
                {
                    deferred.Add(c);
                    continue;
                }
                streak++;
            }
            else
            {
                lastAuthor = c.AuthorUserUuid;
                streak     = 1;
            }
            result.Add(c);
        }

        // Второй проход: вытесненные добавляются с повторной проверкой серий.
        // Порядок стабилен: среди допустимых берётся первый по исходному рангу.
        while (deferred.Count > 0)
        {
            int pick = -1;
            for (int i = 0; i < deferred.Count; i++)
            {
                if (!WouldExceedTailStreak(result, deferred[i].AuthorUserUuid, maxConsecutive))
                {
                    pick = i;
                    break;
                }
            }
            if (pick < 0) pick = 0; // остались посты одного автора — серия неизбежна
            result.Add(deferred[pick]);
            deferred.RemoveAt(pick);
        }

        return result;
    }

    private static bool WouldExceedTailStreak(
        List<FeedCandidate> result, Guid author, int maxConsecutive)
    {
        int streak = 0;
        for (int i = result.Count - 1; i >= 0 && result[i].AuthorUserUuid == author; i--)
            streak++;
        return streak >= maxConsecutive;
    }

    /// <summary>
    /// Равномерно перемежает exploration-посты с основным списком.
    /// Точная доля (§15 FIRA.md, отклонение №3 FIRA-F.md закрыто в v1.1):
    /// вставка 1 exploration после каждых period = round(1/ε − 1) основных даёт долю
    /// 1/(period+1); при ε = 0.15 → period = 6 → 1/7 ≈ 14.3 %.
    /// </summary>
    public static List<Guid> InterleaveExploration(
        List<Guid> main, List<Guid> exploration, double explorationQuota)
    {
        if (exploration.Count == 0) return main;

        int period = ExplorationPeriod(explorationQuota);
        var result = new List<Guid>(main.Count + exploration.Count);
        int explIdx = 0;

        for (int i = 0; i < main.Count; i++)
        {
            result.Add(main[i]);
            if ((i + 1) % period == 0 && explIdx < exploration.Count)
                result.Add(exploration[explIdx++]);
        }
        while (explIdx < exploration.Count)
            result.Add(exploration[explIdx++]);

        return result;
    }

    /// <summary>period = max(1, round(1/ε − 1)); round — MidpointRounding.ToEven (паритет с Rust round_ties_even).</summary>
    public static int ExplorationPeriod(double explorationQuota) =>
        Math.Max(1, (int)Math.Round(1.0 / Math.Max(explorationQuota, 0.01) - 1.0, MidpointRounding.ToEven));
}
