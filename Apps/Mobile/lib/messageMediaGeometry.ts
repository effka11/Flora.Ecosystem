/**
 * Chat message media geometry.
 *
 * Mirrors the collage/single-photo arithmetic `FeedPostImages` actually
 * renders in message mode, so the "loading…" placeholder in
 * `ChatMessageImageCollage` can reserve the exact final height instead of a
 * fixed guess. Two independent copies of the same arithmetic would drift the
 * moment one of them is tuned, so both read from here.
 */
import { floraSpacing } from "@/lib/theme";

const GAP = floraSpacing.gridFine;

/** Same cap `FeedPostImages` applies to `imageUuids`/`previewItems`. */
export const COLLAGE_MAX_ITEMS = 10;

/** Fallback aspect ratio for a single photo before it has decoded once. */
export const DEFAULT_MESSAGE_IMAGE_RATIO = 4 / 3;

/**
 * Final rendered height of the collage `FeedPostImages` draws for `count`
 * photos, given the row height it was configured with. `count <= 1` is not a
 * collage (single photo sizes itself from its aspect ratio instead), so it
 * reports `0`.
 */
export function messageCollageHeight(count: number, rowHeight: number): number {
  const clamped = Math.min(count, COLLAGE_MAX_ITEMS);
  if (clamped <= 1) return 0;
  if (clamped === 2) return rowHeight * 2;
  if (clamped === 3) return rowHeight * 2;
  if (clamped === 4) return rowHeight * 2 + GAP;

  const restRows = Math.ceil((clamped - 2) / 2);
  return rowHeight * 2 + GAP + restRows * rowHeight + (restRows - 1) * GAP;
}

/**
 * Size of a single message photo filling its container width, capped by
 * `maxHeight`. `round` defaults to the identity function: callers that need
 * pixel-grid snapping (`PixelRatio.roundToNearestPixel`, unavailable outside
 * react-native) pass their own.
 */
export function messageSingleImageSize(
  containerWidth: number,
  ratio: number,
  maxHeight: number,
  round: (value: number) => number = (value) => value,
): { width: number; height: number } {
  let w = containerWidth;
  let h = w / ratio;
  if (h > maxHeight) {
    h = maxHeight;
    w = h * ratio;
  }
  if (w > containerWidth) {
    w = containerWidth;
    h = w / ratio;
  }
  return { width: round(w), height: round(h) };
}
