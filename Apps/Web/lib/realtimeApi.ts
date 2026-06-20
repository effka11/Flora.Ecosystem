import { resolvePublicApiRoot } from "@/lib/auth";

/**
 * SSE must bypass Selectel CDN (social.*): long-lived event-stream is buffered or cut off at the edge.
 * Browser calls origin.<apex> directly with Bearer token; API CORS allows social.*.
 */
export function resolveRealtimeStreamApiRoot(): string {
  if (typeof window === "undefined") return resolvePublicApiRoot();

  const explicit = (process.env.NEXT_PUBLIC_REALTIME_API_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (explicit) return explicit;

  const host = window.location.hostname;
  const social = /^social\.(.+)$/.exec(host);
  if (social) return `https://origin.${social[1]}`;

  return resolvePublicApiRoot();
}
