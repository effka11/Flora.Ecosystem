# FIRA-F — Feed Recommendations

**Status:** Active — реализован в Phase 0-профиле (§Implementation Status)  
**Version:** 0.3  
**Date:** 2026-07-13  
**Depends on:** [`FIRA.md`](./FIRA.md)

> Изменения 0.2 → 0.3: добавлен нормативный раздел **Implementation Status (as-built v1)** — фактический pipeline, конфиг, tie-break'и и карта отклонений; целевые (UIP-зависимые) части формул помечены по тексту как *target v2*; закрыт open question по real-time trending. Формулы as-built v1 — референс числового паритета Rust-миграции ([`FIRA.md §15`](./FIRA.md)).

---

## Overview

FIRA-F — компонент системы FIRA, отвечающий за рекомендательную ленту. Его цель — показывать пользователю посты, которые максимально соответствуют его интересам, при этом открывая новый контент через глобальные тренды и социальное окружение. FIRA-F работает параллельно с хронологической вкладкой «Подписки» и не заменяет её.

---

## Goals & Non-Goals

**Goals:**
- Персонализировать ленту на основе UIP пользователя.
- Усиливать сигнал репостов подписок при условии совпадения с интересами пользователя (правило тандема).
- Гарантировать разнообразие и защиту от filter bubble.
- Соблюдать пользовательские настройки (репосты в рекомендациях on/off).

**Non-Goals:**
- Хронологическая лента «Подписки» — она работает независимо, без алгоритма.
- Ранжирование контента внутри сообществ (это зона отдельного компонента).
- Модерация или фильтрация по safety-правилам (другой слой).

---

## Architecture Position

**Модуль-владелец:** `Modules/Flora.Content`

```
Flora.Social (HTTP controller)
  └─→ IFeedRecommendationService  (Flora.Content.Contracts)
        └─→ FeedRecommendationService  (Flora.Content.Application)
              ├─→ IContentFeedQueries   (порт; реализация в Flora.Content.Infrastructure)
              ├─→ IFollowGraphReader    (Flora.Users.Contracts — соц. граф)
              └─→ UIP (target v2; читается через FiraContext)
```

Бизнес-логика скоринга строго в `Flora.Content.Application`: чистые функции в `FiraFeedScorer`, оркестрация pipeline в `FeedRecommendationService`. Контроллер `Flora.Social` только делегирует вызов и отдаёт результат. `IFollowGraphReader` — межмодульный контракт, в Фазе 2b Rust-миграции становится gRPC-мостом к Rust-Users без изменения сигнатуры.

---

## Algorithm

### Шаг 1 — Генерация кандидатов

Пул кандидатов формируется из шести источников. Каждый источник имеет начальный вес, определяющий его вклад в финальный пул (не скоринговый вес — это вес при sampling):

| Источник | Начальный вес пула | Описание |
|----------|--------------------|----------|
| Посты прямых подписок (1-я степень) | 1.0 | Авторы, на которых подписан пользователь |
| Посты авторов 2-й степени | 0.4 | Авторы, на которых подписаны подписки |
| Trending | 0.25 | Посты с высоким виральным коэффициентом за последние 24 ч |
| Посты из сообществ пользователя | 0.6 | Из сообществ, в которых состоит пользователь |
| Exploration | 0.15 | Случайная выборка из новых публичных постов (cold content) |
| CF-кандидаты (Collaborative Filtering) — **target v3** | `CfCandidateWeight` (дефолт: 0.2) | Посты, понравившиеся пользователям с похожим UIP (см. [`FIRA.md §10`](./FIRA.md)); отключается автоматически при `uipConfidence < CfMinUipConfidence`, вручную — при `CfCandidateWeight = 0` |

В as-built v1 реализованы первые пять источников; CF требует UIP и ANN-инфраструктуры. «Вес пула» в v1 фактически используется только как приоритет при дедупликации источников — реальное управление составом пула идёт через долевые лимиты выборки (см. Implementation Status).

Собственные посты пользователя не участвуют в ранжировании — они закрепляются в самом верху ленты вне алгоритма.

Репосты от подписок включаются в пул как отдельные кандидаты с прикреплённым `repostMeta` (§ Repost Signal).

### Шаг 2 — Извлечение признаков

