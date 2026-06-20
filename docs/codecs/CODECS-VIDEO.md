# CODECS-VIDEO — Video Transcoding & Player

**Status:** Released  
**Version:** 1.0  
**Date:** 2026-06-18  
**Depends on:** [`CODECS.md`](./CODECS.md)

---

## Overview

CODECS-VIDEO описывает сжатие видео в двух контурах: **посты ленты** (серверный AV1/SVT-AV1) и **видео в сообщениях** (клиентский WebM до E2E). Включает контракт плеера `FloraVideoPlayer`.

---

## Goals & Non-Goals

**Goals:**

- Лента: AV1 (libsvtav1) в MP4, AVIF-постер, фоновый воркер и range-стриминг.
- Сообщения: клиентское сжатие AV1/VP9/VP8 в WebM, шифроблоб на сервере.
- Единый UI-плеер с проверкой поддержки AV1 в браузере.

**Non-Goals:**

- Аудио-кодеки — [`CODECS-AUDIO.md`](./CODECS-AUDIO.md).
- Live-стриминг / WebRTC calls.
- Серверный транскод E2E-видео (запрещён моделью доверия).

---

## Architecture Position

| Контур | Где сжимается | Кодек | Хранение |
| --- | --- | --- | --- |
| Посты ленты (Flora.Content) | Сервер, фоновый воркер | AV1 (SVT-AV1) в MP4 + AVIF-постер | `flora_core.post_videos`, открытые байты |
| Сообщения (Flora.Messaging) | Клиент (браузер) | AV1/VP9/VP8 в WebM | `flora_core.user_message_video_assets`, шифроблоб (E2E, AES-GCM) |

```
Flora.Social
  ├─→ Flora.Content — IVideoTranscoder, BackgroundService, post_videos
  └─→ Flora.Messaging — video-assets (opaque)

Apps/Web — messageVideos.ts, FloraVideoPlayer.tsx
```

---

## Лента: серверный транскодинг

Поток: `POST /api/auth/posts/{postUuid}/video` (multipart, ≤ 200 МБ, ≤ 10 минут, mp4/mov/webm/mkv) → temp-файл → `Channel`-очередь → `BackgroundService` запускает ffmpeg:

```text
ffmpeg -i <вход> -map_metadata -1 \
  -vf "scale до 1920 по длинной стороне, чётные размеры" \
  -c:v libsvtav1 -preset 7 -crf 32 -pix_fmt yuv420p \
  -c:a libopus -b:a 96k -movflags +faststart out.mp4
```

Постер — первый кадр, пережатый в AVIF тем же пайплайном качества, что и фото постов. Статусы строки `post_videos`: `Processing → Ready | Failed`; до готовности фронтенд показывает плашку «Видео обрабатывается…» и поллит `GET /api/auth/posts/{postUuid}/video/status`.

Раздача: `GET /api/auth/posts/videos/{uuid}` с `enableRangeProcessing: true`; `GET /api/auth/posts/videos/{uuid}/poster` — постер.

Серверный ffmpeg: см. [`CODECS.md` §Shared infrastructure](./CODECS.md#shared-infrastructure-ffmpeg). Требуется `libsvtav1`; иначе upload → HTTP 503.

---

## Сообщения: клиентское сжатие, E2E сохраняется

Сервер не видит plaintext. Перекодирование в браузере (`Apps/Web/lib/messageVideos.ts`):

- исходник ≤ 100 МБ и ≤ 5 минут (mp4/mov/webm);
- файлы ≤ 25 МБ уходят как есть;
- крупнее — realtime-перекодирование: `<canvas>.captureStream()` + звук через `MediaStreamAudioDestinationNode` → `MediaRecorder` (`av01` → `vp9` → `vp8`, 720p-класс, ~1.5 Мбит/с);
- затем `encryptVoiceBlob` (AES-GCM), `POST /api/messaging/video-assets` (шифроблоб ≤ 36 МиБ), блок `kind: "video"` в FSCP-конверте с ключом/nonce внутри plaintext.

Получатель: `GET /api/messaging/video-assets/{uuid}` → расшифровка на клиенте → object URL → плеер.

---

## Плеер

`Apps/Web/app/_shared/FloraVideoPlayer.tsx` — обёртка над `<video playsInline preload="metadata">` с контролами Flora: play/pause, прогресс с буфером и перемоткой (клик/драг), время, mute, fullscreen; `compact` — режим для пузыря чата.

Поддержка AV1: `canPlayType('video/mp4; codecs="av01.0.08M.08"')`. При отсутствии поддержки — подсказка «Браузер не поддерживает AV1».

---

## Module boundaries

- `Flora.Content` владеет `post_videos`; транскодер — `IVideoTranscoder` (Application), ffmpeg — Infrastructure.
- `Flora.Messaging` владеет `user_message_video_assets`; для сервера это opaque-байты.
- `Products/Flora.Social` — только HTTP-эндпоинты и композиция, без бизнес-логики транскода.
