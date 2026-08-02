# FSA-N — Notifications Search (уведомления)

**Status:** Active — нормативная спека; реализация v1 в `fsa_core::notifications`  
**Version:** 0.1  
**Date:** 2026-08-02  
**Depends on:** [`FSA.md`](./FSA.md)

---

## Overview

FSA-N — поиск по уведомлениям пользователя. Домен recency-first: уведомления — хронологический журнал, и пользователь, ищущий в нём, почти всегда ищет «недавнее событие про X». Поэтому FSA-N — единственная поверхность с `RecencyMode::Primary`: свежесть первична, текстовый скоринг работает фильтром и tie-break'ом.

---

## Architecture Position

**Владелец данных:** Social Notifications (`flora-notifications`). Индекс per-user (уведомления приватны по построению — каждый видит только свои).

---

## Профиль (нормативный)

| Поле | Вес | positions | exact_boost |
|------|-----|-----------|-------------|
| `text` | 1.0 | ✓ | — |
| `actor_name` | 1.2 | — | — |

| Параметр | Значение | Обоснование |
|----------|----------|-------------|
| recency | **Primary**: `created_at desc → Score desc → id asc` | журнал; свежее всегда выше |
| static_rank | — | глобального приора нет |
| proximity | — | тексты уведомлений короткие |
| λ (персонализация) | **0.4** | резерв: при Primary-режиме α влияет только на tie-break одинаковых timestamp |
| expansion | prefix ≥ 3, fuzzy ≥ **5** | консервативно: короткие шаблонные тексты |

`actor_name` весит больше текста: «уведомления от Маши» — типовой запрос, а имя актора — самый селективный сигнал в шаблонных текстах.

---

## Документ

`NotificationDoc`: `id`, `text`, `actor_id?` + `actor_name?`, `kind?` (like/comment/follow/mention/system — словарь за Notifications), `read`, `created_at`.

Атрибуты: `kind`, `read ∈ {true,false}`, `actor_id`.  
Ключи аффинити: `actor:{actor_id}`.

---

## API

`NotificationsQuery`: `query`, `limit/offset`, `now`, `personalization (α)`, `unread_only` (`true` → `all_of read=false`), `kind?`.

---

## Implementation Status

Реализовано: `Products/FSA/crates/fsa-core/src/notifications.rs` + unit-тесты (recency-first при любом текстовом скоре, фильтры unread/kind, поиск по имени актора). Подключение к `flora-notifications` — roadmap (FSA.md §9).

## Open Questions

- Диапазонный фильтр по дате (`created_at ∈ [from, to]`) — сейчас атрибуты только точные; кандидат на расширение фильтров ядра.
- Ретенция индекса: индексировать ли уведомления старше N месяцев или ограничить окно.
