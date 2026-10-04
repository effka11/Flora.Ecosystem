/**
 * Pure pull-to-refresh gate: UI spinner should follow this flag, not React Query
 * `isRefetching` (background prefetch/focus must not flash RefreshControl).
 */
export type PullRefreshController = {
  isRefreshing: () => boolean;
  requestRefresh: (run: () => Promise<void>) => Promise<void>;
};

export function createPullRefreshController(options?: {
  onChange?: (refreshing: boolean) => void;
}): PullRefreshController {
  let refreshing = false;

  const setRefreshing = (value: boolean) => {
    refreshing = value;
    options?.onChange?.(value);
  };

  return {
    isRefreshing: () => refreshing,
    async requestRefresh(run: () => Promise<void>): Promise<void> {
      if (refreshing) return;
      setRefreshing(true);
      try {
        await run();
      } catch {
        // Caller (RefreshControl) should not see an unhandled rejection; list stays as-is.
      } finally {
        setRefreshing(false);
      }
    },
  };
}
