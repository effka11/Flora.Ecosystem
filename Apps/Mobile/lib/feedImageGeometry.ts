/**
 * Feed row image geometry.
 *
 * `FeedPostImages` decides these widths once, per layout, when it renders a
 * row; the download band (`useFrcMediaBand`) needs the exact same number
 * before that row ever mounts, to warm the file the mounted row will actually
 * ask for. Two independent copies of the same arithmetic would drift the
 * moment one of them is tuned, so both read from here.
 */
import { floraFeedPost, floraSpacing } from "@/lib/theme";

const GAP = floraSpacing.gridFine;

/**
 * Content width of a feed row before it has measured itself — the same
 * subtraction `FeedPostImages` starts from when it has no measured
 * `containerWidth` yet.
 */
export function feedRowContentWidth(windowWidth: number): number {
  return Math.max(
    1,
    windowWidth -
      floraFeedPost.paddingHorizontal * 2 -
      floraFeedPost.contentInsetRight -
      floraFeedPost.avatarSize -
      floraFeedPost.columnGap,
  );
}

/** Width of one cell in an evenly split, `columns`-wide collage row. */
export function collageCellWidth(totalWidth: number, columns: number): number {
  return Math.floor((totalWidth - GAP * (columns - 1)) / columns);
}

/** Width of the wide left cell in the three-image layout (2/3 of the row, minus the gap). */
export function threeImageLeftCellWidth(totalWidth: number): number {
  return Math.floor(((totalWidth - GAP) * 2) / 3);
}

/**
 * Display width of a row's first image — the exact width `FeedPostImages`
 * renders image index 0 at, for the row's actual image count.
 *
 * A single photo is the one case this does not fit exactly: its rendered
 * width also depends on its aspect ratio, which is unknown until the image
 * decodes, so the content width is only an upper bound here. The bucket
 * ladder the cache rounds up to is coarse enough that this is not a second
 * download in practice, unlike the collage cell mismatch this function
 * exists to close — so the imprecision is left as is rather than papered
 * over with a fake ratio.
 */
export function firstImageDisplayWidth(contentWidth: number, imageCount: number): number {
  if (imageCount <= 1) return contentWidth;
  if (imageCount === 3) return threeImageLeftCellWidth(contentWidth);
  return collageCellWidth(contentWidth, 2);
}
