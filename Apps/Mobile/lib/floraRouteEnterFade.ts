export { FLORA_ROUTE_OPACITY_HOLD, floraRouteKeyframeEasing } from "@/lib/floraRouteEasing";
import { floraMotion } from "@/lib/theme";

/** duration + запас; держать в sync с fade вкладок / ENERGETIC_OPEN_MS. */
export const floraRouteTransitionClearMs =
  floraMotion.tabTransitionDurationMs + 50;
