import { COMPOSE_PROFILE_MODE_ID } from "./composeModes";

const LEGACY_COMPOSE_NEUTRAL_BODY_KEY = "flora.compose.neutralBody";
/** Нейтральный черновик живёт в sessionStorage не дольше часа. */
export const COMPOSE_NEUTRAL_BODY_TTL_MS = 60 * 60 * 1000;

type NeutralBodyCacheEntry = {
  body: string;
  savedAt: number;
};

function composeNeutralBodyKey(scopeKey: string): string {
  return `flora.compose.neutralBody.${scopeKey}`;
}

function parseCacheEntry(raw: string | null): NeutralBodyCacheEntry | null {
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "body" in parsed &&
      "savedAt" in parsed &&
      typeof (parsed as NeutralBodyCacheEntry).body === "string" &&
      typeof (parsed as NeutralBodyCacheEntry).savedAt === "number"
    ) {
      return parsed as NeutralBodyCacheEntry;
    }
  } catch {
    /* legacy plain string — ниже */
  }

  if (raw.length > 0) return { body: raw, savedAt: Date.now() };
  return null;
}

function isExpired(entry: NeutralBodyCacheEntry, now = Date.now()): boolean {
  return now - entry.savedAt >= COMPOSE_NEUTRAL_BODY_TTL_MS;
}

export function readComposeNeutralBodyCache(scopeKey: string): string {
  if (typeof window === "undefined") return "";
  try {
    const key = composeNeutralBodyKey(scopeKey);
    let raw = sessionStorage.getItem(key);

    if (!raw && scopeKey === COMPOSE_PROFILE_MODE_ID) {
      raw = sessionStorage.getItem(LEGACY_COMPOSE_NEUTRAL_BODY_KEY);
      if (raw) {
        sessionStorage.removeItem(LEGACY_COMPOSE_NEUTRAL_BODY_KEY);
      }
    }

    const entry = parseCacheEntry(raw);
    if (!entry) return "";

    if (isExpired(entry)) {
      sessionStorage.removeItem(key);
      return "";
    }

    return entry.body;
  } catch {
    return "";
  }
}

export function writeComposeNeutralBodyCache(body: string, scopeKey: string): void {
  if (typeof window === "undefined") return;
  try {
    const key = composeNeutralBodyKey(scopeKey);
    if (body.length > 0) {
      const entry: NeutralBodyCacheEntry = { body, savedAt: Date.now() };
      sessionStorage.setItem(key, JSON.stringify(entry));
    } else {
      sessionStorage.removeItem(key);
    }
  } catch {
    /* quota / private mode */
  }
}

export function clearComposeNeutralBodyCache(scopeKey: string): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(composeNeutralBodyKey(scopeKey));
  } catch {
    /* quota / private mode */
  }
}
