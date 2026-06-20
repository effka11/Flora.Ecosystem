/**
 * Числовые длительности для таймаутов в TS (шаг = `--flora-motion-base` в `app/flora-motion.css`).
 * В CSS — `var(--flora-duration-*)` и `var(--flora-ease-*)` из того же файла (подключён в `globals.css`).
 */
export const FLORA_MOTION_BASE_MS = 150;

export type FloraDurationSteps = 1 | 2 | 3 | 4 | 5 | 6;

export function floraDurationMs(steps: FloraDurationSteps): number {
  return FLORA_MOTION_BASE_MS * steps;
}
