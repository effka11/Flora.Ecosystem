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
 *
 * Модуль чистый (без react-native): снимок/гидрация тестируются юнит-тестами,
 * а диск живёт в `stores/textMeasureDiskCache` — ключи и строки замеров это
 * plaintext сообщений, поэтому на диск они уходят только зашифрованными.
 */
import { LruCache } from "@/lib/lruCache";

export type CachedBodyMeasure = {
  lineWidths: number[];
  lines: string[];
};

/**
 * Ёмкость под полный проход фонового прогрева плюс запас на историю
 * открытого треда. Один проход `startChatThreadsPrefetch` ставит замеры для
 * (12 топ-кандидатов + 40 чатов CPU-фазы) × 16 строк окна показа ≈ 830
 * записей; при ёмкости 500 хвост прохода вытеснял его же начало, и тап в
 * «уже прогретый» чат находил пустой кэш (симптом: `layout-прогрет=1/10`
 * при давно завершённом прогреве).
 */
export const BODY_MEASURE_CACHE_CAPACITY = 1200;
/**
 * Метки времени: «HH:MM» у сегодняшних сообщений, «вчера» и короткая дата у
 * остальных — на проход прогрева это сотни различных значений. Записи
 * копеечные (строка + число), а промах заставляет пузырь монтировать
 * скрытый замерный узел времени в самом окне открытия.
 */
const TIME_LABEL_CACHE_CAPACITY = 512;

let bodyMeasureCache = new LruCache<string, CachedBodyMeasure>(BODY_MEASURE_CACHE_CAPACITY);
let timeLabelWidthCache = new LruCache<string, number>(TIME_LABEL_CACHE_CAPACITY);

/**
 * Подписка на пополнение кэша. Нужна пузырю, смонтированному ДО того, как
 * offscreen-хост дописал замер его текста: без push такая ячейка рисуется по
 * не-замеренной раскладке и исправляется собственным onTextLayout уже на
 * экране (видимое схлопывание). Подписчики — только ждущие ячейки, их мало.
 */
const measureListeners = new Set<() => void>();

/**
 * Сигнал «в кэше появились замеры, которых нет на диске» — его слушает
 * персист (`lib/messageTextMeasurePersist`). Гидрация его не поднимает:
 * записывать только что прочитанное обратно незачем.
 */
let dirtyListener: (() => void) | null = null;
let hydrating = false;

function notifyMeasureListeners(): void {
  if (hydrating) return;
  for (const listener of Array.from(measureListeners)) listener();
  dirtyListener?.();
}

export function subscribeTextMeasureCache(listener: () => void): () => void {
  measureListeners.add(listener);
  return () => {
    measureListeners.delete(listener);
  };
}

export function setMessageTextMeasureDirtyListener(listener: (() => void) | null): void {
  dirtyListener = listener;
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

/** Снимок для персиста: самые свежие записи (LruCache отдаёт старые первыми). */
export type MessageTextMeasureSnapshot = {
  body: [string, CachedBodyMeasure][];
  time: [string, number][];
};

export function snapshotMessageTextMeasures(maxBodyEntries: number): MessageTextMeasureSnapshot {
  const body = bodyMeasureCache.entries();
  return {
    body: body.length > maxBodyEntries ? body.slice(body.length - maxBodyEntries) : body,
    time: timeLabelWidthCache.entries(),
  };
}

function isCachedBodyMeasure(value: unknown): value is CachedBodyMeasure {
  if (!value || typeof value !== "object") return false;
  const { lineWidths, lines } = value as Partial<CachedBodyMeasure>;
  return (
    Array.isArray(lineWidths) &&
    lineWidths.every((w) => typeof w === "number" && Number.isFinite(w)) &&
    Array.isArray(lines) &&
    lines.every((line) => typeof line === "string")
  );
}

/**
 * Гидрация снимка с диска. Формат валидируется здесь: повреждённая запись
 * пропускается молча, а не роняет старт. Порядок записей = порядок recency,
 * поэтому LRU после гидрации вытесняет ровно то, что вытеснил бы и так.
 */
export function hydrateMessageTextMeasures(payload: unknown): void {
  if (!payload || typeof payload !== "object") return;
  const { body, time } = payload as Partial<MessageTextMeasureSnapshot>;
  hydrating = true;
  try {
    if (Array.isArray(body)) {
      for (const entry of body) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const [key, measure] = entry as [unknown, unknown];
        if (typeof key !== "string" || !isCachedBodyMeasure(measure)) continue;
        bodyMeasureCache.set(key, measure);
      }
    }
    if (Array.isArray(time)) {
      for (const entry of time) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const [label, widthPx] = entry as [unknown, unknown];
        if (typeof label !== "string") continue;
        if (typeof widthPx !== "number" || !Number.isFinite(widthPx)) continue;
        timeLabelWidthCache.set(label, widthPx);
      }
    }
  } finally {
    hydrating = false;
  }
  // Один общий пуш вместо одного на запись: ждущие пузыри перечитают кэш.
  for (const listener of Array.from(measureListeners)) listener();
}

/** Logout: plaintext замеров не должен переживать выход из аккаунта. */
export function clearMessageTextMeasures(): void {
  bodyMeasureCache.clear();
  timeLabelWidthCache.clear();
}

/** Test-only: drops all cached measurements so tests don't leak state into each other. */
export function resetMessageTextMeasureCache(): void {
  bodyMeasureCache = new LruCache<string, CachedBodyMeasure>(BODY_MEASURE_CACHE_CAPACITY);
  timeLabelWidthCache = new LruCache<string, number>(TIME_LABEL_CACHE_CAPACITY);
  dirtyListener = null;
  hydrating = false;
}
