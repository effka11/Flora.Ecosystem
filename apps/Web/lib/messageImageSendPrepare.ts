import { prepareMessageImage, type PreparedMessageImage } from "@/lib/messageImages";

type ImagePrepareJob = {
  promise: Promise<PreparedMessageImage>;
};

const jobs = new Map<string, ImagePrepareJob>();
const inFlightSendIds = new Set<string>();

/** Запускает сжатие фото в фоне; повторный вызов с тем же id вернёт тот же promise. */
export function scheduleMessageImagePrepare(imageId: string, input: File): Promise<PreparedMessageImage> {
  const existing = jobs.get(imageId);
  if (existing) return existing.promise;

  const promise = prepareMessageImage(input).catch((error) => {
    jobs.delete(imageId);
    throw error;
  });

  jobs.set(imageId, { promise });
  return promise;
}

export function markMessageImageSendStarted(imageId: string): void {
  inFlightSendIds.add(imageId);
}

export function markMessageImageSendFinished(imageId: string): void {
  inFlightSendIds.delete(imageId);
  jobs.delete(imageId);
}

/** Отмена фоновой подготовки, если отправка ещё не началась. */
export function cancelMessageImagePrepare(imageId: string): void {
  if (inFlightSendIds.has(imageId)) return;
  jobs.delete(imageId);
}
