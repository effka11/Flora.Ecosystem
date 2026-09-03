/** Как CHAT_PUSH_DIM — затемнение поднимающегося слоя. */
export const ENERGETIC_SHEET_DIM = 0.32;

/** Первый кадр открытия: за низом экрана, skip-motion — сразу на месте. */
export function sheetFirstPaintProgress(skipMotion: boolean): number {
  return skipMotion ? 1 : 0;
}

/** Модалка живёт, пока open или пока не закончился выход. */
export function sheetShouldPresent(open: boolean, presented: boolean): boolean {
  return open || presented;
}

export function sheetOpenRising(wasOpen: boolean | null, open: boolean): boolean {
  return open && wasOpen !== true;
}

export function sheetCloseFalling(wasOpen: boolean | null, open: boolean): boolean {
  return !open && wasOpen === true;
}

/**
 * Как runChatPushExit: callback выхода всегда коммитит unmount, если open
 * не выиграл повторно (прерванный close + новый open).
 */
export function sheetShouldCommitClose(stillOpen: boolean): boolean {
  return !stillOpen;
}
