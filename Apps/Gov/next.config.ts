import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const govRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(govRoot, "..", "..");

// Do not rewrite /api/* to flora-api here — rewrites can run before App Router
// Route Handlers and break POST (405). Proxy via FLORA_API_UPSTREAM in
// app/api/{auth,messaging}.

const isProd = process.env.NODE_ENV === "production";

/** TypeScript ESM keeps `.js` specifiers; source files are `.ts` / `.tsx`. */
const extensionAlias = {
  ".js": [".ts", ".tsx", ".js", ".jsx"],
  ".mjs": [".mts", ".mjs"],
  ".cjs": [".cts", ".cjs"],
};

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  // HSTS only in production; ignored over plain HTTP and on localhost.
  ...(isProd
    ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
    : []),
];

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: repoRoot,
  transpilePackages: ["@flora/client-core", "@flora/fscp"],
  // Next copies this into webpack `resolve.extensionAlias` before user webpack().
  experimental: {
    extensionAlias,
  },
  webpack: (config) => {
    config.resolve ??= {};
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ...extensionAlias,
    };
    config.resolve.fullySpecified = false;
    config.module ??= {};
    config.module.rules ??= [];
    config.module.rules.unshift({
      issuer: /\.[cm]?tsx?$/,
      resolve: {
        fullySpecified: false,
        extensionAlias,
      },
    });
    return config;
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
