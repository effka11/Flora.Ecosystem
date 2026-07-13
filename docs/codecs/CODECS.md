# CODECS — Flora Media Codec Policy

**Status:** Released  
**Version:** 1.1  
**Date:** 2026-07-13

---

## Overview

CODECS — политика сжатия и хранения медиа в экосистеме FLORA. Документ фиксирует, где выполняется транскодирование (сервер vs клиент), какие кодеки и контейнеры допустимы, и как сохраняются границы модулей при E2E-сообщениях.

Спецификации по доменам (сторонние кодеки, текущий прод):

- [`CODECS-AUDIO.md`](./CODECS-AUDIO.md) — музыка (Flora.Music) и голосовые (Flora.Messaging / Apps/Web).
- [`CODECS-VIDEO.md`](./CODECS-VIDEO.md) — видео постов (Flora.Content) и видео в чате (Flora.Messaging / Apps/Web).

Нативные кодеки Flora (семейство **FMC**, разработка):

- [`FIC.md`](./FIC.md) — фото (Flora Image Codec), битстрим **v3** (v1/v2 заморожены, читаются всегда).
- [`FAC.md`](./FAC.md) — аудио (Flora Audio Codec), битстрим v0 (draft).
- [`FVC.md`](./FVC.md) — видео (Flora Video Codec), битстрим FVC1 **v2** (Released v1).

Этот документ нормативен: реализация пайплайнов **обязана** соответствовать описанным здесь правилам и компонентным спекам.

---

## Goals & Non-Goals

**Goals:**

- Единая модель «два контура доверия»: открытые медиа постов/музыки vs E2E-блобы в сообщениях.
- Предсказуемые кодеки, лимиты размера и fallback при недоступности ffmpeg.
- Явное владение данными и транскодом на уровне модулей.

**Non-Goals:**

- Спецификация FSCP wire-format — [`docs/fscp/FSCP.md`](../fscp/FSCP.md).
- Фото/AVIF постов (отдельный пайплайн Flora.Content).
- Выбор UI плеера и дизайн контролов — зона Apps/Web.

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
| FIC (фото, FMC) | библиотека `Backend/crates/media/` | [`FIC.md`](./FIC.md) |
| FAC (аудио, FMC) | библиотека `Codecs/audio/` | [`FAC.md`](./FAC.md) |
| FVC (видео, FMC) | библиотека `Codecs/flora-video/` | [`FVC.md`](./FVC.md) |

---

## FMC — Flora Media Codecs (нативное семейство)

Собственные кодеки Flora на Rust. Три параллельных трека: **FIC** (фото),
**FVC** (видео), **FAC** (аудио). Общие конвенции семейства — здесь, чтобы
треки не конфликтовали.

### Реестр сигнатур и идентификаторов

Пространство magic `0x8F + ASCII-имя` (первый байт не-ASCII — защита от порчи
текстовым режимом) закреплено за нативными контейнерами FMC. Треки видео/аудио
на этапе разработки используют стандартные dev-контейнеры — их идентификаторы
тоже фиксируются здесь:

| Кодек | Сигнатура | Расширение | MIME (предложение) | Статус |
| --- | --- | --- | --- | --- |
| FIC | magic `8F 46 49 43` (`\x8F FIC`) | `.fic` | `image/x-flora-fic` | битстрим **v3** (v1/v2 заморожены) |
| FVC | FourCC `FVC1` в IVF (dev); magic `8F 46 56 43` в `.fvc` | `.fvc`, `.ivf` | `video/x-flora-fvc` | битстрим **v2** (Released) |
| FAC | контейнер `FACS` (dev); magic `8F 46 41 43` — резерв | `.facs` (dev), `.fac` (резерв) | `audio/x-flora-fac` | битстрим v0 |

### Конвенции треков

- Размещение: FIC — `Backend/crates/media/*` (категория `media` валидатора
  границ: видит только другие media-crates); FVC — `Codecs/flora-video`,
  FAC — `Codecs/audio` (отдельные cargo-workspace до стабилизации).
  Модули бэкенда используют кодеки только через свой Infrastructure-слой.
- Ядро кодека: **чистый Rust без C-зависимостей**, `unsafe` запрещён. Мотив:
  аудируемость, WASM-декодеры для клиентов, детерминизм тест-векторов.
- Детерминизм: никакой платформозависимой математики (libm, FMA); константы
  преобразований фиксируются литералами/таблицами в коде и спеке.
- Декодер обязан быть безопасным на недоверенном вводе: без паник, лимиты
  до аллокаций, строгая валидация структуры (см. FIC.md §9 как образец).
- Замороженные форматы фиксируются golden-векторами в `tests/data/`
  соответствующего crate (регенерация — паттерн `FIC_UPDATE_GOLDEN=1`);
  до заморозки (v0.x) битстримы могут меняться без совместимости.
- Переиспользование: энтропийное ядро FIC (rANS + hybrid-uint + битовые
  потоки) экспортировано как `flora_image_codec::entropy` — кандидат для
  intra-кадров FVC при объединении workspace'ов.

### Позиция в продукте

FMC-кодеки — инфраструктурные библиотеки без бизнес-логики. Ввод в прод —
отдельные миграционные задачи модулей-владельцев (Content/Users/Music/Messaging)
с обратной совместимостью для старых клиентов; модель «двух контуров доверия»
(см. выше) не меняется: E2E-медиа кодируются на клиенте до шифрования.

---

## Open Questions / Future Work

- Единый probe API для лимитов длительности/битрейта на upload.
- Серверный fallback для музыки при отсутствии HE-AAC в клиенте (только для не-E2E контуров).
- AV1 в E2E-видео как единственный целевой кодек после расширения поддержки браузеров.

---

*E2E-протокол сообщений: [`docs/fscp/FSCP.md`](../fscp/FSCP.md). Платформа E2E: [`docs/fscp/e2e-security.md`](../fscp/e2e-security.md).*
