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

/** Inner text width for text-only bubbles (minus horizontal bubble padding). */
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
