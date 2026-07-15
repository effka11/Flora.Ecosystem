# FIRA-M — Music Recommendations

**Status:** Active — целевая спека; в production Phase 0 «Music Flow» (§Implementation Status)  
**Version:** 0.3  
**Date:** 2026-07-13  
**Depends on:** [`FIRA.md`](./FIRA.md)

> Изменения 0.2 → 0.3: снята пометка Forward Spec — модуль `Flora.Music` создан (треки, артисты, жанры, плейлисты, избранное) и **Phase 0 FIRA-M работает в production** как «Music Flow» (`GET /api/music/flow`). Listening-инфраструктура (`ListeningEvent`, onboarding, skip-сигналы) остаётся целевой (v2). Добавлен раздел **Implementation Status (as-built v1)**. **Критично для миграции:** `Flora.Music` — **Фаза 1** Rust-миграции, первый FIRA-компонент, уходящий в Rust; формулы as-built замораживаются и переносятся 1:1, целевые расширения (v2) реализуются уже на Rust-стороне (`next-architecture.md` §5.1, §6).

---

## Overview

FIRA-M — компонент системы FIRA, отвечающий за рекомендации музыки. В отличие от остальных компонентов, FIRA-M работает с принципиально другим типом сигналов: паттерны прослушивания (время воспроизведения, пропуски) несут значительно больше информации, чем типичные социальные взаимодействия. Это требует расширения базового UIP музыкально-специфичными измерениями и особого подхода к cold start — без явного выбора жанров пользователем алгоритм не может стартовать осмысленно.

---

## Goals & Non-Goals

**Goals:**
- Персонализировать музыкальные рекомендации на основе истории прослушиваний и UIP.
- Учитывать временные паттерны прослушивания (что слушают утром, вечером, в выходные).
- Балансировать знакомое (любимые жанры/артисты) и новое (discovery).
- Предоставить явный путь для cold start через mandatory onboarding выбора жанров.

**Non-Goals:**
- Плейлисты, созданные пользователем (это персональная коллекция, не рекомендации).
- Лицензирование и работа с правообладателями (инфраструктурный вопрос).
- Lyrics, обложки, биографии артистов (отдельные сервисы).
- Рекомендации музыки в социальном контексте (например, «что слушают в моём сообществе») — это future FIRA-M v2.

---

## Architecture Position

**Модуль-владелец:** `Modules/Flora.Music` (реализован)

```
MusicController (Modules/Flora.Music, /api/music/flow)
  └─→ IMusicRecommendationService  (Flora.Music.Contracts)
        └─→ MusicRecommendationService  (Flora.Music.Application)
              ├─→ IMusicRecommendationRepository  (порт; реализация в Flora.Music.Infrastructure)
              ├─→ IListeningHistoryRepository  (target v2)
              └─→ FiraContext (UIP расширенный + social graph snapshot — target v2)
```

`Flora.Music` — самостоятельный модуль с собственной БД (`MusicDbContext`, схема `flora_core`) и **собственным контроллером** — в отличие от F/C/P, HTTP-поверхность музыки не проходит через `Flora.Social`. Никакой бизнес-логики музыкальных рекомендаций нет в `Flora.Content`, `Flora.Social` или `Flora.Shared`.

---

## Требуемая инфраструктура (Flora.Music module)

Базовый модуль создан: `MusicTrack`, `MusicArtist` (+credits), `MusicFavorite`, `MusicPlaylist`, жанровый каталог, transcoding. Из перечисленного ниже **не реализовано** (target v2): `ListeningEvent` + `ListeningContext`, `UserMusicPreferences` (onboarding), `UserFollowedArtist`, `MusicUipExtensionService`, `TemporalPatternAnalyzer`, `ArtistGraphReader`. Сигнатуры ниже — целевые; фактические контракты см. [`MusicRecommendationContracts.cs`](../../Modules/Flora.Music/Flora.Music.Contracts/MusicRecommendationContracts.cs):

### Flora.Music.Domain

