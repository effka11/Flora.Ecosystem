using System.Text.Json;
using Flora.Content.Application.Communities;
using Flora.Content.Application.Feed;
using Flora.Content.Contracts;
using Flora.Music.Application.Recommendations;
using Flora.Music.Contracts;
using Flora.Users.Application.People;
using Flora.Users.Contracts;

namespace Flora.GoldenVectors;

/// <summary>
/// Генератор golden-векторов FIRA (FIRA.md §15): скореры всех четырёх компонентов
/// «кандидат → Score» + позиционные фикстуры постобработки FIRA-F.
/// Значения вычисляются вызовом боевых чистых функций (эталон — C#-реализация);
/// файлы regenerate-only. Выход: docs/test-vectors/fira/*.json.
///
/// Паритет времени: все timestamp'ы в векторах — с миллисекундной точностью, поэтому
/// TotalHours/TotalDays (C#) и микросекундные дельты (Rust) дают бит-в-бит одинаковые f64
/// (числитель и знаменатель обеих делений точно представимы, деление корректно округлено).
/// UUID'ы tie-break-кейсов выбраны в диапазоне, где порядок RFC-байтов совпадает с Guid.CompareTo.
/// Транси­дентные функции (ln/exp/tanh) могут расходиться на ~1 ulp между libm-реализациями —
/// потребители сравнивают score с относительным допуском 1e-12, порядок ранжирования — точно.
/// </summary>
public static class FiraGoldenVectorGenerator
{
    /// <summary>Фиксированный момент скоринга для всех векторов.</summary>
    public static readonly DateTime NowUtc = new(2026, 7, 13, 12, 0, 0, DateTimeKind.Utc);

    public static void WriteAll(string outputDir)
    {
        Directory.CreateDirectory(outputDir);
        WriteJson(outputDir, "fira-f-scorer-v1.json", BuildFiraFScorerVector());
        WriteJson(outputDir, "fira-f-postprocessing-v1.json", BuildFiraFPostProcessingVector());
        WriteJson(outputDir, "fira-c-scorer-v1.json", BuildFiraCScorerVector());
        WriteJson(outputDir, "fira-p-scorer-v1.json", BuildFiraPScorerVector());
        WriteJson(outputDir, "fira-m-scorer-v1.json", BuildFiraMScorerVector());
    }

    // ─── FIRA-F: скорер (эталон FiraFeedScorer) ─────────────────────────────

    public static FiraFeedConfig DefaultFeedConfig() => new();

    private static object BuildFiraFScorerVector()
    {
        var cfg = DefaultFeedConfig();

        var cases = new (string Name, FeedCandidate Candidate, double RawInteraction)[]
        {
            ("zero_everything",
                Candidate("0f000000-0000-4000-8000-000000000001", "0a000000-0000-4000-8000-0000000000a1",
                    HoursAgo(1), 0, 0, 0, 0, followers: 0, rawInteraction: 0, likers: 0, reposters: 0, cfg), 0),
            ("fresh_viral",
                Candidate("0f000000-0000-4000-8000-000000000002", "0a000000-0000-4000-8000-0000000000a2",
                    HoursAgo(2), 50, 10, 5, 1000, followers: 100, rawInteraction: 0, likers: 0, reposters: 0, cfg), 0),
            ("old_viral_decayed",
                Candidate("0f000000-0000-4000-8000-000000000003", "0a000000-0000-4000-8000-0000000000a3",
                    HoursAgo(72), 50, 10, 5, 1000, followers: 100, rawInteraction: 0, likers: 0, reposters: 0, cfg), 0),
            ("author_affinity_saturated",
                Candidate("0f000000-0000-4000-8000-000000000004", "0a000000-0000-4000-8000-0000000000a4",
                    HoursAgo(5), 3, 0, 0, 40, followers: 10, rawInteraction: 20.5, likers: 0, reposters: 0, cfg), 20.5),
            ("social_likers",
                Candidate("0f000000-0000-4000-8000-000000000005", "0a000000-0000-4000-8000-0000000000a5",
                    HoursAgo(6), 2, 1, 0, 30, followers: 25, rawInteraction: 3.5, likers: 7, reposters: 0, cfg), 3.5),
            ("repost_tandem_active",
                Candidate("0f000000-0000-4000-8000-000000000006", "0a000000-0000-4000-8000-0000000000a6",
                    HoursAgo(4), 1, 0, 2, 15, followers: 5, rawInteraction: 1.0, likers: 2, reposters: 3, cfg), 1.0),
            ("repost_cap_reached",
                Candidate("0f000000-0000-4000-8000-000000000007", "0a000000-0000-4000-8000-0000000000a7",
                    HoursAgo(3), 10, 2, 30, 500, followers: 1000, rawInteraction: 0, likers: 12, reposters: 100, cfg), 0),
            ("future_created_age_clamped",
                Candidate("0f000000-0000-4000-8000-000000000008", "0a000000-0000-4000-8000-0000000000a8",
                    HoursAgo(-2), 4, 1, 1, 10, followers: 3, rawInteraction: 0.5, likers: 1, reposters: 1, cfg), 0.5),
        };

