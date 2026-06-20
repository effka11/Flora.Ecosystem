/**
 * Видео в сообщениях (E2E): валидация и клиентское сжатие.
 * Сервер видит только шифроблоб, поэтому транскодирование — на клиенте:
 * canvas.captureStream + MediaRecorder (AV1 → VP9 → VP8 по поддержке браузера).
 * MP4/MOV всегда перекодируются; WebM ≤ 25 МБ уходит как есть.
 */

export const MAX_MESSAGE_VIDEOS = 1;
/** Лимит исходника до сжатия. */
export const MAX_MESSAGE_VIDEO_SOURCE_BYTES = 100 * 1024 * 1024;
/** До этого размера отправляем оригинал — после AES-GCM влезает в серверный лимит 36 МиБ. */
export const DIRECT_SEND_VIDEO_BYTES = 25 * 1024 * 1024;
export const MAX_MESSAGE_VIDEO_DURATION_MS = 5 * 60 * 1000;
export const MESSAGE_VIDEO_ACCEPT = "video/mp4,video/quicktime,video/webm";

/** Длинная сторона перекодированного видео. */
const TRANSCODE_MAX_LONG_SIDE = 1280;
const TRANSCODE_VIDEO_BPS = 1_500_000;
const TRANSCODE_AUDIO_BPS = 96_000;

const ALLOWED_MESSAGE_VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);

/** Кандидаты MediaRecorder в порядке качества сжатия. */
const RECORDER_MIME_CANDIDATES = [
  'video/webm;codecs="av01,opus"',
  "video/webm;codecs=av01",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8,opus",
  "video/webm",
] as const;

export function extensionForVideoContentType(contentType: string): string {
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base === "video/webm") return "webm";
  if (base === "video/quicktime") return "mov";
  if (base === "video/mp4") return "mp4";
  return "webm";
}

/** Программное скачивание blob:-URL (ПКМ «Сохранить видео» в Chrome часто недоступен). */
export function triggerVideoBlobDownload(
  objectUrl: string,
  contentType = "video/webm",
  prefix = "flora-video",
): void {
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = `${prefix}-${Date.now()}.${extensionForVideoContentType(contentType)}`;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export type PreparedMessageVideo = {
  blob: Blob;
  contentType: string;
  durationMs: number;
  width: number;
  height: number;
  /** true — было перекодировано на клиенте. */
  transcoded: boolean;
};

function inferMessageVideoMime(file: File): string | null {
  const type = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (ALLOWED_MESSAGE_VIDEO_TYPES.has(type)) return type;
  const name = file.name.trim().toLowerCase();
  if (name.endsWith(".mp4") || name.endsWith(".m4v")) return "video/mp4";
  if (name.endsWith(".mov")) return "video/quicktime";
  if (name.endsWith(".webm")) return "video/webm";
  return null;
}

export function messageVideoAttachError(file: File): string | null {
  if (!inferMessageVideoMime(file)) return "Поддерживаются MP4, MOV и WebM.";
  if (file.size <= 0) return "Файл видео пуст.";
  if (file.size > MAX_MESSAGE_VIDEO_SOURCE_BYTES) return "Видео до 100 МБ.";
  return null;
}

type VideoMetadata = { durationMs: number; width: number; height: number };

function loadVideoMetadata(url: string): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.muted = true;
    probe.onloadedmetadata = () => {
      resolve({
        durationMs: Number.isFinite(probe.duration) ? Math.round(probe.duration * 1000) : 0,
        width: probe.videoWidth,
        height: probe.videoHeight,
      });
      probe.src = "";
    };
    probe.onerror = () => reject(new Error("Не удалось прочитать видео."));
    probe.src = url;
  });
}

function pickRecorderMime(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const candidate of RECORDER_MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return null;
}

/** MP4/MOV почти всегда H.264 — перекодируем в AV1 (WebM), даже если файл < 25 МБ. */
function needsClientTranscode(mime: string, fileSize: number): boolean {
  if (fileSize > DIRECT_SEND_VIDEO_BYTES) return true;
  return mime === "video/mp4" || mime === "video/quicktime";
}

/** Чётные целевые размеры с длинной стороной ≤ TRANSCODE_MAX_LONG_SIDE, без апскейла. */
function targetDimensions(width: number, height: number): { width: number; height: number } {
  const longSide = Math.max(width, height);
  const factor = Math.min(1, TRANSCODE_MAX_LONG_SIDE / longSide);
  const w = Math.max(2, Math.floor((width * factor) / 2) * 2);
  const h = Math.max(2, Math.floor((height * factor) / 2) * 2);
  return { width: w, height: h };
}

