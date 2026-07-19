/**
 * Pure decision logic for staged feed page prefetch. Kept side-effect free so
 * the gating rules can be unit-tested independently of react-query, the list,
 * and the network layer.
 *
 * Proximity to the end is expressed in viewports (screen lengths) via
 * {@link PREFETCH_END_THRESHOLD_VIEWPORTS}, which the list applies through
 * `onEndReachedThreshold`. That is viewport/pixel-relative, not a row count, so
 * it behaves consistently across posts of very different heights.
 */

/** Start prefetching this many viewports before the end of the content. */
export const PREFETCH_END_THRESHOLD_VIEWPORTS = 2.5;

export type PrefetchGateInput = {
  isActivePane: boolean;
  /** Local text search filters the visible set; a next network page is irrelevant. */
  isSearching: boolean;
  /** The query still has a next cursor to fetch. */
  hasNextPage: boolean;
  /** A refetch/initial load is already in flight for this query. */
  isFetching: boolean;
  /** A staging request is already in flight. */
  isStaging: boolean;
  /** A staged page is already ready for the current tail cursor. */
  hasStagedForTail: boolean;
  /** Offline (or otherwise disallowed) → do not prefetch. Unknown counts as online/metered. */
  networkAllowsPrefetch: boolean;
};

export function shouldStartPrefetch(i: PrefetchGateInput): boolean {
  if (!i.isActivePane) return false;
  if (i.isSearching) return false;
  if (!i.hasNextPage) return false;
  if (i.isFetching || i.isStaging || i.hasStagedForTail) return false;
  if (!i.networkAllowsPrefetch) return false;
  return true;
}

export function shouldAttachStaged(input: {
  hasStagedPage: boolean;
  settled: boolean;
  /** Near the very end (a fresh end-reached signal) — safety-net append. */
  force: boolean;
}): boolean {
  if (!input.hasStagedPage) return false;
  return input.settled || input.force;
}

/**
 * A staged page may only be attached if the query tail is unchanged since it
 * was requested (its request cursor still equals the current last page's next
 * cursor). A refresh replaces the tail and invalidates the staged page.
 */
export function canAttachToTail(
  currentTailNextCursor: string | undefined,
  stagedRequestCursor: string | undefined,
): boolean {
  if (!stagedRequestCursor) return false;
  return currentTailNextCursor === stagedRequestCursor;
}