        // Ранжирование с tie-break: у кандидатов без сигналов score = 0.0 точно →
        // порядок определяется CreatedAt desc, затем PostUuid asc (§15 FIRA.md).
        var rankingCandidates = new List<FeedCandidate>
        {
            Candidate("0f000000-0000-4000-8000-0000000000b1", "0a000000-0000-4000-8000-0000000000c1",
                HoursAgo(2), 50, 10, 5, 1000, followers: 100, rawInteraction: 0, likers: 0, reposters: 0, cfg),
            Candidate("0f000000-0000-4000-8000-0000000000b2", "0a000000-0000-4000-8000-0000000000c2",
                HoursAgo(6), 2, 1, 0, 30, followers: 25, rawInteraction: 3.5, likers: 7, reposters: 0, cfg),
            Candidate("0f000000-0000-4000-8000-0000000000b3", "0a000000-0000-4000-8000-0000000000c3",
                HoursAgo(2), 0, 0, 0, 0, followers: 4, rawInteraction: 0, likers: 0, reposters: 0, cfg),
            Candidate("0f000000-0000-4000-8000-0000000000b4", "0a000000-0000-4000-8000-0000000000c4",
                HoursAgo(3), 0, 0, 0, 0, followers: 9, rawInteraction: 0, likers: 0, reposters: 0, cfg),
            // Полный tie: score 0.0 и одинаковый CreatedAt → PostUuid asc
            Candidate("0f000000-0000-4000-8000-0000000000b6", "0a000000-0000-4000-8000-0000000000c5",
                HoursAgo(4), 0, 0, 0, 0, followers: 0, rawInteraction: 0, likers: 0, reposters: 0, cfg),
            Candidate("0f000000-0000-4000-8000-0000000000b5", "0a000000-0000-4000-8000-0000000000c6",
                HoursAgo(4), 0, 0, 0, 0, followers: 0, rawInteraction: 0, likers: 0, reposters: 0, cfg),
        };
        var ranked = FiraFeedScorer.Rank(rankingCandidates, cfg, NowUtc);