Для каждого кандидата извлекаются:

- **Теги поста** — *target v2* — список topic_id, извлечённый из контента или заданный автором.
- **Author affinity** — tanh-нормированный накопленный сигнал взаимодействий пользователя с постами этого автора (лайки, комментарии и т.д.). Не является частью UIP-вектора; вычисляется отдельно на основе истории событий по `authorId`.
- **Engagement stats** — лайки, комментарии, репосты, просмотры за последние 48 ч. В формулах обозначаются как `likes`, `comments`, `reposts`, `views` — подразумевается 48h-срез. `exp(−λ × ageHours)` в `GlobalRelevance` дополнительно снижает Score по мере старения поста: даже при устойчивой вирусности очень старые посты отступают на задний план.
- **Content lifecycle** — *target v2* — тип жизненного цикла поста: `Ephemeral`, `Standard`, `Evergreen` (см. [`FIRA.md §9`](./FIRA.md)). Влияет на скорость затухания в `GlobalRelevance`. Задаётся автором при публикации; по умолчанию `Standard`. В v1 все посты фактически `Standard` (`lifecycleMultiplier = 1.0`).
- **Repost meta** — количество и список подписок, сделавших репост (если применимо).
- **Age** — время жизни поста в часах от момента публикации.

### Шаг 3 — Скоринг

Применяется универсальная формула FIRA (см. [`FIRA.md §3`](./FIRA.md)):

```
Score(post) = α · IndividualAffinity(post, UIP)
            + β · GlobalRelevance(post)
            + γ · SocialProximity(post, graph)
```

Компонент-специфичные значения весов. **Production сейчас — колонка Phase 0** (UIP нет, α = 0); Phase 2 — целевые значения после введения UIP и нормализации Score ([`FIRA.md §3`](./FIRA.md)):

| Параметр | Phase 0 (as-built v1) | Phase 2 (target v2) |
|----------|-----------------------|---------------------|
| `α` (IndividualAffinity) | 0.0 | 0.45 |
| `β` (GlobalRelevance) | 0.70 | 0.25 |
| `γ` (SocialProximity) | 0.30 | 0.30 |

Прочие параметры (общие для фаз):

| Параметр | Значение по умолчанию |
|----------|-----------------------|
| `DecayLambda` | 0.05 (≈14 ч полужизни; применяется и для UIP-затухания событий, и для post freshness в `GlobalRelevance` — намеренное упрощение) |
| `AffinityScale` (`authorAffinityScale`) | 5.0 (чувствительность tanh: при сумме = scale affinity ≈ 0.76) |
| Repost-параметры | см. таблицу «Configurable параметры» в §Repost Signal: `affinityThreshold`, `socialRepostThreshold`, `repostWeight`, `repostCap` |

#### IndividualAffinity

Косинусная часть и Session UIP / Hot Zones — *target v2* (нет UIP); в v1 живёт только `authorAffinity` (см. Implementation Status).

```
// tanh(0) = 0: автор без истории взаимодействий получает affinity = 0, не 0.5
// max(0, ...) зажимает отрицательные накопленные суммы в 0 перед tanh
authorAffinity(author) = tanh(max(0, Σ w_decayed(event_i)) / authorAffinityScale)

// Session UIP mixing (FIRA.md §2.7):
// effectiveUip = (1 − sessionMomentumWeight) × UIP + sessionMomentumWeight × SessionUip
// При SessionUip = null: effectiveUip = UIP

// Hot Zones amplification (FIRA.md §11):
// effectiveUip_hotzone[topic] = effectiveUip[topic] × hotZoneFactor(topic, user)

IndividualAffinity(post) = clamp01(
    cosine(postTopicVector, effectiveUip_hotzone) × 0.7
    + authorAffinity(author) × 0.3
)
```

где `effectiveUip_hotzone[topic] = effectiveUip[topic] × hotZoneFactor(topic, user)` — вектор с применёнными Session UIP и Hot Zones.

- `postTopicVector` — бинарный или tf-взвешенный вектор тем поста в пространстве таксономии.
- `authorAffinity` — tanh-нормированный накопленный сигнал по автору. `tanh` выбран вместо sigmoid потому, что `tanh(0) = 0`: авторы без истории взаимодействий получают ровно 0, а не 0.5. `authorAffinityScale` (configurable, дефолт: `5.0`): первый лайк (+1.0) → `tanh(0.2) ≈ 0.197`; при сумме = scale → `tanh(1) ≈ 0.76`.
- Итоговый `IndividualAffinity` зажат в `[0, 1]` через `clamp01`.

