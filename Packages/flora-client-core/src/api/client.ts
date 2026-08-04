import { ApiRequestError, parseApiError, throwApiRequestError } from "../api/errors.js";
import type { ClientIdentity, SessionRecord, SessionStore } from "./types.js";
import {
  SessionRefreshCoordinator,
  type RunRefreshExclusive,
  type SessionRefreshOutcome,
} from "./sessionCoordinator.js";

declare const __DEV__: boolean | undefined;

export type ApiClientConfig = {
  apiBaseUrl: string;
  session: SessionStore;
  clientIdentity: ClientIdentity;
  fetchImpl?: typeof fetch;
  onUnauthorized?: () => void;
  onUpgradeRequired?: () => void;
  onPascalFallback?: (key: string) => void;
  runRefreshExclusive?: RunRefreshExclusive;
  /** Enables re-sending R1 after an ambiguous response. Defaults to false. */
  retrySafeRefreshBackend?: boolean;
};

let _config: ApiClientConfig | null = null;
let _primedBaseUrl: string | null = null;
const sessionRefreshCoordinator = new SessionRefreshCoordinator();

/** Ранний URL до полного configureApiClient (display-хелперы при eager import экранов). */
export function primeApiBaseUrl(apiBaseUrl: string): void {
  _primedBaseUrl = apiBaseUrl.replace(/\/+$/, "");
}

function resolvedApiBaseUrl(): string | null {
  return (_config?.apiBaseUrl ?? _primedBaseUrl)?.replace(/\/+$/, "") ?? null;
}

export function configureApiClient(config: ApiClientConfig): void {
  sessionRefreshCoordinator.supersede();
  _config = config;
  primeApiBaseUrl(config.apiBaseUrl);
}

export function getApiClientConfig(): ApiClientConfig {
  if (!_config) throw new Error("configureApiClient() must be called before API requests.");
  return _config;
}

export function apiUrl(path: string): string {
  const base = resolvedApiBaseUrl();
  if (base === null) throw new Error("configureApiClient() must be called before API requests.");
  const p = path.startsWith("/") ? path : `/${path}`;
  // Пустая база — same-origin относительные пути (Next.js proxy на Web localhost).
  if (base === "") return p;
  return `${base}${p}`;
}

/** @deprecated Prefer `parseApiErrorMessage` from `./errors.js`; kept for historical imports from client. */
export { parseApiErrorMessage } from "../api/errors.js";

function buildHeaders(token: string | null, extra?: RequestInit["headers"]): Headers {
  const { clientIdentity } = getApiClientConfig();
  const h = new Headers(extra);
  h.set("X-Flora-Client", `${clientIdentity.platform}/${clientIdentity.appVersion}`);
  if (token) h.set("Authorization", `Bearer ${token}`);
  return h;
}

const DEFAULT_ACCESS_SKEW_MS = 120_000;
const MIN_PROACTIVE_REFRESH_MS = 60_000;

let lastProactiveRefreshAttemptAt = 0;

function decodeJwtExpMs(accessToken: string): number | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return null;
  const payloadPart = parts[1];
  if (!payloadPart) return null;
  try {
    const payload = JSON.parse(
      atob(payloadPart.replace(/-/g, "+").replace(/_/g, "/")),
    ) as { exp?: unknown };
    if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) {
      return payload.exp * 1000;
    }
  } catch {
    return null;
  }
  return null;
}

function resolveAccessExpiresAtMs(
  session: SessionRecord,
  accessToken: string,
): number | null {
  const stored = session.expiresAt;
  if (stored) {
    const ms = Date.parse(stored);
    if (!Number.isNaN(ms)) return ms;
  }
  return decodeJwtExpMs(accessToken);
}

async function readEffectiveSessionRecord(): Promise<SessionRecord | null> {
  const { session } = getApiClientConfig();
  return sessionRefreshCoordinator.readEffectiveSession(session);
}

export function supersedeSessionRefresh(): void {
  sessionRefreshCoordinator.supersede();
}

export function notifyUnauthorized(onUnauthorized?: () => void): void {
  const handler = onUnauthorized ?? getApiClientConfig().onUnauthorized;
  supersedeSessionRefresh();
  handler?.();
}

/** Sync UI/logout only after the Auth refresh endpoint confirmed Invalid. */
export async function notifyIfSessionRevoked(onUnauthorized?: () => void): Promise<boolean> {
  const { session } = getApiClientConfig();
  if (!(await sessionRefreshCoordinator.isConfirmedInvalidReadyToNotify(session))) {
    return false;
  }
  notifyUnauthorized(onUnauthorized);
  return true;
}

/** @internal Resets in-memory refresh throttle between Vitest cases. */
export function resetSessionRefreshStateForTests(): void {
  sessionRefreshCoordinator.resetForTests();
  lastProactiveRefreshAttemptAt = 0;
}

