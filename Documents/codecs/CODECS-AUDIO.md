# CODECS-AUDIO — Audio Transcoding

**Status:** Released  
**Version:** 1.0  
**Date:** 2026-06-18  
**Depends on:** [`CODECS.md`](./CODECS.md)

---

## Overview

CODECS-AUDIO описывает сжатие аудио в двух контурах: **музыка** (серверный транскод, открытое хранение) и **голосовые сообщения** (клиентский транскод до E2E, opaque blob на сервере).

---

## Goals & Non-Goals

**Goals:**

- Музыка: AAC-LC 256 kbps в M4A с политикой store-if-smaller.
- Голосовые: HE-AAC v1 48 kbps mono в M4A на клиенте, совместимость с FSCP `voiceBlock`.
- Сохранить E2E: сервер не видит plaintext голосовых.

**Non-Goals:**

- Транскод видео — [`CODECS-VIDEO.md`](./CODECS-VIDEO.md).
- Стриминг-протокол (HLS/DASH) — вне v1.
- Дублирование audio pipeline в `Flora.Content` / `Flora.Messaging`.

---

## Architecture Position

| Контур | Где сжимается | Кодек | Хранение |
| --- | --- | --- | --- |
| Музыка (Flora.Music) | Сервер, при upload | AAC-LC 256 kbps в M4A | `flora_core.music_tracks`, открытые байты |
| Голосовые (Flora.Messaging) | Клиент (ffmpeg.wasm) до E2E | HE-AAC v1 48 kbps mono в M4A | `flora_core.user_message_voice_assets`, шифроблоб |

```
Flora.Social (HTTP)
  ├─→ Flora.Music — IAudioTranscoder / FfmpegMusicAudioTranscoder
  └─→ Flora.Messaging — voice-assets (opaque upload only)

Apps/Web — voiceTranscode.ts, ffmpeg.wasm → encrypt → POST voice-assets
```

---

## Музыка: store-if-smaller

Поток: `POST /api/music/tracks/self|platform` → ffprobe → при необходимости ffmpeg:

```text
ffmpeg -i <вход> -vn -map_metadata -1 \
  -c:a aac -profile:a aac_low -b:a 256k -ar 44100 \
  -movflags +faststart out.m4a
```

**Правила:**

1. FLAC, WAV, OGG, Opus, WebM-audio и др. вне MP3/M4A — транскод **обязателен** (без ffmpeg → HTTP 503).
2. MP3 / M4A с битрейтом ≤ 256 kbps — **оригинал без перекодирования** (fast path).
3. MP3 / M4A с битрейтом > 256 kbps — транскод и выбор **меньшего** файла (оригинал или M4A).

В БД возможны `content_type`: `audio/mp4` или `audio/mpeg`. Стриминг: `GET /api/music/tracks/{uuid}/audio` с `Content-Type` из строки.

Принимаемые загрузки: `audio/*`, MP3, M4A, FLAC, WAV, OGG, Opus, WebM и др. (до 70 МБ).

Серверный ffmpeg: см. [`CODECS.md` §Shared infrastructure](./CODECS.md#shared-infrastructure-ffmpeg). Нужен энкодер `aac`.

---

## Голосовые: клиентский транскод, E2E сохраняется

1. MediaRecorder → WebM/Opus (захват).
2. **ffmpeg.wasm** → HE-AAC v1 48k mono M4A (`Apps/Web/lib/voiceTranscode.ts`).
3. AES-GCM → `POST /api/auth/messages/voice-assets`.
4. FSCP `voiceBlock.contentType = audio/mp4`.

Лимит upload: **~14 MiB** на 30 минут (48 kbps + 25% overhead). Старые сообщения с Opus/WebM продолжают воспроизводиться по сохранённому `contentType`.

```text
ffmpeg -i input.webm -vn -map_metadata -1 \
  -c:a aac -profile:a aac_he -b:a 48k -ac 1 -ar 44100 \
  -movflags +faststart output.m4a
```

Статика ffmpeg.wasm: `Apps/Web/public/ffmpeg/` (копируется `npm run postinstall`). При недоступности HE-AAC в wasm-сборке клиент пробует AAC-LC 48k.

---

## Module boundaries

- Транскод музыки — только `Flora.Music` (`IAudioTranscoder`, `FfmpegMusicAudioTranscoder`).
- Транскод голоса — только `Apps/Web` (сервер не видит plaintext).
- `Flora.Content` / `Flora.Messaging` не дублируют audio pipeline.
