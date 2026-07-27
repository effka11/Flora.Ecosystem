import {
  MESSAGE_RECEIPT_INLINE_RESERVE_PX,
  TIME_INLINE_GAP_PX,
  resolveBubbleTimePlacementFromLineWidths,
  type BubbleTimePlacement,
} from "@flora/client-core/display";

import { floraMessages, floraSpacing } from "@/lib/theme";

type BubbleRowContext = {
  screenWidth: number;
  isFromMe: boolean;
  showPeerAvatar: boolean;
  isPeerIndented: boolean;
};

function peerInset(isFromMe: boolean, showPeerAvatar: boolean, isPeerIndented: boolean): number {
  return !isFromMe && (showPeerAvatar || isPeerIndented)
    ? floraMessages.peerBubbleAvatarSize + floraSpacing.grid
    : 0;
}

function rowContentWidth(screenWidth: number, isFromMe: boolean, showPeerAvatar: boolean, isPeerIndented: boolean): number {
  const horizontalPad = floraSpacing.grid * 2;
  return screenWidth - horizontalPad - peerInset(isFromMe, showPeerAvatar, isPeerIndented);
}

/** Text-only bubble max width — 78% of screen, no photo cap (parity web). */
export function maxTextBubbleWidth({
  screenWidth,
  isFromMe,
  showPeerAvatar,
  isPeerIndented,
}: BubbleRowContext): number {
  if (screenWidth <= 0) return 0;

  const maxByRatio = Math.floor(screenWidth * floraMessages.bubbleMaxWidthRatio);
  const maxByRow = rowContentWidth(screenWidth, isFromMe, showPeerAvatar, isPeerIndented);
  return Math.max(0, Math.min(maxByRatio, maxByRow));
}

/** Inner text width for text-only bubbles (minus horizontal bubble padding only). */
export function maxTextBubbleInnerWidth(ctx: BubbleRowContext): number {
  return Math.max(0, maxTextBubbleWidth(ctx) - floraMessages.bubblePadding * 2);
}

export function maxPhotoBubbleWidth(ctx: BubbleRowContext): number {
  if (ctx.screenWidth <= 0) return floraMessages.photoBubbleWidth;

  const maxByRatio = Math.floor(ctx.screenWidth * floraMessages.bubbleMaxWidthRatio);
  const maxByRow = rowContentWidth(ctx.screenWidth, ctx.isFromMe, ctx.showPeerAvatar, ctx.isPeerIndented);
  return Math.max(0, Math.min(floraMessages.photoBubbleWidth, maxByRatio, maxByRow));
}

export function maxVoiceBubbleWidth(ctx: BubbleRowContext): number {
  if (ctx.screenWidth <= 0) return floraMessages.voiceBubbleWidth;

  const maxByRatio = Math.floor(ctx.screenWidth * floraMessages.bubbleMaxWidthRatio);
  const maxByRow = rowContentWidth(ctx.screenWidth, ctx.isFromMe, ctx.showPeerAvatar, ctx.isPeerIndented);
  return Math.max(0, Math.min(floraMessages.voiceBubbleWidth, maxByRatio, maxByRow));
}

/** Caption / nested text area inner width. */
export function captionInnerWidth(containerWidth: number, horizontalPadding: number): number {
  return Math.max(0, containerWidth - horizontalPadding * 2);
}

export function voiceCaptionInnerWidth(ctx: BubbleRowContext): number {
  return captionInnerWidth(maxVoiceBubbleWidth(ctx), floraMessages.bubblePadding);
}

export function photoCaptionInnerWidth(ctx: BubbleRowContext): number {
  return captionInnerWidth(maxPhotoBubbleWidth(ctx), floraSpacing.grid);
}

/**
 * Нативный text layout отдаёт дробные ширины строк, а отрисованный <Text> округляет их вверх.
 * Без запаса пограничное «влезает ровно» превращается в перенос последнего слова.
 */
const MEASURE_ROUNDING_GUARD_PX = 2;

export type BubbleMetaLayoutInput = {
  /** Ширины визуальных строк тела (без времени), из onTextLayout. */
  lineWidths: number[];
  timeLabelWidthPx: number;
  hasReceipt: boolean;
  maxInnerWidthPx: number;
};

export type BubbleMetaLayout = {
  placement: BubbleTimePlacement;
  /** Ширина последней строки вместе с метой; никогда не больше внутренней ширины пузыря. */
  inlineBlockWidthPx: number;
};

/** Ширина блока «время + галочки» вместе с отступом от хвоста текста. */
export function bubbleMetaWidth(timeLabelWidthPx: number, hasReceipt: boolean): number {
  return (
    timeLabelWidthPx + TIME_INLINE_GAP_PX + (hasReceipt ? MESSAGE_RECEIPT_INLINE_RESERVE_PX : 0)
  );
}

/** Как в TG: мета в хвосте последней строки, пока весь блок помещается во внутреннюю ширину пузыря. */
export function resolveBubbleMetaLayout({
  lineWidths,
  timeLabelWidthPx,
  hasReceipt,
  maxInnerWidthPx,
}: BubbleMetaLayoutInput): BubbleMetaLayout {
  const metaWidth = bubbleMetaWidth(timeLabelWidthPx, hasReceipt);
  const lastLineWidth = lineWidths.at(-1) ?? 0;
  const maxOtherWidth = lineWidths.length > 1 ? Math.max(...lineWidths.slice(0, -1)) : 0;
  const limitPx =
    maxInnerWidthPx > 0 ? Math.max(1, maxInnerWidthPx - MEASURE_ROUNDING_GUARD_PX) : 0;
  const inlineBlockWidthPx = Math.max(
    Math.ceil(maxOtherWidth),
    Math.ceil(lastLineWidth + metaWidth) + MEASURE_ROUNDING_GUARD_PX,
  );

  return {
    placement: resolveBubbleTimePlacementFromLineWidths(lineWidths, metaWidth, limitPx),
    inlineBlockWidthPx:
      maxInnerWidthPx > 0 ? Math.min(inlineBlockWidthPx, maxInnerWidthPx) : inlineBlockWidthPx,
  };
}
