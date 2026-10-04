/**
 * Web bridge onto @flora/client-core authFetch (session coordinator).
 * Always init the API client; prefer relative `/api/...` paths (core applies base).
 */
import {
  ApiRequestError,
  authDelete as coreAuthDelete,
  authFetch,
  authGetJson as coreAuthGetJson,
  authPatchJson as coreAuthPatchJson,
  authPostForm as coreAuthPostForm,
  authPostJson as coreAuthPostJson,
  authPutJson as coreAuthPutJson,
  throwApiRequestError,
} from "@flora/client-core/api";
import { initWebApiClient } from "@/lib/apiClient";

export { ApiRequestError };

function ensureClient(): void {
  initWebApiClient();
}

/**
 * Path for client-core (`/api/...`); strips origin from absolute Web URLs.
 * Rejects protocol-relative `//...` (ambiguous host).
 */
export function toApiPath(urlOrPath: string): string {
  const raw = urlOrPath.trim();
  if (!raw) return "/";
  if (raw.startsWith("//")) {
    throw new Error("Protocol-relative API URLs are not supported.");
  }
  if (raw.startsWith("/")) return raw;
  try {
    const u = new URL(raw);
    return `${u.pathname}${u.search}`;
  } catch {
    return raw.startsWith("/") ? raw : `/${raw}`;
  }
}

export async function authorizedFetch(
  urlOrPath: string,
  init?: RequestInit,
): Promise<Response> {
  ensureClient();
  return authFetch(toApiPath(urlOrPath), init);
}

export async function authGetJson(urlOrPath: string): Promise<unknown> {
  ensureClient();
  return coreAuthGetJson(toApiPath(urlOrPath));
}

export async function authPostJson(
  urlOrPath: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  ensureClient();
  return coreAuthPostJson(toApiPath(urlOrPath), body);
}

export async function authPutJson(
  urlOrPath: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  ensureClient();
  return coreAuthPutJson(toApiPath(urlOrPath), body);
}

export async function authPatchJson(
  urlOrPath: string,
  body: Record<string, unknown> = {},
): Promise<unknown> {
  ensureClient();
  return coreAuthPatchJson(toApiPath(urlOrPath), body);
}

/** PATCH with empty JSON object (legacy Web helpers). */
export async function authPatch(urlOrPath: string): Promise<void> {
  await authPatchJson(urlOrPath, {});
}

export async function authDelete(urlOrPath: string): Promise<void> {
  ensureClient();
  await coreAuthDelete(toApiPath(urlOrPath));
}

export async function authDeleteJson(urlOrPath: string): Promise<unknown> {
  ensureClient();
  const r = await authFetch(toApiPath(urlOrPath), { method: "DELETE" });
  if (!r.ok) await throwApiRequestError(r);
  if (r.status === 204) return null;
  return r.json().catch(() => ({}));
}

/** DELETE with JSON body (notifications batch, 2FA disable). */
export async function authDeleteWithBody(
  urlOrPath: string,
  body: Record<string, unknown>,
): Promise<Response> {
  ensureClient();
  const r = await authFetch(toApiPath(urlOrPath), {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) await throwApiRequestError(r);
  return r;
}

export async function authPostForm(urlOrPath: string, form: FormData): Promise<unknown> {
  ensureClient();
  return coreAuthPostForm(toApiPath(urlOrPath), form);
}

export async function authPost204(urlOrPath: string, body?: Record<string, unknown>): Promise<void> {
  ensureClient();
  const r = await authFetch(toApiPath(urlOrPath), {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok && r.status !== 204) {
    await throwApiRequestError(r);
  }
}

export async function authGetBlob(urlOrPath: string): Promise<Blob> {
  ensureClient();
  const r = await authFetch(toApiPath(urlOrPath), { method: "GET" });
  if (!r.ok) await throwApiRequestError(r);
  return r.blob();
}
