/**
 * Bounded in-memory aspect-ratio cache, keyed by asset id.
 *
 * Pure — no react-native imports, so it is unit-testable under the node
 * vitest environment. `imageRatioStore.ts` is the thin MMKV-backed layer on
 * top of this: it hydrates this cache once at module load and persists it
 * (debounced) whenever the dirty listener fires.
 */
import { LruCache } from "@/lib/lruCache";

const CAPACITY = 300;

let cache = new LruCache<string, number>(CAPACITY);
let dirtyListener: (() => void) | null = null;

export function getImageRatio(id: string): number | null {
  return cache.get(id) ?? null;
}

export function setImageRatio(id: string, ratio: number): void {
  if (!Number.isFinite(ratio) || ratio <= 0) return;

  const previous = cache.get(id);
  if (previous === ratio) return;

  cache.set(id, ratio);
  dirtyListener?.();
}

export function hydrateImageRatios(serialized: string | null): void {
  if (!serialized) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return;
  }

  if (!Array.isArray(parsed)) return;

  for (const entry of parsed) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [id, ratio] = entry as [unknown, unknown];
    if (typeof id !== "string" || typeof ratio !== "number") continue;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    cache.set(id, ratio);
  }
}

export function serializeImageRatios(): string {
  return JSON.stringify(cache.entries());
}

export function setImageRatioDirtyListener(listener: (() => void) | null): void {
  dirtyListener = listener;
}

/** Test-only: drop all cached ratios and the dirty listener. */
export function resetImageRatioCache(): void {
  cache = new LruCache<string, number>(CAPACITY);
  dirtyListener = null;
}
