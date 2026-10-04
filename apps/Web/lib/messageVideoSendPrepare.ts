import { prepareMessageVideo, type PreparedMessageVideo } from "@/lib/messageVideos";

type VideoPrepareJob = {
  promise: Promise<PreparedMessageVideo>;
};

const jobs = new Map<string, VideoPrepareJob>();
const inFlightSendIds = new Set<string>();

/** Запускает сжатие видео в фоне; повторный вызов с тем же id вернёт тот же promise. */
export function scheduleMessageVideoPrepare(videoId: string, input: File): Promise<PreparedMessageVideo> {
  const existing = jobs.get(videoId);
  if (existing) return existing.promise;

  const promise = prepareMessageVideo(input).catch((error) => {
    jobs.delete(videoId);
    throw error;
  });

  jobs.set(videoId, { promise });
  return promise;
}

export function markMessageVideoSendStarted(videoId: string): void {
  inFlightSendIds.add(videoId);
}

export function markMessageVideoSendFinished(videoId: string): void {
  inFlightSendIds.delete(videoId);
  jobs.delete(videoId);
}

/** Отмена фоновой подготовки, если отправка ещё не началась. */
export function cancelMessageVideoPrepare(videoId: string): void {
  if (inFlightSendIds.has(videoId)) return;
  jobs.delete(videoId);
}
