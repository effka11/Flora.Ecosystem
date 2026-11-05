import { mmkv } from "@/lib/mmkv";
import {
  DEFAULT_FLORA_THEME_ID,
  isFloraThemeId,
  type FloraThemeId,
} from "@/lib/floraTheme";

const STORAGE_KEY = "flora.userSettings.theme.v2";
/**
 * v1 → v2: разовый сброс на dark при переходе на монохромную палитру.
 * Старый ключ больше не читается; выбор пользователя после обновления
 * снова сохраняется в v2.
 */
const LEGACY_STORAGE_KEY = "flora.userSettings.theme";

export type FloraThemeStorage = {
  load: () => FloraThemeId;
  save: (themeId: FloraThemeId) => void;
};

/** Персист темы на устройстве; создаётся один раз в `stores/themeStore`. */
export function createFloraThemeStorage(): FloraThemeStorage {
  return {
    load() {
      try {
        try {
          mmkv.delete(LEGACY_STORAGE_KEY);
        } catch {
          /* cleanup must not block reading the current theme */
        }
        const raw = mmkv.getString(STORAGE_KEY);
        return isFloraThemeId(raw) ? raw : DEFAULT_FLORA_THEME_ID;
      } catch {
        return DEFAULT_FLORA_THEME_ID;
      }
    },
    save(themeId) {
      mmkv.set(STORAGE_KEY, themeId);
    },
  };
}
