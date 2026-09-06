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
/** Cookie name used when *setting* media access (env-specific `__Host-` in production). */
const MEDIA_ACCESS_COOKIE_NAME = IS_PRODUCTION
  ? "__Host-flora_media_access"
  : "flora_media_access";
/**
 * Cookie names accepted when *lifting* to Bearer — same order as flora-api
 * `optional_bearer_jwt` (`__Host-…` then bare name).
 */
const MEDIA_ACCESS_COOKIE_READ_NAMES = [
  "__Host-flora_media_access",
  "flora_media_access",
] as const;
/** Accept current and pre-`__Host-` refresh cookies so a name cutover does not look like logout. */
const REFRESH_COOKIE_READ_NAMES = [
  "__Host-flora_refresh",
  "flora_refresh",
] as const;
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

function mediaAccessCookie(value: string): string {
  const secure = IS_PRODUCTION ? "; Secure" : "";
  return `${MEDIA_ACCESS_COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Priority=High${secure}`;
}

function clearMediaAccessCookie(): string {
  return `${mediaAccessCookie("")}; Max-Age=0`;
}

function clearOtherRefreshCookie(): string {
  const other =
    REFRESH_COOKIE_NAME === "__Host-flora_refresh"
      ? "flora_refresh"
      : "__Host-flora_refresh";
  const secure = IS_PRODUCTION ? "; Secure" : "";
  return `${other}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Priority=High${secure}`;
}

function clearBrowserAuthCookies(headers: Headers): void {
  headers.set("Set-Cookie", clearRefreshCookie());
  headers.append("Set-Cookie", clearOtherRefreshCookie());
  headers.append("Set-Cookie", clearMediaAccessCookie());
}

function refreshCookieFromRequest(request: NextRequest): string | undefined {
  for (const name of REFRESH_COOKIE_READ_NAMES) {
    const token = request.cookies.get(name)?.value?.trim();
    if (token) return token;
  }
  return undefined;
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

function accessTokenFromPayload(payload: Record<string, unknown>): string | null {
  if (typeof payload.accessToken === "string" && payload.accessToken) {
    return payload.accessToken;
  }
  if (typeof payload.AccessToken === "string" && payload.AccessToken) {
    return payload.AccessToken;
  }
  return null;
}

/**
 * Public origin as seen by the browser behind nginx.
 * Trust only headers nginx overwrites (`Host`, `X-Forwarded-Proto`).
 * Do not prefer client-controlled `X-Forwarded-Host`.
 */
function requestPublicOrigin(request: NextRequest): string | null {
  // Prefer nginx-injected Host; fall back to nextUrl.host (tests / direct listen).
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
  const raw = (
    process.env.FLORA_API_UPSTREAM ??
    process.env.API_UPSTREAM_URL ??
    process.env.FLORA_API_INTERNAL_URL ??
    ""
  )
    .trim()
    .replace(/\/+$/, "");
  return raw.length > 0 ? raw : null;
}

function forwardableHeaders(request: NextRequest): Headers {
  const out = new Headers();
  request.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (!forwardableRequestHeaders.has(lower)) return;
    out.set(key, value);
  });

  // Production Next listens on loopback behind nginx, which overwrites X-Real-IP.
  // Collapse any XFF chain to one hop before passing it to flora-api's trusted-proxy resolver.
  const realIp = request.headers.get("x-real-ip")?.trim();
  const forwardedIp = request.headers
    .get("x-forwarded-for")
    ?.split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .at(-1);
  const clientIp = realIp || forwardedIp;
  if (clientIp && !clientIp.includes(",")) out.set("x-forwarded-for", clientIp);

  // Credentialed browser calls often omit Authorization (FRI decode, media GETs).
  // Lift media-access JWT → Bearer on any proxied request; never forward Cookie (refresh).
  applyMediaAccessAuthorization(request, out);

  return out;
}

/**
 * When `Authorization` is absent, map the HttpOnly media-access cookie to
 * `Authorization: Bearer` so flora-api optional JWT sees the viewer.
 */
function applyMediaAccessAuthorization(request: NextRequest, headers: Headers): void {
  if (headers.has("authorization")) return;
  for (const name of MEDIA_ACCESS_COOKIE_READ_NAMES) {
    const token = request.cookies.get(name)?.value?.trim();
    if (!token) continue;
    headers.set("authorization", `Bearer ${token}`);
    return;
  }
}

