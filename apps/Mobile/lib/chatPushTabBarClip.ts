/**
 * Геометрия дырки таб-бара при chat push: непрозрачны только пиксели с
 * экранным `x < uncoveredWidthPx`. Справа alpha 0 — сквозь дырку виден чат.
 * Считается без RN, чтобы vitest закрыл p=0 / 0.5 / 1; в animated style
 * функции помечены worklet (UI-поток, без hop на JS).
 */

/**
 * Прогресс, по которому рисуется маска бара. Живой маршрут треда закрывает бар
 * целиком: его пиксели не должны всплывать над полем ввода, даже если progress
 * сбросили снаружи (возврат из системного пикера). Вне треда — как раньше,
 * максимум chat/compose push (вход/выход ведёт progress).
 */
export function tabBarMaskProgress(args: {
  threadOpen: boolean;
  chatProgress: number;
  composeProgress: number;
}): number {
  "worklet";
  if (args.threadOpen) return 1;
  return Math.max(args.chatProgress, args.composeProgress);
}

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
