/**
 * MMKV-backed persistence for `imageRatioCache`, mirroring `imeHeightStore.ts`.
 *
 * Hydrates the in-memory cache synchronously at module load, then persists
 * it back on a short debounce whenever the cache reports a change — so a
 * burst of images decoding on the same frame collapses into a single write.
 */
import { mmkv } from "@/lib/mmkv";
import {
  getImageRatio,
  hydrateImageRatios,
  serializeImageRatios,
  setImageRatio,
  setImageRatioDirtyListener,
} from "@/lib/imageRatioCache";

export const IMAGE_ASPECT_RATIOS_MMKV_KEY = "imageAspectRatios";

const PERSIST_DEBOUNCE_MS = 1000;

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(): void {
  if (persistTimer != null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    mmkv.set(IMAGE_ASPECT_RATIOS_MMKV_KEY, serializeImageRatios());
  }, PERSIST_DEBOUNCE_MS);
}

hydrateImageRatios(mmkv.getString(IMAGE_ASPECT_RATIOS_MMKV_KEY) ?? null);
setImageRatioDirtyListener(schedulePersist);

export function getStoredImageRatio(id: string): number | null {
  return getImageRatio(id);
}

export function rememberImageRatio(id: string, ratio: number): void {
  setImageRatio(id, ratio);
}
