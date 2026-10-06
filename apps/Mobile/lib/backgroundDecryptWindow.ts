/** Ранги 1–4 расшифровывают страницу целиком, остальные — только хвост. */
export const BACKGROUND_DECRYPT_FULL_PAGE_RANKS = 4;
export const BACKGROUND_DECRYPT_TAIL = 24;

export function messagesForBackgroundDecrypt<T>(messages: readonly T[], rank: number): readonly T[] {
  if (rank <= BACKGROUND_DECRYPT_FULL_PAGE_RANKS) return messages;
  return messages.slice(-BACKGROUND_DECRYPT_TAIL);
}

let windowUnits = 0;

/** Верхняя граница decrypt за проход: сумма окон, не повторные чтения кэша. */
export function noteBackgroundDecryptWindow(count: number): void {
  if (count > 0) windowUnits += count;
}

export function backgroundDecryptWindowUnits(): number {
  return windowUnits;
}

export function resetBackgroundDecryptWindowUnits(): void {
  windowUnits = 0;
}
