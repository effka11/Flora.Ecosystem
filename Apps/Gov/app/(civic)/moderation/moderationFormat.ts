export function truncateUuid(uuid: string): string {
  const trimmed = uuid.trim();
  if (trimmed.length <= 13) return trimmed;
  return `${trimmed.slice(0, 8)}…${trimmed.slice(-4)}`;
}

function normalizeUsername(username: string | null | undefined): string | null {
  if (!username) return null;
  const trimmed = username.trim().replace(/^@+/u, "");
  return trimmed || null;
}

/** Public handle: `@username`. */
export function formatFrankingHandle(username: string | null | undefined): string {
  const normalized = normalizeUsername(username);
  return normalized ? `@${normalized}` : "неизвестно";
}

export function formatFrankingTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const NAME_IDENTIFIER_CLAIM =
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier";

function decodeJwtPayloadJson(payload: string): Record<string, unknown> | null {
  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = `${normalized}${"=".repeat((4 - (normalized.length % 4)) % 4)}`;
  try {
    const json =
      typeof Buffer !== "undefined"
        ? Buffer.from(padded, "base64").toString("utf8")
        : new TextDecoder().decode(
            Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)),
          );
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readUuidClaim(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Reads the user UUID from a Flora access token. Signature is not checked; Auth already admitted the session. */
export function readUserUuidFromAccessToken(token: string | null): string | null {
  if (!token) return null;
  const payload = token.split(".")[1];
  if (!payload) return null;
  const parsed = decodeJwtPayloadJson(payload);
  if (!parsed) return null;
  return readUuidClaim(parsed.sub) ?? readUuidClaim(parsed[NAME_IDENTIFIER_CLAIM]);
}
