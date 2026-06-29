import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(webRoot, "..", "..");

type FloraVersionManifest = {
  ecosystem: string;
  products: { social: string };
};

function loadFloraVersions(): FloraVersionManifest {
  try {
    const raw = readFileSync(path.join(repoRoot, "VERSION"), "utf8");
    const parsed = JSON.parse(raw) as FloraVersionManifest;
    if (parsed.ecosystem && parsed.products?.social) return parsed;
  } catch {
    // fall through
  }
  return { ecosystem: "0.2.0-alpha", products: { social: "0.2.0-alpha" } };
}

const floraVersions = loadFloraVersions();

// Do not rewrite /api/* to Flora.API here — it can run before App Router Route Handlers
// and break POST (405). Proxy in app/api/auth and app/api/messaging route handlers via FLORA_API_UPSTREAM.

const isProd = process.env.NODE_ENV === "production";

/** Cross-origin API/realtime hosts embedded at build (e.g. origin.<apex> when using -PublicApiBaseUrl). */
function resolveConnectSrcExtraOrigins(): string[] {
  const origins = new Set<string>();
  for (const raw of [
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "",
    process.env.NEXT_PUBLIC_REALTIME_API_BASE_URL ?? "",
  ]) {
    const trimmed = raw.trim().replace(/\/+$/, "");
    if (!trimmed) continue;
    try {
      const origin = new URL(trimmed).origin;
      if (origin) origins.add(origin);
    } catch {
      // ignore invalid URL
    }
  }
  return [...origins];
}

/**
 * Content Security Policy. Tuned for this app's runtime: WASM crypto (libsodium) and ffmpeg.wasm
 * (web workers + blob URLs), AVIF media served same-origin, and the same-origin /api/* proxy.
 *
 * Known follow-up (documented in SECURITY.md): script-src still allows 'unsafe-inline'/'unsafe-eval'
 * because Next.js App Router emits inline bootstrap scripts and the Emscripten-built media stack needs
 * eval. Migrating to a per-request nonce (strict-dynamic) is a post-release hardening step. The
 * high-value directives below (frame-ancestors, object-src, base-uri, form-action) are already strict.
 */
const crossOriginApiOrigins = resolveConnectSrcExtraOrigins();
const crossOriginApiOriginsCsp = crossOriginApiOrigins.join(" ");
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob:${crossOriginApiOriginsCsp ? ` ${crossOriginApiOriginsCsp}` : ""}`,
  `media-src 'self' blob:${crossOriginApiOriginsCsp ? ` ${crossOriginApiOriginsCsp}` : ""}`,
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  `connect-src 'self' blob:${crossOriginApiOriginsCsp ? ` ${crossOriginApiOriginsCsp}` : ""}`,
  "frame-ancestors 'none'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "manifest-src 'self'",
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  // Microphone is needed for voice messages; camera for in-app capture. Everything else is denied.
  { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=(), payment=(), usb=()" },
  // HSTS only in production; ignored over plain HTTP and on localhost, but avoids any dev HTTPS edge cases.
  ...(isProd
    ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
    : []),
];

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: repoRoot,
  transpilePackages: ["@flora/client-core"],
  env: {
    NEXT_PUBLIC_APP_VERSION:
      process.env.NEXT_PUBLIC_APP_VERSION ?? floraVersions.products.social,
    NEXT_PUBLIC_ECOSYSTEM_VERSION:
      process.env.NEXT_PUBLIC_ECOSYSTEM_VERSION ?? floraVersions.ecosystem,
  },
  webpack: (config) => {
    config.resolve ??= {};
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    };
    return config;
  },
  /**
   * Middleware/proxy буферизует тело запроса (по умолчанию 10 МБ).
   * Видео в сообщениях ≤ 36 МиБ, в постах ≤ 200 МБ — иначе multipart обрезается и прокси даёт 502.
   */
  experimental: {
    proxyClientMaxBodySize: "210mb",
  },
  /** Метаданные в <head> синхронно — без streaming `<div hidden>` (гидратация /login, React 19). */
  htmlLimitedBots: /.*/,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
  async redirects() {
    return [
      { source: "/favicon.ico", destination: "/icon.svg", permanent: false },
      { source: "/feed/compose", destination: "/compose", permanent: false }
    ];
  },
};

export default nextConfig;
