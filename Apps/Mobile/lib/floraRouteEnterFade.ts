export {
  FLORA_ROUTE_OPACITY_HOLD,
  floraRouteKeyframeEasing,
  floraRouteRevealEasing,
} from "@/lib/floraRouteEasing";
import { floraMotion } from "@/lib/theme";

/** duration + запас; держать в sync с fade вкладок. */
export const floraRouteTransitionClearMs =
  floraMotion.tabTransitionDurationMs + 50;
