export const FLORA_GOV_DOCUMENT_TITLE = "Flora Gov";

/**
 * Единый разделитель «тире» в UI-тексте Apps/Gov (вкладки, правила, aria-label).
 * Визуально: `Flora Gov  –  Модерация`.
 *
 * Обычные пробелы HTML схлопывает в один — поэтому два `\u00A0` с каждой стороны,
 * не `"  –  "`. Не заменять на длинное тире `—` (U+2014).
 */
export const FLORA_TITLE_SEPARATOR = "\u00A0\u00A0–\u00A0\u00A0";

/** Единый формат вкладки: `Flora Gov  –  Модерация`. */
export function formatGovDocumentTitle(pageTitle: string): string {
  const trimmed = pageTitle.trim();
  if (!trimmed) return FLORA_GOV_DOCUMENT_TITLE;
  return `${FLORA_GOV_DOCUMENT_TITLE}${FLORA_TITLE_SEPARATOR}${trimmed}`;
}