```csharp
// Треки и артисты
record Track(Guid TrackId, Guid ArtistId, Guid AlbumId, string Title, TimeSpan Duration,
             TopicTag[] Tags, DateTime ReleasedAt);

record Artist(Guid ArtistId, string Name, TopicTag[] Genres);

record Album(Guid AlbumId, Guid ArtistId, string Title, DateTime ReleasedAt);

// История прослушиваний
record ListeningEvent(Guid EventId, Guid UserUuid, Guid TrackId,
                      DateTime StartedAt, TimeSpan Played, bool Skipped,
                      ListeningContext Context); // Context: см. enum ниже

// Временной контекст прослушивания (для Temporal Patterns, FIRA-M v2)
enum ListeningContext
{
    Morning,    // 06:00–09:59
    Work,       // 10:00–17:59
    Evening,    // 18:00–22:59
    Night,      // 23:00–05:59
    Weekend     // суббота/воскресенье, перекрывает временные слоты выше
}

// Пользовательские предпочтения
record UserMusicPreferences(Guid UserUuid, TopicTag[] ExplicitGenres,
                            bool OnboardingCompleted, DateTime UpdatedAt);

// Artist follow
record UserFollowedArtist(Guid UserUuid, Guid ArtistId, DateTime FollowedAt);
```

### Flora.Music.Application

- `MusicRecommendationService` — реализация `IFiraComponent<TrackCandidate, RecommendedTrackDto>`
- `MusicUipExtensionService` — обновление музыкальной части UIP на основе `ListeningEvent`
- `ListeningEventHandler` — обработчик событий прослушивания (async, через очередь)
- `TemporalPatternAnalyzer` — анализ паттернов прослушивания по времени суток и дню недели

### Flora.Music.Infrastructure

- `MusicDbContext` — EF Core контекст для `Track`, `Album`, `Artist`, `ListeningEvent`, `UserMusicPreferences`, `UserFollowedArtist`
- `MusicRecommendationQueries` — запросы кандидатов для скоринга
- `ListeningHistoryRepository` — история прослушиваний пользователя
- `ArtistGraphReader` — граф похожих артистов (may use external music metadata API)

### Flora.Music.Contracts

```csharp
interface IMusicRecommendationService
{
    Task<RecommendedTrackDto[]> GetRecommendationsAsync(
        Guid userUuid, MusicRecommendationOptions options, CancellationToken ct);
}

record RecommendedTrackDto(Guid TrackId, string Title, ArtistDto Artist,
                           string AlbumArtUrl, TimeSpan Duration, double Score);

record MusicRecommendationOptions(int PageSize = 30, bool IncludeExplored = true);
```

---

## Algorithm

### Шаг 1 — Генерация кандидатов

| Источник | Начальный вес пула | Описание |
|----------|--------------------|----------|
| История прослушиваний (collaborative filtering) | 1.0 | Треки, похожие на прослушанные с высоким completion rate |
| Граф похожих артистов | 0.7 | Артисты, похожие на тех, кого слушает пользователь |
| Жанровый / настроенческий UIP | 0.6 | Треки жанров из UIP пользователя (явные + неявные) |
| Trending tracks | 0.3 | Треки с высоким числом прослушиваний за 48 ч |
| Новые релизы подписанных артистов | 0.8 | Новинки от артистов, которых фолловит пользователь |
| Exploration | 0.15 | Случайная выборка из новых публичных треков |

Из пула исключаются:
- Треки, прослушанные пользователем за последние 24 ч (кроме явного повтора).
- Треки, помеченные пользователем «Не нравится» (dislike).

### Шаг 2 — Извлечение признаков

Для каждого трека:

- **trackTagVector** — вектор жанровых тегов трека.
- **artistAffinityScore** — накопленная история взаимодействий пользователя с этим артистом.
- **completionRateHistory** — средний процент дослушивания этого трека в мировой аудитории.
- **streamCount** — общее число прослушиваний (log-нормированное).
- **releaseAge** — возраст релиза в днях.
- **followedArtist** — подписан ли пользователь на артиста трека.
- **likedByFollowed** — количество подписок пользователя, поставивших лайк треку.
- **temporalContext** — время суток и день недели текущего запроса.