export function refreshSession(): Promise<SessionRefreshOutcome> {
  const {
    session,
    fetchImpl = fetch,
    onPascalFallback,
    runRefreshExclusive,
    retrySafeRefreshBackend = false,
  } = getApiClientConfig();
  return sessionRefreshCoordinator.refresh({
    session,
    fetchImpl,
    refreshUrl: apiUrl("/api/auth/refresh"),
    onPascalFallback,
    runRefreshExclusive,
    retrySafeRefreshBackend,
  });
}

/**
 * True when the caller should re-read effective access and retry.
 * - `ready`: new tokens committed (or about to be read from store)
 * - `storage_pending`: volatile R2 is authoritative via readEffective
 * - `superseded`: only if effective access differs from the pre-refresh snapshot
 */
export async function refreshSessionIfPossible(
  previousAccess?: string | null,
): Promise<boolean> {
  const before =
    previousAccess === undefined
      ? (await readEffectiveSessionRecord().catch(() => null))?.accessToken ?? null
      : previousAccess;
  const outcome = await refreshSession();
  if (outcome === "ready") return true;
  if (outcome === "storage_pending") {
    return Boolean((await readEffectiveSessionRecord().catch(() => null))?.accessToken);
  }
  if (outcome !== "superseded") return false;
  const after = (await readEffectiveSessionRecord().catch(() => null))?.accessToken;
  return Boolean(after && after !== before);
}

export async function ensureFreshAccessToken(options?: { skewMs?: number }): Promise<void> {
  const skewMs = options?.skewMs ?? DEFAULT_ACCESS_SKEW_MS;
  const { session } = getApiClientConfig();
  if (sessionRefreshCoordinator.hasPendingCommit(session)) {
    await refreshSession();
    return;
  }

  const stored = await readEffectiveSessionRecord().catch(() => null);
  if (!stored?.refresh) return;

  const accessToken = stored.accessToken;
  const expiresAtMs = accessToken
    ? resolveAccessExpiresAtMs(stored, accessToken)
    : null;
  const now = Date.now();
  const shouldRefresh =
    !accessToken || expiresAtMs === null || now >= expiresAtMs - skewMs;
  if (!shouldRefresh) return;

  if (now - lastProactiveRefreshAttemptAt < MIN_PROACTIVE_REFRESH_MS) return;
  lastProactiveRefreshAttemptAt = now;
  await refreshSession();
}

/** Proactive refresh + immediate logout when refresh token revoked (App resume / NetInfo). */
export async function syncStoredSessionTokens(options?: { skewMs?: number }): Promise<void> {
  await ensureFreshAccessToken(options);
  await notifyIfSessionRevoked();
}

async function throwUnauthorizedResponse(
  r: Response,
  _onUnauthorized?: () => void,
): Promise<never> {
  const { message, code } = await parseApiError(r);
  throw new ApiRequestError(401, message, code);
}

/** Upload helpers: same logout rules as authFetch final 401 branch. */
export async function rejectUploadUnauthorized(
  status: number,
  message: string,
  _onUnauthorized?: () => void,
): Promise<never> {
  if (status !== 401) throw new ApiRequestError(status, message);
  throw new ApiRequestError(401, message);
}

/**
 * Recover from resource 401 without needless refresh when store already has a
 * newer access (JTI rotate race). Returns the Response to use (may still be 401).
 *
 * Plan steps: stale-first → refresh → on ready|storage_pending|superseded retry with
 * effective access; on transient retry only if access changed vs the Bearer that just failed.
 */
async function recoverFromResourceUnauthorized(
  usedToken: string,
  originalUnauthorized: Response,
  doFetch: (token: string) => Promise<Response>,
  onUnauthorized?: () => void,
): Promise<{ token: string; response: Response }> {
  let token = usedToken;
  let response = originalUnauthorized;

  const latestBeforeRefresh = (await readEffectiveSessionRecord().catch(() => null))
    ?.accessToken;
  if (latestBeforeRefresh && latestBeforeRefresh !== token) {
    token = latestBeforeRefresh;
    response = await doFetch(token);
    if (response.status !== 401) {
      return { token, response };
    }
  }

  const outcome = await refreshSession();
  if (outcome === "invalid") {
    await notifyIfSessionRevoked(onUnauthorized);
    return { token, response };
  }

  const latest = (await readEffectiveSessionRecord().catch(() => null))?.accessToken;
  if (!latest) {
    return { token, response };
  }

  if (
    outcome === "ready" ||
    outcome === "storage_pending" ||
    outcome === "superseded"
  ) {
    return { token: latest, response: await doFetch(latest) };
  }

  // Compare to the Bearer that just failed (after stale-first), not the original request token.
  if (outcome === "transient" && latest !== token) {
    return { token: latest, response: await doFetch(latest) };
  }

  return { token, response };
}

