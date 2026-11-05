import { type ImageStyle, type TextStyle, type ViewStyle } from "react-native";
import { createKeyedLiveValue } from "@/lib/liveCache";

type NamedStyles<T> = { [P in keyof T]: ViewStyle | TextStyle | ImageStyle };

/**
 * Styles rebuilt when the Flora grid step or the active theme changes.
 * Pass `() => StyleSheet.create({ ... })` so create runs after the current step is set.
 * The cache keeps one sheet per grid step × theme.
 */
export function liveGridStyles<T extends NamedStyles<T>>(factory: () => T): T {
  return createKeyedLiveValue(factory);
}
