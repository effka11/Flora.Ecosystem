import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  type ReactNode,
} from "react";
import { getFloraThemeCrossfade } from "flora-theme-crossfade";
import type { FloraThemeId } from "@/lib/floraTheme";
import { THEME_CROSSFADE_MS } from "@/lib/floraThemeCrossfade";
import { useThemeStore } from "@/stores/themeStore";

type FloraThemeContextValue = {
  /** Тема, применённая к палитре (совпадает с активным `floraColors`). */
  themeId: FloraThemeId;
  /** Растёт на каждом применении — ключ для мемо и внешних подписчиков. */
  epoch: number;
};

const FloraThemeContext = createContext<FloraThemeContextValue | null>(null);

/**
 * Контекст темы и растворение снимка после смены палитры.
 *
 * Снимок старого экрана ставит нативный модуль до применения палитры (см.
 * `createFloraThemeTransition`). Здесь — вторая половина: когда дерево с новой
 * палитрой закоммичено, просим модуль растворить снимок. Layout-эффект, а не
 * passive: passive шедулер откладывает на сотни мс на тяжёлом дереве. Эффект
 * корневого провайдера срабатывает после layout-эффектов всех детей, то есть
 * когда новая палитра закоммичена всем деревом.
 */
export function FloraThemeProvider({ children }: { children: ReactNode }) {
  const themeId = useThemeStore((state) => state.appliedThemeId);
  const epoch = useThemeStore((state) => state.version);

  useLayoutEffect(() => {
    if (epoch === 0) return;
    getFloraThemeCrossfade()?.reveal(THEME_CROSSFADE_MS);
  }, [epoch]);

  useEffect(
    () => () => {
      getFloraThemeCrossfade()?.cancel();
    },
    [],
  );

  const value = useMemo<FloraThemeContextValue>(() => ({ themeId, epoch }), [themeId, epoch]);

  return <FloraThemeContext.Provider value={value}>{children}</FloraThemeContext.Provider>;
}

export function useFloraTheme(): FloraThemeContextValue {
  const value = useContext(FloraThemeContext);
  if (!value) {
    throw new Error("useFloraTheme must be used inside FloraThemeProvider");
  }
  return value;
}
