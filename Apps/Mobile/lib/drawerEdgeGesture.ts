export type DrawerEdgeIntent = "pending" | "activate" | "fail";

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
