# CODECS — Flora Media Codec Policy

**Status:** Released  
**Version:** 1.3
**Date:** 2026-07-21

---

## Overview

CODECS — политика сжатия и хранения медиа в экосистеме FLORA. Документ фиксирует, где выполняется транскодирование (сервер vs клиент), какие кодеки и контейнеры допустимы, и как сохраняются границы модулей при E2E-сообщениях.

Спецификации по доменам (сторонние кодеки, текущий прод):

- [`CODECS-AUDIO.md`](./CODECS-AUDIO.md) — музыка (Flora.Music) и голосовые (Flora.Messaging / Apps/Web).
- [`CODECS-VIDEO.md`](./CODECS-VIDEO.md) — видео постов (Flora.Content) и видео в чате (Flora.Messaging / Apps/Web).
- [`CODECS-IMAGE.md`](./CODECS-IMAGE.md) — фото постов/аватаров и E2E-фото (FRC-I + WebP fallback).

Нативные кодеки Flora (семейство **FRC**, Flora Relativistic Codec, разработка):

- [`FRC-I.md`](./FRC-I.md) — фото (FRC-I), замороженный битстрим v10
  (ранее FMC/FIC; decoder compatibility v1..v10).
- [`FRC-A.md`](./FRC-A.md) — аудио (FRC-A), битстрим v0 (draft).
- [`FRC-V.md`](./FRC-V.md) — видео (FRC-V), битстрим кадра **v2**; контейнерный FourCC/magic — `FRV1` / `\x8F FRV`.

Этот документ нормативен: реализация пайплайнов **обязана** соответствовать описанным здесь правилам и компонентным спекам.

---

## Goals & Non-Goals

**Goals:**

- Единая модель «два контура доверия»: открытые медиа постов/музыки vs E2E-блобы в сообщениях.
- Предсказуемые кодеки, лимиты размера и fallback при недоступности ffmpeg.
- Явное владение данными и транскодом на уровне модулей.

**Non-Goals:**

- Спецификация FSCP wire-format — [`Documents/fscp/FSCP.md`](../fscp/FSCP.md).
- Выбор UI плеера и дизайн контролов — зона Apps/Web.
  Фото-пайплайн (FRC-I + WebP) — [`CODECS-IMAGE.md`](./CODECS-IMAGE.md).

---

## Architecture Position

Медиа-пайплайны живут в **Modules**; HTTP — в **Products/Flora.Social**; клиентское сжатие E2E — в **Apps/Web**.

```
Apps/Web (ffmpeg.wasm, MediaRecorder, canvas capture)
  └─→ Flora.API
        └─→ Flora.Social (composition)
              ├─→ Flora.Content   — post videos (server transcode)
              ├─→ Flora.Music     — music tracks (server transcode)
              └─→ Flora.Messaging — voice/video assets (opaque ciphertext blobs)
```

### Два контура доверия

| Контур | Где сжимается | Хранение | Примеры |
| --- | --- | --- | --- |
| **Открытый** | Сервер (ffmpeg) | Plain bytes в БД / object storage | Посты ленты, музыка |
| **E2E** | Клиент до шифрования | Шифроблоб; сервер не видит plaintext | Голосовые, видео в FSCP |

Сервер **никогда** не расшифровывает и не перекодирует E2E-медиа. Клиент **не** полагается на серверный ffmpeg для сообщений.

---

## Principles

1. **Store-if-smaller** (музыка): перекодировать только когда результат меньше оригинала или формат вне allow-list.
2. **Client-first для E2E**: сжатие до AES-GCM / FSCP envelope на устройстве отправителя.
3. **Graceful degradation**: недоступный ffmpeg на сервере → HTTP 503 для затронутого upload, остальная система работает.
4. **Обратная совместимость**: старые `contentType` (Opus/WebM и т.д.) продолжают воспроизводиться по метаданным сообщения.

---

## Shared infrastructure: ffmpeg

Серверные контуры (видео постов, музыка) используют **ffmpeg** и **ffprobe** из конфигурации `Media` в `Flora.API/appsettings.json` (`MediaTranscodingOptions`):

```json
"Media": {
  "FfmpegPath": "ffmpeg",
  "FfprobePath": null
}
```

- `FfmpegPath` — имя в `PATH` либо абсолютный путь, например `C:\\ffmpeg\\bin\\ffmpeg.exe`.
- `FfprobePath` — необязателен: по умолчанию `ffprobe` из каталога `FfmpegPath` или из `PATH`.

### Установка ffmpeg (Windows)

Полная сборка с **libsvtav1** (видео постов) и **aac** (музыка):

```powershell
winget install Gyan.FFmpeg
# или
choco install ffmpeg-full
```

Проверка энкодеров:

```powershell
ffmpeg -hide_banner -encoders | Select-String "svtav1| aac "
```

Ожидаются строки `libsvtav1` и `aac`. Если `libsvtav1` отсутствует — полная сборка с https://www.gyan.dev/ffmpeg/builds/ (`ffmpeg-release-full`).

Клиентский контур сообщений от серверного ffmpeg **не зависит** (сжатие в браузере).

---

## Component index

