/**
 * Канонические Flora UI-токены (hex).
 * Источник правды для клиентов: значения из apps/Web/app/globals.css (:root)
 * и предвычисленные color-mix для React Native (без color-mix в рантайме).
 *
 * Палитра — Neutral Black + Cold Silver: два цвета, остальные слоты —
 * уровни серебра на чёрном. Ключи greenLight / greenDark исторические.
 */
export const FLORA_THEME_TOKENS = {
  bg: "#0a0a0a",
  whiteTemplate: "#dde2e8",
  textSecondary: "#b3b7bc",
  greenLight: "#dde2e8",
  greenDark: "#303132",
  like: "#e8382c",
  /** Ошибки, деструктивные действия, бейджи. */
  signal: "#ff9688",

  accentFillSubtle: "#171717",
  accentFillSubtleHover: "#282829",
  greenBubble: "#5e6063",

  reserveSurfaceThem: "#111111",
  reserveSubstrateTemplate: "#1b1b1c",
  reserveSubstrateGrayMuted: "#1c1c1c",
  reservePopoverInset: "#1b1b1c",
  reservePopoverAccentSelected: "#363738",
  reservePopoverAccentChip: "#232425",
  reservePopoverDivider: "#232425",
  reserveSurfaceThemHover: "#141415",
  reserveHoverSurface: "#1b1b1c",
  reserveHoverOnSurfaceThem: "#212222",

  gray: "#979a9e",
  grayHover: "#b3b7bc",
  /** color-mix(gray 14%, bg 86%) */
  grayDivider: "#1e1e1f",

  gridLine: "#343536",
  gridLineFine: "#1f2020",

  /** globals.css --flora-text-on-bubble */
  textOnBubble: "#d5d9df",

  /**
   * .messagesBubbleThem background — color-mix chain из globals + messages.module.css.
   * mix(mix(reserve-bubble-them 10%, accent-fill-subtle-hover 90%) 75%, substrate-gray-muted 25%)
   */
  messagesBubbleThemBg: "#232324",
  /** color-mix(text-on-bubble 74%, gray 26%) */
  messagesBubbleThemText: "#c5c9ce",
  /** color-mix(messagesBubbleThemText 26%, gray 74%) */
  messagesBubbleThemTime: "#a3a6ab",

  /** 20% silver + bg — иконки reply/follow в уведомлениях */
  accentGreenOverlay20: "#343536",
  /** 14% silver на surface-them — активная вкладка эмодзи */
  accentTint14OnSurfaceThem: "#2e2e2f",
  /** 18% silver на surface-them — выбранная категория в рейле */
  accentTint18OnSurfaceThem: "#363738",
} as const;

export type FloraThemeToken = keyof typeof FLORA_THEME_TOKENS;