/**
 * Перекодирование в реальном времени: видео рисуется на canvas (captureStream),
 * звук уводится в MediaStreamAudioDestinationNode (на колонки не выводится).
 */
async function transcodeVideo(url: string, meta: VideoMetadata, mimeType: string): Promise<Blob> {
  const video = document.createElement("video");
  video.src = url;
  video.preload = "auto";
  video.playsInline = true;

  await new Promise<void>((resolve, reject) => {
    video.oncanplay = () => resolve();
    video.onerror = () => reject(new Error("Не удалось декодировать видео."));
  });

  const dims = targetDimensions(meta.width, meta.height);
  const canvas = document.createElement("canvas");
  canvas.width = dims.width;
  canvas.height = dims.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D недоступен.");

  const canvasStream = canvas.captureStream();
  const audioCtx = new AudioContext();
  const sourceNode = audioCtx.createMediaElementSource(video);
  const audioDest = audioCtx.createMediaStreamDestination();
  sourceNode.connect(audioDest);

  const tracks = [...canvasStream.getVideoTracks(), ...audioDest.stream.getAudioTracks()];
  const stream = new MediaStream(tracks);
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: TRANSCODE_VIDEO_BPS,
    audioBitsPerSecond: TRANSCODE_AUDIO_BPS,
  });

  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  let rafId = 0;
  const drawFrame = () => {
    ctx.drawImage(video, 0, 0, dims.width, dims.height);
    rafId = requestAnimationFrame(drawFrame);
  };

  try {
    const done = new Promise<void>((resolve, reject) => {
      recorder.onstop = () => resolve();
      recorder.onerror = () => reject(new Error("Сбой кодирования видео."));
      video.onended = () => {
        if (recorder.state !== "inactive") recorder.stop();
      };
    });

    recorder.start(1000);
    drawFrame();
    await video.play();
    await done;
  } finally {
    cancelAnimationFrame(rafId);
    video.pause();
    video.src = "";
    for (const track of tracks) track.stop();
    void audioCtx.close().catch(() => {});
  }

  const baseType = mimeType.split(";")[0] ?? "video/webm";
  return new Blob(chunks, { type: baseType });
}

/**
 * Готовит видео к E2E-отправке: метаданные + при необходимости клиентское сжатие.
 * Бросает Error с понятным русским сообщением при невозможности отправки.
 */
export async function prepareMessageVideo(file: File): Promise<PreparedMessageVideo> {
  const attachError = messageVideoAttachError(file);
  if (attachError) throw new Error(attachError);

  const mime = inferMessageVideoMime(file)!;
  const url = URL.createObjectURL(file);
  try {
    const meta = await loadVideoMetadata(url);
    if (meta.durationMs > MAX_MESSAGE_VIDEO_DURATION_MS) {
      throw new Error("Видео в сообщениях — до 5 минут.");
    }

    if (!needsClientTranscode(mime, file.size)) {
      return {
        blob: file,
        contentType: mime,
        durationMs: meta.durationMs,
        width: meta.width,
        height: meta.height,
        transcoded: false,
      };
    }

    const recorderMime = pickRecorderMime();
    if (!recorderMime) {
      if (file.size <= DIRECT_SEND_VIDEO_BYTES) {
        return {
          blob: file,
          contentType: mime,
          durationMs: meta.durationMs,
          width: meta.width,
          height: meta.height,
          transcoded: false,
        };
      }
      throw new Error("Браузер не поддерживает сжатие видео — уменьшите файл до 25 МБ.");
    }

    const blob = await transcodeVideo(url, meta, recorderMime);
    if (blob.size <= 0) throw new Error("Сжатие видео не удалось.");
    if (blob.size > DIRECT_SEND_VIDEO_BYTES) {
      throw new Error("Видео слишком большое даже после сжатия — укоротите ролик.");
    }

    const dims = targetDimensions(meta.width, meta.height);
    const contentType = blob.type || recorderMime.split(";")[0] || "video/webm";
    return {
      blob,
      contentType,
      durationMs: meta.durationMs,
      width: dims.width,
      height: dims.height,
      transcoded: true,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}
