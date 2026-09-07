/** Геометрия SVG clip-path панели с вырезом под триггер (post ⋮ / compose +). */

import { sPx } from "@flora/design";
import { getViewportFrame } from "./viewportFrame";

type NotchPanelMetrics = {
  cornerR: number;
  depth: number;
  fine: number;
  primary: number;
  gap: number;
  minWidth: number;
  clipMinH: number;
};

function notchPanelMetrics(): NotchPanelMetrics {
  const { s, step, stepFine } = getViewportFrame();
  const cornerR = sPx(10, s);
  const depth = sPx(46, s);
  const fine = stepFine;
  const primary = step;
  const gap = sPx(225, s) - (sPx(154, s) + 5 * fine);
  const minWidth = Math.ceil((gap + cornerR * 2) / primary) * primary;
  const clipMinH = depth + cornerR + sPx(8, s);
  return { cornerR, depth, fine, primary, gap, minWidth, clipMinH };
}

/** Live px getter typed as number so PostMoreMenu (sot-spx) can add / useState. */
function livePx(get: () => number): number {
  const fn = Object.assign(
    function livePxValue(): number {
      return get();
    },
    {
      valueOf: get,
      [Symbol.toPrimitive]: get,
    },
  );
  return fn as unknown as number;
}

export function notchPanelCornerR(): number {
  return notchPanelMetrics().cornerR;
}

export function notchPanelDepthPx(): number {
  return notchPanelMetrics().depth;
}

export function notchPanelFineGridPx(): number {
  return notchPanelMetrics().fine;
}

export function notchPanelPrimaryGridPx(): number {
  return notchPanelMetrics().primary;
}

export function notchPanelGapPx(): number {
  return notchPanelMetrics().gap;
}

export function notchPanelMinWidthPx(): number {
  return notchPanelMetrics().minWidth;
}

export function notchPanelClipMinH(): number {
  return notchPanelMetrics().clipMinH;
}

export const NOTCH_PANEL_CORNER_R = livePx(notchPanelCornerR);
export const NOTCH_PANEL_DEPTH = livePx(notchPanelDepthPx);
export const NOTCH_PANEL_FINE_GRID_PX = livePx(notchPanelFineGridPx);
export const NOTCH_PANEL_PRIMARY_GRID_PX = livePx(notchPanelPrimaryGridPx);
export const NOTCH_PANEL_GAP_PX = livePx(notchPanelGapPx);
export const NOTCH_PANEL_MIN_WIDTH_PX = livePx(notchPanelMinWidthPx);
export const NOTCH_PANEL_CLIP_MIN_H = livePx(notchPanelClipMinH);

export function snapNotchPanelWidthToFineGrid(px: number): number {
  const { fine, minWidth } = notchPanelMetrics();
  return Math.max(minWidth, Math.ceil(px / fine) * fine);
}

/** Вырез сверху справа (меню под ⋮ в посте). */
export function notchPanelPathTopRight(h: number, w: number): string {
  const { cornerR: R, depth, gap, clipMinH } = notchPanelMetrics();
  const W = snapNotchPanelWidthToFineGrid(Math.round(w));
  const H = Math.max(clipMinH, Math.round(h));
  const notchInnerX = W - gap;
  const yBeforeInnerFillet = depth - R;
  const xAfterInnerFillet = notchInnerX + R;
  const brArcEndX = W - R;
  return `M ${R} 0 H ${notchInnerX - R} A ${R} ${R} 0 0 1 ${notchInnerX} ${R} V ${yBeforeInnerFillet} A ${R} ${R} 0 0 0 ${xAfterInnerFillet} ${depth} H ${brArcEndX} A ${R} ${R} 0 0 1 ${W} ${depth + R} V ${H - R} A ${R} ${R} 0 0 1 ${brArcEndX} ${H} H ${R} A ${R} ${R} 0 0 1 0 ${H - R} V ${R} A ${R} ${R} 0 0 1 ${R} 0 Z`;
}

/** Вырез снизу слева (меню над + в поле сообщения). */
export function notchPanelPathBottomLeft(
  h: number,
  w: number,
  gapPx: number = notchPanelGapPx(),
): string {
  const { cornerR: R, depth, fine, clipMinH } = notchPanelMetrics();
  const W = snapNotchPanelWidthToFineGrid(Math.round(w));
  const H = Math.max(clipMinH, Math.round(h));
  const notchInnerX = Math.max(R + fine, Math.round(gapPx));
  const yAboveInnerFillet = H - depth + R;
  const xBeforeInnerFillet = notchInnerX + R;
  return `M ${R} 0 H ${W - R} A ${R} ${R} 0 0 1 ${W} ${R} V ${H - R} A ${R} ${R} 0 0 1 ${W - R} ${H} H ${xBeforeInnerFillet} A ${R} ${R} 0 0 1 ${notchInnerX} ${H - R} V ${yAboveInnerFillet} A ${R} ${R} 0 0 0 ${notchInnerX - R} ${H - depth} H ${R} A ${R} ${R} 0 0 1 0 ${H - depth - R} V ${R} A ${R} ${R} 0 0 1 ${R} 0 Z`;
}

export function notchPanelClipPath(
  placement: "top-right" | "bottom-left",
  h: number,
  w: number,
  gapPx?: number,
): string {
  const d =
    placement === "top-right"
      ? notchPanelPathTopRight(h, w)
      : notchPanelPathBottomLeft(h, w, gapPx);
  return `path("${d}")`;
}

/** Зазор выреза от края панели до триггера (как post-more: ширина кнопки + sPx(6), шаг fine). */
export function notchPanelGapForTriggerWidthPx(triggerWidthPx: number): number {
  const { cornerR, fine } = notchPanelMetrics();
  const raw = Math.max(cornerR + fine, Math.round(triggerWidthPx) + sPx(6, getViewportFrame().s));
  return Math.ceil(raw / fine) * fine;
}

export function readNotchPanelClipHeightPx(el: HTMLElement): number {
  return Math.max(notchPanelClipMinH(), Math.round(el.offsetHeight));
}