/** Browser origins allowed to call proxy routes cross-origin (comma-separated HTTPS origins). */
function parseProxyCorsOrigins(): Set<string> {
  const raw = (process.env.FLORA_AUTH_PROXY_CORS_ORIGINS ?? "").trim();
  if (!raw.length) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().replace(/\/+$/, ""))
      .filter(Boolean),
  );
}

function corsAllowedOrigin(request: NextRequest): string | null {
  const origin = request.headers.get("origin")?.trim();
  if (!origin) return null;
  const allowed = parseProxyCorsOrigins();
  if (allowed.size === 0) return null;
  return allowed.has(origin) ? origin : null;
}

function withProxyCors(request: NextRequest, res: Response): Response {
  const allow = corsAllowedOrigin(request);
  if (!allow) return res;
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", allow);
  h.set("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
  const reqHdrs = request.headers.get("access-control-request-headers");
  h.set(
    "Access-Control-Allow-Headers",
    reqHdrs && reqHdrs.trim().length > 0 ? reqHdrs : "Content-Type, Authorization",
  );
  h.set("Access-Control-Max-Age", "86400");
  h.append("Vary", "Origin");
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: h,
  });
}

/** Forwards the request to Flora.API preserving path and query (e.g. /api/auth/*, /api/messaging/*). */
export async function proxyFloraApiRequest(request: NextRequest): Promise<Response> {
  const method = request.method.toUpperCase();
  if (request.nextUrl.pathname === BROWSER_SESSION_PATH && method === "DELETE") {
    const headers = new Headers({ "Cache-Control": "no-store" });
    clearBrowserAuthCookies(headers);
    return new Response(null, { status: 204, headers });
  }

  const base = upstreamBase();
  if (!base) {
    console.error("Flora API proxy is not configured");
    return withProxyCors(
      request,
      Response.json({ error: "Сервис API временно недоступен." }, { status: 503 }),
    );
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
    const cookieToken = refreshCookieFromRequest(request);
    if (cookieToken) {
      if (!isSameOrigin(request)) {
        const denied = new Headers({
          "Cache-Control": "no-store",
          "Content-Type": "application/json; charset=utf-8",
        });
        clearBrowserAuthCookies(denied);
        return withProxyCors(
          request,
          new Response(JSON.stringify({ error: "Cross-origin refresh is not allowed." }), {
            status: 403,
            headers: denied,
          }),
        );
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
    return withProxyCors(
      request,
      Response.json({ error: "Сервис API временно недоступен." }, { status: 502 }),
    );
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
        const accessToken = accessTokenFromPayload(payload);
        delete payload.refreshToken;
        delete payload.RefreshToken;
        payload[refresh.key] = REFRESH_COOKIE_MARKER;
        responseHeaders.set(
          "Set-Cookie",
          refreshCookie(refresh.token, REFRESH_COOKIE_MAX_AGE_SECONDS),
        );
        responseHeaders.append("Set-Cookie", clearOtherRefreshCookie());
        if (accessToken) {
          responseHeaders.append("Set-Cookie", mediaAccessCookie(accessToken));
        }
        responseHeaders.set("content-type", "application/json; charset=utf-8");
        return withProxyCors(
          request,
          new Response(JSON.stringify(payload), {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: responseHeaders,
          }),
        );
      }

      return withProxyCors(
        request,
        new Response(responseText, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: responseHeaders,
        }),
      );
    }

    if (
      browserCookieSession &&
      pathname === "/api/auth/refresh" &&
      (upstream.status === 401 || upstream.status === 403)
    ) {
      clearBrowserAuthCookies(responseHeaders);
    }
  }

  if (
    browserCookieSession &&
    upstream.ok &&
    (pathname === "/api/auth/logout" || pathname === "/api/auth/delete-account")
  ) {
    clearBrowserAuthCookies(responseHeaders);
  }

  return withProxyCors(
    request,
    new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    }),
  );
}

export function floraApiProxyOptions(request: NextRequest): Response {
  return withProxyCors(request, new Response(null, { status: 204 }));
}