### Шаг 3 — Скоринг

*Target v2* — формулы ниже требуют listening-событий и музыкального UIP; production-скоринг v1 описан в §Implementation Status.

```
Score(track) = α · IndividualAffinity(track, UIP)
             + β · GlobalRelevance(track)
             + γ · SocialProximity(track, graph)
             + temporalBoost(track, context)
```

Компонент-специфичные значения весов (Phase 2):

| Параметр | Значение по умолчанию |
|----------|-----------------------|
| `α` (IndividualAffinity) | 0.50 |
| `β` (GlobalRelevance) | 0.25 |
| `γ` (SocialProximity) | 0.25 |
| `DecayLambda` | 0.01 (музыкальный вкус меняется медленно) |
| `completionRateWeight` | 0.3 (трек с CR=1.0 получает +0.3 к `GlobalRelevance`) |
| `FollowedArtistBoost` | 1.5 (фиксированный бонус в `SocialProximity` за подписку на артиста) |
| `AffinityScale` (`artistAffinityScale`) | 8.0 (чувствительность tanh: первый `play_completed` (+3.0) → affinity ≈ 0.361) |

#### IndividualAffinity

```
// tanh(0) = 0: артист без прослушиваний получает affinity = 0, не 0.5
// max(0, ...) зажимает отрицательные суммы (много пропусков) в 0 перед tanh
artistAffinityScore(artist) = tanh(max(0, Σ w_decayed(listeningEvent_i)) / artistAffinityScale)

IndividualAffinity(track) = clamp01(
    cosine(trackTagVector, musicUipVector) × 0.6
    + artistAffinityScore(artist) × 0.4
)
```

- `musicUipVector` — расширение базового UIP специфично-музыкальными измерениями (жанры, темп, настроение). Хранится в `UserMusicPreferences`, обновляется `MusicUipExtensionService`.
- `artistAffinityScore` — tanh-нормированный сигнал. `tanh` выбран вместо sigmoid: `tanh(0) = 0`, поэтому артист без прослушиваний получает 0, а не 0.5. `artistAffinityScale` (configurable, дефолт: `8.0`): первый `play_completed` (`+3.0`) → `tanh(3.0/8.0) ≈ 0.361`; повторные прослушивания наращивают аффинити к 1.0 постепенно.
- Итоговый `IndividualAffinity` зажат в `[0, 1]` через `clamp01`.

#### GlobalRelevance

```
GlobalRelevance(track) = log10(streamCount + 1) × 1.5
                       + completionRateHistory × completionRateWeight
                       + releaseRecencyBonus(releaseAge, track)
```

```
// Content Lifecycle (FIRA.md §9): Ephemeral стареет быстрее, Evergreen — медленнее
lifecycleHalfLife(track)         = releaseHalfLifeDays / lifecycleMultiplier(track.ContentLifecycle)
                                 // Ephemeral ÷ 2.0 → 7 дней | Standard ÷ 1.0 → 14 дней | Evergreen ÷ 0.2 → 70 дней

releaseRecencyBonus(days, track) = newReleaseWeight × exp(−days / lifecycleHalfLife(track))
```

| Параметр | Значение по умолчанию |
|----------|-----------------------|
| `newReleaseWeight` | 2.0 |
| `releaseHalfLifeDays` | 14 дней (базовое значение для `Standard`; делится на `lifecycleMultiplier`) |

Новые релизы получают значительный буст в первые 2 недели (для `Standard`), затем он убывает. Треки `Ephemeral` (топ-чарты недели) затухают вдвое быстрее (7 дней); `Evergreen` (классика) — в 5 раз медленнее (70 дней).

#### SocialProximity

```
SocialProximity(track) = followedArtistBoost + log10(likedByFollowed + 1) × 2.0
```

```
followedArtistBoost = config.FollowedArtistBoost  если followedArtist = true, иначе 0
```

(`FollowedArtistBoost` — configurable параметр в `FiraComponentConfig`, дефолт: `1.5`)

#### Temporal Boost

