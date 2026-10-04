/**
 * Viewability-aware media bands.
 *
 * A feed row gets one of these modes based on its distance from the currently
 * visible index band. Two bands of different depth are expressed by the same
 * map: subscribing a row is what starts its download, and the mode is what
 * ranks its decode, so a deep, cheap download band and a shallow, expensive
 * decode band need no separate state.
 *
 * - `visible`  — really on screen; decode every image of the row.
 * - `near`     — immediately adjacent (±1); decode every image too, otherwise
 *   images 2..10 of a collage stay blank until the row is fully on screen.
 * - `background` — the download band: as many rows as the measured channel can
 *   deliver in the next few seconds, ahead of the gesture (see
 *   {@link ComputeRowModesParams.rowsAhead}). Only the first image of the row
 *   decodes, at the lowest priority, so the deep band costs bandwidth and not
 *   native decode time.
 * - rows outside the band are absent from the map (no decode; cache hits still
 *   render).
 */
import type { QueuePriority } from "@/lib/subscriberTaskQueue";

/** Полоса видимости строки — значения, которые кладутся в Map режимов. */
export type FrcRowMediaMode = "visible" | "near" | "background";

/**
 * Состояние декодирования строки: полоса видимости либо явная причина не
 * декодировать. `"gated-out"` — пейн намеренно выключен (неактивная страница
 * пейджера); `"out-of-band"` — строка вне полосы видимости в управляемом
 * пейне. В отличие от голого `FrcRowMediaMode`, здесь эти два случая не
 * схлопываются в один и тот же `undefined`.
 */
export type FrcRowDecodeState = FrcRowMediaMode | "gated-out" | "out-of-band";

/** Direction the visible band is travelling in; the deep side of the band. */
export type FrcScrollDirection = "down" | "up";

/** Visible index band as published by viewability (`null` before the first pass). */
export type FrcVisibleRange = { min: number | null; max: number | null };

/**
 * Rows kept warm on the side the gesture is moving away from. One row is
 * enough to survive a reversal without hitting a cliff, and every row spent
 * backwards is a row not spent in the direction the user is actually going.
 */
export const ROWS_BEHIND_GESTURE = 1;

function edgeDelta(previous: number | null, next: number | null): number {
  if (previous === null || next === null) return 0;
  return next - previous;
}

/**
 * Scroll direction from two consecutive visible bands.
 *
 * Both edges moving the same way is unambiguous; anything else — an unchanged
 * band, a band that only grew or shrank, a first measurement — keeps
 * `current`, because a wrong reversal would move the deep band to the wrong
 * side of the screen for as long as the ambiguity lasts.
 */
export function nextScrollDirection(
  previous: FrcVisibleRange,
  next: FrcVisibleRange,
  current: FrcScrollDirection,
): FrcScrollDirection {
  const min = edgeDelta(previous.min, next.min);
  const max = edgeDelta(previous.max, next.max);
  const forward = min > 0 || max > 0;
  const backward = min < 0 || max < 0;
  if (forward === backward) return current;
  return forward ? "down" : "up";
}

export type ComputeRowModesParams = {
  /** Total number of rows currently in the list. */
  count: number;
  /** Lowest visible row index, or null when viewability is not yet known. */
  minVisible: number | null;
  /** Highest visible row index, or null when viewability is not yet known. */
  maxVisible: number | null;
  /**
   * Depth of the download band ahead of the gesture, in rows. Comes from the
   * measured channel (`getRowsAhead()`); zero means "no band at all" and is
   * what an offline device passes.
   */
  rowsAhead: number;
  /** Where the band is deep. Defaults to `"down"`: feeds are read downwards. */
  direction?: FrcScrollDirection;
};

/**
 * Compute per-index media modes. Pure and allocation-light so it can run on
 * every viewability change without pulling in React or platform APIs.
 */
export function computeRowMediaModes(
  params: ComputeRowModesParams,
): Map<number, FrcRowMediaMode> {
  const { count, minVisible, maxVisible, rowsAhead, direction = "down" } = params;
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

  // Download band: full depth the way the gesture is going, one row the other
  // way. A channel we know nothing can reach (offline) gets neither.
  const ahead = Math.max(0, Math.floor(rowsAhead));
  const behind = ahead > 0 ? ROWS_BEHIND_GESTURE : 0;
  const depthBelow = direction === "down" ? ahead : behind;
  const depthAbove = direction === "up" ? ahead : behind;

  for (let step = 1; step <= depthBelow; step += 1) {
    const index = below + step;
    if (index > count - 1) break;
    if (!modes.has(index)) modes.set(index, "background");
  }
  for (let step = 1; step <= depthAbove; step += 1) {
    const index = above - step;
    if (index < 0) break;
    if (!modes.has(index)) modes.set(index, "background");
  }

  return modes;
}

