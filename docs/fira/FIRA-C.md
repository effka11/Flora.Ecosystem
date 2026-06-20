# FIRA-C — Communities Recommendations

**Status:** Draft  
**Version:** 0.2  
**Date:** 2026-06-09  
**Depends on:** [`FIRA.md`](./FIRA.md)

---

## Overview

FIRA-C — компонент системы FIRA, отвечающий за рекомендации сообществ. Его задача — предлагать пользователю сообщества, которые соответствуют его интересам (через UIP) и социальному окружению (через граф подписок), а также поддерживать рост новых сообществ через exploration. FIRA-C особенно важен для здоровья экосистемы: качественные рекомендации сообществ создают долгосрочную вовлечённость пользователя.

---

## Goals & Non-Goals

**Goals:**
- Рекомендовать сообщества на основе совпадения тем с UIP.
- Учитывать социальную близость: сообщества, в которых состоят подписки пользователя.
- Поддерживать discovery новых сообществ через growth bonus.
- Уважать приватность: приватные сообщества не появляются в рекомендациях без invite.

**Non-Goals:**
- Ранжирование контента внутри сообщества (это задача FIRA-F с параметром источника «joined communities»).
- Поиск сообществ по названию/тегу (отдельный поисковый сервис).
- Модерация или оценка качества контента сообщества.

---

## Architecture Position

**Модуль-владелец:** `Modules/Flora.Content`

```
Flora.Social (HTTP controller)
  └─→ ICommunityRecommendationService  (Flora.Content.Contracts)
        └─→ CommunityRecommendationService  (Flora.Content.Application)
              ├─→ ICommunityRecommendationQueries  (Flora.Content.Infrastructure)
              └─→ FiraContext (UIP + social graph snapshot)
```

Данные о членстве в сообществах хранятся в `Flora.Content` (`UserCommunity`). Граф подписок читается через `FiraContext.Graph`, переданный из `Flora.Users` через контракт — прямого обращения к `Flora.Users` БД нет.

---

## Algorithm

### Шаг 1 — Генерация кандидатов

| Источник | Начальный вес пула | Описание |
|----------|--------------------|----------|
| Сообщества подписок пользователя | 1.0 | Публичные сообщества, в которых состоят подписки |
| Совпадение тем UIP | 0.8 | Сообщества, теги которых близки к UIP-вектору |
| Новые / быстрорастущие | 0.3 | Сообщества, созданные < 30 дней назад или показавшие резкий рост участников |
| Высокое пересечение участников | 0.6 | Сообщества, в которых состоит наибольшее число подписок |
| CF-кандидаты (Collaborative Filtering) | `CfCandidateWeight` (дефолт: 0.2) | Сообщества, понравившиеся пользователям с похожим UIP (см. [`FIRA.md §10`](./FIRA.md)); отключается автоматически при `uipConfidence < CfMinUipConfidence`, вручную — при `CfCandidateWeight = 0` |

Из пула исключаются до скоринга:
- Сообщества, в которых пользователь уже состоит.
- Приватные сообщества (без публичного invite-линка).
- Сообщества, из которых пользователь был исключён или сам покинул с explicit «Не интересно».

### Шаг 2 — Извлечение признаков

Для каждого кандидата:

- **communityTagVector** — вектор тем сообщества (теги, заданные при создании + доминирующие темы публичных постов).
- **memberCount** — общее число участников.
- **recentPostCount** — число публичных постов за последние 7 дней (индикатор активности).
- **followedMembers** — количество подписок текущего пользователя, состоящих в сообществе.
- **communityAge** — возраст сообщества в днях от даты создания.
- **weeklyGrowthRate** — прирост числа участников за последние 7 дней / memberCount.

### Шаг 3 — Скоринг

```
Score(community) = α · IndividualAffinity(community, UIP)
                 + β · GlobalRelevance(community)
                 + γ · SocialProximity(community, graph)
                 + growthBonus(community)
```

`growthBonus` — аддитивная надбавка вне основной формулы (§ Growth Bonus).

Компонент-специфичные значения весов (Phase 2):

| Параметр | Значение по умолчанию |
|----------|-----------------------|
| `α` (IndividualAffinity) | 0.40 |
| `β` (GlobalRelevance) | 0.25 |
| `γ` (SocialProximity) | 0.35 |
| `DecayLambda` | 0.02 (активность сообщества затухает медленнее, чем посты) |

#### IndividualAffinity

```
// Session UIP + Hot Zones (FIRA.md §2.7, §11):
effectiveUip_hotzone[topic] = effectiveUip[topic] × hotZoneFactor(topic, user)
// effectiveUip = (1 − sessionMomentumWeight) × UIP + sessionMomentumWeight × SessionUip

IndividualAffinity(community) = cosine(communityTagVector, effectiveUip_hotzone)   ∈ [0, 1]
```

