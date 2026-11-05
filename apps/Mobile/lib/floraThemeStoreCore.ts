import { create } from "zustand";
import type { FloraThemeId } from "@/lib/floraTheme";
import {
  instantFloraThemeTransition,
  type FloraThemeTransition,
} from "@/lib/floraThemeCrossfade";
import { applyFloraTheme } from "@/lib/floraThemeRuntime";

export type FloraThemePersistence = {
  save: (themeId: FloraThemeId) => void;
};

export type FloraThemeState = {
  /** Тема, сохранённая пользователем; переживает перезапуск. */
  savedThemeId: FloraThemeId;
  /** Живой предпросмотр из настроек; на диск не пишется. */
  previewThemeId: FloraThemeId | null;
  /** Тема, применённая к палитре и показанная на экране. */
  appliedThemeId: FloraThemeId;
  /** Растёт только когда меняется фактически применённая тема. */
  version: number;
  /** Выбрать тему в настройках: предпросмотр применяется сразу. */
  selectTheme: (themeId: FloraThemeId) => void;
  /** Зафиксировать предпросмотр на диске. Палитру не трогает. */
  commitTheme: () => FloraThemeId;
  /** Сбросить предпросмотр и вернуть сохранённую тему. */
  discardTheme: () => FloraThemeId;
};

/** Тема, которую выбрал пользователь (предпросмотр или сохранённая). */
export function effectiveFloraThemeId(
  state: Pick<FloraThemeState, "savedThemeId" | "previewThemeId">,
): FloraThemeId {
  return state.previewThemeId ?? state.savedThemeId;
}

/**
 * Единственный владелец темы. Выбор меняется синхронно; палитру применяет
 * стратегия `transition` — по умолчанию сразу, в приложении через нативный
 * кроссфейд (снимок экрана → палитра → растворение после коммита).
 */
export function createFloraThemeStore({
  initialSavedThemeId,
  persistence,
  transition = instantFloraThemeTransition,
}: {
  initialSavedThemeId: FloraThemeId;
  persistence?: FloraThemePersistence;
  transition?: FloraThemeTransition;
}) {
  applyFloraTheme(initialSavedThemeId);

  return create<FloraThemeState>()((set, get) => {
    /** Палитра ← выбранная тема; `true`, если применённая тема изменилась. */
    const applyEffective = (): boolean => {
      const state = get();
      const themeId = effectiveFloraThemeId(state);
      if (themeId === state.appliedThemeId) return false;
      applyFloraTheme(themeId);
      set({ appliedThemeId: themeId, version: state.version + 1 });
      return true;
    };

    /** Запускает переход, только если палитре есть куда меняться. */
    const scheduleApply = () => {
      const state = get();
      if (effectiveFloraThemeId(state) === state.appliedThemeId) return;
      transition(applyEffective);
    };

    return {
      savedThemeId: initialSavedThemeId,
      previewThemeId: null,
      appliedThemeId: initialSavedThemeId,
      version: 0,

      selectTheme(themeId) {
        const current = get();
        const previewThemeId = themeId === current.savedThemeId ? null : themeId;
        if (previewThemeId === current.previewThemeId) return;
        set({ previewThemeId });
        scheduleApply();
      },

      commitTheme() {
        const current = get();
        if (current.previewThemeId === null) return current.savedThemeId;
        persistence?.save(current.previewThemeId);
        set({ savedThemeId: current.previewThemeId, previewThemeId: null });
        return current.previewThemeId;
      },

      discardTheme() {
        const current = get();
        if (current.previewThemeId === null) return current.savedThemeId;
        set({ previewThemeId: null });
        scheduleApply();
        return current.savedThemeId;
      },
    };
  });
}