        return new
        {
            vectorId = "fira_f_scorer_v1",
            reference = "Modules/Flora.Content/Flora.Content.Application/Feed/FiraFeedScorer.cs",
            nowUtc = Iso(NowUtc),
            scoreToleranceRelative = 1e-12,
            config = new
            {
                alphaPhase0 = cfg.AlphaPhase0,
                betaPhase0 = cfg.BetaPhase0,
                gammaPhase0 = cfg.GammaPhase0,
                decayLambda = cfg.DecayLambda,
                authorAffinityScale = cfg.AuthorAffinityScale,
                affinityThreshold = cfg.AffinityThreshold,
                socialRepostThreshold = cfg.SocialRepostThreshold,
                repostWeight = cfg.RepostWeight,
                repostCap = cfg.RepostCap,
            },
            cases = cases.Select(c => new
            {
                name = c.Name,
                candidate = SerializeCandidate(c.Candidate, c.RawInteraction),
                expected = new
                {
                    authorAffinity = c.Candidate.AuthorAffinity,
                    individualAffinity = FiraFeedScorer.IndividualAffinity(c.Candidate),
                    globalRelevance = FiraFeedScorer.GlobalRelevance(c.Candidate, cfg, NowUtc),
                    socialProximity = FiraFeedScorer.SocialProximity(
                        c.Candidate, FiraFeedScorer.IndividualAffinity(c.Candidate), cfg),
                    repostBoost = FiraFeedScorer.RepostBoost(
                        c.Candidate, FiraFeedScorer.IndividualAffinity(c.Candidate), cfg),
                    score = FiraFeedScorer.Score(c.Candidate, cfg, NowUtc),
                },
            }).ToArray(),
            ranking = new
            {
                comment = "tie-break: Score desc → CreatedAt desc → PostUuid asc",
                candidates = rankingCandidates.Select(c => SerializeCandidate(c, rawInteraction: null)).ToArray(),
                expectedOrder = ranked.Select(c => c.PostUuid.ToString("d")).ToArray(),
            },
        };

        static object SerializeCandidate(FeedCandidate c, double? rawInteraction) => new
        {
            postUuid = c.PostUuid.ToString("d"),
            authorUserUuid = c.AuthorUserUuid.ToString("d"),
            createdAt = Iso(c.CreatedAt),
            likes48h = c.Likes48h,
            comments48h = c.Comments48h,
            reposts48h = c.Reposts48h,
            views48h = c.Views48h,
            authorFollowerCount = c.AuthorFollowerCount,
            rawAuthorInteractionScore = rawInteraction,
            authorAffinity = c.AuthorAffinity,
            followedLikersCount = c.FollowedLikersCount,
            followedRepostersCount = c.FollowedRepostersCount,
        };
    }

    private static FeedCandidate Candidate(
        string postUuid, string authorUuid, DateTime createdAt,
        int likes, int comments, int reposts, int views,
        int followers, double rawInteraction, int likers, int reposters,
        FiraFeedConfig cfg) =>
        new(
            Guid.Parse(postUuid),
            Guid.Parse(authorUuid),
            createdAt,
            likes, comments, reposts, views,
            followers,
            FiraFeedScorer.AuthorAffinity(rawInteraction, cfg.AuthorAffinityScale),
            likers,
            reposters,
            PoolWeight: 1.0);

    // ─── FIRA-F: постобработка (эталон FiraFeedPostProcessing) ──────────────

    private static object BuildFiraFPostProcessingVector()
    {
        var authorA = "0a000000-0000-4000-8000-0000000000d1";
        var authorB = "0a000000-0000-4000-8000-0000000000d2";
        var authorC = "0a000000-0000-4000-8000-0000000000d3";

        var diversityCases = new (string Name, int MaxConsecutive, (string Post, string Author)[] Items)[]
        {
            ("triple_runs_max2", 2, new[]
            {
                ("0f000000-0000-4000-8000-0000000000e1", authorA),
                ("0f000000-0000-4000-8000-0000000000e2", authorA),
                ("0f000000-0000-4000-8000-0000000000e3", authorA),
                ("0f000000-0000-4000-8000-0000000000e4", authorB),
                ("0f000000-0000-4000-8000-0000000000e5", authorB),
                ("0f000000-0000-4000-8000-0000000000e6", authorB),
            }),
            ("single_author_unavoidable", 2, new[]
            {
                ("0f000000-0000-4000-8000-0000000000e7", authorA),
                ("0f000000-0000-4000-8000-0000000000e8", authorA),
                ("0f000000-0000-4000-8000-0000000000e9", authorA),
                ("0f000000-0000-4000-8000-0000000000ea", authorA),
            }),
            ("interleaved_untouched", 2, new[]
            {
                ("0f000000-0000-4000-8000-0000000000eb", authorA),
                ("0f000000-0000-4000-8000-0000000000ec", authorB),
                ("0f000000-0000-4000-8000-0000000000ed", authorA),
                ("0f000000-0000-4000-8000-0000000000ee", authorC),
            }),
            ("pairs_max1", 1, new[]
            {
                ("0f000000-0000-4000-8000-0000000000ef", authorA),
                ("0f000000-0000-4000-8000-0000000000f0", authorA),
                ("0f000000-0000-4000-8000-0000000000f1", authorB),
                ("0f000000-0000-4000-8000-0000000000f2", authorB),
            }),
        };

