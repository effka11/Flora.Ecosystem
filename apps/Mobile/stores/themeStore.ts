import { Platform } from "react-native";
import { getFloraThemeCrossfade } from "flora-theme-crossfade";
import { createFloraThemeTransition } from "@/lib/floraThemeCrossfade";
import { createFloraThemeStorage } from "@/lib/floraThemeStorage";
import { createFloraThemeStore } from "@/lib/floraThemeStoreCore";

const storage = createFloraThemeStorage();
const crossfade = getFloraThemeCrossfade();

if (__DEV__ && crossfade === null && Platform.OS === "android") {
  console.warn(
    "[flora-theme] flora-theme-crossfade is not linked; theme switch falls back to instant. Rebuild the native app.",
  );
}

export const useThemeStore = createFloraThemeStore({
  initialSavedThemeId: storage.load(),
  persistence: storage,
  transition: createFloraThemeTransition(crossfade),
});