#### GlobalRelevance

Виральный коэффициент нормирует engagement к размеру аудитории автора, чтобы небольшие авторы с высокой вовлечённостью не проигрывали крупным:

```
// likes_48h, comments_48h, reposts_48h, views_48h — 48-часовые срезы (см. §Feature Extraction)
engagementScore(post) = ln(likes_48h + 1) · 1.0
                      + ln(comments_48h + 1) · 2.0
                      + ln(reposts_48h + 1) · 2.5
                      + ln(views_48h + 1) · 0.01

// ln(authorFollowers + 2) вместо ln(authorFollowers + 1):
// при 0 подписчиков знаменатель = ln(2) ≈ 0.693 (нет деления на ноль)
// при 1 подписчике = ln(3) ≈ 1.099; разница минимальна для реальных аккаунтов
viral(post) = engagementScore(post) / ln(authorFollowers + 2)

// Content Lifecycle decay (FIRA.md §9):
// Ephemeral (мем, новость) → λ × 2.0 (быстрое устаревание)
// Standard  (обычный пост) → λ × 1.0
// Evergreen (туториал)     → λ × 0.2 (медленное устаревание)
lifecycleDecayLambda(post) = DecayLambda × lifecycleMultiplier(post.ContentLifecycle)

GlobalRelevance(post) = viral(post) · exp(−lifecycleDecayLambda(post) · ageHours)
```

#### SocialProximity

```
SocialProximity(post) = ln(followedLikers + 1) · 3.0 + repostBoost
```

`repostBoost` описан в следующем разделе.

### Шаг 4 — Постобработка

- **Diversity filter:** не более `maxConsecutiveSameAuthor = 2` постов подряд от одного автора.
- **Topic diversity** — *target v2* (требует тегов постов): минимум `minUniqueTopicsPerPage = 3` разных тем на каждые 10 позиций.
- **Exploration quota:** минимум `ε = 15%` позиций занято кандидатами из источников Trending и Exploration (адаптивное значение при `UseAdaptiveBandit = true` — *target v3*, см. [`FIRA.md §5`](./FIRA.md)).
- **Dedup:** один и тот же пост не может появиться дважды (по `PostUuid`).
- **Privacy filter:** посты из приватных сообществ, в которых пользователь не состоит, исключаются; посты авторов с блокировкой в любом направлении исключаются (нормативные инварианты [`FIRA.md §12`](./FIRA.md); в v1 закрыты не на всех источниках — см. карту отклонений в Implementation Status, исправление в v1.1).

### Шаг 5 — Выдача

- Per-user кэш, TTL = 120 с.
- **Триггеры инвалидации** (полная матрица — [`FIRA.md §13.2`](./FIRA.md)):
  лайк/анлайк, репост/анрепост, комментарий, новый пост, подписка/отписка, вступление/выход из сообщества, `hide` (*target v1.1* — эндпоинт hide ещё не реализован).
- **Метаданные ответа:** каждый `FeedPage` содержит `generatedAt` и `expiresAt` — клиент использует их для управления обновлением (§13.3 FIRA.md).
- **Индикатор новых постов:** `GET /api/auth/feed/has-new?since=<generatedAt>` → `{ hasNew: bool }`.
  Клиент поллит раз в 30 с; при `hasNew = true` показывает баннер «Новые посты».
- Пагинация курсорная; pull-to-refresh сбрасывает курсор клиентом (§13.5 FIRA.md).

---

## Repost Signal

Репост — социальный сигнал одобрения. Важно: он не является самостоятельным критерием попадания поста в рекомендации, а только усиливает сигнал при совпадении с интересами пользователя.

### Вкладка «Подписки» vs. рекомендательная лента

| Место | Поведение репостов |
|-------|--------------------|
| **Вкладка «Подписки»** | Репосты подписок **всегда** отображаются хронологически, без фильтрации. Алгоритм не применяется. |
| **Рекомендательная лента** | Репосты влияют через `repostBoost` по правилу тандема (см. ниже). |