Прямое косинусное сходство вектора тем сообщества с `effectiveUip_hotzone`. Оба вектора неотрицательны (`communityTagVector` — binary/tf-weighted, `effectiveUip_hotzone` — нормированный с `clamp to 0` по §2.5 FIRA.md и масштабированный Hot Zones), поэтому косинус гарантированно лежит в `[0, 1]`. Главный персонализирующий сигнал: если пользователю интересна тема «Фотография», а сообщество посвящено фотографии — affinity будет высоким.

Если пользователь только что вступил в Photography-сообщество (`HotZone(Photography, ×1.3)`), тема Photography дополнительно усиливается через `hotZoneFactor`, что поднимает другие похожие сообщества.

#### GlobalRelevance

```
GlobalRelevance(community) = log10(memberCount + 1) × 2.0
                           + log10(recentPostCount + 1) × 3.0
```

Сочетание размера и активности. Активность (recentPostCount) весит больше, чем размер: маленькое, но живое сообщество предпочтительнее большого, но мёртвого.

#### SocialProximity

```
SocialProximity(community) = log10(followedMembers + 1) × 4.0
```

Сколько из подписок пользователя уже состоит в этом сообществе. Это самый сильный сигнал социального одобрения: если туда пришли люди, которым пользователь уже доверяет (подписан) — сообщество релевантно.

#### Growth Bonus

`growthBonus` — аддитивная надбавка вне основной нормированной тройки (разрешено механизмом `AdditiveBonusWeight` из [`FIRA.md §3`](./FIRA.md)).

```
growthBonus(community) = AdditiveBonusWeight
                        × exp(−communityAge / newCommunityHalfLifeDays)
                        × min(weeklyGrowthRate, growthRateCap)
```

Максимальное значение `growthBonus` = `AdditiveBonusWeight × growthRateCap` = `0.4 × 0.5 = 0.2` (в момент создания сообщества при максимальном росте). `growthRateCap = 0.5` — верхний предел `weeklyGrowthRate`, поэтому реальный потолок вдвое ниже `AdditiveBonusWeight`. Это обеспечивает согласованный масштаб с основной частью Score.

| Параметр | Описание | Значение по умолчанию |
|----------|----------|----------------------|
| `AdditiveBonusWeight` | Максимальная надбавка (из FiraComponentConfig) | 0.4 |
| `newCommunityHalfLifeDays` | Период полужизни буста роста | 30 дней |
| `growthRateCap` | Верхний предел weeklyGrowthRate (против накрутки) | 0.5 |

Буст плавно убывает по мере взросления сообщества. Через 30 дней он составит ~50% от максимума, через 60 дней — ~25%. Это гарантирует visibility для новых сообществ, не давая им вечно занимать топ.

> Фактический максимум `growthBonus = 0.2` выбран так, что он заметно меньше, чем вклад одного сильного компонента (α·IndividualAffinity ≤ 0.40). Новое сообщество с высоким ростом поднимается в рекомендациях, но не вытесняет релевантный персонализированный результат.

### Шаг 4 — Постобработка

- **Diversity:** не более 2 сообществ из одной тематической категории подряд.
- **Exploration quota:** минимум `ε = 15%` позиций занято кандидатами из источника «Новые / быстрорастущие» (или адаптивное значение при `UseAdaptiveBandit = true`, см. [`FIRA.md §5`](./FIRA.md)).
- **Dedup:** сообщество не появляется дважды (по `CommunityId`).
- **Privacy re-check:** повторная проверка `isPrivate` перед выдачей.

### Шаг 5 — Выдача

- Per-user кэш, TTL = 600 с (рекомендации сообществ обновляются реже ленты).
- **Триггеры инвалидации** (матрица — [`FIRA.md §13.2`](./FIRA.md)): вступление / выход из любого сообщества.
- **Метаданные ответа:** `generatedAt` и `expiresAt` (§13.3 FIRA.md).
- Endpoint `has-new` для FIRA-C не реализуется — обновление по TTL (раз в 600 с) достаточно.

---

## Scoring Formula Summary

```
// --- Session UIP + Hot Zones (FIRA.md §2.7, §11) ---
effectiveUip(u)             = (1 − sessionMomentumWeight) × UIP(u)
                            + sessionMomentumWeight × SessionUip(u)
effectiveUip_hotzone[topic] = effectiveUip[topic] × hotZoneFactor(topic, u)

// --- IndividualAffinity ---
IndividualAffinity(c)       = cosine(communityTagVector(c), effectiveUip_hotzone)   ← ∈ [0, 1]

// --- GlobalRelevance ---
GlobalRelevance(c)          = log10(memberCount + 1) × 2.0
                            + log10(recentPostCount + 1) × 3.0

// --- SocialProximity ---
SocialProximity(c)          = log10(followedMembers + 1) × 4.0

// --- growthBonus (аддитивный) ---
growthBonus(c)              = AdditiveBonusWeight
                            × exp(−age / newCommunityHalfLifeDays)
                            × min(weeklyGrowthRate, growthRateCap)

// --- Итоговый Score ---
Score(c)                    = 0.40 · IndividualAffinity(c)
                            + 0.25 · GlobalRelevance(c)
                            + 0.35 · SocialProximity(c)
                            + growthBonus(c)            ← max = AdditiveBonusWeight × growthRateCap = 0.2
```