        var interleaveCases = new (string Name, int MainCount, int ExplorationCount, double Quota)[]
        {
            ("quota_015_period_6", 10, 2, 0.15),
            ("quota_025_period_3", 9, 4, 0.25),
            ("quota_05_period_1", 4, 4, 0.5),
            ("exploration_exhausted", 3, 5, 0.15),
        };

        return new
        {
            vectorId = "fira_f_postprocessing_v1",
            reference = "Modules/Flora.Content/Flora.Content.Application/Feed/FiraFeedPostProcessing.cs",
            authorDiversity = diversityCases.Select(c =>
            {
                var candidates = c.Items
                    .Select(i => DummyCandidate(i.Post, i.Author))
                    .ToList();
                var result = FiraFeedPostProcessing.ApplyAuthorDiversity(candidates, c.MaxConsecutive);
                return new
                {
                    name = c.Name,
                    maxConsecutiveSameAuthor = c.MaxConsecutive,
                    items = c.Items.Select(i => new { postUuid = i.Post, authorUserUuid = i.Author }).ToArray(),
                    expectedOrder = result.Select(r => r.PostUuid.ToString("d")).ToArray(),
                };
            }).ToArray(),
            interleaveExploration = interleaveCases.Select(c =>
            {
                var main = Enumerable.Range(1, c.MainCount)
                    .Select(i => Guid.Parse($"0f000000-0000-4000-8000-00000000{i:x4}"))
                    .ToList();
                var exploration = Enumerable.Range(1, c.ExplorationCount)
                    .Select(i => Guid.Parse($"0e000000-0000-4000-8000-00000000{i:x4}"))
                    .ToList();
                var merged = FiraFeedPostProcessing.InterleaveExploration(main, exploration, c.Quota);
                return new
                {
                    name = c.Name,
                    explorationQuota = c.Quota,
                    expectedPeriod = FiraFeedPostProcessing.ExplorationPeriod(c.Quota),
                    main = main.Select(g => g.ToString("d")).ToArray(),
                    exploration = exploration.Select(g => g.ToString("d")).ToArray(),
                    expectedOrder = merged.Select(g => g.ToString("d")).ToArray(),
                };
            }).ToArray(),
        };

        static FeedCandidate DummyCandidate(string postUuid, string authorUuid) =>
            new(Guid.Parse(postUuid), Guid.Parse(authorUuid), NowUtc,
                0, 0, 0, 0, 0, 0.0, 0, 0, 1.0);
    }

    // ─── FIRA-C: скорер (эталон CommunityRecommendationScorer) ──────────────

    private static object BuildFiraCScorerVector()
    {
        var options = new CommunityRecommendationOptions();

        var cases = new (string Name, CommunityRecommendationCandidate Candidate)[]
        {
            ("empty_new_community", new CommunityRecommendationCandidate
            {
                CommunityId = Guid.Parse("0c000000-0000-4000-8000-000000000001"),
                Name = "Botany Circle", Slug = "botany-circle",
                CreatedAt = DaysAgo(0.5), MemberCount = 0, RecentPostCount = 0, FollowedMembersCount = 0,
            }),
            ("large_active", new CommunityRecommendationCandidate
            {
                CommunityId = Guid.Parse("0c000000-0000-4000-8000-000000000002"),
                Name = "Флора и фауна", Slug = "flora-fauna",
                CreatedAt = DaysAgo(400), MemberCount = 12000, RecentPostCount = 340, FollowedMembersCount = 9,
            }),
            ("social_pull", new CommunityRecommendationCandidate
            {
                CommunityId = Guid.Parse("0c000000-0000-4000-8000-000000000003"),
                Name = "Piano Friends", Slug = "piano-friends",
                CreatedAt = DaysAgo(30), MemberCount = 45, RecentPostCount = 12, FollowedMembersCount = 14,
            }),
            ("recency_boost_partial", new CommunityRecommendationCandidate
            {
                CommunityId = Guid.Parse("0c000000-0000-4000-8000-000000000004"),
                Name = "Rust Migration Club", Slug = "rust-migration",
                CreatedAt = DaysAgo(7), MemberCount = 100, RecentPostCount = 5, FollowedMembersCount = 1,
            }),
        };

