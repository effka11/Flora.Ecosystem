/**
 * Окно первого коммита ленты чата: FlashList монтирует ровно столько строк,
 * сколько закрывает вьюпорт (+запас), остальная история доклеивается сразу
 * после первого видимого кадра. Смысл — телеграмный: время до показа платит
 * только видимый экран, а не всё окно расшифровки.
 *
 * Лента плоская (каждый пузырь — item), поэтому срез точный по-пузырно.
 * Веса строк — те же оценки, что у insertLift (`chatListInsertLiftEstimate`):
 * заниженная оценка безопасна (домонтируем лишнее), завышенная страхуется
 * запасом и минимумом строк.
 */
import {
  estimateRowInsertLiftPx,
  type InsertLiftEstimateCtx,
} from "@/lib/chatListInsertLiftEstimate";
import type { ThreadListItem } from "@/lib/threadMessageGroups";

/**
 * Минимум строк в окне — страховка от завышенных оценок высот. Ровно
 * страховка, не цель: полноэкранные пузыри (стихи, коллажи) не должны
 * тянуть в первый коммит лишние экраны истории.
 */
const MIN_WINDOW_ITEMS = 4;

export type ThreadWindowCtx = {
  /** Ширина текста своих сообщений (без peer-колонки). */
  own: InsertLiftEstimateCtx;
  /** Ширина текста чужих сообщений (с peer-inset). */
  peer: InsertLiftEstimateCtx;
};

/**
 * Срез ленты (новые → старые, как listData) до суммарной оценки ≥ targetPx.
 * Без среза возвращает исходный массив по ссылке — memo выше не перерендерит.
 */
export function sliceThreadListToViewport(
  items: readonly ThreadListItem[],
  targetPx: number,
  ctx: ThreadWindowCtx,
): readonly ThreadListItem[] {
  if (items.length <= MIN_WINDOW_ITEMS) return items;
  let accumulatedPx = 0;
  for (let i = 0; i < items.length; i++) {
    if (accumulatedPx >= targetPx && i >= MIN_WINDOW_ITEMS) {
      return items.slice(0, i);
    }
    const item = items[i]!;
    accumulatedPx += estimateRowInsertLiftPx(
      item.message,
      item.kind === "own" ? ctx.own : ctx.peer,
    );
  }
  return items;
}
