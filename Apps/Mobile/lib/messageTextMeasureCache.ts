/**
 * Bounded, recycling-safe text-measurement memory for chat text bubbles.
 *
 * `ChatMessageBubbleTextBody` measures the body and the time label via
 * hidden `onTextLayout` slots before it knows whether the time fits inline
 * or has to drop below the text. Without this cache that first measurement
 * is lost on every remount: a FlashList cell recycle or a re-entry into the
 * chat re-renders `placement = "inline"` for a frame, then jumps to the
 * real layout once `onTextLayout` fires again. Keyed by the exact inputs
 * `resolveBubbleMetaLayout` depends on, so a cache hit is always valid for
 * the text currently being rendered.
 */
import { LruCache } from "@/lib/lruCache";

export type CachedBodyMeasure = {
  lineWidths: number[];
  lines: string[];
};

const BODY_CACHE_CAPACITY = 500;
const TIME_LABEL_CACHE_CAPACITY = 64;

let bodyMeasureCache = new LruCache<string, CachedBodyMeasure>(BODY_CACHE_CAPACITY);
let timeLabelWidthCache = new LruCache<string, number>(TIME_LABEL_CACHE_CAPACITY);

/**
 * Подписка на пополнение кэша. Нужна пузырю, смонтированному ДО того, как
 * offscreen-хост дописал замер его текста: без push такая ячейка рисуется по
 * не-замеренной раскладке и исправляется собственным onTextLayout уже на
 * экране (видимое схлопывание). Подписчики — только ждущие ячейки, их мало.
 */
const measureListeners = new Set<() => void>();

function notifyMeasureListeners(): void {
  for (const listener of Array.from(measureListeners)) listener();
}

export function subscribeTextMeasureCache(listener: () => void): () => void {
  measureListeners.add(listener);
  return () => {
    measureListeners.delete(listener);
  };
}

function bodyCacheKey(body: string, maxInnerWidthPx: number): string {
  return `${maxInnerWidthPx}|${body}`;
}

export function getCachedBodyMeasure(
  body: string,
  maxInnerWidthPx: number,
): CachedBodyMeasure | null {
  return bodyMeasureCache.get(bodyCacheKey(body, maxInnerWidthPx)) ?? null;
}

export function setCachedBodyMeasure(
  body: string,
  maxInnerWidthPx: number,
  measure: CachedBodyMeasure,
): void {
  bodyMeasureCache.set(bodyCacheKey(body, maxInnerWidthPx), measure);
  notifyMeasureListeners();
}

export function getCachedTimeLabelWidth(timeLabel: string): number | null {
  return timeLabelWidthCache.get(timeLabel) ?? null;
}

export function setCachedTimeLabelWidth(timeLabel: string, widthPx: number): void {
  timeLabelWidthCache.set(timeLabel, widthPx);
  notifyMeasureListeners();
}

/** Test-only: drops all cached measurements so tests don't leak state into each other. */
export function resetMessageTextMeasureCache(): void {
  bodyMeasureCache = new LruCache<string, CachedBodyMeasure>(BODY_CACHE_CAPACITY);
  timeLabelWidthCache = new LruCache<string, number>(TIME_LABEL_CACHE_CAPACITY);
}