        // Tie-break: одинаковые счётчики → Score равен точно; Name asc (ordinal, ignore case).
        var tieA = new CommunityRecommendationCandidate
        {
            CommunityId = Guid.Parse("0c000000-0000-4000-8000-000000000005"),
            Name = "zeta garden", Slug = "zeta-garden",
            CreatedAt = DaysAgo(60), MemberCount = 10, RecentPostCount = 2, FollowedMembersCount = 3,
        };
        var tieB = new CommunityRecommendationCandidate
        {
            CommunityId = Guid.Parse("0c000000-0000-4000-8000-000000000006"),
            Name = "Alpha Garden", Slug = "alpha-garden",
            CreatedAt = DaysAgo(60), MemberCount = 10, RecentPostCount = 2, FollowedMembersCount = 3,
        };
        var rankingCandidates = cases.Select(c => c.Candidate).Concat([tieA, tieB]).ToList();
        var ranked = rankingCandidates
            .Select(c => (Candidate: c, Score: CommunityRecommendationScorer.Score(c, options, NowUtc)))
            .OrderByDescending(x => x.Score)
            .ThenBy(x => x.Candidate.Name, StringComparer.OrdinalIgnoreCase)
            .Select(x => x.Candidate.CommunityId.ToString("d"))
            .ToArray();

        return new
        {
            vectorId = "fira_c_scorer_v1",
            reference = "Modules/Flora.Content/Flora.Content.Application/Communities/CommunityRecommendationScorer.cs",
            nowUtc = Iso(NowUtc),
            scoreToleranceRelative = 1e-12,
            options = new
            {
                weightMembers = options.WeightMembers,
                weightActivity = options.WeightActivity,
                weightSocial = options.WeightSocial,
                weightRecency = options.WeightRecency,
                newCommunityBoostDays = options.NewCommunityBoostDays,
            },
            cases = cases.Select(c => new
            {
                name = c.Name,
                candidate = Serialize(c.Candidate),
                expectedScore = CommunityRecommendationScorer.Score(c.Candidate, options, NowUtc),
            }).ToArray(),
            ranking = new
            {
                comment = "tie-break: Score desc → Name asc (ordinal, ignore case)",
                candidates = rankingCandidates.Select(Serialize).ToArray(),
                expectedOrder = ranked,
            },
        };

        static object Serialize(CommunityRecommendationCandidate c) => new
        {
            communityId = c.CommunityId.ToString("d"),
            name = c.Name,
            createdAt = Iso(c.CreatedAt),
            memberCount = c.MemberCount,
            recentPostCount = c.RecentPostCount,
            followedMembersCount = c.FollowedMembersCount,
        };
    }

    // ─── FIRA-P: скорер (эталон UserRecommendationScorer) ───────────────────

    private static object BuildFiraPScorerVector()
    {
        var options = new UserRecommendationOptions();