export async function authFetch(
  path: string,
  init: RequestInit = {},
  options?: { baseUrl?: string },
): Promise<Response> {
  const { fetchImpl = fetch, onUnauthorized, onUpgradeRequired } = getApiClientConfig();

  await ensureFreshAccessToken();
  if (await notifyIfSessionRevoked(onUnauthorized)) {
    throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");
  }
  let token = (await readEffectiveSessionRecord().catch(() => null))?.accessToken;
  if (!token) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");

  const resolveUrl = (p: string) => {
    const base = options?.baseUrl?.trim().replace(/\/+$/, "");
    if (base) {
      const suffix = p.startsWith("/") ? p : `/${p}`;
      return `${base}${suffix}`;
    }
    return apiUrl(p);
  };

  const doFetch = (t: string) =>
    fetchImpl(resolveUrl(path), {
      ...init,
      headers: buildHeaders(t, init.headers),
    });

  let r = await doFetch(token);
  if (r.status === 426) {
    onUpgradeRequired?.();
    await throwApiRequestError(r);
  }
  if (r.status === 401) {
    const recovered = await recoverFromResourceUnauthorized(
      token,
      r,
      doFetch,
      onUnauthorized,
    );
    token = recovered.token;
    r = recovered.response;
  }
  if (r.status === 426) {
    onUpgradeRequired?.();
    await throwApiRequestError(r);
  }
  if (r.status === 401) {
    return throwUnauthorizedResponse(r, onUnauthorized);
  }
  return r;
}

export async function authGetJson(path: string): Promise<unknown> {
  const r = await authFetch(path, { method: "GET" });
  if (!r.ok) await throwApiRequestError(r);
  return r.json().catch(() => ({}));
}

export async function authGetArrayBuffer(path: string): Promise<ArrayBuffer> {
  const r = await authFetch(path, { method: "GET" });
  if (!r.ok) await throwApiRequestError(r);
  return r.arrayBuffer();
}

export async function authPostJson(path: string, body: Record<string, unknown>): Promise<unknown> {
  const r = await authFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.warn("[api] POST failed", r.status, path);
    }
    await throwApiRequestError(r);
  }
  if (r.status === 204) return null;
  return r.json().catch(() => ({}));
}

export async function authPutJson(path: string, body: Record<string, unknown>): Promise<unknown> {
  const r = await authFetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) await throwApiRequestError(r);
  if (r.status === 204) return null;
  return r.json().catch(() => ({}));
}

export async function authPatchJson(path: string, body: Record<string, unknown>): Promise<unknown> {
  const r = await authFetch(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.warn("[api] PATCH failed", r.status, path);
    }
    await throwApiRequestError(r);
  }
  if (r.status === 204) return null;
  return r.json().catch(() => ({}));
}

export async function authPostForm(path: string, form: FormData): Promise<unknown> {
  const { fetchImpl = fetch, onUnauthorized, onUpgradeRequired, clientIdentity } =
    getApiClientConfig();

  await ensureFreshAccessToken();
  if (await notifyIfSessionRevoked(onUnauthorized)) {
    throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");
  }
  let token = (await readEffectiveSessionRecord().catch(() => null))?.accessToken;
  if (!token) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");

  const multipartHeaders = (accessToken: string): Record<string, string> => ({
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "X-Flora-Client": `${clientIdentity.platform}/${clientIdentity.appVersion}`,
  });

  const doFetch = (accessToken: string) =>
    fetchImpl(apiUrl(path), {
      method: "POST",
      body: form,
      headers: multipartHeaders(accessToken),
    });

  let r = await doFetch(token);
  if (r.status === 426) {
    onUpgradeRequired?.();
    await throwApiRequestError(r);
  }
  if (r.status === 401) {
    const recovered = await recoverFromResourceUnauthorized(
      token,
      r,
      doFetch,
      onUnauthorized,
    );
    token = recovered.token;
    r = recovered.response;
  }
  if (r.status === 426) {
    onUpgradeRequired?.();
    await throwApiRequestError(r);
  }
  if (r.status === 401) {
    return throwUnauthorizedResponse(r, onUnauthorized);
  }
  if (!r.ok) await throwApiRequestError(r);
  return r.json().catch(() => ({}));
}

export async function authDelete(path: string): Promise<void> {
  const r = await authFetch(path, { method: "DELETE" });
  if (!r.ok) await throwApiRequestError(r);
}

export async function publicPostJson(path: string, body: Record<string, unknown>): Promise<unknown> {
  const { fetchImpl = fetch } = getApiClientConfig();
  const r = await fetchImpl(apiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) await throwApiRequestError(r);
  return r.json().catch(() => ({}));
}

export async function publicGetJson(path: string): Promise<unknown> {
  const { fetchImpl = fetch } = getApiClientConfig();
  const r = await fetchImpl(apiUrl(path), { method: "GET" });
  if (!r.ok) await throwApiRequestError(r);
  return r.json().catch(() => ({}));
}
