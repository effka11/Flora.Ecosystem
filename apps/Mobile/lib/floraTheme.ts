import { FLORA_THEME_TOKENS } from "@flora/client-core/display";

/**
 * Набор UI-токенов одной темы.
 * Ключи повторяют кросс-клиентский канон `FLORA_THEME_TOKENS`, чтобы mobile
 * оставался зеркалом web-палитры и предвычисленных color-mix.
 */
export type FloraThemeTokens = {
  [K in keyof typeof FLORA_THEME_TOKENS]: string;
};

export type FloraThemeId = "dark" | "light" | "flora";

export const FLORA_THEME_IDS: readonly FloraThemeId[] = ["dark", "light", "flora"];

export type FloraThemeDefinition = {
  id: FloraThemeId;
  label: string;
  description: string;
  /** Тёмная полярность — для статус-бара и служебных решений. */
  isDark: boolean;
  palette: FloraThemeTokens;
};

/**
 * «Флора (старая)» — палитра до перехода на Neutral Black + Cold Silver:
 * тёплый чёрный, зелёный акцент, производные из старого `globals.css`.
 */
const FLORA_LEGACY_PALETTE: FloraThemeTokens = {
  bg: "#0c0c0c",
  whiteTemplate: "#fafafa",
  textSecondary: "#d6d6d6",
  greenLight: "#a4d18a",
  greenDark: "#2c3527",
  signalSolid: "#e8382c",
  signal: "#ff9688",

  accentFillSubtle: "#151814",
  accentFillSubtleHover: "#21281e",
  greenBubble: "#495b3e",

  reserveSurfaceThem: "#111210",
  reserveSubstrateTemplate: "#1f1f1f",
  reserveSubstrateGrayMuted: "#1c1d1b",
  reservePopoverInset: "#1d1e1c",
  reservePopoverAccentSelected: "#2b3426",
  reservePopoverAccentChip: "#23291f",
  reservePopoverDivider: "#2d2e2c",
  reserveSurfaceThemHover: "#131512",
  reserveHoverSurface: "#1f1f1f",
  reserveHoverOnSurfaceThem: "#242523",

  gray: "#8f8f8f",
  grayHover: "#d6d6d6",
  grayDivider: "#1e1e1e",

  gridLine: "#2a3325",
  gridLineFine: "#1b2019",

  textOnBubble: "#fafafa",

  messagesBubbleThemBg: "#111210",
  messagesBubbleThemText: "#dedede",
  messagesBubbleThemTime: "#a4a4a4",

  accentGreenOverlay20: "#2a3325",
  accentTint14OnSurfaceThem: "#262d21",
  accentTint18OnSurfaceThem: "#2c3426",
};

/**
 * Светлая тема — инверсия пары по documents/design/brand-colors-research.md §3:
 * холст #f3f5f8, чернила #0a0a0a, серый #63686e.
 */
const LIGHT_PALETTE: FloraThemeTokens = {
  bg: "#f3f5f8",
  whiteTemplate: "#0a0a0a",
  textSecondary: "#63686e",
  greenLight: "#0a0a0a",
  greenDark: "#c9cbcd",
  signalSolid: "#e8382c",
  signal: "#c21a14",

  accentFillSubtle: "#e5e7ea",
  accentFillSubtleHover: "#d2d4d7",
  greenBubble: "#8a8b8d",

  reserveSurfaceThem: "#ffffff",
  reserveSubstrateTemplate: "#e0e2e5",
  reserveSubstrateGrayMuted: "#e0e2e5",
  reservePopoverInset: "#f2f3f5",
  reservePopoverAccentSelected: "#d2d4d7",
  reservePopoverAccentChip: "#dfe1e3",
  reservePopoverDivider: "#e0e1e3",
  reserveSurfaceThemHover: "#ebedf0",
  reserveHoverSurface: "#e0e2e5",
  reserveHoverOnSurfaceThem: "#ececec",

  gray: "#82878c",
  grayHover: "#63686e",
  grayDivider: "#e3e6e9",

  gridLine: "#c4c6c8",
  gridLineFine: "#dcdee0",

  textOnBubble: "#0a0a0a",

  messagesBubbleThemBg: "#e3e5e8",
  messagesBubbleThemText: "#292b2d",
  messagesBubbleThemTime: "#6b6f73",

  accentGreenOverlay20: "#c3c5c8",
  accentTint14OnSurfaceThem: "#dedfe1",
  accentTint18OnSurfaceThem: "#d1d2d4",
};

export const FLORA_THEMES: Record<FloraThemeId, FloraThemeDefinition> = {
  dark: {
    id: "dark",
    label: "Тёмная",
    description: "Нейтральный чёрный и холодное серебро",
    isDark: true,
    palette: { ...FLORA_THEME_TOKENS },
  },
  light: {
    id: "light",
    label: "Светлая",
    description: "Светлый холст и чернила",
    isDark: false,
    palette: LIGHT_PALETTE,
  },
  flora: {
    id: "flora",
    label: "Flora (старая)",
    description: "Зелёный акцент прежней Flora",
    isDark: true,
    palette: FLORA_LEGACY_PALETTE,
  },
};

export const DEFAULT_FLORA_THEME_ID: FloraThemeId = "dark";

export function isFloraThemeId(value: unknown): value is FloraThemeId {
  return typeof value === "string" && (FLORA_THEME_IDS as readonly string[]).includes(value);
}

/** `#dde2e8` + 0.12 → `rgba(221, 226, 232, 0.12)`. */
export function floraTokenAlpha(hex: string, alpha: number): string {
  const normalized = hex.replace("#", "");
  const value =
    normalized.length === 3
      ? normalized
          .split("")
          .map((char) => char + char)
          .join("")
      : normalized;
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  if ([red, green, blue].some((channel) => Number.isNaN(channel))) {
    return hex;
  }
  const clampedAlpha = Math.min(1, Math.max(0, alpha));
  return `rgba(${red}, ${green}, ${blue}, ${clampedAlpha})`;
}