        var cases = new (string Name, UserRecommendationCandidate Candidate)[]
        {
            ("fresh_profile_no_signals", new UserRecommendationCandidate
            {
                UserUuid = Guid.Parse("0d000000-0000-4000-8000-000000000001"),
                DisplayName = "Nova", FollowerCount = 0, FollowedByFollowingCount = 0,
                UpdatedAt = NowUtc,
            }),
            ("popular_and_social", new UserRecommendationCandidate
            {
                UserUuid = Guid.Parse("0d000000-0000-4000-8000-000000000002"),
                DisplayName = "Мария", FollowerCount = 1000, FollowedByFollowingCount = 5,
                UpdatedAt = DaysAgo(10),
            }),
            ("stale_profile_recency_zero", new UserRecommendationCandidate
            {
                UserUuid = Guid.Parse("0d000000-0000-4000-8000-000000000003"),
                DisplayName = "Old Timer", FollowerCount = 50, FollowedByFollowingCount = 0,
                UpdatedAt = DaysAgo(45),
            }),
            ("social_dominates", new UserRecommendationCandidate
            {
                UserUuid = Guid.Parse("0d000000-0000-4000-8000-000000000004"),
                DisplayName = "connector", FollowerCount = 12, FollowedByFollowingCount = 9,
                UpdatedAt = DaysAgo(2),
            }),
        };

        var tieA = new UserRecommendationCandidate
        {
            UserUuid = Guid.Parse("0d000000-0000-4000-8000-000000000005"),
            DisplayName = "боб", FollowerCount = 10, FollowedByFollowingCount = 2, UpdatedAt = DaysAgo(40),
        };
        var tieB = new UserRecommendationCandidate
        {
            UserUuid = Guid.Parse("0d000000-0000-4000-8000-000000000006"),
            DisplayName = "Анна", FollowerCount = 10, FollowedByFollowingCount = 2, UpdatedAt = DaysAgo(40),
        };
        var rankingCandidates = cases.Select(c => c.Candidate).Concat([tieA, tieB]).ToList();
        var ranked = rankingCandidates
            .Select(c => (Candidate: c, Score: UserRecommendationScorer.Score(c, options, NowUtc)))
            .OrderByDescending(x => x.Score)
            .ThenBy(x => x.Candidate.DisplayName, StringComparer.OrdinalIgnoreCase)
            .Select(x => x.Candidate.UserUuid.ToString("d"))
            .ToArray();

        return new
        {
            vectorId = "fira_p_scorer_v1",
            reference = "Modules/Flora.Users/Flora.Users.Application/People/UserRecommendationScorer.cs",
            nowUtc = Iso(NowUtc),
            scoreToleranceRelative = 1e-12,
            options = new
            {
                weightFollowers = options.WeightFollowers,
                weightSocial = options.WeightSocial,
                weightRecency = options.WeightRecency,
                recencyBoostDays = options.RecencyBoostDays,
            },
            cases = cases.Select(c => new
            {
                name = c.Name,
                candidate = Serialize(c.Candidate),
                expectedScore = UserRecommendationScorer.Score(c.Candidate, options, NowUtc),
            }).ToArray(),
            ranking = new
            {
                comment = "tie-break: Score desc → DisplayName asc (ordinal, ignore case)",
                candidates = rankingCandidates.Select(Serialize).ToArray(),
                expectedOrder = ranked,
            },
        };

        static object Serialize(UserRecommendationCandidate c) => new
        {
            userUuid = c.UserUuid.ToString("d"),
            displayName = c.DisplayName,
            followerCount = c.FollowerCount,
            followedByFollowingCount = c.FollowedByFollowingCount,
            updatedAt = Iso(c.UpdatedAt),
        };
    }

    // ─── FIRA-M: скорер (эталон MusicFlowScorer) ────────────────────────────

    private static object BuildFiraMScorerVector()
    {
        // Секция FiraMusic отсутствует в appsettings.json — эталоном являются дефолты кода;
        // Rust-порт обязан пиновать те же дефолты (FIRA-M.md §Implementation Status).
        var options = new MusicRecommendationOptions();

        var genreWeights = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase)
        {
            ["rock"] = 6,
            ["jazz"] = 3,
        };
        var maxGenreWeight = genreWeights.Values.DefaultIfEmpty(0).Max();

