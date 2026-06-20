import type { NextRequest } from "next/server";

const hopByHop = new Set([
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
    if (hopByHop.has(lower)) return;
    out.set(key, value);
  });
  return out;
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
  const base = upstreamBase();
  if (!base) {
    return withProxyCors(
      request,
      Response.json(
        {
          error:
            "Сервер веб-приложения не настроил прокси к Flora.API: задайте FLORA_API_UPSTREAM (или API_UPSTREAM_URL) в среде запуска, либо соберите с этой переменной, либо укажите NEXT_PUBLIC_API_BASE_URL для прямых запросов в браузер.",
        },
        { status: 503 },
      ),
    );
  }

  const targetPath = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  const targetUrl = `${base}${targetPath}`;

  const method = request.method.toUpperCase();
  const headers = forwardableHeaders(request);

  let body: ArrayBuffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const raw = await request.arrayBuffer();
    if (raw.byteLength > 0) body = raw;
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
  } catch {
    return withProxyCors(
      request,
      Response.json(
        { error: `Flora.API недоступен по адресу ${base} (проверьте FLORA_API_UPSTREAM и запуск API).` },
        { status: 502 },
      ),
    );
  }

  const responseHeaders = new Headers(upstream.headers);
  hopByHop.forEach((name) => {
    responseHeaders.delete(name);
  });

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
