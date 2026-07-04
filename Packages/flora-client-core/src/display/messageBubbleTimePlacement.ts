/** Telegram-style inline time placement in message bubbles (shared web + mobile). */

export type BubbleTimePlacement = "inline" | "below";

/** Gap between body tail and time label on the last line (flora primary grid step). */
export const TIME_INLINE_GAP_PX = 15;

/** Reserve for read-receipt icons when time is inline (parity web MESSAGE_RECEIPT_INLINE_RESERVE_PX). */
export const MESSAGE_RECEIPT_INLINE_RESERVE_PX = 28;

/**
 * Как в TG: время в строке, если lastLine + meta ≤ max(остальные строки, lastLine + meta) и ≤ лимита пузыря.
 * @param lineWidths — visual line widths from text layout (body only, without inline time).
 * @param metaWidthPx — time label width + gap + optional receipt reserve.
 * @param maxBubbleInnerWidthPx — inner max width of bubble content area.
 */
export function resolveBubbleTimePlacementFromLineWidths(
  lineWidths: number[],
  metaWidthPx: number,
  maxBubbleInnerWidthPx: number,
): BubbleTimePlacement {
  if (lineWidths.length === 0) return "inline";

  const lastLineWidth = lineWidths[lineWidths.length - 1] ?? 0;
  const maxOtherWidth = lineWidths.length > 1 ? Math.max(...lineWidths.slice(0, -1)) : 0;
  const widthWithInlineTime = Math.max(maxOtherWidth, lastLineWidth + metaWidthPx);
  const limit = maxBubbleInnerWidthPx > 0 ? maxBubbleInnerWidthPx : Infinity;

  return widthWithInlineTime <= limit ? "inline" : "below";
}