        var cases = new (string Name, MusicFlowCandidateRow Track)[]
        {
            ("top_genre_fresh_release", Track("0b000000-0000-4000-8000-000000000001", "Solar Bloom", "rock", DaysAgo(1))),
            ("weak_genre_mid_age", Track("0b000000-0000-4000-8000-000000000002", "Night Drive", "jazz", DaysAgo(7))),
            ("no_genre_old_release", Track("0b000000-0000-4000-8000-000000000003", "Untitled Sketch", null, DaysAgo(30))),
            ("unknown_genre_new", Track("0b000000-0000-4000-8000-000000000004", "Petals", "pop", DaysAgo(0))),
            ("boundary_exact_window", Track("0b000000-0000-4000-8000-000000000005", "Fourteen Days", "rock", DaysAgo(14))),
        };

        // Tie: одинаковый жанр + один PublishedAt → Score равен точно; Title asc (ordinal, ignore case).
        var tieA = Track("0b000000-0000-4000-8000-000000000006", "ambient dusk", "jazz", DaysAgo(3));
        var tieB = Track("0b000000-0000-4000-8000-000000000007", "Ambient Dawn", "jazz", DaysAgo(3));
        var rankingTracks = cases.Select(c => c.Track).Concat([tieA, tieB]).ToList();
        var ranked = rankingTracks
            .Select(t => (Track: t, Score: MusicFlowScorer.Score(t, genreWeights, maxGenreWeight, options, NowUtc)))
            .OrderByDescending(x => x.Score)
            .ThenByDescending(x => x.Track.PublishedAt)
            .ThenBy(x => x.Track.Title, StringComparer.OrdinalIgnoreCase)
            .Select(x => x.Track.TrackUuid.ToString("d"))
            .ToArray();

        return new
        {
            vectorId = "fira_m_scorer_v1",
            reference = "Modules/Flora.Music/Flora.Music.Application/Recommendations/MusicFlowScorer.cs",
            nowUtc = Iso(NowUtc),
            scoreToleranceRelative = 1e-12,
            optionsSource = "code defaults — секция FiraMusic в appsettings.json отсутствует",
            options = new
            {
                weightAlpha = options.WeightAlpha,
                weightBeta = options.WeightBeta,
                weightGamma = options.WeightGamma,
                recencyBoostDays = options.RecencyBoostDays,
                explorationQuota = options.ExplorationQuota,
                maxCandidates = options.MaxCandidates,
                cacheTtlSeconds = options.CacheTtlSeconds,
            },
            genreWeights,
            maxGenreWeight,
            cases = cases.Select(c => new
            {
                name = c.Name,
                track = Serialize(c.Track),
                expectedScore = MusicFlowScorer.Score(c.Track, genreWeights, maxGenreWeight, options, NowUtc),
            }).ToArray(),
            ranking = new
            {
                comment = "tie-break: Score desc → PublishedAt desc → Title asc (ordinal, ignore case)",
                tracks = rankingTracks.Select(Serialize).ToArray(),
                expectedOrder = ranked,
            },
        };

        static MusicFlowCandidateRow Track(string uuid, string title, string? genreId, DateTime publishedAt) =>
            new(Guid.Parse(uuid), Guid.Parse("0a000000-0000-4000-8000-0000000000ff"),
                title, "Flora Artist", genreId, null, null, null, false, 180_000,
                publishedAt.AddDays(-1), publishedAt);

        static object Serialize(MusicFlowCandidateRow t) => new
        {
            trackUuid = t.TrackUuid.ToString("d"),
            title = t.Title,
            genreId = t.GenreId,
            publishedAt = Iso(t.PublishedAt),
        };
    }

    // ─── Общие помощники ─────────────────────────────────────────────────────

    private static DateTime HoursAgo(double hours) => NowUtc.AddHours(-hours);

    private static DateTime DaysAgo(double days) => NowUtc.AddDays(-days);

    private static string Iso(DateTime utc) => utc.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");

    private static void WriteJson(string dir, string name, object payload)
    {
        var json = JsonSerializer.Serialize(payload, new JsonSerializerOptions
        {
            WriteIndented = true,
            Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        });
        File.WriteAllText(Path.Combine(dir, name), json + "\n");
    }
}
