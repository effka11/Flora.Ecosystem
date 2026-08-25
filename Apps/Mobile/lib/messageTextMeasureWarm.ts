/**
 * Привязка очереди offscreen-замеров к кэшу замеров текста и к геометрии
 * пузыря: прогрев считает `maxInnerWidthPx` ровно так же, как чат, иначе
 * ключ кэша не совпадёт и замер не пригодится.
 */
import { Dimensions } from "react-native";

import { formatChatTime } from "@/lib/formatChatTime";
import { maxTextBubbleInnerWidth } from "@/lib/messageBubbleLayout";
import {
  getCachedBodyMeasure,
  getCachedTimeLabelWidth,
} from "@/lib/messageTextMeasureCache";
import {
  createMeasureWarmQueue,
  type TextMeasureRequest,
} from "@/lib/messageTextMeasureWarmQueue";

export const messageTextMeasureWarmQueue = createMeasureWarmQueue({
  hasBodyMeasure: (body, maxInnerWidthPx) =>
    getCachedBodyMeasure(body, maxInnerWidthPx) != null,
  hasTimeLabelWidth: (timeLabel) => getCachedTimeLabelWidth(timeLabel) != null,
});

/**
 * Внутренняя ширина текстового пузыря. Лента рендерит только два контекста:
 * своё сообщение (без peer-колонки) и чужое в peer-строке (колонка под
 * аватар зарезервирована) — см. renderMessage / ChatPeerMessageRow.
 */
export function warmTextInnerWidthPx(isFromMe: boolean): number {
  return maxTextBubbleInnerWidth({
    screenWidth: Dimensions.get("window").width,
    isFromMe,
    showPeerAvatar: false,
    isPeerIndented: !isFromMe,
  });
}

export type WarmMeasureRow = {
  text: string;
  createdAt: string;
  isFromMe: boolean;
};

/**
 * Заявки на замер для строк треда. Только чистый текст: у пузырей с фото и
 * голосовыми ширина подписи считается от своей геометрии, а высота приходит
 * из ratio-store / волны, и первый кадр там не прыгает.
 *
 * `urgent` — путь открытия чата (тап/press-in/ready): без фоновой паузы хоста,
 * иначе замеры проигрывают гонку монтажу ячеек.
 */
export function enqueueThreadTextMeasures(
  rows: readonly WarmMeasureRow[],
  opts?: { urgent?: boolean },
): void {
  const requests: TextMeasureRequest[] = [];
  for (const row of rows) {
    const body = row.text?.trim() ?? "";
    if (body.length === 0) continue;
    requests.push({
      body: row.text,
      maxInnerWidthPx: warmTextInnerWidthPx(row.isFromMe),
      timeLabel: formatChatTime(row.createdAt),
    });
  }
  if (requests.length > 0) messageTextMeasureWarmQueue.enqueue(requests, opts);
}
