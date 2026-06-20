/** Разбиение текста пузыря на визуальные строки (явные \n и перенос по max-width). */

export type BubbleTimePlacement = "inline" | "below";

const TIME_INLINE_GAP_PX = 15;

export function measureTextWidth(text: string, font: string): number {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return 0;
  ctx.font = font;
  return ctx.measureText(text).width;
}

function wrapSegment(segment: string, maxWidthPx: number, font: string): string[] {
  if (!segment) return [""];
  if (measureTextWidth(segment, font) <= maxWidthPx) return [segment];

  const lines: string[] = [];
  let current = "";
  const tokens = segment.split(/(\s+)/).filter((token) => token.length > 0);

  for (const token of tokens) {
    const trial = current + token;
    if (current && measureTextWidth(trial, font) > maxWidthPx) {
      lines.push(current);
      current = token.trimStart();
    } else {
      current = trial;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

/** maxWidthPx — внутренняя ширина пузыря (без горизонтального padding). */
export function splitBubbleTextLines(body: string, maxWidthPx: number, font: string): string[] {
  if (!body) return [""];
  if (maxWidthPx <= 0) return body.split("\n");

  return body.split("\n").flatMap((segment) => wrapSegment(segment, maxWidthPx, font));
}

/** Как в TG: время в строке, если lastLine + time ≤ max(остальные строки, lastLine + time) и ≤ лимита пузыря. */
export function resolveBubbleTimePlacement(
  lines: string[],
  textFont: string,
  timeFont: string,
  timeLabel: string,
  maxBubbleWidthPx: number,
  timeExtraWidthPx = 0
): BubbleTimePlacement {
  if (lines.length === 0) return "inline";

  const lineWidths = lines.map((line) => measureTextWidth(line, textFont));
  const lastLineWidth = lineWidths[lineWidths.length - 1] ?? 0;
  const maxOtherWidth = lineWidths.length > 1 ? Math.max(...lineWidths.slice(0, -1)) : 0;
  const timeWidth = measureTextWidth(timeLabel, timeFont) + TIME_INLINE_GAP_PX + timeExtraWidthPx;
  const widthWithInlineTime = Math.max(maxOtherWidth, lastLineWidth + timeWidth);
  const limit = maxBubbleWidthPx > 0 ? maxBubbleWidthPx : Infinity;

  return widthWithInlineTime <= limit ? "inline" : "below";
}

export function bubbleInnerMaxWidthPx(bubbleEl: HTMLElement): number {
  const computed = window.getComputedStyle(bubbleEl);
  const paddingX =
    (parseFloat(computed.paddingLeft) || 0) + (parseFloat(computed.paddingRight) || 0);
  const wrap = bubbleEl.closest("[data-messages-bubble-wrap]");
  if (!(wrap instanceof HTMLElement)) return 0;

  const maxRatio = 0.78;
  return Math.max(0, wrap.clientWidth * maxRatio - paddingX);
}
