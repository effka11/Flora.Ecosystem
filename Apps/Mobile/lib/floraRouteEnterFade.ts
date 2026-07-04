export { FLORA_ROUTE_OPACITY_HOLD, floraRouteKeyframeEasing } from "@/lib/floraRouteEasing";
import { floraMotion } from "@/lib/theme";

/** duration + delay + запас; держать в sync с floraMotion.tabTransition*. */
export const floraRouteTransitionClearMs =
  floraMotion.tabTransitionDurationMs + floraMotion.tabTransitionDelayMs + 50;
