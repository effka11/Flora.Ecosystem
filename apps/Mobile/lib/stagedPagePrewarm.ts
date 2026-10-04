/**
 * Which of a freshly staged feed page's own images to warm before the page
 * ever joins the list.
 *
 * A staged page arrives whole (`take` posts, typically 20), but only the
 * rows a viewer could plausibly reach before the *next* page in turn warms
 * need to be pre-downloaded — the same depth the in-list download band
 * already uses (`getRowsAhead()` from `@/lib/mediaBandwidth`), taken from
 * the front of the page since that is exactly the order its rows will mount
 * in once attached. Posts past that depth are left for the in-list band to
 * pick up once the page is actually on screen and the window has moved.
 *
 * Only the first image of each of those posts is requested, mirroring
 * `backgroundPrefetchUrls` in `@/lib/frcMediaMode`: the point is a warm
 * first paint, not a fully decoded collage nobody scrolled to yet.
 */
import type { FrcPrefetchTarget } from "@/lib/frcMediaMode";

export type StagedPagePrewarmPost = { imageUuids: readonly string[] };

export type SelectStagedPagePrewarmTargetsParams = {
  /** Posts of the staged page, in the order they will render. */
  posts: readonly StagedPagePrewarmPost[];
  /** Depth of the warm-up window, in posts — see `getRowsAhead()`. */
  rowsAhead: number;
  /** Absolute URL of an image id. */
  urlForImage: (imageUuid: string) => string;
};

/**
 * Targets for the first `rowsAhead` posts of a staged page (positionally —
 * a post with no image still occupies its slot in that window and simply
 * contributes no target, rather than being skipped over in favour of the
 * next one).
 */
export function selectStagedPagePrewarmTargets(
  params: SelectStagedPagePrewarmTargetsParams,
): FrcPrefetchTarget[] {
  const { posts, rowsAhead, urlForImage } = params;
  const depth = Math.min(posts.length, Math.max(0, Math.floor(rowsAhead)));
  const targets: FrcPrefetchTarget[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < depth; index += 1) {
    const post = posts[index];
    const firstImage = post?.imageUuids[0];
    if (!firstImage) continue;
    const url = urlForImage(firstImage);
    // A repost sharing an image with an earlier post in the same window
    // needs only one warm-up.
    if (seen.has(url)) continue;
    seen.add(url);
    targets.push({ url, imageCount: post.imageUuids.length });
  }

  return targets;
}
