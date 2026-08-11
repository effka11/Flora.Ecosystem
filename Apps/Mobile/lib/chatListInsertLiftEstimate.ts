import type { FscpMessageBlock } from "@flora/client-core/fscp";
import { floraMessages } from "@/lib/theme";

/** Базовый lift однострочного текста (эмпирика; ≈ bubble + вклад row gap). */
export const TEXT_BASE_INSERT_LIFT_PX = 52;

/** Запас на meta-ряд `below` (время + gap), когда lines ≥ 2. */
export const BELOW_TIME_RESERVE_PX = 16;

/**
 * Средняя ширина глифа ≈ 0.55 × fontSize (калибровка плана).
 * Чуть ниже — soft-wrap чаще переоценивает строки (недобор lift → рывок).
 */
const AVG_CHAR_WIDTH_FACTOR = 0.55;

export type InsertLiftEstimateCtx = {
  maxInnerWidthPx?: number;
};

/** Число визуальных строк: hard-breaks + soft-wrap; floor = split("\\n").length. */
export function estimateTextVisualLineCount(
  body: string,
  maxInnerWidthPx?: number,
): number {
  const paragraphs = body.split("\n");
  const hardFloor = Math.max(1, paragraphs.length);

  if (maxInnerWidthPx == null || maxInnerWidthPx <= 0) {
    return hardFloor;
  }

  const avgCharWidth = floraMessages.bubbleFontSize * AVG_CHAR_WIDTH_FACTOR;
  const maxChars = Math.max(1, Math.floor(maxInnerWidthPx / avgCharWidth));

  let lines = 0;
  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) {
      lines += 1;
    } else {
      lines += Math.max(1, Math.ceil(paragraph.length / maxChars));
    }
  }
  return Math.max(hardFloor, lines);
}

export function estimateTextInsertLiftPx(
  body: string | undefined,
  ctx?: InsertLiftEstimateCtx,
): number {
  const text = body ?? "";
  if (text.length === 0) return TEXT_BASE_INSERT_LIFT_PX;

  const lines = estimateTextVisualLineCount(text, ctx?.maxInnerWidthPx);
  let heightPx = TEXT_BASE_INSERT_LIFT_PX + (lines - 1) * floraMessages.bubbleLineHeight;
  if (lines >= 2) heightPx += BELOW_TIME_RESERVE_PX;
  return heightPx;
}

function textBodyFromBlocks(blocks: FscpMessageBlock[]): string | undefined {
  const text = blocks.find((b) => b.kind === "text");
  return text?.kind === "text" ? text.body : undefined;
}

/** Оценка высоты новой строки — для counter-lift в тот же кадр, что insert. */
export function estimateBlocksInsertLiftPx(
  blocks: FscpMessageBlock[],
  ctx?: InsertLiftEstimateCtx,
): number {
  if (blocks.some((b) => b.kind === "voice")) return 72;
  const images = blocks.filter((b) => b.kind === "image").length;
  if (images === 1) return 220;
  if (images > 1) return 280;
  return estimateTextInsertLiftPx(textBodyFromBlocks(blocks), ctx);
}

export function estimateRowInsertLiftPx(
  row: {
    voiceBlock?: unknown;
    imageBlocks?: readonly unknown[];
    text?: string;
  },
  ctx?: InsertLiftEstimateCtx,
): number {
  if (row.voiceBlock) return 72;
  const images = row.imageBlocks?.length ?? 0;
  if (images === 1) return 220;
  if (images > 1) return 280;
  return estimateTextInsertLiftPx(row.text, ctx);
}
