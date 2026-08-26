/**
 * Метрики шрифта текста пузыря и метки времени — один источник для пузыря и
 * для offscreen-прогрева замеров (`MessageTextMeasureWarmHost`).
 *
 * Прогрев обязан мерить теми же метриками, что рисует пузырь: расхождение в
 * одном свойстве (letterSpacing, lineHeight, includeFontPadding) даёт другие
 * ширины строк — и кэш замеров стал бы источником неверной раскладки вместо
 * мгновенно правильной.
 */
import type { TextStyle } from "react-native";

import { floraMessages } from "@/lib/theme";

/** Только layout-значимые свойства: цвет/opacity на замер не влияют. */
export const messageBubbleBodyTextMetrics: TextStyle = {
  fontSize: floraMessages.bubbleFontSize,
  fontWeight: "300",
  letterSpacing: 0.45,
  lineHeight: floraMessages.bubbleLineHeight,
  includeFontPadding: false,
};

export const messageBubbleTimeTextMetrics: TextStyle = {
  fontSize: floraMessages.bubbleTimeFontSize,
  lineHeight: 18,
  includeFontPadding: false,
};
