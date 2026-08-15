import { Easing, useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { floraMotion } from "@/lib/theme";

/** Open/close поиска: чуть дольше baseMs, только opacity (не layout). */
export const SEARCH_CHROME_MS = Math.round(floraMotion.baseMs * (4 / 3));
export const SEARCH_CHROME_EASING = Easing.bezier(0.33, 1, 0.2, 1);

/**
 * Incoming search поверх непрозрачного idle: только opacity p.
 * Фейдить оба слоя нельзя — stacked Porter-Duff даёт провал (мигание) в середине.
 */
export function useSearchChromeLayerStyles(progress: SharedValue<number>) {
  const searchStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
  }));
  return { searchStyle };
}
