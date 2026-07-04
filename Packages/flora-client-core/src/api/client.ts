import { ApiRequestError } from "../api/errors.js";
import type { ClientIdentity, SessionStore } from "./types.js";

declare const __DEV__: boolean | undefined;

export type ApiClientConfig = {
  apiBaseUrl: string;
  session: SessionStore;
  clientIdentity: ClientIdentity;
  fetchImpl?: typeof fetch;
  onUnauthorized?: () => void;
  onUpgradeRequired?: () => void;
  onPascalFallback?: (key: string) => void;
};

let _config: ApiClientConfig | null = null;
let _primedBaseUrl: string | null = null;

/** Ранний URL до полного configureApiClient (display-хелперы при eager import экранов). */
export function primeApiBaseUrl(apiBaseUrl: string): void {
  _primedBaseUrl = apiBaseUrl.replace(/\/+$/, "");
}

function resolvedApiBaseUrl(): string | null {
  return (_config?.apiBaseUrl ?? _primedBaseUrl)?.replace(/\/+$/, "") ?? null;
}

export function configureApiClient(config: ApiClientConfig): void {
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

type ApiErrorBody = { error?: string; detail?: string; Detail?: string };

async function parseErrorMessage(r: Response): Promise<string> {
  const data = (await r.json().catch(() => ({}))) as ApiErrorBody;
  const base = typeof data.error === "string" ? data.error : `Ошибка ${r.status}`;
  const detailRaw = data.detail ?? data.Detail;
  const detail = typeof detailRaw === "string" && detailRaw.trim().length > 0 ? detailRaw.trim() : "";
  if (!detail || base.includes(detail)) return base;
  return `${base} (${detail})`;
}

function buildHeaders(token: string | null, extra?: RequestInit["headers"]): Headers {
  const { clientIdentity } = getApiClientConfig();
  const h = new Headers(extra);
  h.set("X-Flora-Client", `${clientIdentity.platform}/${clientIdentity.appVersion}`);
  if (token) h.set("Authorization", `Bearer ${token}`);
  return h;
}

const DEFAULT_ACCESS_SKEW_MS = 120_000;
const MIN_PROACTIVE_REFRESH_MS = 60_000;

let refreshInFlight: Promise<boolean> | null = null;
let lastProactiveRefreshAttemptAt = 0;

type RefreshAttemptResult = "success" | "auth_failed" | "transient_failed";

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

async function resolveAccessExpiresAtMs(
  session: SessionStore,
  accessToken: string,
): Promise<number | null> {
  const stored = await session.getExpiresAt();
  if (stored) {
    const ms = Date.parse(stored);
    if (!Number.isNaN(ms)) return ms;
  }
  return decodeJwtExpMs(accessToken);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function notifyUnauthorized(onUnauthorized?: () => void): void {
  const handler = onUnauthorized ?? getApiClientConfig().onUnauthorized;
  handler?.();
}

/** True when both tokens are gone — session was revoked server-side. */
async function isSessionFullyRevoked(session: SessionStore): Promise<boolean> {
  const [refreshToken, accessToken] = await Promise.all([
    session.getRefreshToken(),
    session.getAccessToken(),
  ]);
  return !refreshToken && !accessToken;
}

/** Sync UI/logout handler after proactive refresh cleared SecureStore. */
export async function notifyIfSessionRevoked(onUnauthorized?: () => void): Promise<boolean> {
  const { session } = getApiClientConfig();
  if (!(await isSessionFullyRevoked(session))) return false;
  await session.clearSession(false);
  notifyUnauthorized(onUnauthorized);
  return true;
}

async function refreshSessionOnce(): Promise<RefreshAttemptResult> {
  const { session, fetchImpl = fetch } = getApiClientConfig();
  const refreshToken = await session.getRefreshToken();
  if (!refreshToken) return "auth_failed";

  try {
    const r = await fetchImpl(apiUrl("/api/auth/refresh"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (r.status === 401 || r.status === 403) {
      await session.clearSession(false);
      return "auth_failed";
    }
    if (!r.ok) {
      return "transient_failed";
    }
    const raw = await r.json();
    const { parseLoginPayload } = await import("../contracts/auth.js");
    try {
      const parsed = parseLoginPayload(raw);
      await session.saveSession({
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
        expiresAt: parsed.expiresAt,
      });
      return "success";
    } catch {
      await session.clearSession(false);
      return "auth_failed";
    }
  } catch {
    return "transient_failed";
  }
}

/** @internal Resets in-memory refresh throttle between Vitest cases. */
export function resetSessionRefreshStateForTests(): void {
  refreshInFlight = null;
  lastProactiveRefreshAttemptAt = 0;
}

export async function refreshSessionIfPossible(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      let result = await refreshSessionOnce();
      if (result === "transient_failed") {
        await sleep(500);
        result = await refreshSessionOnce();
      }
      if (result === "success") {
        return true;
      }
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export async function ensureFreshAccessToken(options?: { skewMs?: number }): Promise<void> {
  const skewMs = options?.skewMs ?? DEFAULT_ACCESS_SKEW_MS;
  const { session } = getApiClientConfig();
  const accessToken = await session.getAccessToken();
  if (!accessToken) return;

  const expiresAtMs = await resolveAccessExpiresAtMs(session, accessToken);
  const now = Date.now();
  const shouldRefresh =
    expiresAtMs === null ? true : now >= expiresAtMs - skewMs;
  if (!shouldRefresh) return;

  if (now - lastProactiveRefreshAttemptAt < MIN_PROACTIVE_REFRESH_MS) return;
  lastProactiveRefreshAttemptAt = now;
  await refreshSessionIfPossible();
}

/** Proactive refresh + immediate logout when refresh token revoked (App resume / NetInfo). */
export async function syncStoredSessionTokens(options?: { skewMs?: number }): Promise<void> {
  await ensureFreshAccessToken(options);
  await notifyIfSessionRevoked();
}

async function throwUnauthorizedResponse(
  r: Response,
  onUnauthorized?: () => void,
): Promise<never> {
  const { session } = getApiClientConfig();
  const message = await parseErrorMessage(r);
  const refreshToken = await session.getRefreshToken();
  if (!refreshToken) {
    await session.clearSession(false);
    notifyUnauthorized(onUnauthorized);
  }
  throw new ApiRequestError(401, message);
}

/** Upload helpers: same logout rules as authFetch final 401 branch. */
export async function rejectUploadUnauthorized(
  status: number,
  message: string,
  onUnauthorized?: () => void,
): Promise<never> {
  if (status !== 401) throw new ApiRequestError(status, message);
  const { session } = getApiClientConfig();
  const refreshToken = await session.getRefreshToken();
  if (refreshToken) {
    throw new ApiRequestError(401, message);
  }
  await session.clearSession(false);
  notifyUnauthorized(onUnauthorized);
  throw new ApiRequestError(401, message);
}

export async function authFetch(
  path: string,
  init: RequestInit = {},
  options?: { baseUrl?: string },
): Promise<Response> {
  const { session, fetchImpl = fetch, onUnauthorized, onUpgradeRequired } = getApiClientConfig();
  let token = await session.getAccessToken();
  if (!token) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");

  await ensureFreshAccessToken();
  if (await notifyIfSessionRevoked(onUnauthorized)) {
    throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");
  }
  token = (await session.getAccessToken()) ?? token;

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
    throw new ApiRequestError(426, await parseErrorMessage(r));
  }
  if (r.status === 401) {
    if (await refreshSessionIfPossible()) {
      token = await session.getAccessToken();
      if (token) r = await doFetch(token);
    }
  }
  if (r.status === 426) {
    onUpgradeRequired?.();
    throw new ApiRequestError(426, await parseErrorMessage(r));
  }
  if (r.status === 401) {
    return throwUnauthorizedResponse(r, onUnauthorized);
  }
  return r;
}

export async function authGetJson(path: string): Promise<unknown> {
  const r = await authFetch(path, { method: "GET" });
  if (!r.ok) throw new ApiRequestError(r.status, await parseErrorMessage(r));
  return r.json().catch(() => ({}));
}

export async function authGetArrayBuffer(path: string): Promise<ArrayBuffer> {
  const r = await authFetch(path, { method: "GET" });
  if (!r.ok) throw new ApiRequestError(r.status, await parseErrorMessage(r));
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
    throw new ApiRequestError(r.status, await parseErrorMessage(r));
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
  if (!r.ok) throw new ApiRequestError(r.status, await parseErrorMessage(r));
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
    throw new ApiRequestError(r.status, await parseErrorMessage(r));
  }
  if (r.status === 204) return null;
  return r.json().catch(() => ({}));
}

export async function authPostForm(path: string, form: FormData): Promise<unknown> {
  const { session, fetchImpl = fetch, onUnauthorized, onUpgradeRequired, clientIdentity } =
    getApiClientConfig();
  let token = await session.getAccessToken();
  if (!token) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");

  await ensureFreshAccessToken();
  if (await notifyIfSessionRevoked(onUnauthorized)) {
    throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");
  }
  token = (await session.getAccessToken()) ?? token;

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
    throw new ApiRequestError(426, await parseErrorMessage(r));
  }
  if (r.status === 401) {
    if (await refreshSessionIfPossible()) {
      token = await session.getAccessToken();
      if (token) r = await doFetch(token);
    }
  }
  if (r.status === 426) {
    onUpgradeRequired?.();
    throw new ApiRequestError(426, await parseErrorMessage(r));
  }
  if (r.status === 401) {
    return throwUnauthorizedResponse(r, onUnauthorized);
  }
  if (!r.ok) throw new ApiRequestError(r.status, await parseErrorMessage(r));
  return r.json().catch(() => ({}));
}

export async function authDelete(path: string): Promise<void> {
  const r = await authFetch(path, { method: "DELETE" });
  if (!r.ok) throw new ApiRequestError(r.status, await parseErrorMessage(r));
}

export async function publicPostJson(path: string, body: Record<string, unknown>): Promise<unknown> {
  const { fetchImpl = fetch } = getApiClientConfig();
  const r = await fetchImpl(apiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new ApiRequestError(r.status, await parseErrorMessage(r));
  return r.json().catch(() => ({}));
}

export async function publicGetJson(path: string): Promise<unknown> {
  const { fetchImpl = fetch } = getApiClientConfig();
  const r = await fetchImpl(apiUrl(path), { method: "GET" });
  if (!r.ok) throw new ApiRequestError(r.status, await parseErrorMessage(r));
  return r.json().catch(() => ({}));
}