### Правило тандема

Репост увеличивает вероятность появления поста в рекомендательной ленте **только** при одновременном выполнении двух условий:

- **Условие A (социальный сигнал):** пост репостнул как минимум один пользователь из подписок пользователя (`repostedByFollowed ≥ socialRepostThreshold`).
- **Условие B (интерес):** контент поста совпадает с UIP пользователя (`IndividualAffinity(post) ≥ affinityThreshold`).

Если выполнены оба — к `SocialProximity` добавляется `repostBoost`. Если выполнено только одно — `repostBoost = 0`, пост участвует в ранжировании по стандартной формуле.

### Формула

```
repostBoost = repostWeight
            × min(ln(repostedByFollowed + 1), repostCap)
            × heaviside(IndividualAffinity − affinityThreshold)
```

`heaviside(x) = 1` если `x ≥ 0`, иначе `0` — обнуляет буст при несоответствии интересам.

### Configurable параметры

| Параметр | Описание | Значение по умолчанию |
|----------|----------|----------------------|
| `affinityThreshold` | Минимальный IndividualAffinity для активации буста | 0.3 |
| `socialRepostThreshold` | Минимальное число подписок-репостеров | 1 |
| `repostWeight` | Масштабирующий коэффициент буста | 1.5 |
| `repostCap` | Верхний предел log-аргумента (ограничивает влияние массовых репостов) | 3.0 |

### Пользовательская настройка

*Target v1.1.* В **Settings → Feed** доступен переключатель «Показывать репосты в рекомендациях». При отключении: `repostBoost = 0` принудительно для всех кандидатов. Репосты при этом всё равно отображаются во вкладке «Подписки». Настройка пользователя сильнее глобальных дефолтов и governance-решений (FGP §1.2 п. 2; [`FIRA.md §16`](./FIRA.md)).

---

## Scoring Formula Summary

Полная целевая формула (v2). As-built v1 получается подстановкой Phase 0: `cosine = 0` (нет UIP), `lifecycleMultiplier = 1.0`, веса `0.0 / 0.70 / 0.30`, `affinityThreshold = 0.0`.

```
// --- Author affinity ---
authorAffinity(a)           = tanh(max(0, Σ w_decayed(event_i)) / authorAffinityScale)

// --- Session UIP + Hot Zones (FIRA.md §2.7, §11) ---
effectiveUip(u)             = (1 − sessionMomentumWeight) × UIP(u)
                            + sessionMomentumWeight × SessionUip(u)
                            // SessionUip = null → effectiveUip = UIP
effectiveUip_hotzone[topic] = effectiveUip[topic] × hotZoneFactor(topic, u)

// --- IndividualAffinity ---
IndividualAffinity(p)       = clamp01(
                                cosine(postTopicVector(p), effectiveUip_hotzone) × 0.7
                                + authorAffinity(author(p)) × 0.3
                              )   ← ∈ [0, 1]

// --- GlobalRelevance (с lifecycle decay, FIRA.md §9) ---
engagementScore(p)          = ln(likes_48h + 1) × 1.0
                            + ln(comments_48h + 1) × 2.0
                            + ln(reposts_48h + 1) × 2.5
                            + ln(views_48h + 1) × 0.01

lifecycleDecayLambda(p)     = DecayLambda × lifecycleMultiplier(p.ContentLifecycle)
                            // Ephemeral × 2.0 | Standard × 1.0 | Evergreen × 0.2

GlobalRelevance(p)          = (engagementScore(p) / ln(authorFollowers + 2))
                            × exp(−lifecycleDecayLambda(p) × ageHours)

// --- SocialProximity ---
SocialProximity(p)          = ln(followedLikers + 1) × 3.0
                            + repostBoost(p)

repostBoost(p)              = repostWeight
                            × min(ln(repostedByFollowed + 1), repostCap)
                            × heaviside(IndividualAffinity(p) − affinityThreshold)

// --- Итоговый Score (веса Phase 2; в v1 действует 0.0/0.70/0.30) ---
Score(p)                    = 0.45 · IndividualAffinity(p)   ← ∈ [0,1]
                            + 0.25 · GlobalRelevance(p)
                            + 0.30 · SocialProximity(p)
```

