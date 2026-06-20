import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

// No baked-in IPs. The allowlist is opt-in via env and ships disabled (public site).
const DEFAULT_ALLOWED_IPS: string[] = [];

function isIpAllowlistEnforced(): boolean {
  const flag = process.env.FLORA_ENFORCE_IP_ALLOWLIST?.trim().toLowerCase();
  if (flag === "1" || flag === "true" || flag === "on" || flag === "yes") return true;
  // Off by default. Opt in explicitly (and set FLORA_ALLOWED_IPS) to gate access by IP.
  return false;
}

function parseAllowedIps(): string[] {
  const raw = process.env.FLORA_ALLOWED_IPS?.trim();
  if (!raw) return DEFAULT_ALLOWED_IPS;

  return raw
    .split(",")
    .map((ip) => ip.trim())
    .filter(Boolean);
}

function parseForwardedRfc7239(value: string): string | null {
  // e.g. "for=198.51.100.1;proto=https" or for="[2001:db8::1]"
  const m = /for=(?:\s*)([^;,\s"]+|"[^"]+")/i.exec(value);
  if (!m?.[1]) return null;
  let s = m[1].trim();
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  if (s.startsWith("[") && s.includes("]")) s = s.slice(1, s.indexOf("]"));
  return s || null;
}

function getClientIp(request: NextRequest): string | null {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }

  const forwarded = request.headers.get("forwarded");
  if (forwarded) {
    for (const part of forwarded.split(",")) {
      const fromPart = parseForwardedRfc7239(part.trim());
      if (fromPart) return fromPart;
    }
  }

  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;

  const cfIp = request.headers.get("cf-connecting-ip")?.trim();
  if (cfIp) return cfIp;

  // `ip` exists on NextRequest in supported runtimes; keep a safe fallback.
  const direct = (request as unknown as { ip?: string }).ip?.trim();
  if (direct) return direct;

  return null;
}

export function middleware(request: NextRequest) {
  if (!isIpAllowlistEnforced()) {
    return NextResponse.next();
  }

  const allowedIps = parseAllowedIps();
  const clientIp = getClientIp(request);

  if (!clientIp || !allowedIps.includes(clientIp)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  return NextResponse.next();
}

export const config = {
  // Крупные multipart-загрузки не прогонять через middleware — иначе Next буферизует тело (лимит в next.config).
  matcher: [
    "/((?!api/messaging/video-assets|api/messaging/image-assets|api/messaging/voice-assets|api/auth/posts/[^/]+/video|api/music/tracks/self|api/music/tracks/platform).*)",
  ],
};
