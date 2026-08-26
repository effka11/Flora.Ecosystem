/**
 * Привязка очереди offscreen-замеров к кэшу замеров текста и к геометрии
 * пузыря: прогрев считает `maxInnerWidthPx` ровно так же, как чат, иначе
 * ключ кэша не совпадёт и замер не пригодится.
 */
import { Dimensions } from "react-native";

import { formatChatTime } from "@/lib/formatChatTime";
import {
  maxTextBubbleInnerWidth,
  photoCaptionInnerWidth,
  voiceCaptionInnerWidth,
} from "@/lib/messageBubbleLayout";
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
 * Контекст геометрии пузыря. Лента рендерит только два контекста: своё
 * сообщение (без peer-колонки) и чужое в peer-строке (колонка под аватар
 * зарезервирована, `inPeerGroup`) — см. renderMessage / ChatPeerMessageRow.
 */
function warmLayoutCtx(isFromMe: boolean) {
  return {
    screenWidth: Dimensions.get("window").width,
    isFromMe,
    showPeerAvatar: false,
    isPeerIndented: !isFromMe,
  };
}

/** Внутренняя ширина чисто текстового пузыря. */
export function warmTextInnerWidthPx(isFromMe: boolean): number {
  return maxTextBubbleInnerWidth(warmLayoutCtx(isFromMe));
}

export type WarmMeasureRow = {
  text: string;
  createdAt: string;
  isFromMe: boolean;
  /** Медиа-пузырь: ширина подписи считается от геометрии фото/голосового. */
  media?: "photo" | "voice";
};

/**
 * Ширина текста строки с учётом медиа: подпись под фото/голосовым живёт в
 * своей колонке. Раньше медиа-строки прогрев пропускал — длинная подпись
 * (стих под фото) меряла себя уже в ячейке и схлопывала пузырь на экране
 * (в трассе: «ячейка … 1235→955 после reveal»).
 */
export function warmMeasureRowInnerWidthPx(
  row: Pick<WarmMeasureRow, "isFromMe" | "media">,
): number {
  if (row.media === "photo") return photoCaptionInnerWidth(warmLayoutCtx(row.isFromMe));
  if (row.media === "voice") return voiceCaptionInnerWidth(warmLayoutCtx(row.isFromMe));
  return warmTextInnerWidthPx(row.isFromMe);
}

/**
 * Заявки на замер для строк треда — текстовых и подписей медиа.
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
      maxInnerWidthPx: warmMeasureRowInnerWidthPx(row),
      timeLabel: formatChatTime(row.createdAt),
    });
  }
  if (requests.length > 0) messageTextMeasureWarmQueue.enqueue(requests, opts);
}
