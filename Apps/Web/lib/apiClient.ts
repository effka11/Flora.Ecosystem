import {
  configureApiClient,
  ensureFreshAccessToken as ensureCoreAccessToken,
  getApiClientConfig,
  refreshSession as refreshCoreSession,
  refreshSessionIfPossible as refreshCoreSessionIfPossible,
  supersedeSessionRefresh,
  syncStoredSessionTokens as syncCoreSessionTokens,
  type SessionRefreshOutcome,
} from "@flora/client-core/api";
import {
  runWebAuthExclusive,
  webSessionStore,
} from "./sessionStore";

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
// Two coordinator attempts plus its 500 ms ambiguity delay finish before the
// 16 s Web-Lock acquisition bound, so login/logout never bypass a live retry.
const REFRESH_FETCH_TIMEOUT_MS = 7_000;
/** SSE open only needs headers; keep generous vs API cold-start, not body lifetime. */
const EVENT_STREAM_FETCH_TIMEOUT_MS = 60_000;

let apiClientInitialized = false;
let unauthorizedRedirectScheduled = false;

/** Browser API root. Empty means same-origin Next proxy routes. */
export function resolvePublicApiRoot(): string {
  return (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").trim().replace(/\/+$/, "");
}

export function publicApiUrl(path: string): string {
  const root = resolvePublicApiRoot();
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return root ? `${root}${suffix}` : suffix;
}

export function authPublicFetchUrl(path: string): string {
  return publicApiUrl(path);
}

function scheduleUnauthorizedRedirect(): void {
  if (typeof window === "undefined" || unauthorizedRedirectScheduled) return;
  if (window.location.pathname === "/login") return;
  unauthorizedRedirectScheduled = true;
  queueMicrotask(() => {
    window.location.replace("/login");
  });
}

function combineAbortSignals(
  timeoutController: AbortController,
  external: AbortSignal | null | undefined,
): () => void {
  if (!external) return () => undefined;
  if (external.aborted) {
    timeoutController.abort(external.reason);
    return () => undefined;
  }
  const abort = () => timeoutController.abort(external.reason);
  external.addEventListener("abort", abort, { once: true });
  return () => external.removeEventListener("abort", abort);
}

/** All Web auth requests are bounded so a held Web Lock cannot stall indefinitely. */
export async function webApiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const detach = combineAbortSignals(controller, init.signal);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    detach();
  }
}

export function isAuthRefreshRequest(input: RequestInfo | URL): boolean {
  const rawUrl =
    typeof input === "string"
      ? input
      : "url" in input
        ? input.url
        : input.href;
  const baseUrl =
    typeof window === "undefined" ? "http://localhost/" : window.location.href;
  try {
    return new URL(rawUrl, baseUrl).pathname.endsWith("/api/auth/refresh");
  } catch {
    return false;
  }
}

function isEventStreamRequest(init?: RequestInit): boolean {
  if (!init?.headers) return false;
  const accept = new Headers(init.headers).get("accept") ?? "";
  return accept.includes("text/event-stream");
}

const webClientCoreFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  webApiFetch(
    input,
    init,
    isAuthRefreshRequest(input)
      ? REFRESH_FETCH_TIMEOUT_MS
      : isEventStreamRequest(init)
        ? EVENT_STREAM_FETCH_TIMEOUT_MS
        : DEFAULT_FETCH_TIMEOUT_MS,
  )) as typeof fetch;

/** Safe for eager imports and HMR; configuring API never controls sodium setup. */
export function initWebApiClient(): void {
  if (apiClientInitialized) return;
  try {
    const existing = getApiClientConfig();
    if (existing.session === webSessionStore) {
      apiClientInitialized = true;
      return;
    }
  } catch {
    // No configured client yet.
  }

  configureApiClient({
    apiBaseUrl: resolvePublicApiRoot(),
    session: webSessionStore,
    clientIdentity: {
      platform: "web",
      appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? "0.9.0-alpha",
    },
    fetchImpl: webClientCoreFetch,
    runRefreshExclusive: runWebAuthExclusive,
    onUnauthorized: scheduleUnauthorizedRedirect,
  });
  apiClientInitialized = true;
}

export async function refreshSession(): Promise<SessionRefreshOutcome> {
  initWebApiClient();
  return refreshCoreSession();
}

export async function refreshSessionIfPossible(): Promise<boolean> {
  initWebApiClient();
  return refreshCoreSessionIfPossible();
}

export async function ensureFreshAccessToken(options?: { skewMs?: number }): Promise<void> {
  initWebApiClient();
  await ensureCoreAccessToken(options);
}

export async function syncStoredSessionTokens(options?: { skewMs?: number }): Promise<void> {
  initWebApiClient();
  await syncCoreSessionTokens(options);
}

export function supersedeWebSessionRefresh(): void {
  initWebApiClient();
  supersedeSessionRefresh();
}

/** Best-effort cookie cleanup is ordered after any in-flight cookie mutation. */
export function clearBrowserSessionCookie(): void {
  if (typeof window === "undefined" || resolvePublicApiRoot()) return;
  void runWebAuthExclusive(async () => {
    await webApiFetch("/api/auth/browser-session", {
      method: "DELETE",
      credentials: "same-origin",
      keepalive: true,
    });
  }).catch(() => {
    // The canonical tombstone remains authoritative; retry on a later explicit logout.
  });
}

export { runWebAuthExclusive };
