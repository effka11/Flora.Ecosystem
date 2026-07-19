/**
 * Viewability-aware media decoding modes.
 *
 * A feed row gets one of these modes based on its distance from the currently
 * visible index band. This keeps FRC-I decode work proportional to what the
 * user can (nearly) see instead of decoding every mounted/`drawDistance` row:
 *
 * - `visible`  — really on screen; decode all shown images.
 * - `near`     — immediately adjacent (±1); decode only the first image.
 * - `background` — short lookahead below the visible band; prewarm the first
 *   image only, at the lowest priority.
 * - rows outside the band are absent from the map (no decode; cache hits still
 *   render).
 */
import type { QueuePriority } from "@/lib/subscriberTaskQueue";

export type FrcRowMediaMode = "visible" | "near" | "background";

export type NetworkClass = "wifi" | "metered" | "unknown";

/**
 * Background lookahead depth (posts below the visible band whose first image is
 * prewarmed). Wi‑Fi is generous; metered is minimal; unknown/offline never
 * prewarms.
 */
export function backgroundLookaheadForNetwork(network: NetworkClass): number {
  switch (network) {
    case "wifi":
      return 3;
    case "metered":
      return 1;
    default:
      return 0;
  }
}

export type ComputeRowModesParams = {
  /** Total number of rows currently in the list. */
  count: number;
  /** Lowest visible row index, or null when viewability is not yet known. */
  minVisible: number | null;
  /** Highest visible row index, or null when viewability is not yet known. */
  maxVisible: number | null;
  /** Background lookahead depth (see {@link backgroundLookaheadForNetwork}). */
  lookahead: number;
};

/**
 * Compute per-index media modes. Pure and allocation-light so it can run on
 * every settle without pulling in React or platform APIs.
 */
export function computeRowMediaModes(
  params: ComputeRowModesParams,
): Map<number, FrcRowMediaMode> {
  const { count, minVisible, maxVisible, lookahead } = params;
  const modes = new Map<number, FrcRowMediaMode>();
  if (count <= 0) return modes;

  // Before the first viewability pass, treat only the very top as visible so a
  // cold open decodes the first row rather than the whole mounted window.
  const min = minVisible ?? 0;
  const max = maxVisible ?? 0;
  if (max < min) return modes;

  const lo = Math.max(0, min);
  const hi = Math.min(count - 1, max);
  for (let i = lo; i <= hi; i += 1) modes.set(i, "visible");

  // Adjacent rows above and below the visible band.
  const above = min - 1;
  if (above >= 0 && !modes.has(above)) modes.set(above, "near");
  const below = max + 1;
  if (below <= count - 1 && !modes.has(below)) modes.set(below, "near");

  // Lookahead below the near row.
  for (let step = 1; step <= lookahead; step += 1) {
    const index = below + step;
    if (index > count - 1) break;
    if (!modes.has(index)) modes.set(index, "background");
  }

  return modes;
}

/** Queue priority for a row mode; missing mode → lowest. */
export function priorityForMode(mode: FrcRowMediaMode | undefined): QueuePriority {
  switch (mode) {
    case "visible":
      return "visible";
    case "near":
      return "near";
    default:
      return "background";
  }
}

/**
 * Whether an image at `imageIndex` within a row of the given mode should be
 * decoded now. Visible rows decode every image; near/background prewarm only
 * the first; absent modes decode nothing.
 */
export function shouldDecodeImage(
  mode: FrcRowMediaMode | undefined,
  imageIndex: number,
): boolean {
  if (mode === "visible") return true;
  if (mode === "near" || mode === "background") return imageIndex === 0;
  return false;
}