Учёт паттернов прослушивания по времени суток и дню недели — future phase, описан в разделе Open Questions. В версии 0.2 `temporalBoost = 0`.

#### Content Lifecycle в музыке

FIRA-M применяет Content Lifecycle для `releaseRecencyBonus` (см. [`FIRA.md §9`](./FIRA.md)). Треки в категории `Ephemeral` (позиции в топ-чартах текущей недели) получают `× 2.0` к скорости затухания `releaseRecencyBonus`. Треки `Evergreen` (классика, 10+ лет) получают `× 0.2`. Стандартные треки: `× 1.0`. Lifecycle трека выставляется при индексации в `Flora.Music.Infrastructure` на основе `releaseAge` (evergreenThresholdYears) и позиции в чарте.

> **Session UIP:** FIRA-M не использует Session UIP (§2.7 FIRA.md). Вместо него используется собственный механизм контекста прослушивания через `ListeningContext`. Если будущий анализ покажет полезность session momentum, это решение пересматривается — флаг `SessionMomentumWeight = 0` в конфиге.

### Шаг 4 — Постобработка

- **Artist diversity:** не более `maxConsecutiveSameArtist = 2` треков от одного артиста подряд.
- **Genre diversity:** минимум `minUniqueGenresPerPage = 3` разных жанров на 10 треков.
- **Exploration quota:** минимум `ε = 15%` позиций занято треками из источников «Trending» и «Exploration» (или адаптивное значение при `UseAdaptiveBandit = true`, см. [`FIRA.md §5`](./FIRA.md)).
- **Dedup:** один трек не появляется дважды за сессию.
- **Skip penalty:** трек, пропущенный пользователем менее чем за 20% в эту сессию, не показывается повторно.

### Шаг 5 — Выдача

- Per-user кэш, TTL = 180 с.
- **Триггер инвалидации** (матрица — [`FIRA.md §13.2`](./FIRA.md)): новый `ListeningEvent` (завершение или пропуск трека) → инвалидация → следующий запрос пересчитывает рекомендации.
- **Метаданные ответа:** `generatedAt` и `expiresAt` (§13.3 FIRA.md).
- Endpoint `has-new` для FIRA-M не реализуется — обновление по TTL (180 с) в рамках сессии прослушивания достаточно.

---

## Signals (Music-specific UIP extension)

Музыкальные сигналы сильнее и точнее, чем социальные взаимодействия в ленте, потому что продолжительность прослушивания — прямое выражение интереса.

### Позитивные сигналы

| Событие | Базовый вес | Описание |
|---------|-------------|----------|
| `play_completed` (≥ 80% трека) | +3.0 | Сильнейший сигнал: пользователь дослушал |
| `replay` (повтор трека) | +4.0 | Явное желание услышать снова |
| `save` / `like` | +2.5 | Явный позитивный сигнал |
| `playlist_add` | +2.0 | Долгосрочный интерес |
| `play_partial` (20–80%) | +1.0 | Трек воспроизведён без активного нажатия skip в этом диапазоне |
| `artist_follow` | +3.5 | Явная подписка на артиста |

### Негативные сигналы

| Событие | Базовый вес | Описание |
|---------|-------------|----------|
| `skip_early` (< 20% трека) | −2.0 | Трек не понравился |
| `dislike` | −3.5 | Явный негативный сигнал; трек исключается навсегда |
| `skip_mid` (20–50%) | −0.5 | Пользователь **активно нажал skip** в диапазоне 20–50% |

> **Разграничение `play_partial` и `skip_mid`:** Диапазоны 20–50% пересекаются, но события взаимоисключающие: `play_partial` создаётся, если трек воспроизвёлся до паузы/конца без нажатия skip; `skip_mid` — при явном нажатии skip в этом диапазоне. Для одного воспроизведения создаётся только одно событие.

Негативные сигналы в музыке весят больше, чем в ленте (FIRA-F), потому что пользователь активно управляет воспроизведением — каждый пропуск информативен.

### Temporal Patterns (Future Phase)

На основе накопленных `ListeningEvent` с полем `Context` (`TemporalPatternAnalyzer`) строится суточный профиль:

