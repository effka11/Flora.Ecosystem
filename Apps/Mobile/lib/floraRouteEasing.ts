/** Как dashboardRouteInFromLeft/Right: 0–8% keyframe на opacity: 0. */
export const FLORA_ROUTE_OPACITY_HOLD = 0.08;

const BEZIER_X1 = 0.33;
const BEZIER_Y1 = 1;
const BEZIER_X2 = 0.2;
const BEZIER_Y2 = 1;

function cubicBezierComponent(t: number, p1: number, p2: number): number {
  "worklet";
  const u = 1 - t;
  return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t;
}

/** CSS cubic-bezier(0.33, 1, 0.2, 1) — progress по шкале времени анимации. */
function floraEaseOutTimeline(linearT: number): number {
  "worklet";
  if (linearT <= 0) {
    return 0;
  }
  if (linearT >= 1) {
    return 1;
  }

  let t = linearT;
  for (let i = 0; i < 10; i++) {
    const x = cubicBezierComponent(t, BEZIER_X1, BEZIER_X2);
    const dx =
      3 * (1 - t) * (1 - t) * BEZIER_X1 +
      6 * (1 - t) * t * (BEZIER_X2 - BEZIER_X1) +
      3 * t * t * (1 - BEZIER_X2);
    if (Math.abs(dx) < 1e-6) {
      break;
    }
    t -= (x - linearT) / dx;
    t = Math.min(1, Math.max(0, t));
  }

  return cubicBezierComponent(t, BEZIER_Y1, BEZIER_Y2);
}

/**
 * CSS keyframes dashboardRouteInFromLeft + animation-timing-function ease-out.
 * linearT ∈ [0,1] — доля wall-clock (после animation-delay).
 */
export function floraRouteKeyframeEasing(linearT: number): number {
  "worklet";
  const timeline = floraEaseOutTimeline(linearT);
  if (timeline <= FLORA_ROUTE_OPACITY_HOLD) {
    return 0;
  }
  return (timeline - FLORA_ROUTE_OPACITY_HOLD) / (1 - FLORA_ROUTE_OPACITY_HOLD);
}
