# FIRA-F — Feed Recommendations

**Status:** Draft  
**Version:** 0.2  
**Date:** 2026-06-09  
**Depends on:** [`FIRA.md`](./FIRA.md)

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
              ├─→ IContentFeedQueries  (Flora.Content.Infrastructure)
              └─→ UIP (читается через FiraContext)
```

Бизнес-логика скоринга строго в `Flora.Content.Application`. Контроллер `Flora.Social` только делегирует вызов и отдаёт результат.

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
| CF-кандидаты (Collaborative Filtering) | `CfCandidateWeight` (дефолт: 0.2) | Посты, понравившиеся пользователям с похожим UIP (см. [`FIRA.md §10`](./FIRA.md)); отключается автоматически при `uipConfidence < CfMinUipConfidence`, вручную — при `CfCandidateWeight = 0` |

Собственные посты пользователя не участвуют в ранжировании — они закрепляются в самом верху ленты вне алгоритма.

Репосты от подписок включаются в пул как отдельные кандидаты с прикреплённым `repostMeta` (§ Repost Signal).

### Шаг 2 — Извлечение признаков

Для каждого кандидата извлекаются:

- **Теги поста** — список topic_id, извлечённый из контента или заданный автором.
- **Author affinity** — tanh-нормированный накопленный сигнал взаимодействий пользователя с постами этого автора (лайки, комментарии и т.д.). Не является частью UIP-вектора; вычисляется отдельно на основе истории событий по `authorId`.
- **Engagement stats** — лайки, комментарии, репосты, просмотры за последние 48 ч. В формулах обозначаются как `likes`, `comments`, `reposts`, `views` — подразумевается 48h-срез. `exp(−λ × ageHours)` в `GlobalRelevance` дополнительно снижает Score по мере старения поста: даже при устойчивой вирусности очень старые посты отступают на задний план.
- **Content lifecycle** — тип жизненного цикла поста: `Ephemeral`, `Standard`, `Evergreen` (см. [`FIRA.md §9`](./FIRA.md)). Влияет на скорость затухания в `GlobalRelevance`. Задаётся автором при публикации; по умолчанию `Standard`.
- **Repost meta** — количество и список подписок, сделавших репост (если применимо).
- **Age** — время жизни поста в часах от момента публикации.

### Шаг 3 — Скоринг

Применяется универсальная формула FIRA (см. [`FIRA.md §3`](./FIRA.md)):

```
Score(post) = α · IndividualAffinity(post, UIP)
            + β · GlobalRelevance(post)
            + γ · SocialProximity(post, graph)
```

Компонент-специфичные значения весов (Phase 2):

| Параметр | Значение по умолчанию |
|----------|-----------------------|
| `α` (IndividualAffinity) | 0.45 |
| `β` (GlobalRelevance) | 0.25 |
| `γ` (SocialProximity) | 0.30 |
| `DecayLambda` | 0.05 (≈14 ч полужизни; применяется и для UIP-затухания событий, и для post freshness в `GlobalRelevance` — намеренное упрощение) |
| `AffinityScale` (`authorAffinityScale`) | 5.0 (чувствительность tanh: при сумме = scale affinity ≈ 0.76) |
| Repost-параметры | см. таблицу «Configurable параметры» в §Repost Signal: `affinityThreshold`, `socialRepostThreshold`, `repostWeight`, `repostCap` |

#### IndividualAffinity

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
- **Topic diversity:** минимум `minUniqueTopicsPerPage = 3` разных тем на каждые 10 позиций.
- **Exploration quota:** минимум `ε = 15%` позиций занято кандидатами из источников Trending и Exploration (или адаптивное значение при `UseAdaptiveBandit = true`, см. [`FIRA.md §5`](./FIRA.md)).
- **Dedup:** один и тот же пост не может появиться дважды (по `PostUuid`).
- **Privacy filter:** посты из приватных сообществ, в которых пользователь не состоит, исключаются.

### Шаг 5 — Выдача

- Per-user кэш, TTL = 120 с.
- **Триггеры инвалидации** (полная матрица — [`FIRA.md §13.2`](./FIRA.md)):
  лайк/анлайк, репост/анрепост, комментарий, новый пост, подписка/отписка, вступление/выход из сообщества, `hide`.
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

В **Settings → Feed** доступен переключатель «Показывать репосты в рекомендациях». При отключении: `repostBoost = 0` принудительно для всех кандидатов. Репосты при этом всё равно отображаются во вкладке «Подписки».

---

## Scoring Formula Summary

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

// --- Итоговый Score ---
Score(p)                    = 0.45 · IndividualAffinity(p)   ← ∈ [0,1]
                            + 0.25 · GlobalRelevance(p)
                            + 0.30 · SocialProximity(p)
```

---

## Individual vs Global Balance

| Фаза cold start | α | β | γ | Поведение |
|-----------------|---|---|---|-----------|
| Phase 0 (0 сигналов) | 0.0 | 0.70 | 0.30 | Только тренды и социальный граф |
| Phase 1 (1–19) | 0.0 → 0.45 | 0.70 → 0.25 | **0.30** (константа) | Линейная интерполяция α и β; γ неизменен |
| Phase 2 (≥ 20) | 0.45 | 0.25 | 0.30 | Полная персонализация |

Explicit onboarding (выбор тем) переводит систему из Phase 0 в Phase 1 мгновенно.

---

## Cold Start Protocol

- **Phase 0:** кандидаты только из Trending (β=0.7) и социального графа (γ=0.3). Exploration quota увеличивается до 30% для максимального discovery.
- **Onboarding acceleration:** выбранные в Settings → Interests темы мгновенно сидируют UIP с весом `explicitTopicSeedWeight` и переводят систему в Phase 1.
- Explicit теги при onboarding → немедленно влияют на `postTopicVector` matching.

---

## Feedback Loop

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

## Open Questions / Future Work

- **Теги постов:** авто-извлечение тегов из текста (NLP) vs. явные теги от автора vs. комбинация.
- **Author affinity decay:** должен ли распад по времени для author affinity быть быстрее/медленнее, чем для тем?
- **Repost chain:** если A репостнул B, а B репостнул оригинал — суммируются ли социальные сигналы?
- **Feed freshness:** механизм «не показывать один и тот же пост дольше 24 ч» без расширения кэша.
- **Real-time trending:** частота обновления trending-пула (сейчас: предполагается каждые 15 мин).
- **ContentLifecycle auto-classification:** NLP-классификация `Ephemeral/Standard/Evergreen` по тексту поста без ручного указания автором; порог точности для production.
- **CF-источник и freshness:** CF-кандидаты могут быть стареющими постами (пользователи-соседи лайкали их давно) — нужен ли дополнительный фильтр по `ageHours` для CF-пула?
- **Position bias bootstrapping:** как корректно инициализировать `expectedCtr(pos)` при нулевой истории данных — equal-weight или prior из академических datasets?