- **Утро (6–10):** энергичные жанры, высокий темп.
- **Работа (10–18):** фоновая музыка, low-distraction жанры.
- **Вечер (18–23):** расслабленные жанры, открытость к новому.
- **Выходные:** более широкий диапазон, exploration quota ↑.

Результат: `temporalBoost` — корректирующий множитель к Score на основе совпадения жанра/темпа трека с профилем текущего временного окна. Реализуется в FIRA-M v2.

---

## Scoring Formula Summary

```
IndividualAffinity(t)  = clamp01(
                           cosine(trackTagVector(t), musicUipVector) × 0.6
                           + artistAffinityScore(t) × 0.4
                         )

lifecycleHalfLife(t)   = releaseHalfLifeDays / lifecycleMultiplier(t.ContentLifecycle)

GlobalRelevance(t)     = log10(streamCount + 1) × 1.5
                       + completionRateHistory × completionRateWeight
                       + newReleaseWeight × exp(−age / lifecycleHalfLife(t))

SocialProximity(t)     = followedArtistBoost
                       + log10(likedByFollowed + 1) × 2.0

Score(t)               = 0.50 · IndividualAffinity(t)   ← ∈ [0,1] после clamp01
                       + 0.25 · GlobalRelevance(t)
                       + 0.25 · SocialProximity(t)
                       + temporalBoost(t)               ← 0 в v0.2
```

---

## Individual vs Global Balance

| Фаза cold start | α | β | γ | Поведение |
|-----------------|---|---|---|-----------|
| Phase 0 (нет onboarding) | недоступна | — | — | Onboarding блокирует выдачу |
| Phase 0 (onboarding пройден) | 0.0 | 0.75 | 0.25 | Жанровый топ + социальный граф |
| Phase 1 (1–19 событий) | 0.0 → 0.50 | 0.75 → 0.25 | 0.25 → 0.25 | Линейная интерполяция α и β; γ остаётся константой 0.25; сумма = 1 на каждом шаге |
| Phase 2 (≥ 20 событий) | 0.50 | 0.25 | 0.25 | Полная персонализация |

---

## Cold Start Protocol

FIRA-M — единственный компонент, где cold start **неустраним** без явного ввода данных. Музыкальный вкус нельзя вывести ни из социального графа, ни из поведения в ленте с достаточной точностью.

**Обязательный onboarding:**
- Перед первым открытием раздела «Музыка» пользователю предлагается экран выбора жанров.
- Пользователь выбирает от 1 до `floor(MaxMusicGenres / 3)` жанров из предустановленного списка.
- Без завершения onboarding раздел «Музыка» показывает только глобальный топ-чарт без персонализации (либо onboarding-экран блокирует выдачу — решение на уровне продукта).
- После выбора: `musicUipVector` немедленно сидируется явными жанровыми весами. Это **не** переводит в Phase 1 автоматически — пользователь остаётся в Phase 0 (onboarding пройден), но уже с α=0 и UIP заполненным явными жанрами. Phase 1 начинается только после первого реального listening-события.

> **Почему не переходим сразу в Phase 1?** Явный выбор жанров — слабый сигнал: пользователь мог выбрать жанры для первоначальной настройки, не отражающей реальный вкус. Первое прослушивание — первое поведенческое подтверждение, которое переводит в Phase 1 и начинает накопление `IndividualAffinity`.

**Phase 0 (onboarding пройден):**
- Chart top-100 публичных треков, отфильтрованных по выбранным жанрам.
- Новые релизы подписанных артистов (если пользователь перешёл из другого раздела с существующими подписками).

---

## Feedback Loop

```
Пользователь слушает трек → ListeningEvent создаётся при завершении/пропуске
  → MusicUipExtensionService обновляет musicUipVector асинхронно
  → При следующем запросе Score учитывает обновлённый UIP
  → Daily batch: полный пересчёт artistAffinityScore и жанровых весов
```

**Немедленные действия:**
- `dislike` → трек исключается из пула навсегда; артист получает негативный сигнал.
- `skip_early` × 3 подряд для одного жанра → жанр временно понижается на 12 ч.
- `artist_follow` → артист мгновенно переходит в источник «Новые релизы подписанных артистов».

