import { useFloraTheme } from "@/lib/FloraThemeProvider";
import { effectiveFloraThemeId } from "@/lib/floraThemeStoreCore";
import { useThemeStore } from "@/stores/themeStore";

/**
 * Черновик темы для экрана настроек: тап применяет тему сразу,
 * сохранение фиксирует её на диске, уход с экрана возвращает прежнюю.
 */
export function useFloraThemeDraft() {
  useFloraTheme();
  const previewThemeId = useThemeStore((state) => state.previewThemeId);
  const selectedThemeId = useThemeStore((state) => effectiveFloraThemeId(state));
  const selectTheme = useThemeStore((state) => state.selectTheme);
  const commitTheme = useThemeStore((state) => state.commitTheme);
  const discardTheme = useThemeStore((state) => state.discardTheme);

  return {
    previewThemeId,
    selectedThemeId,
    selectTheme,
    commitTheme,
    discardTheme,
  };
}
