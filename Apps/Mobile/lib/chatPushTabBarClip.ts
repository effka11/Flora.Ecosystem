/**
 * Геометрия дырки таб-бара при chat push: непрозрачны только пиксели с
 * экранным `x < uncoveredWidthPx`. Справа alpha 0 — сквозь дырку виден чат.
 * Считается без RN, чтобы vitest закрыл p=0 / 0.5 / 1; в animated style
 * функции помечены worklet (UI-поток, без hop на JS).
 */

/** Видимая полоса бара в экранных координатах: [0, uncoveredWidthPx). */
export function uncoveredWidthPx(progress: number, screenWidth: number): number {
  "worklet";
  if (screenWidth <= 0) {
    return 0;
  }
  const p = progress < 0 ? 0 : progress > 1 ? 1 : progress;
  return (1 - p) * screenWidth;
}

/**
 * translateX полноширинной белой маски так, чтобы непрозрачные пиксели
 * маски совпали с [0, uncoveredWidthPx). Не layout-width и не scaleX+inverse.
 */
export function tabBarMaskTranslateXPx(progress: number, screenWidth: number): number {
  "worklet";
  return uncoveredWidthPx(progress, screenWidth) - screenWidth;
}
