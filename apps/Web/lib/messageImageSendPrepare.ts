import { prepareMessageImage, type PreparedMessageImage } from "@/lib/messageImages";

type ImagePrepareJob = {
  promise: Promise<PreparedMessageImage>;
};

const jobs = new Map<string, ImagePrepareJob>();
const inFlightSendIds = new Set<string>();
/**
 * Очередь из одного слота: каждый prepare декодирует и рисует крупное фото.
 * Параллельный запуск 10 штук — пик памяти на вкладку и длинный жёсткий
 * блок main thread; готовим по одному, порядок выбора сохраняется.
 */
let queueTail: Promise<unknown> = Promise.resolve();

/** Запускает сжатие фото в фоне; повторный вызов с тем же id вернёт тот же promise. */
export function scheduleMessageImagePrepare(imageId: string, input: File): Promise<PreparedMessageImage> {
  const existing = jobs.get(imageId);
  if (existing) return existing.promise;

  const promise = queueTail.then(() => prepareMessageImage(input));
  queueTail = promise.catch(() => undefined);
  const job: ImagePrepareJob = { promise };
  jobs.set(imageId, job);
  promise.catch(() => {
    if (jobs.get(imageId) === job) jobs.delete(imageId);
  });
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