---

## Privacy Boundaries

Унаследованы из [`FIRA.md §12`](./FIRA.md).

Специфично для FIRA-M:
- История прослушиваний хранится только в `Modules/Flora.Music`. Другие модули не имеют к ней прямого доступа.
- `musicUipVector` передаётся в `FiraContext` как read-only DTO — без раскрытия истории прослушиваний.
- `likedByFollowed` вычисляется на сервере; клиент получает только числовой скоровый сигнал.
- Данные о прослушиваниях не раскрываются другим пользователям (если пользователь не разрешил это явно — future «последнее прослушанное» на профиле).

---

## Cache & Performance

| Параметр | Значение |
|----------|---------|
| Cache scope | Per-user |
| TTL | 180 с |
| Инвалидация | Новый `ListeningEvent` (завершение/пропуск трека) |
| Метаданные ответа | `generatedAt` (UTC), `expiresAt` (UTC) |
| Индикатор новых (has-new) | Не поддерживается; обновление по TTL |
| Размер пула кандидатов | Configurable (`candidatePoolSize`, дефолт: 300) |
| История для CF | Последние 500 `ListeningEvent` пользователя |
| Политика обновления (полная) | [`FIRA.md §13`](./FIRA.md) |

---

## Implementation Status (as-built v1 — «Music Flow»)

Production-реализация: [`MusicRecommendationService.cs`](../../Modules/Flora.Music/Flora.Music.Application/Recommendations/MusicRecommendationService.cs) + [`MusicRecommendationRepository.cs`](../../Modules/Flora.Music/Flora.Music.Infrastructure/MusicRecommendationRepository.cs); эндпоинт `GET /api/music/flow` (`MusicController`). **Референс паритета для Rust-порта Фазы 1 — первый переносимый FIRA-компонент**; golden-вектора снимаются с этих формул до начала Фазы 1 ([`FIRA.md §15`](./FIRA.md)).

**Кандидаты:** опубликованные платформенные треки — весь каталог либо срез по `genreId`/`subgenreId` из запроса, лимит `MaxCandidates = 500`. Отдельных источников/весов пула нет.

**Жанровые веса пользователя** (прокси музыкального вкуса при отсутствии listening-событий): `weight(genre) = 2 × собственные треки жанра + 1 × избранные треки жанра`; нормируются на максимум по жанрам пользователя → `genreAffinity ∈ [0, 1]`.

**Скоринг v1:**

```
globalRelevance = max(0, RecencyBoostDays − releaseAgeDays) / RecencyBoostDays   // линейный, 14 дней
genreAffinity   = genreWeight(track.GenreId) / maxGenreWeight                   // 0 если жанра нет / нет весов

Score = WeightAlpha × 0.0              // 0.0  — α-слот зарезервирован под listening-based IA (v2)
      + WeightBeta  × globalRelevance  // 0.75
      + WeightGamma × genreAffinity    // 0.25 — см. семантическое отклонение ниже
```

Tie-break: `Score desc → PublishedAt desc → Title asc (case-insensitive)`.

**Выдача («волна»):** snapshot ранжированного списка в кэше `flora:fira-m:v1:{userUuid}:{genre}:{subgenre}` (**per-user + per-scope**), TTL `CacheTtlSeconds = 180`; из snapshot исключаются `ExcludeTrackUuids` клиента (уже проигранные в сессии — серверного skip-трекинга нет); батч = топ `take·(1−ε)` + случайные `take·ε` из хвоста (`ExplorationQuota = 0.15`, clamp ≤ 0.5). Инвалидации нет — обновление по TTL; `generatedAt`/`expiresAt` в `MusicFlowWaveDto`.

**Конфигурация** — секция `FiraMusic`. **В `appsettings.json` секция отсутствует — действуют дефолты кода** (для Rust-порта их обязательно продублировать бит-в-бит; см. [`FIRA.md §15`](./FIRA.md)): `WeightAlpha = 0.0`, `WeightBeta = 0.75`, `WeightGamma = 0.25`, `ExplorationQuota = 0.15`, `CacheTtlSeconds = 180`, `RecencyBoostDays = 14`, `MaxCandidates = 500`.

