import type { NextRequest } from "next/server";

const responseHopByHop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
]);

const forwardableRequestHeaders = new Set([
  "accept",
  "accept-language",
  "authorization",
  "content-type",
  "if-match",
  "if-none-match",
  "if-range",
  "last-event-id",
  "range",
  "user-agent",
  "x-flora-client",
  "x-request-id",
]);

const IS_PRODUCTION = process.env.NODE_ENV === "production";
const REFRESH_COOKIE_NAME = IS_PRODUCTION ? "__Host-flora_refresh" : "flora_refresh";
const REFRESH_COOKIE_MARKER = "http-only";
const REFRESH_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const BROWSER_SESSION_PATH = "/api/auth/browser-session";
const AUTH_TOKEN_RESPONSE_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/refresh",
  "/api/auth/verify-registration",
]);

function refreshCookie(value: string, maxAgeSeconds: number): string {
  const secure = IS_PRODUCTION ? "; Secure" : "";
  return `${REFRESH_COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}; Priority=High${secure}`;
}

function clearRefreshCookie(): string {
  return refreshCookie("", 0);
}

function refreshTokenFromPayload(payload: Record<string, unknown>): {
  key: "refreshToken" | "RefreshToken";
  token: string;
} | null {
  if (typeof payload.refreshToken === "string" && payload.refreshToken) {
    return { key: "refreshToken", token: payload.refreshToken };
  }
  if (typeof payload.RefreshToken === "string" && payload.RefreshToken) {
    return { key: "RefreshToken", token: payload.RefreshToken };
  }
  return null;
}

/**
 * Public origin as seen by the browser behind nginx.
 * Trust only headers nginx overwrites (`Host`, `X-Forwarded-Proto`).
 * Do not prefer client-controlled `X-Forwarded-Host`.
 */
function requestPublicOrigin(request: NextRequest): string | null {
  const host =
    request.headers.get("host")?.split(",")[0]?.trim() || request.nextUrl.host;
  if (!host) return null;
  const forwardedProto = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  const proto =
    forwardedProto === "http" || forwardedProto === "https"
      ? forwardedProto
      : request.nextUrl.protocol.replace(/:$/, "") || "https";
  return `${proto}://${host}`;
}

function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const originUrl = new URL(origin).origin;
    const publicOrigin = requestPublicOrigin(request);
    if (publicOrigin && originUrl === publicOrigin) return true;
    return originUrl === request.nextUrl.origin;
  } catch {
    return false;
  }
}

/** Browser POST/fetch carries Origin and modern browsers also add Sec-Fetch-Site.
 * Native/API clients do not; they must receive refresh tokens for secure device storage.
 * Never use X-Flora-Client for this decision because browser script can forge it.
 */
function usesBrowserCookieSession(request: NextRequest): boolean {
  return request.headers.has("origin") || request.headers.has("sec-fetch-site");
}

function upstreamBase(): string | null {
  const raw = (process.env.FLORA_API_UPSTREAM ?? "").trim().replace(/\/+$/, "");
  return raw.length > 0 ? raw : null;
}

function forwardableHeaders(request: NextRequest): Headers {
  const out = new Headers();
  request.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (!forwardableRequestHeaders.has(lower)) return;
    out.set(key, value);
  });
  return out;
}

/** Forwards the request to flora-api preserving path and query (e.g. /api/auth/*, /api/messaging/*). */
export async function proxyFloraApiRequest(request: NextRequest): Promise<Response> {
  const method = request.method.toUpperCase();
  if (request.nextUrl.pathname === BROWSER_SESSION_PATH && method === "DELETE") {
    const headers = new Headers({ "Cache-Control": "no-store" });
    headers.set("Set-Cookie", clearRefreshCookie());
    return new Response(null, { status: 204, headers });
  }

  const base = upstreamBase();
  if (!base) {
    console.error("Flora API proxy is not configured");
    return Response.json({ error: "Сервис API временно недоступен." }, { status: 503 });
  }

  const targetPath = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  const targetUrl = `${base}${targetPath}`;

  const headers = forwardableHeaders(request);

  let body: ArrayBuffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const raw = await request.arrayBuffer();
    if (raw.byteLength > 0) body = raw;
  }
  const browserCookieSession = usesBrowserCookieSession(request);
  if (
    browserCookieSession &&
    request.nextUrl.pathname === "/api/auth/refresh" &&
    method === "POST"
  ) {
    const cookieToken = request.cookies.get(REFRESH_COOKIE_NAME)?.value;
    if (cookieToken) {
      if (!isSameOrigin(request)) {
        const denied = new Headers({
          "Cache-Control": "no-store",
          "Content-Type": "application/json; charset=utf-8",
        });
        denied.set("Set-Cookie", clearRefreshCookie());
        return new Response(JSON.stringify({ error: "Cross-origin refresh is not allowed." }), {
          status: 403,
          headers: denied,
        });
      }
      body = new TextEncoder().encode(JSON.stringify({ refreshToken: cookieToken })).buffer;
      headers.set("content-type", "application/json");
    }
  }
  if (!body) {
    headers.delete("content-length");
    headers.delete("transfer-encoding");
  }

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method,
      headers,
      body,
      redirect: "manual",
    });
  } catch (error) {
    console.error("Flora API upstream request failed", {
      base,
      cause: error instanceof Error ? error.name : "unknown",
    });
    return Response.json({ error: "Сервис API временно недоступен." }, { status: 502 });
  }

  const responseHeaders = new Headers(upstream.headers);
  responseHopByHop.forEach((name) => {
    responseHeaders.delete(name);
  });

  const pathname = request.nextUrl.pathname;
  if (AUTH_TOKEN_RESPONSE_PATHS.has(pathname)) {
    responseHeaders.set("Cache-Control", "no-store");

    if (upstream.ok && browserCookieSession) {
      responseHeaders.delete("content-length");
      const responseText = await upstream.text();
      let payload: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(responseText);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          payload = parsed as Record<string, unknown>;
        }
      } catch {
        // Preserve malformed upstream responses so the existing client-side validation rejects them.
      }

      const refresh = payload ? refreshTokenFromPayload(payload) : null;
      if (payload && refresh) {
        delete payload.refreshToken;
        delete payload.RefreshToken;
        payload[refresh.key] = REFRESH_COOKIE_MARKER;
        responseHeaders.set(
          "Set-Cookie",
          refreshCookie(refresh.token, REFRESH_COOKIE_MAX_AGE_SECONDS),
        );
        responseHeaders.set("content-type", "application/json; charset=utf-8");
        return new Response(JSON.stringify(payload), {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: responseHeaders,
        });
      }

      return new Response(responseText, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    }

    if (
      browserCookieSession &&
      pathname === "/api/auth/refresh" &&
      (upstream.status === 401 || upstream.status === 403)
    ) {
      responseHeaders.set("Set-Cookie", clearRefreshCookie());
    }
  }

  if (
    browserCookieSession &&
    upstream.ok &&
    (pathname === "/api/auth/logout" || pathname === "/api/auth/delete-account")
  ) {
    responseHeaders.set("Set-Cookie", clearRefreshCookie());
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export function floraApiProxyOptions(_request: NextRequest): Response {
  return new Response(null, { status: 204 });
}
