/**
 * Public Flora HTTPS origins. Social and Gov sit on Cloudflare (orange);
 * origin.* is DNS-only for SSE and oversized PUT that a CDN would buffer or cap.
 *
 * Release REST uses EXPO_PUBLIC_API_URL (Social CDN). Gov Next is the same
 * Cloudflare pattern: set EXPO_PUBLIC_GOV_URL and/or point a future Gov
 * client at EXPO_PUBLIC_API_URL=https://gov.flora-s.net once flora-gov :3001 is up.
 */

export const FLORA_SOCIAL_CDN_ORIGIN = "https://social.flora-s.net";
export const FLORA_GOV_CDN_ORIGIN = "https://gov.flora-s.net";
export const FLORA_ORIGIN_DIRECT = "https://origin.flora-s.net";

export function stripFloraOriginSlash(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** Civic portal through Cloudflare. Safe to bake before Next on :3001 exists. */
export function resolveGovOrigin(): string {
  const explicit = process.env.EXPO_PUBLIC_GOV_URL?.trim();
  if (explicit) return stripFloraOriginSlash(explicit);
  return FLORA_GOV_CDN_ORIGIN;
}

/** Grey-cloud VPS. Web SSE already uses this; keep for large media PUT if CF body limits bite. */
export function resolveOriginDirect(): string {
  const explicit = process.env.EXPO_PUBLIC_ORIGIN_URL?.trim();
  if (explicit) return stripFloraOriginSlash(explicit);
  return FLORA_ORIGIN_DIRECT;
}
