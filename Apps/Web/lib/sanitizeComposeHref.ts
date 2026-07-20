const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const ABSOLUTE_HTTP_URL = /^https?:\/\//i;

/**
 * User-authored markdown links may navigate only to HTTP(S) or a same-origin
 * path/fragment. Returning null renders the label as plain text.
 */
export function sanitizeComposeHref(rawHref: string): string | null {
  const href = rawHref.trim();
  if (!href || CONTROL_CHARACTERS.test(href)) return null;

  if (href.startsWith("#") || href.startsWith("?")) return href;
  if (href.startsWith("/") && !href.startsWith("//") && !href.startsWith("/\\")) {
    return href;
  }
  if (!ABSOLUTE_HTTP_URL.test(href)) return null;

  try {
    const parsed = new URL(href);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    return href;
  } catch {
    return null;
  }
}
