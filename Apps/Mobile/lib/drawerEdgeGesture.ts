import { floraSpacing } from "@/lib/theme";

export type DrawerEdgeIntent = "pending" | "activate" | "fail";

/** Зона edge-swipe гамбургер-меню (60px на всю высоту, без вырезов). */
export function DRAWER_EDGE_HIT_WIDTH() {
  return 4 * floraSpacing.grid;
}
/** Быстрый vertical fail edge-pan: ScrollView не ждёт PENDING при waitFor. */
export const DRAWER_EDGE_FAIL_OFFSET_Y = 8;
/**
 * Вертикальный порог нативного edge-guard (dp): меньше fail-offset, чтобы
 * handover ленты произошёл до того, как RNGH зафейлит pan и активирует скролл.
 */
export const DRAWER_EDGE_GUARD_VERTICAL_SLOP = 6;

/** Edge claim только ниже chrome (гамбургер/табы) и внутри левой полосы. */
export function shouldClaimDrawerEdgeTouch(
  absoluteX: number,
  absoluteY: number,
  edgeMaxX: number,
  chromeBottomY: number,
): boolean {
  "worklet";
  return absoluteX <= edgeMaxX && absoluteY > chromeBottomY;
}

export function classifyDrawerEdgeIntent(
  deltaX: number,
  deltaY: number,
  axisThreshold: number,
): DrawerEdgeIntent {
  "worklet";
  if (deltaX < -axisThreshold * 0.6) return "fail";
  if (Math.abs(deltaY) > axisThreshold && Math.abs(deltaY) >= Math.abs(deltaX)) {
    return "fail";
  }
  if (deltaX > axisThreshold * 0.6) return "activate";
  return "pending";
}

export function shouldOpenDrawer(
  progress: number,
  panelWidth: number,
  velocityX: number,
  ratioThreshold: number,
  distanceThreshold: number,
  velocityThreshold: number,
): boolean {
  "worklet";
  return (
    progress > ratioThreshold ||
    progress * panelWidth >= distanceThreshold ||
    velocityX > velocityThreshold
  );
}
