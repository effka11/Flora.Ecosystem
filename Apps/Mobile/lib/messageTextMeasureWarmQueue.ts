/**
 * Очередь offscreen-замеров текста пузырей — Flora-аналог `generateLayout`
 * из Telegram: раскладка сообщения считается ДО открытия чата.
 *
 * Зачем: `ChatMessageBubbleTextBody` не знает, встаёт ли время в хвост
 * последней строки, пока не придёт `onTextLayout`. Пока замера нет, пузырь
 * рисуется как однострочный, а на следующем кадре перескакивает в реальную
 * раскладку — это и есть «пузыри дёргаются, вставая на место». Плюс сам замер
 * (двойной рендер тела + setState на пузырь) падает в окно открытия чата.
 *
 * Поэтому заявки на замер ставит фоновый прогрев тредов, а невидимый хост
 * исполняет их пачками в паузы. К моменту тапа кэш замеров прогрет, и первый
 * кадр ленты сразу финальный.
 *
 * Модуль чистый (без react-native): очередь, дедуп и порядок тестируются
 * юнит-тестами, RN-часть — только рендер узлов в хосте.
 */

export type TextMeasureRequest = {
  body: string;
  maxInnerWidthPx: number;
  timeLabel: string;
};

/** Дедуп-ключ пары «тело + ширина»; метка времени дедуплицируется отдельно. */
function bodyKey(body: string, maxInnerWidthPx: number): string {
  return `${maxInnerWidthPx}|${body}`;
}

export type MeasureWarmQueueDeps = {
  /** Замер уже в кэше — заявка не нужна. */
  hasBodyMeasure: (body: string, maxInnerWidthPx: number) => boolean;
  hasTimeLabelWidth: (timeLabel: string) => boolean;
};

export type MeasureWarmQueue = {
  /** Ставит в очередь то, чего нет ни в кэше, ни уже в очереди. */
  enqueue: (requests: readonly TextMeasureRequest[]) => void;
  /** Снимает следующую пачку; пустой массив — очередь исчерпана. */
  takeBatch: (maxSize: number) => TextMeasureRequest[];
  /** Пачка исполнена (замеры записаны в кэш) — снять с «в работе». */
  settleBatch: (batch: readonly TextMeasureRequest[]) => void;
  size: () => number;
  subscribe: (listener: () => void) => () => void;
  clear: () => void;
};

/**
 * Потолок очереди: заявки — это будущая работа UI-потока, копить их
 * неограниченно нельзя. При переполнении отбрасываются самые старые: свежий
 * прогрев целится в чаты, которые пользователь откроет скорее.
 */
const QUEUE_CAPACITY = 400;

export function createMeasureWarmQueue(deps: MeasureWarmQueueDeps): MeasureWarmQueue {
  /** Порядок = порядок постановки; ключ → заявка (дедуп). */
  const queued = new Map<string, TextMeasureRequest>();
  /** Отданные в хост, но ещё не исполненные — чтобы не выдать их дважды. */
  const inFlight = new Set<string>();
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of Array.from(listeners)) listener();
  };

  const enqueue: MeasureWarmQueue["enqueue"] = (requests) => {
    let added = false;
    for (const request of requests) {
      const body = request.body;
      const needsBody =
        body.trim().length > 0 &&
        request.maxInnerWidthPx > 0 &&
        !deps.hasBodyMeasure(body, request.maxInnerWidthPx);
      const needsTime =
        request.timeLabel.length > 0 && !deps.hasTimeLabelWidth(request.timeLabel);
      if (!needsBody && !needsTime) continue;
      // Ключ по телу+ширине: у сообщений одной минуты общая метка времени, и
      // отдельная заявка на неё была бы дублем — хост мерит и то, и то.
      const key = needsBody
        ? bodyKey(body, request.maxInnerWidthPx)
        : `time|${request.timeLabel}`;
      if (queued.has(key) || inFlight.has(key)) continue;
      queued.set(key, {
        body: needsBody ? body : "",
        maxInnerWidthPx: request.maxInnerWidthPx,
        timeLabel: needsTime ? request.timeLabel : "",
      });
      added = true;
    }
    while (queued.size > QUEUE_CAPACITY) {
      const oldest = queued.keys().next();
      if (oldest.done) break;
      queued.delete(oldest.value);
    }
    if (added) notify();
  };

  const takeBatch: MeasureWarmQueue["takeBatch"] = (maxSize) => {
    const batch: TextMeasureRequest[] = [];
    for (const [key, request] of queued) {
      if (batch.length >= maxSize) break;
      queued.delete(key);
      inFlight.add(key);
      batch.push(request);
    }
    return batch;
  };

  const settleBatch: MeasureWarmQueue["settleBatch"] = (batch) => {
    for (const request of batch) {
      inFlight.delete(
        request.body.length > 0
          ? bodyKey(request.body, request.maxInnerWidthPx)
          : `time|${request.timeLabel}`,
      );
    }
  };

  return {
    enqueue,
    takeBatch,
    settleBatch,
    size: () => queued.size,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clear: () => {
      queued.clear();
      inFlight.clear();
    },
  };
}
