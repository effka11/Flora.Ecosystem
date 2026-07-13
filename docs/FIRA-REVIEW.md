# Ревью FIRA (Flora Individual Recommendation Algorithm)

**Дата:** 2026-07-14  
**Объект:** [`docs/fira/FIRA.md`](./fira/FIRA.md) (v0.3) + компонентные спеки FIRA-F/P/C/M; as-built C# (Phase 0 / v1.1-гигиена); Rust-порт скореров; golden-векторы  
**Контекст:** числовой паритет C# ↔ Rust ([`next-architecture.md`](../next-architecture.md) §6–§7), governance и суверенитет ленты ([`fgp/FGP.md`](./fgp/FGP.md) §1.2, анти-захват рекомендаций)  
**Статус ревью:** зафиксировано; пункты remediation — ниже (§Рекомендуемый порядок)

---

## Вердикт

Паритетная поверхность FIRA (скореры + постобработка FIRA-F + tie-break'и + дефолты конфига) **зафиксирована корректно** и защищена тестами с обеих сторон — фундамент для миграции на Rust надёжный.

- формулы Phase 0 (as-built) в C# и Rust сходятся 1:1 по порядку операций и IEEE-арифметике возраста;
- tie-break'и нормативны (`Guid` / ordinal ignore-case / стабильная сортировка);
- v1.1-гигиена приватности (VisiblePosts, двунаправленный блоклист, детерминированный trending) закрыта до съёмки golden-векторов;
- golden-вектора сняты после гигиены; Rust-потребитель `fira_vectors.rs` сверяет score с допуском `1e-12` и порядок ранжирования точно.

Ревью нашло **три замечания средней тяжести** — все **вне** замороженной формульной поверхности (кандидаты / метаданные кэша). Формулы и вектора трогать не нужно.

---

## Объём проверки

| Артефакт | Что смотрели |
| --- | --- |
| [`FIRA.md`](./fira/FIRA.md) | Score §3, pipeline, privacy §12, as-built §14, детерминизм §15, FGP §16, roadmap §17 |
| [`FIRA-F.md`](./fira/FIRA-F.md) / [`FIRA-P.md`](./fira/FIRA-P.md) / [`FIRA-C.md`](./fira/FIRA-C.md) / [`FIRA-M.md`](./fira/FIRA-M.md) | as-built формулы, карта отклонений, Rust-порт, конфиг |
| C# скореры | `FiraFeedScorer`, `FiraFeedPostProcessing`, `UserRecommendationScorer`, `CommunityRecommendationScorer`, `MusicFlowScorer` |
| C# кандидаты / фильтры | `ContentFeedQueries` (VisiblePosts, trending, exploration, engagement48h), `UserRecommendationQueries`, `CommunityRecommendationQueries` |
| C# сервисы | `FeedRecommendationService`, `UserRecommendationService`, `CommunityRecommendationService`, `MusicRecommendationService` |
| Конфиг | `Flora.API/appsettings.json` vs code defaults vs Rust `Default` |
| Rust | `flora-content` (`feed`, `communities`), `flora-users` (`people`), `flora-music` (`recommendations`), `flora-shared` (`dotnet_time`, `ordinal`) |
| Векторы | `docs/test-vectors/fira/*.json`, C# freeze-контроль, `Backend/tests/parity/tests/fira_vectors.rs` |
| Миграция | `next-architecture.md` Фазы 1 / 2b / 3 (FIRA-M / P / F+C) |

---

## Существенные находки

### M1 — второй `UtcNow` внутри pipeline FIRA-F (средняя, differential)

**Факт.** `ComputeFiraFeedAsync` фиксирует единый `nowUtc` для скоринга возраста, но `GetEngagement48hAsync` берёт собственный срез:

```csharp
// Modules/Flora.Content/.../ContentFeedQueries.cs
var cutoff = DateTime.UtcNow.AddHours(-48);
```

**Риск.** На границе 48-часового окна C# и Rust (или два прогона C#) могут получить разные счётчики engagement при идентичной БД — ложный провал differential-диффа Фазы 3. Формулы и golden-вектора не задеты (вектора подают уже готовые счётчики).

**Remediation.** Пробросить `nowUtc` (или `cutoff`) параметром в `GetEngagement48hAsync`. Сделать до cutover Фазы 3.

---

### M2 — недетерминизм `Take` на границе при равных `CreatedAt` (средняя, кандидаты)

**Факт.** Trending закрыт в v1.1 (`ORDER BY CreatedAt desc, PostUuid asc` до `Take`). Остальные источники кандидатов FIRA-F делают `ORDER BY CreatedAt DESC` + `Take` **без** вторичного ключа:

- `GetPostsByAuthorsSinceAsync`
- `GetCommunityPostsForUserAsync`
- `GetRepostsFromUsersAsync` / `GetFirstRepostsFromUsersAsync`
- backfill в `EnsureMinFeedSizeAsync`

**Риск.** Состав пула на границе лимита зависит от плана запроса / физической порядка строк. На голову ранжированной ленты влияет редко (нужны коллизии времени на границе), но честный C# ↔ Rust differential по полному pipeline ломается.

**Remediation.** Добавить `ThenBy(PostUuid)` (и аналогичный стабильный ключ для репостов) везде, где есть `Take` после сортировки по времени. Формулы и вектора не меняются.

---

### M3 — FIRA-M: метаданные кэша игнорируют genre-scope (средняя / низко-средняя)

**Факт.** Волна кэшируется per-scope:

```csharp
// MusicRecommendationService
CacheKey(userUuid, genreId, subgenreId) // flora:fira-m:v1:{user}:{genre}:{subgenre}
```

а `GetCacheGeneratedAt` / `GetCacheExpiresAt` смотрят только `CacheKey(userUuid)` без жанра.

**Риск.** Для жанровой волны контроллер получает `null` или чужой timestamp. Само DTO волны несёт корректные `generatedAt` / `expiresAt`, поэтому runtime выдачи не ломается — ломается контракт метаданных.

**Remediation.** Принять scope в методах метаданных **или** убрать их из публичного контракта при переносе Music (Фаза 1).

---

## Мелочи (L)

| # | Описание | Рекомендация |
| --- | --- | --- |
| L1 | `UserRecommendationQueries` дублирует SQL блоклиста инлайном, хотя в том же модуле есть `UserBlocklistService.GetBlockedUserIdsBidirectionalAsync` | Одна точка истины — сервис блоклиста |
| L2 | `PickWaveBatch` (FIRA-M): фильтр `!mainIds.Contains` после `Skip(mainCount)` избыточен — дубликатов в ranked нет | Упростить при касании файла |
| L3 | `FIRA.md` §14 колонка «Код (ядро)» для FIRA-F не упоминает `FiraFeedPostProcessing.cs`, хотя постобработка — нормативная часть паритета | Дописать путь в таблицу §14 |

---

## Что проверено и в порядке

| Область | Оценка |
| --- | --- |
| Score Phase 0 (F/P/C/M) C# ↔ Rust | 1:1 порядок ops; ln/log10/exp/tanh; clamp/Max |
| Возраст (`TotalHours` / `TotalDays`) | `flora_shared::dotnet_time` — тики .NET, то же IEEE-деление |
| Tie-break UUID | `Guid.CompareTo` ≡ `Uuid::cmp` (RFC bytes) |
| Tie-break строк | `StringComparer.OrdinalIgnoreCase` ≡ `ordinal::cmp_ordinal_ignore_case` (simple uppercase + греческие ипогеграммени) |
| FIRA-F постобработка | author diversity (двухпроходный), interleave `period = round_ties_even(1/ε − 1)` |
| Конфиг `FiraFeed` | appsettings есть; refresh-ключи только в code defaults = Rust `Default` |
| Конфиг P/C | appsettings полные = дефолтам кода = Rust |
| Конфиг `FiraMusic` | секции в appsettings **нет**; Rust-тест сверяет дефолты с вектором |
| Кэш-ключи | `fira-f:v4`, `fira-p:v1`, `fira-c:v1`, `fira-m:v1` — доки ↔ код |
| Privacy v1.1 | `VisiblePosts` на кандидатных запросах FIRA-F; двунаправленный блоклист FIRA-F + FIRA-P; свои посты автора обходят фильтр |
| Trending | детерминированный префикс + tie-break Score/CreatedAt/PostUuid |
| Golden-вектора | сняты после v1.1; freeze C# + consumer Rust |
| FIRA-M γ-семантика | осознанно открыто (жанр как proxy SocialProximity до listening-событий) — не дефект freeze |

---

## Открытый остаток v1.1 (уже в спеке, подтверждён)

Не трогает замороженные формулы; можно закрывать в любом порядке до фаз миграции:

| Пункт | Компонент | Примечание |
| --- | --- | --- |
| `hide`-эндпоинт + toggle репостов | FIRA-F | суверенитет ленты (FGP) |
| Неалгоритмические fallback-сортировки | FIRA-C, FIRA-M | требование суверенитета §16 |
| Dismissal | FIRA-C, FIRA-P | |
| `DiscoverableByRecommendations` | FIRA-P | opt-out из пула |
| Seen-post demotion | FIRA-F | roadmap §17 «остаток» |

---

## Карта статусов отклонений (снимок)

| ID | Тема | Статус на дату ревью |
| --- | --- | --- |
| F-1…F-4, F-6 | privacy / blocklist / exploration share / trending / author diversity | **закрыто в v1.1** |
| F-5, F-7 | hide / fallback sorts (F) | открыто (остаток v1.1) |
| P-1 | blocklist в кандидатах | **закрыто в v1.1** |
| P-2…P-6 | UIP / dismissal / discoverable / … | открыто (target v2 или остаток) |
| M-γ | семантика WeightGamma | открыто (осознанно до listening v2) |

Детали — таблицы в компонентных спеках и `FIRA.md` §14 / §17.

---

## Рекомендуемый порядок действий

1. **M1** — пробросить `nowUtc` в `GetEngagement48hAsync` (до Фазы 3 / differential ленты).
2. **M2** — стабильный tie-break на всех `Take` кандидатных источников FIRA-F (до Фазы 3).
3. **M3** — scope в метаданных кэша FIRA-M (при переносе Music, Фаза 1).
4. **L3** — дописать `FiraFeedPostProcessing.cs` в §14 `FIRA.md` (документационный пакет; можно сразу).
5. **L1–L2** — при касании соответствующих файлов.
6. Остаток v1.1 (hide, fallback sorts, dismissal, discoverable) — вне freeze формул, по приоритету продукта / FGP.

Пункты 1–3 **не** требуют регенерации golden-векторов и совместимы с уже снятыми `docs/test-vectors/fira/*`.

---

## Связанные артефакты

- Норма: [`docs/fira/FIRA.md`](./fira/FIRA.md), [`FIRA-F.md`](./fira/FIRA-F.md), [`FIRA-P.md`](./fira/FIRA-P.md), [`FIRA-C.md`](./fira/FIRA-C.md), [`FIRA-M.md`](./fira/FIRA-M.md)
- Векторы: [`docs/test-vectors/fira/`](./test-vectors/fira/), [`docs/test-vectors/README.md`](./test-vectors/README.md)
- Миграция: [`next-architecture.md`](../next-architecture.md) §6 (Фазы 1 / 2b / 3), §7 (golden / differential)
- FGP: [`docs/fgp/FGP.md`](./fgp/FGP.md) (суверенитет рекомендаций, anti-capture)
- C#: `Modules/Flora.Content|Users|Music/.../Application/...` (скореры, сервисы), `.../Infrastructure/*Queries.cs`
- Rust: `Backend/crates/modules/flora-{content,users,music}/src/application/`, `flora-shared` (`dotnet_time`, `ordinal`)
- Паритет: `Backend/tests/parity/tests/fira_vectors.rs`

---

*Ревью проведено 2026-07-14. Документ — снимок находок; remediation не выполнен автоматически при фиксации.*
