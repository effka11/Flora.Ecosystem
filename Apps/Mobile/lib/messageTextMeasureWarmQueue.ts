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
  /**
   * Ставит в очередь то, чего нет ни в кэше, ни уже в очереди.
   * `urgent` — полоса открытия чата: заявки уходят в начало очереди, хост
   * исполняет их без фоновой паузы и увеличенной пачкой. Обычная заявка,
   * поставленная повторно как срочная, переезжает в срочную полосу.
   */
  enqueue: (requests: readonly TextMeasureRequest[], opts?: { urgent?: boolean }) => void;
  /** Снимает следующую пачку (срочные первыми); пустой массив — очередь исчерпана. */
  takeBatch: (maxSize: number) => TextMeasureRequest[];
  /** Пачка исполнена (замеры записаны в кэш) — снять с «в работе». */
  settleBatch: (batch: readonly TextMeasureRequest[]) => void;
  size: () => number;
  /** Есть срочные заявки — хосту пора работать без паузы. */
  hasUrgent: () => boolean;
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
  /** Срочная полоса (открываемый чат) — исполняется первой. */
  const urgentQueued = new Map<string, TextMeasureRequest>();
  /** Фоновая полоса; порядок = порядок постановки; ключ → заявка (дедуп). */
  const queued = new Map<string, TextMeasureRequest>();
  /** Отданные в хост, но ещё не исполненные — чтобы не выдать их дважды. */
  const inFlight = new Set<string>();
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of Array.from(listeners)) listener();
  };

  const enqueue: MeasureWarmQueue["enqueue"] = (requests, opts) => {
    const urgent = opts?.urgent === true;
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
      if (inFlight.has(key) || urgentQueued.has(key)) continue;
      if (queued.has(key)) {
        if (!urgent) continue;
        // Повышение приоритета: фоновая заявка переезжает в срочную полосу.
        queued.delete(key);
      }
      const entry = {
        body: needsBody ? body : "",
        maxInnerWidthPx: request.maxInnerWidthPx,
        timeLabel: needsTime ? request.timeLabel : "",
      };
      (urgent ? urgentQueued : queued).set(key, entry);
      added = true;
    }
    // Переполнение бьёт только по фоновой полосе: срочная — это открываемый
    // сейчас чат, её терять нельзя (да и она всегда мала — окно показа).
    while (urgentQueued.size + queued.size > QUEUE_CAPACITY && queued.size > 0) {
      const oldest = queued.keys().next();
      if (oldest.done) break;
      queued.delete(oldest.value);
    }
    if (added) notify();
  };

  const takeBatch: MeasureWarmQueue["takeBatch"] = (maxSize) => {
    const batch: TextMeasureRequest[] = [];
    for (const source of [urgentQueued, queued]) {
      for (const [key, request] of source) {
        if (batch.length >= maxSize) break;
        source.delete(key);
        inFlight.add(key);
        batch.push(request);
      }
      if (batch.length >= maxSize) break;
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
    size: () => urgentQueued.size + queued.size,
    hasUrgent: () => urgentQueued.size > 0,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clear: () => {
      urgentQueued.clear();
      queued.clear();
      inFlight.clear();
    },
  };
}