| Компонент | Модуль | Спека |
| --- | --- | --- |
| CODECS-AUDIO | Flora.Music, Flora.Messaging | [`CODECS-AUDIO.md`](./CODECS-AUDIO.md) |
| CODECS-VIDEO | Flora.Content, Flora.Messaging | [`CODECS-VIDEO.md`](./CODECS-VIDEO.md) |
| CODECS-IMAGE | Flora.Content, Flora.Users, Flora.Messaging | [`CODECS-IMAGE.md`](./CODECS-IMAGE.md) |
| FRC-I (фото, FRC) | библиотека `Products/FRC/crates/frc-i` | [`FRC-I.md`](./FRC-I.md) |
| FRC-A (аудио, FRC) | библиотека `Products/FRC/crates/frc-a-*` | [`FRC-A.md`](./FRC-A.md) |
| FRC-V (видео, FRC) | библиотека `Products/FRC/crates/frc-v*` | [`FRC-V.md`](./FRC-V.md) |

---

## FRC — Flora Relativistic Codec (нативное семейство)

Собственные кодеки Flora на Rust. Три параллельных трека: **FRC-I** (фото),
**FRC-V** (видео), **FRC-A** (аудио). Общие конвенции семейства — здесь, чтобы
треки не конфликтовали.

### Бренд ↔ wire

| Бренд | Magic ASCII (после `0x8F`) | FourCC / container | Файл |
| --- | --- | --- | --- |
| FRC-A | `FRA` (резерв под нативный `.fra`) | dev-контейнер `FRAS` (ASCII) | `.fras` (dev) / `.fra` (резерв) |
| FRC-I | `FRI` | — | `.fri` |
| FRC-V | `FRV` | IVF FourCC `FRV1` | `.frv` |

Бренд пишется с дефисом (`FRC-I`); wire — три ASCII-байта без дефиса (`FRI`).

### Реестр сигнатур и идентификаторов

Пространство magic `0x8F + ASCII-имя` (первый байт не-ASCII — защита от порчи
текстовым режимом) закреплено за нативными контейнерами FRC. Треки видео/аудио
на этапе разработки используют стандартные / временные контейнеры — их
идентификаторы тоже фиксируются здесь:

| Кодек | Сигнатура | Расширение | MIME (предложение) | Статус |
| --- | --- | --- | --- | --- |
| FRC-I | magic `8F 46 52 49` (`\x8F FRI`) | `.fri` | `image/x-flora-frc-i` | frozen v10 (asymmetric per-root AQ; wire/decode v9); S2 −0.64%/BA −0.34% vs v9, encode speed unchanged ([FRC-I.md](./FRC-I.md)) |
| FRC-V | FourCC `FRV1` в IVF (dev); magic `8F 46 52 56` (`\x8F FRV`) в `.frv` | `.frv`, `.ivf` | `video/x-flora-frc-v` | кадр `BITSTREAM_VERSION=2`; контейнер FRC-V |
| FRC-A | **as-built:** ASCII `FRAS` (4 B) в файловом контейнере инструментов; **резерв:** magic `8F 46 52 41` (`\x8F FRA`) под нативный `.fra` | `.fras` (dev), `.fra` (резерв) | `audio/x-flora-frc-a` | битстрим v0 |

Декодеры **не** принимают устаревшие идентификаторы FMC (`\x8F FIC`/`FVC`/`FAC`, FourCC `FVC1`, контейнер `FACS`).

### Конвенции треков

- Размещение: все FRC-треки — `Products/FRC/crates/*` (members общего Cargo
  workspace). Модули бэкенда используют кодеки только через свой Infrastructure-слой.
- Ядро кодека: **чистый Rust без C-зависимостей**, `unsafe` запрещён. Мотив:
  аудируемость, WASM-декодеры для клиентов, детерминизм тест-векторов.
- Детерминизм: никакой платформозависимой математики (libm, FMA); константы
  преобразований фиксируются литералами/таблицами в коде и спеке.
- Декодер обязан быть безопасным на недоверенном вводе: без паник, лимиты
  до аллокаций, строгая валидация структуры (см. FRC-I.md §9 как образец).
- Замороженные форматы фиксируются golden-векторами в `tests/data/`
  соответствующего crate (регенерация — `FRC_I_UPDATE_GOLDEN=1` /
  `FRC_V_UPDATE_GOLDEN=1`); до заморозки (v0.x) битстримы могут меняться без
  совместимости.
- Переиспользование: энтропийное ядро FRC-I (rANS + hybrid-uint + битовые
  потоки) экспортировано как `frc_i::entropy` — кандидат для
  intra-кадров FRC-V при объединении workspace'ов.

### Позиция в продукте

FRC-кодеки — инфраструктурные библиотеки без бизнес-логики. Ввод в прод —
отдельные миграционные задачи модулей-владельцев (Content/Users/Music/Messaging)
с обратной совместимостью для старых клиентов; модель «двух контуров доверия»
(см. выше) не меняется: E2E-медиа кодируются на клиенте до шифрования.

---

## Open Questions / Future Work

- Единый probe API для лимитов длительности/битрейта на upload.
- Серверный fallback для музыки при отсутствии HE-AAC в клиенте (только для не-E2E контуров).
- AV1 в E2E-видео как единственный целевой кодек после расширения поддержки браузеров.

---

*E2E-протокол сообщений: [`Documents/fscp/FSCP.md`](../fscp/FSCP.md). Платформа E2E: [`Documents/fscp/e2e-security.md`](../fscp/e2e-security.md).*
