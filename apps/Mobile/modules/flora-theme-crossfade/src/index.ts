import { requireOptionalNativeModule } from "expo-modules-core";
import { Platform } from "react-native";

/**
 * Нативный кроссфейд смены темы: снимок экрана в памяти поверх UI,
 * палитра меняется под ним, после коммита снимок растворяется.
 */
export type FloraThemeCrossfadeApi = {
  /**
   * Снять текущий экран и закрыть им UI. `true` — снимок на экране, можно менять
   * палитру. `false` — переключаться без кроссфейда (нет Activity, reduce motion,
   * ошибка readback). Идемпотентен: при непрозрачном снимке возвращает `true`
   * без пересъёмки, во время fade пересъёмка включает полупрозрачный снимок.
   */
  freeze(): Promise<boolean>;
  /**
   * Новая палитра закоммичена: растворить снимок за `durationMs` после кадра, в
   * котором Fabric уже отрисовал новое дерево. `durationMs <= 0` — убрать без
   * анимации. Во время fade — no-op.
   */
  reveal(durationMs: number): void;
  /** Убрать снимок немедленно. */
  cancel(): void;
};

const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<FloraThemeCrossfadeApi>("FloraThemeCrossfade")
    : null;

/** `null` — модуль не слинкован (iOS, старый dev-build): тема переключается мгновенно. */
export function getFloraThemeCrossfade(): FloraThemeCrossfadeApi | null {
  return native;
}
