import {
  DEFAULT_FLORA_THEME_ID,
  FLORA_THEMES,
  floraTokenAlpha,
  type FloraThemeId,
  type FloraThemeTokens,
} from "@/lib/floraTheme";
import { setFloraRuntimeThemeKey } from "@/lib/runtimeCacheVersion";

/**
 * Семантические алиасы палитры, которыми пользуется UI.
 * Таблица — единственное место, где связаны «роль» и токен палитры.
 */
const FLORA_COLOR_ALIASES = {
  bg: "bg",
  surface: "reserveHoverSurface",
  surfaceElevated: "reserveSurfaceThem",
  text: "whiteTemplate",
  textSecondary: "textSecondary",
  textMuted: "gray",
  accent: "greenLight",
  accentDark: "greenDark",
  signalSolid: "signalSolid",
  signal: "signal",
  border: "grayDivider",
  error: "signal",
  whiteTemplate: "whiteTemplate",
  gray: "gray",
  grayLight: "whiteTemplate",
  greenLight: "greenLight",
  greenDark: "greenDark",
  greenBubble: "greenBubble",
  popoverRail: "reserveSubstrateGrayMuted",
  popoverInset: "reservePopoverInset",
  popoverDivider: "reservePopoverDivider",
  textOnBubble: "textOnBubble",
} as const satisfies Record<string, keyof FloraThemeTokens>;

export type FloraColorAlias = keyof typeof FLORA_COLOR_ALIASES;

type FloraAliasColors = Record<FloraColorAlias, string>;

/**
 * Палитра, которую сейчас читает `floraColors`.
 * Меняется до уведомления React-подписчиков, поэтому первый же кадр
 * после переключения читает уже новую тему.
 */
export type FloraColors = FloraAliasColors & {
  /** Hairline на фоне chrome. */
  hairline: string;
  /** Полупрозрачный тон поверхности: на тёмной теме — серебро, на светлой — чернила. */
  overlay: (alpha: number) => string;
};

function buildFloraColors(palette: FloraThemeTokens): FloraColors {
  const aliases = {} as FloraAliasColors;
  for (const alias of Object.keys(FLORA_COLOR_ALIASES) as FloraColorAlias[]) {
    aliases[alias] = palette[FLORA_COLOR_ALIASES[alias]];
  }
  return {
    ...aliases,
    hairline: floraTokenAlpha(palette.whiteTemplate, 0.08),
    overlay: (alpha: number) => floraTokenAlpha(palette.whiteTemplate, alpha),
  };
}

let activeThemeId: FloraThemeId = DEFAULT_FLORA_THEME_ID;
let activePalette: FloraThemeTokens = FLORA_THEMES[DEFAULT_FLORA_THEME_ID].palette;
let activeColors: FloraColors = buildFloraColors(activePalette);
setFloraRuntimeThemeKey(activeThemeId);

export function getFloraThemeId(): FloraThemeId {
  return activeThemeId;
}

export function getFloraThemePalette(): FloraThemeTokens {
  return activePalette;
}

export function getFloraColors(): FloraColors {
  return activeColors;
}

export function applyFloraTheme(themeId: FloraThemeId): void {
  if (themeId === activeThemeId) return;
  activeThemeId = themeId;
  activePalette = FLORA_THEMES[themeId].palette;
  activeColors = buildFloraColors(activePalette);
  setFloraRuntimeThemeKey(themeId);
}
