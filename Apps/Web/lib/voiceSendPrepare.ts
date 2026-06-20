import {
  transcodeVoiceToHeAac,
  VOICE_HE_AAC_CONTENT_TYPE,
  warmVoiceTranscodeEngine,
} from "@/lib/voiceTranscode";

export type PreparedVoiceBlob = {
  blob: Blob;
  contentType: string;
};

type VoicePrepareJob = {
  promise: Promise<PreparedVoiceBlob>;
};

const jobs = new Map<string, VoicePrepareJob>();
const inFlightSendIds = new Set<string>();

export const VOICE_TRANSCODE_TIMEOUT_MS = 20_000;

/** Подгружает ffmpeg.wasm заранее (микрофон / превью), не блокируя UI. */
export function prefetchVoiceTranscodeEngine(): void {
  warmVoiceTranscodeEngine();
}

/** Запускает HE-AAC сжатие в фоне; повторный вызов с тем же id вернёт тот же promise. */
export function scheduleVoiceTranscode(voiceId: string, input: Blob): Promise<PreparedVoiceBlob> {
  const existing = jobs.get(voiceId);
  if (existing) return existing.promise;

  const promise = transcodeVoiceToHeAac(input)
    .then((blob) => ({
      blob,
      contentType: VOICE_HE_AAC_CONTENT_TYPE,
    }))
    .catch((error) => {
      jobs.delete(voiceId);
      throw error;
    });

  jobs.set(voiceId, { promise });
  return promise;
}

/**
 * Ждёт транскод с таймаутом; при ошибке/таймауте — оригинальная запись (WebM/Opus и т.д.).
 */
export async function awaitPreparedVoiceWithFallback(
  promise: Promise<PreparedVoiceBlob>,
  fallback: { blob: Blob; contentType: string },
  timeoutMs = VOICE_TRANSCODE_TIMEOUT_MS,
): Promise<PreparedVoiceBlob> {
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("voice transcode timeout")), timeoutMs);
      }),
    ]);
  } catch (error) {
    console.warn("voice transcode fallback to original recording", error);
    const contentType = fallback.contentType.trim() || fallback.blob.type || "audio/webm";
    return { blob: fallback.blob, contentType };
  }
}

export function markVoiceSendStarted(voiceId: string): void {
  inFlightSendIds.add(voiceId);
}

export function markVoiceSendFinished(voiceId: string): void {
  inFlightSendIds.delete(voiceId);
  jobs.delete(voiceId);
}

/** Отмена фоновой подготовки, если отправка ещё не началась. */
export function cancelVoicePrepare(voiceId: string): void {
  if (inFlightSendIds.has(voiceId)) return;
  jobs.delete(voiceId);
}
