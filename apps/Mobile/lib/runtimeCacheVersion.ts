import { FLORA_GRID_FINE_PX, FLORA_GRID_PRIMARY_PX } from "@flora/client-core/display";
import { DEFAULT_FLORA_THEME_ID, type FloraThemeId } from "@/lib/floraTheme";

/**
 * Нейтральный ключ инвалидации runtime-кэшей (стили, live-записи).
 * Сетка и тема не знают друг о друге: обе пишут сюда свою часть ключа,
 * а `liveGridStyles` / `liveGridRecord` читают один общий ключ.
 */
let gridKey = `${FLORA_GRID_PRIMARY_PX}:${FLORA_GRID_FINE_PX}`;
let themeKey: FloraThemeId = DEFAULT_FLORA_THEME_ID;

export function setFloraRuntimeGridKey(step: number, stepFine: number): void {
  gridKey = `${step}:${stepFine}`;
}

export function setFloraRuntimeThemeKey(themeId: FloraThemeId): void {
  themeKey = themeId;
}

export function getFloraRuntimeCacheKey(): string {
  return `${gridKey}:${themeKey}`;
}
