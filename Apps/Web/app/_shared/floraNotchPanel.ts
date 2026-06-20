/** Геометрия SVG clip-path панели с вырезом под триггер (post ⋮ / compose +). */

export const NOTCH_PANEL_CORNER_R = 10;
export const NOTCH_PANEL_DEPTH = 46;
export const NOTCH_PANEL_FINE_GRID_PX = 5;
export const NOTCH_PANEL_PRIMARY_GRID_PX = 3 * NOTCH_PANEL_FINE_GRID_PX;

/** Зазор от края панели до внутреннего угла выреза (калибровка при W ≈ 225). */
export const NOTCH_PANEL_GAP_PX = 225 - (154 + 5 * NOTCH_PANEL_FINE_GRID_PX);

export const NOTCH_PANEL_MIN_WIDTH_PX =
  Math.ceil((NOTCH_PANEL_GAP_PX + NOTCH_PANEL_CORNER_R * 2) / NOTCH_PANEL_PRIMARY_GRID_PX) *
  NOTCH_PANEL_PRIMARY_GRID_PX;

export const NOTCH_PANEL_CLIP_MIN_H = NOTCH_PANEL_DEPTH + NOTCH_PANEL_CORNER_R + 8;

export function snapNotchPanelWidthToFineGrid(px: number): number {
  return Math.max(
    NOTCH_PANEL_MIN_WIDTH_PX,
    Math.ceil(px / NOTCH_PANEL_FINE_GRID_PX) * NOTCH_PANEL_FINE_GRID_PX,
  );
}

/** Вырез сверху справа (меню под ⋮ в посте). */
export function notchPanelPathTopRight(h: number, w: number): string {
  const W = snapNotchPanelWidthToFineGrid(Math.round(w));
  const H = Math.max(NOTCH_PANEL_CLIP_MIN_H, Math.round(h));
  const R = NOTCH_PANEL_CORNER_R;
  const notchInnerX = W - NOTCH_PANEL_GAP_PX;
  const yBeforeInnerFillet = NOTCH_PANEL_DEPTH - R;
  const xAfterInnerFillet = notchInnerX + R;
  const brArcEndX = W - R;
  return `M ${R} 0 H ${notchInnerX - R} A ${R} ${R} 0 0 1 ${notchInnerX} ${R} V ${yBeforeInnerFillet} A ${R} ${R} 0 0 0 ${xAfterInnerFillet} ${NOTCH_PANEL_DEPTH} H ${brArcEndX} A ${R} ${R} 0 0 1 ${W} ${NOTCH_PANEL_DEPTH + R} V ${H - R} A ${R} ${R} 0 0 1 ${brArcEndX} ${H} H ${R} A ${R} ${R} 0 0 1 0 ${H - R} V ${R} A ${R} ${R} 0 0 1 ${R} 0 Z`;
}

/** Вырез снизу слева (меню над + в поле сообщения). */
export function notchPanelPathBottomLeft(
  h: number,
  w: number,
  gapPx: number = NOTCH_PANEL_GAP_PX,
): string {
  const W = snapNotchPanelWidthToFineGrid(Math.round(w));
  const H = Math.max(NOTCH_PANEL_CLIP_MIN_H, Math.round(h));
  const R = NOTCH_PANEL_CORNER_R;
  const notchInnerX = Math.max(R + NOTCH_PANEL_FINE_GRID_PX, Math.round(gapPx));
  const yAboveInnerFillet = H - NOTCH_PANEL_DEPTH + R;
  const xBeforeInnerFillet = notchInnerX + R;
  return `M ${R} 0 H ${W - R} A ${R} ${R} 0 0 1 ${W} ${R} V ${H - R} A ${R} ${R} 0 0 1 ${W - R} ${H} H ${xBeforeInnerFillet} A ${R} ${R} 0 0 1 ${notchInnerX} ${H - R} V ${yAboveInnerFillet} A ${R} ${R} 0 0 0 ${notchInnerX - R} ${H - NOTCH_PANEL_DEPTH} H ${R} A ${R} ${R} 0 0 1 0 ${H - NOTCH_PANEL_DEPTH - R} V ${R} A ${R} ${R} 0 0 1 ${R} 0 Z`;
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

/** Зазор выреза от края панели до триггера (как post-more: ширина кнопки + 6px, шаг 5px). */
export function notchPanelGapForTriggerWidthPx(triggerWidthPx: number): number {
  const raw = Math.max(
    NOTCH_PANEL_CORNER_R + NOTCH_PANEL_FINE_GRID_PX,
    Math.round(triggerWidthPx) + 6,
  );
  return Math.ceil(raw / NOTCH_PANEL_FINE_GRID_PX) * NOTCH_PANEL_FINE_GRID_PX;
}

export function readNotchPanelClipHeightPx(el: HTMLElement): number {
  return Math.max(NOTCH_PANEL_CLIP_MIN_H, Math.round(el.offsetHeight));
}
