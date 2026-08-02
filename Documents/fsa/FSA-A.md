# FSA-A — Audio Search (музыка)

**Status:** Active — нормативная спека; реализация v1 в `fsa_core::audio`  
**Version:** 0.1  
**Date:** 2026-08-02  
**Depends on:** [`FSA.md`](./FSA.md)

---

## Overview

FSA-A — поиск по музыкальному каталогу (треки). Домен навигационный: пользователь чаще всего знает, что ищет, но пишет с опечатками — имена артистов и названия треков на чужом языке пишутся неточно («металика», «linkin parc»). Профиль делает ставку на fuzzy-исправление, точные совпадения названия/артиста и глобальную популярность; свежесть почти не важна (классика ищется так же, как новинки).

---

## Architecture Position

**Владелец данных:** Social Music (`flora-music`). Каталог опубликованных треков индексируется в `AudioSearch`; приватные/неопубликованные треки не индексируются.

---

## Профиль (нормативный)

| Поле | Вес | positions | exact_boost |
|------|-----|-----------|-------------|
| `title` | 2.0 | ✓ | 0.6 |
| `artist` | 1.8 | — | 0.5 |
| `album` | 1.0 | — | — |
| `tags` | 0.8 | — | — |

| Параметр | Значение | Обоснование |
|----------|----------|-------------|
| recency | Boost, half-life **90 дней**, вес 0.1 | лёгкий буст новинок; каталог вечнозелёный |
| static_rank | 0.5 × popularity_rank | при равном тексте популярный трек первым — чаще всего это и есть искомое |
| proximity | 0.15 | название трека из нескольких слов |
| λ (персонализация) | **0.7** | вкус влияет, но не прячет глобальные хиты |
| expansion | prefix ≥ **2**, fuzzy ≥ 4 | typeahead по коротким названиям; опечатки — норма домена |

`exact_boost` на `title` и `artist` — навигационные запросы («точное название», «точное имя артиста») выигрывают у частичных совпадений.

---

## Документ

`AudioTrack`: `id`, `title`, `artist_name` + `artist_id`, `album?` + `album_id?`, `tags[]`, `genre?`, `explicit`, `published_at`, `popularity_rank ∈ [0,1]`.

Атрибуты: `artist_id`, `album_id`, `genre`, `explicit ∈ {true,false}`.  
Ключи аффинити: `artist:{artist_id}`, `genre:{genre}`.

---

## API

`AudioQuery`: `query`, `limit/offset`, `now`, `personalization (α)`, скоупы `artist_id?` / `genre?`, `exclude_explicit` (`true` → `none_of explicit=true`).

`AffinitySnapshot` для FSA-A собирается из FIRA-M-сигналов: artist affinity (история прослушиваний) → `artist:{id}`, жанровые веса → `genre:{id}`. При `α = 0` выдача полностью глобальна.

---

## Implementation Status

Реализовано: `Products/FSA/crates/fsa-core/src/audio.rs` + unit-тесты (fuzzy по имени артиста, приор популярности при равном тексте, explicit-фильтр). Подключение к `flora-music` — roadmap (FSA.md §9).

## Open Questions

- Поиск артистов/альбомов как отдельные типы выдачи (сейчас — треки; артист ищется через поле `artist`).
- Транслитерация имён (Чайковский ↔ Tchaikovsky) — словарь синонимов профиля (FSA.md §Open Questions).
- Связь с Music Flow: переход из поиска в волну с сохранением контекста.
