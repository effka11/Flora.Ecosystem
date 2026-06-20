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

let refreshInFlight: Promise<boolean> | null = null;

export async function refreshSessionIfPossible(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  const { session, fetchImpl = fetch } = getApiClientConfig();
  const refreshToken = await session.getRefreshToken();
  if (!refreshToken) return false;

  refreshInFlight = (async () => {
    try {
      const r = await fetchImpl(apiUrl("/api/auth/refresh"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (!r.ok) {
        await session.clearSession(false);
        return false;
      }
      const raw = await r.json();
      const { parseLoginPayload } = await import("../contracts/auth.js");
      const parsed = parseLoginPayload(raw);
      await session.saveSession({
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
        expiresAt: parsed.expiresAt,
      });
      return true;
    } catch {
      await session.clearSession(false);
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export async function authFetch(
  path: string,
  init: RequestInit = {},
  options?: { baseUrl?: string },
): Promise<Response> {
  const { session, fetchImpl = fetch, onUnauthorized, onUpgradeRequired } = getApiClientConfig();
  let token = await session.getAccessToken();
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
    await session.clearSession(false);
    onUnauthorized?.();
    throw new ApiRequestError(401, await parseErrorMessage(r));
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
    await session.clearSession(false);
    onUnauthorized?.();
    throw new ApiRequestError(401, await parseErrorMessage(r));
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
