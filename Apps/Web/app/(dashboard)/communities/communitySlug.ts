/** Синхронно с LatinIdentifiers.NormalizeSlug / ImportedSocialController.NormalizeSlug. */
export const COMMUNITY_SLUG_RE = /^[a-zA-Z0-9_-]{1,100}$/;

export const COMMUNITY_SLUG_FORMAT_MESSAGE =
  "Ссылка: только латиница, цифры, дефис и подчёркивание.";

export function hasOnlyCommunitySlugChars(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed.length > 0 && [...trimmed].every((c) => /[a-zA-Z0-9_-]/.test(c));
}

export function normalizeCommunitySlug(raw: string): string {
  if (!raw.trim()) return "";
  const s = raw.trim().toLowerCase();
  const chars = [...s].filter((c) => c === "-" || c === "_" || /[a-z0-9]/.test(c));
  const joined = chars.join("");
  return joined.length > 100 ? joined.slice(0, 100) : joined;
}
