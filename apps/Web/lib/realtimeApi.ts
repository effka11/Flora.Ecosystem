import { resolvePublicApiRoot } from "@/lib/auth";

/**
 * SSE uses the same host as the rest of the Web app (`social.*` through
 * Cloudflare). A public grey `origin.*` would be reachable from networks
 * that block CF. nginx already proxies `/api/auth/signals/stream` to
 * flora-api with buffering off; Cloudflare may recycle the connection ~100s,
 * and `connectSignalsStream` reconnects.
 *
 * `NEXT_PUBLIC_REALTIME_API_BASE_URL` is an explicit override for local/dev
 * only — production deploy must not set it.
 */
export function resolveRealtimeStreamApiRoot(): string {
  const explicit = (process.env.NEXT_PUBLIC_REALTIME_API_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  return resolvePublicApiRoot();
}