---

## Individual vs Global Balance

| Фаза cold start | α | β | γ | Поведение |
|-----------------|---|---|---|-----------|
| Phase 0 (0 сигналов) | 0.0 | 0.45 | 0.55 | Популярные и социально близкие сообщества |
| Phase 0* (нет подписок + явные темы) | 0.40 | 0.60 | 0.0 | Специальный случай: только глобал + темы, без социального графа |
| Phase 1 (1–19) | 0.0 → 0.40 | 0.45 → 0.25 | 0.55 → 0.35 | Интерполяция от **Phase 0** к Phase 2; см. примечание по Phase 0* ниже |
| Phase 2 (≥ 20) | 0.40 | 0.25 | 0.35 | Полная персонализация |

> **Phase 0* → Phase 1:** Phase 0* — это статический режим отображения при условии «нет подписок + явные темы», он не участвует в интерполяции Phase 1. Как только пользователь получает первое engagement-событие (Phase 1), интерполяция стартует от стандартных Phase 0 значений (α=0, β=0.45, γ=0.55), независимо от того, был ли пользователь в Phase 0*. Если подписки по-прежнему отсутствуют, γ · SocialProximity → 0 естественным образом (нет followedMembers), поэтому коррекция не нужна.

Growth bonus применяется во всех фазах — он не зависит от степени персонализации.

---

## Cold Start Protocol

- **Phase 0:** крупнейшие активные публичные сообщества платформы. Exploration quota увеличивается до 25% для поддержки новых сообществ.
- **Onboarding acceleration:** если пользователь выбрал темы в Settings → Interests, `communityTagVector ↔ UIP` matching начинает работать немедленно. Сообщества с выбранными темами поднимаются даже в Phase 1.
- Пользователям без единой подписки (нет социального графа) применяется специальный случай Phase 0* из таблицы выше: `γ = 0, β = 0.60, α = 0.40` при наличии явных тем. Без явных тем: `γ = 0, β = 1.0, α = 0`.

---

## Feedback Loop

- **Вступление** в рекомендованное сообщество → позитивный сигнал; все темы сообщества получают буст в UIP; сообщество исключается из пула рекомендаций.
- **Dismissal** («Не интересно») → сообщество не показывается 60 дней; темы получают лёгкий негативный сигнал.
- **Покидание** сообщества через «Не интересно» (не просто leave) → сообщество исключается навсегда.

---

## Privacy Boundaries

Унаследованы из [`FIRA.md §12`](./FIRA.md).

Специфично для FIRA-C:
- Приватные сообщества (`isPrivate = true`) никогда не появляются в пуле кандидатов для пользователей, не получивших явный invite.
- `followedMembers` вычисляется исключительно на стороне сервера и передаётся клиенту только как числовое значение — не как список конкретных пользователей.
- Контент постов сообщества для вычисления `communityTagVector` используется только если пост публичный или пользователь является членом сообщества.

---

## Cache & Performance

| Параметр | Значение |
|----------|---------|
| Cache scope | Per-user |
| TTL | 600 с |
| Инвалидация | Join / leave сообщества |
| Метаданные ответа | `generatedAt` (UTC), `expiresAt` (UTC) |
| Индикатор новых (has-new) | Не поддерживается; обновление по TTL |
| Размер пула кандидатов | Configurable (`candidatePoolSize`, дефолт: 150) |
| Политика обновления (полная) | [`FIRA.md §13`](./FIRA.md) |

---

## Open Questions / Future Work

- **Community tag vector:** автоматическая актуализация тегов по контенту постов (NLP job) — частота обновления (ежедневно?).
- **Геолокационные сообщества:** стоит ли добавить источник по локации пользователя?
- **Ranked invite:** механизм рекомендации приватных сообществ через invite-запрос, если достаточно `followedMembers`.
- **Trending communities:** отдельный sub-source для сообществ с viral growth за последние 48 ч.
- **CF cold start:** при каком минимальном `uipConfidence` включать CF-источник — нужен эмпирический порог.
- **Hot Zones от FIRA-C:** стоит ли публиковать `HotZoneSignal` при вступлении в сообщество (пользователь только что проявил интерес к теме) — или это избыточно поверх уже накопленного UIP?