При переходе на Phase 2 компоненты GR и SP нормируются через `tanh(x / Scale)` до смешивания — нормативное требование [`FIRA.md §3`](./FIRA.md) (иначе α-слагаемое арифметически подавляется неограниченными GR/SP).

---

## Individual vs Global Balance

| Фаза cold start | α | β | γ | Поведение |
|-----------------|---|---|---|-----------|
| Phase 0 (0 сигналов) | 0.0 | 0.70 | 0.30 | Только тренды и социальный граф |
| Phase 1 (1–19) | 0.0 → 0.45 | 0.70 → 0.25 | **0.30** (константа) | Линейная интерполяция α и β; γ неизменен |
| Phase 2 (≥ 20) | 0.45 | 0.25 | 0.30 | Полная персонализация |

Explicit onboarding (выбор тем) переводит систему из Phase 0 в Phase 1 мгновенно.

> **As-built v1:** система целиком работает в Phase 0 для всех пользователей — фазовый механизм и интерполяция появляются вместе с UIP (v2). Именно поэтому конфиг называет веса `AlphaPhase0`/`BetaPhase0`/`GammaPhase0`.

---

## Cold Start Protocol

- **Phase 0:** кандидаты только из Trending (β=0.7) и социального графа (γ=0.3). Exploration quota увеличивается до 30% для максимального discovery.
- **Onboarding acceleration:** выбранные в Settings → Interests темы мгновенно сидируют UIP с весом `explicitTopicSeedWeight` и переводят систему в Phase 1.
- Explicit теги при onboarding → немедленно влияют на `postTopicVector` matching.

---

## Feedback Loop

*Target v2* — кроме первого пункта в части like/comment/repost: эти события уже учитываются ретроспективно через `authorAffinity` (запрос истории взаимодействий за `InteractionHistoryDays`), без событийного pipeline.

- Каждое engagement-событие с постом (like, comment, repost, **view_full, view_partial,** hide, skip) асинхронно отправляется в UIP update pipeline с весами, определёнными в [`FIRA.md §2.2`](./FIRA.md).
- `hide`/`skip` на конкретный пост: автор и его темы немедленно понижаются в кэше сессии.
- Повторный показ скрытого поста в той же сессии запрещён.
- `view_full` и `view_partial` трекаются клиентом на основе времени видимости поста во viewport; порог «полного просмотра» — configurable (`fullViewThresholdSeconds`, дефолт: 5 с).

---

## Privacy Boundaries

Унаследованы из [`FIRA.md §12`](./FIRA.md).

Специфично для FIRA-F:
- Информация о том, **кто** из подписок репостнул пост, используется только для расчёта `repostBoost`. Список конкретных пользователей клиенту не передаётся — только итоговый скоровый буст.
- Посты из приватных сообществ не попадают в кандидатный пул для пользователей, не являющихся членами сообщества.

---

## Cache & Performance

| Параметр | Значение |
|----------|---------|
| Cache scope | Per-user |
| TTL | 120 с |
| Инвалидация | Лайк, анлайк, репост, анрепост, комментарий, новый пост, follow/unfollow, join/leave сообщества, `hide` |
| Метаданные ответа | `generatedAt` (UTC), `expiresAt` (UTC) |
| Индикатор новых постов | `GET /feed/has-new?since=<generatedAt>` |
| Интервал поллинга has-new | 30 с (рекомендуется) |
| Пагинация | Cursor-based (offset) |
| Размер пула кандидатов | Configurable (`MaxCandidates`, дефолт: 1000) |
| Политика обновления (полная) | [`FIRA.md §13`](./FIRA.md) |

---

## Implementation Status (as-built v1)

Нормативное описание production-реализации: [`FeedRecommendationService.cs`](../../Modules/Flora.Content/Flora.Content.Application/Feed/FeedRecommendationService.cs) (pipeline) + [`FiraFeedScorer.cs`](../../Modules/Flora.Content/Flora.Content.Application/Feed/FiraFeedScorer.cs) (чистые функции скоринга). Раздел — источник истины для golden-векторов и Rust-порта (Фаза 3; [`FIRA.md §15`](./FIRA.md)).

### Фактический pipeline

