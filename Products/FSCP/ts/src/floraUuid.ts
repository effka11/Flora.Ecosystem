import { v7 as uuidv7 } from "uuid";

let uuidQueue: string[] | null = null;
let frozenCreatedAt: string | null = null;

export function floraNewUuid(): string {
  const next = uuidQueue?.shift();
  if (next !== undefined) return next;
  return uuidv7();
}

/** Envelope `createdAt` (and plaintext fallback). Production: wall clock. */
export function floraCreatedAtIso(): string {
  return frozenCreatedAt ?? new Date().toISOString();
}

/**
 * Golden generators only: pin `floraNewUuid` / `floraCreatedAtIso` for one async
 * call. Not part of the send API — `buildFscpWireEnvelope` has no override field.
 */
export async function withFloraGoldenClock<T>(
  params: { uuids: readonly string[]; createdAt: string },
  fn: () => Promise<T>,
): Promise<T> {
  if (uuidQueue !== null || frozenCreatedAt !== null) {
    throw new Error("withFloraGoldenClock: nested or leftover clock.");
  }
  uuidQueue = [...params.uuids];
  frozenCreatedAt = params.createdAt;
  try {
    const result = await fn();
    if (uuidQueue.length !== 0) {
      throw new Error(
        `withFloraGoldenClock: unused uuids (${uuidQueue.length}).`,
      );
    }
    return result;
  } finally {
    uuidQueue = null;
    frozenCreatedAt = null;
  }
}