### Карта отклонений (нормативная)

| # | Отклонение | Факт | Решение |
|---|-----------|------|---------|
| 1 | **γ-слот занят жанровой аффинити** | `WeightGamma` умножается на `genreAffinity`, семантически это α·IA-сигнал (личный вкус), а не SocialProximity | техдолг конфига: при введении listening-based IA (v2) жанровая аффинити переезжает в α-слагаемое, γ освобождается под социальные сигналы (`likedByFollowed`, `followedArtistBoost`). До Фазы 1 ключи не переименовывать (freeze) — исправление на Rust-стороне вместе с v2 |
| 2 | Exploration недетерминирован и не в snapshot | случайная выборка хвоста `Random.Shared` на каждый запрос волны | допустимо; исключается из differential-диффа ([`FIRA.md §15`](./FIRA.md)) |
| 3 | Dislike / skip-исключения | нет listening-событий — исключение только клиентским `ExcludeTrackUuids` | v2 |
| 4 | Onboarding жанров | не реализован; Phase 0 работает без mandatory onboarding (прокси — собственные/избранные треки) | v2; требование «onboarding блокирует выдачу» смягчено — Flow работает и без выбора жанров |
| 5 | Неалгоритмический fallback | нет отдельного топ-чарта/новых релизов без персонализации | v1.1 — требование суверенитета [`FIRA.md §16`](./FIRA.md) |

### Rust-порт (Фаза 1, перенесён заранее)

Чистый скорер портирован 1:1 и закреплён consumer-тестом на golden-векторе `fira-m-scorer-v1.json` — формулы и **дефолты конфига** заморожены до cutover Фазы 1: C# [`MusicFlowScorer.cs`](../../Modules/Flora.Music/Flora.Music.Application/Recommendations/MusicFlowScorer.cs) ↔ Rust [`recommendations.rs`](../../Backend/crates/modules/flora-music/src/application/recommendations.rs) (`score`, `rank`, `GenreWeights`); тесты — [`fira_vectors.rs`](../../Backend/Tests/parity/tests/fira_vectors.rs). Дефолты `MusicRecommendationOptions` продублированы в Rust `Default` и сверяются тестом с вектором (снятым с дефолтов C#). Case-insensitive ключи жанров и tie-break по `Title` — ordinal ignore-case с паритетом .NET (`flora_shared::ordinal`).

---

## Open Questions / Future Work

- **Collaborative filtering:** item-based CF (похожие треки по матрице слушателей) vs. model-based (matrix factorization). Для начала item-based проще. CF в FIRA-M рассматривается как расширение Шага 1 (аналогично FIRA-F/C, §10 FIRA.md); включается через `CfCandidateWeight`.
- **Музыкальный граф артистов:** собственная реализация или интеграция с внешним API (Last.fm, MusicBrainz, Spotify API)?
- **Temporal patterns v2:** хранить `Context` в `ListeningEvent` с первого дня — данные для будущей реализации.
- **Mood detection:** определять настроение трека по audio features (tempo, energy, valence) — требует внешнего API или собственного ML.
- **Cross-component UIP:** как правильно расшарить `musicUipVector` с FIRA-F? Нужен ли единый граф тем, включающий музыкальные жанры, или два отдельных вектора?
- **Offline listening:** треки, сохранённые для offline — учитывать ли их completion events?
- **Подписка на артиста vs. follow in feed:** один и тот же граф или разные?
- **Hot Zones из FIRA-M:** FIRA-M уже описана как источник `HotZoneSignal` (FIRA.md §11). Нужно определить: при каком `streakLength` (≥ 3 треков артиста/жанра подряд) сигнал публикуется, и нужен ли `HotZoneEventBus` в `Flora.Music.Contracts`.
- **Content Lifecycle evergreenThresholdYears:** при каком возрасте трек становится `Evergreen` — нужен эмпирический анализ retention по жанрам.
