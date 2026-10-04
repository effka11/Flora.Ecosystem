/**
 * Public Flora HTTPS origins. Social and Gov sit on Cloudflare (orange).
 * Clients must not address a grey `origin.*` host: that IP is reachable from
 * networks that block Cloudflare, which is the opposite of the intended door.
 */

export const FLORA_SOCIAL_CDN_ORIGIN = "https://social.flora-s.net";
export const FLORA_GOV_CDN_ORIGIN = "https://gov.flora-s.net";

export function stripFloraOriginSlash(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** Civic portal through Cloudflare. Safe to bake before Next on :3001 exists. */
export function resolveGovOrigin(): string {
  const explicit = process.env.EXPO_PUBLIC_GOV_URL?.trim();
  if (explicit) return stripFloraOriginSlash(explicit);
  return FLORA_GOV_CDN_ORIGIN;
}
