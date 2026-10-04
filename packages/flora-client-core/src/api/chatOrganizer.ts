/**
 * FSCP-ORG chat organizer blob API (`/api/chat-organizer`).
 * Opaque wire — decrypt via `@flora/fscp` / `@flora/client-core/fscp`.
 */
import { ApiRequestError } from "./errors.js";
import { authGetJson, authPostJson } from "./client.js";

export type ChatOrganizerBlobDto = {
  revision: number;
  wire: string;
  updatedAt: string;
};

function asRecord(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
}

function readStr(o: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function readRevision(o: Record<string, unknown>): number | null {
  const v = o.revision ?? o.Revision;
  if (typeof v === "number" && Number.isInteger(v) && v >= 1) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 1) return n;
  }
  return null;
}

/**
 * GET /api/chat-organizer —
 * - 404 → `null` (no blob; migrate candidate)
 * - 200 malformed → throws (must NOT be treated as empty)
 */
export async function apiGetChatOrganizer(): Promise<ChatOrganizerBlobDto | null> {
  let raw: unknown;
  try {
    raw = await authGetJson("/api/chat-organizer");
  } catch (e: unknown) {
    if (e instanceof ApiRequestError && e.status === 404) return null;
    throw e;
  }
  const o = asRecord(raw);
  if (!o) {
    throw new ApiRequestError(502, "Malformed chat organizer blob (not an object).");
  }
  const revision = readRevision(o);
  const wire = readStr(o, ["wire", "Wire"]);
  const updatedAt = readStr(o, ["updatedAt", "UpdatedAt"]);
  if (revision == null || !wire) {
    throw new ApiRequestError(
      502,
      "Malformed chat organizer blob (missing revision/wire).",
    );
  }
  return { revision, wire, updatedAt };
}

/** POST /api/chat-organizer — primary (CDN may block PUT). 204 → void; 409 throws ApiRequestError. */
export async function apiPutChatOrganizer(wire: string): Promise<void> {
  await authPostJson("/api/chat-organizer", { wire });
}
