# CODECS — Flora Media Codec Policy

**Status:** Released  
**Version:** 1.0  
**Date:** 2026-06-18

---

## Overview

CODECS — политика сжатия и хранения **аудио и видео** в экосистеме FLORA. Документ фиксирует, где выполняется транскодирование (сервер vs клиент), какие кодеки и контейнеры допустимы, и как сохраняются границы модулей при E2E-сообщениях.

Спецификации по доменам:

- [`CODECS-AUDIO.md`](./CODECS-AUDIO.md) — музыка (Flora.Music) и голосовые (Flora.Messaging / Apps/Web).
- [`CODECS-VIDEO.md`](./CODECS-VIDEO.md) — видео постов (Flora.Content) и видео в чате (Flora.Messaging / Apps/Web).

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

---

## Open Questions / Future Work

- Единый probe API для лимитов длительности/битрейта на upload.
- Серверный fallback для музыки при отсутствии HE-AAC в клиенте (только для не-E2E контуров).
- AV1 в E2E-видео как единственный целевой кодек после расширения поддержки браузеров.

---

*E2E-протокол сообщений: [`docs/fscp/FSCP.md`](../fscp/FSCP.md). Платформа E2E: [`docs/fscp/e2e-security.md`](../fscp/e2e-security.md).*
