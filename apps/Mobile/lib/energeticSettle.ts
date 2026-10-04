import { Easing, withTiming } from "react-native-reanimated";
import { floraMotion } from "@/lib/theme";

export {
  ENERGETIC_SNAP_VX,
  snapPagerOffset,
} from "@/lib/energeticPagerSnap";

/** Как web modal dialogIn: --flora-duration-3 + --flora-ease-out. */
export const ENERGETIC_OPEN_MS = floraMotion.baseMs * 3;
/** Как web modal dialogOut: --flora-duration-2 + --flora-ease-in. */
export const ENERGETIC_CLOSE_MS = floraMotion.baseMs * 2;
/** --flora-ease-out: cubic-bezier(0.33, 1, 0.2, 1) */
export const ENERGETIC_OPEN_EASING = Easing.bezier(0.33, 1, 0.2, 1);
/** --flora-ease-in: cubic-bezier(0.36, 0, 0.64, 1) */
export const ENERGETIC_CLOSE_EASING = Easing.bezier(0.36, 0, 0.64, 1);

export const ENERGETIC_SETTLE_MIN_MS = floraMotion.baseMs;
export const ENERGETIC_SETTLE_MAX_MS = floraMotion.baseMs * 3;

/**
 * Доводка shared-value к target через withTiming: длительность от оставшейся
 * дистанции и скорости пальца (та же политика, что settle сайдбара).
 *
 * @param fullSpan — полный ход жеста в единицах value (1 для progress 0…1, pageWidth для offset-px)
 * @param pxPerUnit — сколько px в одной единице value (panelWidth для progress, 1 для offset-px)
 */
export function settleEnergetic(
  value: { value: number },
  target: number,
  fullSpan: number,
  pxPerUnit: number,
  velocityPxPerSec: number,
  fullSpanMs: number,
  easing: typeof ENERGETIC_OPEN_EASING,
  onFinished?: (finished?: boolean) => void,
): void {
  "worklet";
  const distance = Math.abs(target - value.value);
  const remainingPx = distance * pxPerUnit;
  if (remainingPx < 0.5 || fullSpan <= 0) {
    value.value = target;
    if (onFinished) onFinished(true);
    return;
  }
  const speedPx = Math.max(180, Math.abs(velocityPxPerSec));
  const fromVelocityMs = Math.round((remainingPx / speedPx) * 1000);
  const fromDistanceMs = Math.round(fullSpanMs * (distance / fullSpan));
  const duration = Math.max(
    ENERGETIC_SETTLE_MIN_MS,
    Math.min(ENERGETIC_SETTLE_MAX_MS, Math.max(fromVelocityMs, fromDistanceMs)),
  );
  value.value = withTiming(target, { duration, easing }, onFinished);
}