**Шаг 1 — кандидаты.** Пул собирается в словарь по `PostUuid`; дубль между источниками получает больший вес пула (вес далее в скоринге **не используется**). Долевые лимиты от `MaxCandidates = 1000`:

| Источник | Лимит выборки | Вес пула (только дедуп) | Окно |
|----------|---------------|--------------------------|------|
| Подписки 1-й степени | 50 % | 1.0 | `max(FollowingWindowDays, FollowingPostsDays, 30)` дней (фактически 30) |
| Авторы 2-й степени | 15 % | 0.4 | то же |
| Trending | 15 % | 0.25 | 2 дня → fallback 30 дней → 30 дней (каскад при пустоте) |
| Сообщества пользователя | 20 % | 0.6 | 30 дней |
| Репосты подписок | 10 % | 0.6 | 30 дней |
| Exploration (backfill) | до `MinFeedSize` | 0.15 | 30 дней → +23 дня → без ограничения |

Trending определяется как топ по упрощённому engagement-скору `likes + 2·comments + 2.5·reposts` за окно (все взаимодействия, не 48h-срез), исключая авторов-подписок и удалённые посты. Собственные посты пользователя не скорятся: prepend в начало ленты (до 100, без окна по дате). При пустом пуле — cold-start-ветка: own + exploration, затем latest.

**Шаг 2 — фичи.** Батч-запросы: engagement 48h по постам; кол-во подписчиков авторов; сырой балл взаимодействий пользователя с каждым автором за `InteractionHistoryDays = 90` (`likes×1 + comments×2 + reposts×2.5`); кол-во подписок-лайкеров по постам. Кол-во подписок-репостеров берётся из уже загруженного репост-среза Шага 1.

**Шаг 3 — скоринг.** `Score = 0·IA + 0.70·GR + 0.30·SP` (Phase 0), формулы — как в §Скоринг с подстановками: `IA = clamp01(authorAffinity·0.3)` (cosine-часть = 0), `lifecycleMultiplier = 1.0`. Сортировка с нормативным tie-break: `Score desc → CreatedAt desc → PostUuid asc`.

**Шаг 4 — постобработка.** Author diversity (`MaxConsecutiveSameAuthor = 2`; вытесненные посты уходят в конец списка); затем интерливинг exploration: `mainSlots = MaxCandidates·(1−ε)`, вставка 1 exploration-поста после каждых `period = round(1/ε) = 7` основных. Дедуп гарантирован конструкцией (exploration-запрос исключает уже выбранные id).

**Шаг 5 — выдача.** Snapshot (список id) в per-user кэше `flora:fira-f:v3:{userUuid}` с TTL `CacheTtlSeconds = 120`; страница — `Skip/Take` по offset-курсору; `GeneratedAt`/`ExpiresAt` из snapshot. `forceRefresh=true` на первой странице пересобирает snapshot и применяет позиционный shuffle к прежнему топу (`RefreshShuffleWindow = 5`, вероятности свопа `[1.0, 0.75, 0.55, 0.35, 0.15]`, свежий собственный пост защищён `RefreshOwnPostProtectMinutes = 60`). `has-new` проверяет только новые посты подписок (не community/trending). Инвалидация кэша — вызовами `InvalidateFeedCache` из контроллера по триггерам §13.2 FIRA.md.

### Конфигурация (production)

Секция `FiraFeed` в `appsettings.json` (Rust-порт обязан читать те же ключи и повторять дефолты кода для отсутствующих):

| Ключ | Значение | В appsettings |
|------|----------|---------------|
| `AlphaPhase0 / BetaPhase0 / GammaPhase0` | 0.0 / 0.70 / 0.30 | да |
| `DecayLambda` | 0.05 | да |
| `AuthorAffinityScale` | 5.0 | да |
| `AffinityThreshold` | 0.0 (Phase 0: тандем-условие B отключено) | да |
| `SocialRepostThreshold / RepostWeight / RepostCap` | 1 / 1.5 / 3.0 | да |
| `MaxConsecutiveSameAuthor` | 2 | да |
| `ExplorationQuota` | 0.15 | да |
| `MaxCandidates / MinFeedSize` | 1000 / 20 | да |
| `FollowingWindowDays / TrendingWindowDays / InteractionHistoryDays` | 7 / 2 / 90 | да |
| `EnableCache / CacheTtlSeconds` | true / 120 | да |
| `RefreshShuffleWindow / RefreshPositionSwapProbabilities / RefreshOwnPostProtectMinutes` | 5 / [1.0, 0.75, 0.55, 0.35, 0.15] / 60 | **нет — дефолты кода** |

