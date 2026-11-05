export type WebFloraThemeId = "dark" | "light" | "flora";

export const WEB_FLORA_THEME_IDS: readonly WebFloraThemeId[] = ["dark", "light", "flora"];

export const DEFAULT_WEB_FLORA_THEME_ID: WebFloraThemeId = "dark";

export const WEB_FLORA_THEME_STORAGE_KEY = "flora.userSettings.prefs";

export const WEB_FLORA_THEME_ATTR = "data-flora-theme";

export type WebFloraThemeDefinition = {
  id: WebFloraThemeId;
  label: string;
  description: string;
  /** CSS scope with the same palette variables as `[data-flora-theme]`. */
  previewClassName: string;
};

export const WEB_FLORA_THEMES: Record<WebFloraThemeId, WebFloraThemeDefinition> = {
  dark: {
    id: "dark",
    label: "Тёмная",
    description: "Нейтральный чёрный и холодное серебро",
    previewClassName: "flora-theme-dark",
  },
  light: {
    id: "light",
    label: "Светлая",
    description: "Светлый холст и чернила",
    previewClassName: "flora-theme-light",
  },
  flora: {
    id: "flora",
    label: "Flora (старая)",
    description: "Зелёный акцент прежней Flora",
    previewClassName: "flora-theme-flora",
  },
};

export function isWebFloraThemeId(value: unknown): value is WebFloraThemeId {
  return value === "dark" || value === "light" || value === "flora";
}

/** `system` / `midnight` и любые старые значения сходятся в dark. */
export function normalizeWebFloraTheme(value: unknown): WebFloraThemeId {
  return isWebFloraThemeId(value) ? value : DEFAULT_WEB_FLORA_THEME_ID;
}

type StoredPrefs = Record<string, unknown> & {
  customization?: Record<string, unknown>;
};

function readPrefs(): StoredPrefs | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(WEB_FLORA_THEME_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as StoredPrefs) : null;
  } catch {
    return null;
  }
}

export function readStoredWebFloraTheme(): WebFloraThemeId {
  return normalizeWebFloraTheme(readPrefs()?.customization?.theme);
}

export function writeStoredWebFloraTheme(themeId: WebFloraThemeId): void {
  if (typeof window === "undefined") return;
  try {
    const prefs = readPrefs() ?? {};
    const customization =
      prefs.customization && typeof prefs.customization === "object" ? prefs.customization : {};
    window.localStorage.setItem(
      WEB_FLORA_THEME_STORAGE_KEY,
      JSON.stringify({
        ...prefs,
        customization: { ...customization, theme: themeId },
      }),
    );
  } catch {
    /* ignore storage errors */
  }
}