/** Row as the download band sees it: its key and the images it would show. */
export type FrcBandRow = { postUuid: string; imageUuids: readonly string[] };

export type BackgroundPrefetchParams = {
  rows: readonly FrcBandRow[];
  /** Index → mode, as returned by {@link computeRowMediaModes}. */
  modes: Map<number, FrcRowMediaMode>;
  /** Absolute URL of an image id. */
  urlForImage: (imageUuid: string) => string;
  /** A pane that is switched off warms nothing at all. */
  enabled: boolean;
};

/**
 * A URL the download band wants warm, and the image count of the row it came
 * from — the row's layout depends only on that count, so it is enough for the
 * caller to size the warm-up to the cell the row will actually show it in
 * (see `firstImageDisplayWidth` in `@/lib/feedImageGeometry`).
 */
export type FrcPrefetchTarget = {
  url: string;
  imageCount: number;
};

/**
 * URLs the download band wants warm.
 *
 * The band reaches further than the list mounts rows, so these are the images
 * no component will ask for on its own. Only the first image of a row, exactly
 * like {@link shouldDecodeImage} for `background`: the band exists to make a
 * row's first paint free, and pulling whole collages down it would spend the
 * measured lead time on images that would not be decoded on arrival anyway.
 */
export function backgroundPrefetchUrls(params: BackgroundPrefetchParams): FrcPrefetchTarget[] {
  const { rows, modes, urlForImage, enabled } = params;
  if (!enabled) return [];
  const targets: FrcPrefetchTarget[] = [];
  const seen = new Set<string>();
  for (const [index, mode] of modes) {
    if (mode !== "background") continue;
    const row = rows[index];
    const firstImage = row?.imageUuids[0];
    if (!firstImage) continue;
    const url = urlForImage(firstImage);
    // Two rows can carry the same image (a repost); one warm-up covers both,
    // sized to whichever of them was seen first.
    if (seen.has(url)) continue;
    seen.add(url);
    targets.push({ url, imageCount: row.imageUuids.length });
  }
  return targets;
}

/** Starts a warm-up for one URL and returns its cancellation. */
export type FrcPrefetchStart = (url: string) => () => void;

/**
 * Keeps live warm-ups in step with what the band wants.
 *
 * One warm-up per URL: started when the URL enters the band, cancelled when it
 * leaves — a row the user scrolled past must stop competing for the channel
 * with the rows that replaced it — and left alone while it stays, so a band
 * that shifts by one row does not restart the downloads it already has. The
 * start function is injected, which keeps the bookkeeping testable without a
 * pipeline behind it.
 */
export class FrcPrefetchBand {
  private readonly active = new Map<string, () => void>();

  constructor(private readonly start: FrcPrefetchStart) {}

  sync(urls: readonly string[]): void {
    const wanted = new Set(urls);
    for (const [url, cancel] of [...this.active]) {
      if (wanted.has(url)) continue;
      this.active.delete(url);
      cancel();
    }
    for (const url of wanted) {
      if (this.active.has(url)) continue;
      this.active.set(url, this.start(url));
    }
  }

  /** Cancel everything: the pane went away. */
  stop(): void {
    const cancels = [...this.active.values()];
    this.active.clear();
    for (const cancel of cancels) cancel();
  }

  /** Warm-ups currently held, in the order they were started. */
  activeUrls(): string[] {
    return [...this.active.keys()];
  }
}

/** Queue priority for a row decode state; anything but visible/near → lowest. */
export function priorityForMode(state: FrcRowDecodeState | undefined): QueuePriority {
  switch (state) {
    case "visible":
      return "visible";
    case "near":
      return "near";
    default:
      return "background";
  }
}

/**
 * Whether an image at `imageIndex` within a row of the given decode state
 * should be decoded now. Visible and near rows decode every image — a collage
 * that only decoded its first cell would paint the rest as holes on the way
 * in. `background` is the deep download band and prewarms the first image
 * only; `"gated-out"` (pane intentionally disabled), `"out-of-band"` (row
 * outside the visible band) and `undefined` (no scope mounted at all is
 * handled upstream as `"visible"`; this branch only sees `undefined` from call
 * sites outside any row scope) decode nothing.
 */
export function shouldDecodeImage(
  state: FrcRowDecodeState | undefined,
  imageIndex: number,
): boolean {
  if (state === "visible" || state === "near") return true;
  if (state === "background") return imageIndex === 0;
  return false;
}