Смежная секция `FeedRecommendation` (вкладка «Подписки», без алгоритма): `MaxCandidates = 2000`, `FollowingPostsDays = 30`, кэш 120 с.

### Карта отклонений от спеки (нормативная, к исправлению в v1.1)

| # | Отклонение | Факт | Требование |
|---|-----------|------|------------|
| 1 | **Privacy: приватные сообщества** | trending / exploration / latest / 2-я степень не фильтруют посты приватных сообществ; членство проверяется только в источнике «сообщества пользователя» | инвариант §12 FIRA.md: фильтр на каждом кандидатном запросе |
| 2 | **Privacy: блоклист** | взаимные блокировки не исключаются из пула | инвариант §12 FIRA.md |
| 3 | Exploration-доля | вставка после каждых 7 основных даёт ≈ 1/8 = 12.5 % вместо ε = 15 % | `period = round(1/ε − 1) = 6` → 1/7 ≈ 14.3 % |
| 4 | Trending-недетерминизм | кандидаты окна сокращаются `Take(limit·3)` **до** ранжирования и без `ORDER BY` — состав подмножества зависит от плана запроса | ранжировать полное окно либо сортировать до `Take` (детерминизм, [`FIRA.md §15`](./FIRA.md)) |
| 5 | `hide`-эндпоинт и toggle репостов | нет эндпоинта, нет настройки | v1.1 (§Repost Signal, §Feedback Loop) |
| 6 | Author diversity: хвост | вытесненные посты дописываются в конец без повторной проверки streak — в хвосте возможны серии одного автора длиннее лимита | допустимо для v1 (хвост за пределами типичной глубины чтения); строгий второй проход — v1.1 |
| 7 | `has-new` | учитывает только посты подписок | допустимо: дешёвый индикатор; полная семантика — v2 |

### Стохастические точки (исключаются из differential-диффа C# ↔ Rust)

1. Exploration-выборка: SQL `ORDER BY random()`.
2. Refresh-shuffle: `Random.Shared` при `forceRefresh=true`.

Дифф ленты гоняется при `refresh=false`; exploration-позиции детерминированно вычислимы по period-формуле и вырезаются из сравнения. Остальной pipeline детерминирован при фиксированных `nowUtc` и состоянии БД.

---

## Open Questions / Future Work

**Решено в 0.3:**

- ~~Real-time trending~~ — отдельного trending-снапшота нет: trending-запрос выполняется в момент сборки ленты и кэшируется вместе с ней (TTL 120 с). Отдельный материализованный trending-пул с обновлением каждые 15 мин — оптимизация при росте нагрузки, не требование.

**Открыто:**

- **Теги постов:** авто-извлечение тегов из текста (NLP) vs. явные теги от автора vs. комбинация. Решение v2: старт с явных тегов автора (см. [`FIRA.md §17`](./FIRA.md)); NLP — v3.
- **Author affinity decay:** должен ли распад по времени для author affinity быть быстрее/медленнее, чем для тем? В v1 затухания по событиям нет вовсе — используется жёсткое окно `InteractionHistoryDays = 90`; при введении UIP-затухания (v2) окно заменяется на `w_decayed`.
- **Repost chain:** если A репостнул B, а B репостнул оригинал — суммируются ли социальные сигналы?
- **Feed freshness:** механизм «не показывать один и тот же пост дольше 24 ч» без расширения кэша (seen-post demotion — кандидат в v1.1, [`FIRA.md §17`](./FIRA.md)).
- **ContentLifecycle auto-classification:** NLP-классификация `Ephemeral/Standard/Evergreen` по тексту поста без ручного указания автором; порог точности для production.
- **CF-источник и freshness:** CF-кандидаты могут быть стареющими постами (пользователи-соседи лайкали их давно) — нужен ли дополнительный фильтр по `ageHours` для CF-пула?
- **Position bias bootstrapping:** как корректно инициализировать `expectedCtr(pos)` при нулевой истории данных — equal-weight или prior из академических datasets?
