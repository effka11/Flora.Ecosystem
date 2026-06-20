/**
 * Канонические Flora UI-токены (hex).
 * Источник правды для клиентов: значения из Apps/Web/app/globals.css (:root)
 * и предвычисленные color-mix для React Native (без color-mix в рантайме).
 */
export const FLORA_THEME_TOKENS = {
  bg: "#0c0c0c",
  whiteTemplate: "#fafafa",
  greenLight: "#a4d18a",
  greenDark: "#2c3527",
  like: "#e8382c",

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
  /** color-mix(gray 14%, bg 86%) */
  grayDivider: "#1e1e1e",

  gridLine: "#2a3325",
  gridLineFine: "#1b2019",

  /** messages.module.css --flora-text-on-bubble */
  textOnBubble: "#f2f4f2",

  /**
   * .messagesBubbleThem background — color-mix chain из globals + messages.module.css.
   * mix(mix(reserve-bubble-them 10%, accent-fill-subtle-hover 90%) 75%, substrate-gray-muted 25%)
   */
  messagesBubbleThemBg: "#1e241d",
  /** color-mix(text-on-bubble 74%, gray 26%) */
  messagesBubbleThemText: "#d8dad8",
  /** color-mix(messagesBubbleThemText 26%, gray 74%) */
  messagesBubbleThemTime: "#a2a3a2",

  /** 20% green-light + bg — иконки reply/follow в уведомлениях */
  accentGreenOverlay20: "#2a3325",
  /** 14% green-light на surface-them — активная вкладка эмодзи */
  accentTint14OnSurfaceThem: "#1a1f18",
  /** 18% green-light на surface-them — выбранная категория в рейле */
  accentTint18OnSurfaceThem: "#232a1f",
} as const;

export type FloraThemeToken = keyof typeof FLORA_THEME_TOKENS;
