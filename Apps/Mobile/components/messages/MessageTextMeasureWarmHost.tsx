/**
 * Невидимый исполнитель offscreen-замеров текста пузырей (см.
 * `messageTextMeasureWarmQueue`): монтируется один раз на приложение и
 * пачками мерит тела сообщений, которые фоновый прогрев тредов поставил в
 * очередь. Результат ложится в тот же кэш замеров, из которого читает
 * `ChatMessageBubbleTextBody`, — при открытии чата первый кадр ленты уже
 * финальный, без перескока раскладки.
 *
 * Узлы абсолютные и прозрачные (как замерный слот в самом пузыре), поэтому
 * ни на раскладку, ни на попадания тапов не влияют.
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  StyleSheet,
  Text,
  View,
  type NativeSyntheticEvent,
  type TextLayoutEventData,
} from "react-native";

import {
  messageBubbleBodyTextMetrics,
  messageBubbleTimeTextMetrics,
} from "@/lib/messageBubbleTextStyle";
import {
  setCachedBodyMeasure,
  setCachedTimeLabelWidth,
} from "@/lib/messageTextMeasureCache";
import { messageTextMeasureWarmQueue } from "@/lib/messageTextMeasureWarm";
import type { TextMeasureRequest } from "@/lib/messageTextMeasureWarmQueue";

/**
 * Узлов за коммит. Замер — нативный layout текста без React-поддерева пузыря,
 * так что пачка дешёвая; держим её небольшой, чтобы прогрев никогда не съедал
 * кадр у списка чатов, по которому пользователь в этот момент скроллит.
 */
const BATCH_SIZE = 8;
/** Пауза между пачками: фоновый прогрев принципиально не приоритетнее UI. */
const BATCH_GAP_MS = 96;
/**
 * Срочная полоса — окно показа открываемого ПРЯМО СЕЙЧАС чата: пачка на всё
 * окно и без паузы, иначе замеры проигрывают гонку монтажу ячеек и пузыри
 * доизмеряются уже на экране (видимый сдвиг после показа).
 */
const URGENT_BATCH_SIZE = 24;

function requestKey(request: TextMeasureRequest): string {
  return `${request.maxInnerWidthPx}|${request.timeLabel}|${request.body}`;
}

export const MessageTextMeasureWarmHost = memo(function MessageTextMeasureWarmHost() {
  const [batch, setBatch] = useState<TextMeasureRequest[]>([]);
  const batchRef = useRef<TextMeasureRequest[]>([]);
  batchRef.current = batch;

  /**
   * Один живой таймер на хост: и подписка на очередь, и завершение пачки
   * ведут в один и тот же «взять следующую пачку», и без общего таймера
   * всплеск заявок породил бы несколько параллельных цепочек.
   */
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  /** Дев-трассировка: когда пачка ушла в рендер и была ли срочной. */
  const batchTraceRef = useRef({ takenAt: 0, urgent: false });

  const pumpRef = useRef<() => void>(() => undefined);
  pumpRef.current = () => {
    if (!mountedRef.current) return;
    const urgent = messageTextMeasureWarmQueue.hasUrgent();
    if (timerRef.current != null) {
      if (!urgent) return;
      // Fast-track: срочная заявка пришла во время фоновой паузы — не ждём её.
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (batchRef.current.length > 0) return;
    if (messageTextMeasureWarmQueue.size() === 0) return;
    timerRef.current = setTimeout(
      () => {
        timerRef.current = null;
        if (!mountedRef.current) return;
        const urgentNow = messageTextMeasureWarmQueue.hasUrgent();
        const next = messageTextMeasureWarmQueue.takeBatch(
          urgentNow ? URGENT_BATCH_SIZE : BATCH_SIZE,
        );
        if (next.length === 0) return;
        if (__DEV__) batchTraceRef.current = { takenAt: Date.now(), urgent: urgentNow };
        setBatch(next);
      },
      urgent ? 0 : BATCH_GAP_MS,
    );
  };

  useEffect(() => {
    mountedRef.current = true;
    const unsubscribe = messageTextMeasureWarmQueue.subscribe(() => pumpRef.current());
    pumpRef.current();
    return () => {
      mountedRef.current = false;
      unsubscribe();
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  /**
   * Пачка исполнена — снимаем её из дерева и просим следующую. Считаем
   * события, а не ждём каждое: у пустых заявок (только метка времени) узла
   * тела нет, и «ждать все» повисло бы.
   */
  const doneCountRef = useRef(0);
  const onNodeMeasured = useCallback(() => {
    doneCountRef.current += 1;
    const current = batchRef.current;
    const expected = current.reduce(
      (n, request) =>
        n + (request.body.trim().length > 0 ? 1 : 0) + (request.timeLabel ? 1 : 0),
      0,
    );
    if (doneCountRef.current < expected) return;
    doneCountRef.current = 0;
    if (__DEV__ && batchTraceRef.current.urgent) {
      // Латентность срочной полосы: сколько прошло от взятия пачки до полного
      // замера. Большие значения = хост голодает на занятом JS-потоке.
      console.log(
        `[measure-host] срочная пачка ${current.length} за ${Date.now() - batchTraceRef.current.takenAt}мс`,
      );
    }
    messageTextMeasureWarmQueue.settleBatch(current);
    setBatch([]);
    pumpRef.current();
  }, []);

  if (batch.length === 0) return null;

  return (
    <View
      style={styles.host}
      pointerEvents="none"
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      {batch.map((request) => {
        const key = requestKey(request);
        const body = request.body;
        return (
          <View key={key}>
            {body.trim().length > 0 ? (
              <View style={[styles.slot, { width: request.maxInnerWidthPx }]}>
                <Text
                  style={messageBubbleBodyTextMetrics}
                  onTextLayout={(event: NativeSyntheticEvent<TextLayoutEventData>) => {
                    const lines = event.nativeEvent.lines;
                    setCachedBodyMeasure(body, request.maxInnerWidthPx, {
                      lineWidths: lines.map((line) => line.width),
                      lines: resolveLines(body, lines),
                    });
                    onNodeMeasured();
                  }}
                >
                  {body}
                </Text>
              </View>
            ) : null}
            {request.timeLabel ? (
              <View style={styles.slot}>
                <Text
                  style={messageBubbleTimeTextMetrics}
                  onTextLayout={(event: NativeSyntheticEvent<TextLayoutEventData>) => {
                    setCachedTimeLabelWidth(
                      request.timeLabel,
                      event.nativeEvent.lines[0]?.width ?? 0,
                    );
                    onNodeMeasured();
                  }}
                >
                  {request.timeLabel}
                </Text>
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
});

/** Зеркало `resolveLayoutLines` пузыря: пустые тексты строк — перенос по \n. */
function resolveLines(body: string, lines: TextLayoutEventData["lines"]): string[] {
  const texts = lines.map((line) => line.text?.trimEnd() ?? "");
  if (texts.every((text) => text.length === 0)) {
    return body.includes("\n") ? body.split("\n") : [body];
  }
  return texts;
}

const styles = StyleSheet.create({
  host: {
    position: "absolute",
    left: 0,
    top: 0,
    width: 0,
    height: 0,
    opacity: 0,
    zIndex: -1,
  },
  slot: {
    position: "absolute",
    left: 0,
    top: 0,
    opacity: 0,
  },
});
