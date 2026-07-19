/**
 * Batching core for post-view recording, isolated from React/MMKV/network so
 * it can be unit-tested. While the feed is moving, newly-viewed ids and their
 * server view-counts are accumulated in memory; a single MMKV persist and a
 * single React update are applied on flush (settle / background / unmount /
 * user change).
 *
 * The API stays idempotent for the current session: an id is sent at most once
 * because it is deduplicated against both the persisted and the in-flight set.
 * On send failure the id is rolled back so it is never persisted as recorded.
 */

export type PostViewBatcherDeps = {
  /** Ids already persisted as recorded for the active session. */
  loadPersisted: () => Set<string>;
  /** Persist the full recorded set in one operation (MMKV write). */
  persist: (ids: Set<string>) => void;
  /** Fire the (idempotent) record request. Resolves to the new count or null. */
  send: (postUuid: string) => Promise<{ viewsCount: number } | null>;
  /** Apply buffered counts to React state in a single update. */
  applyCounts: (counts: Record<string, number>) => void;
  /** Per-id change notification (fired on flush). */
  notifyChange?: (postUuid: string, viewsCount: number) => void;
  isMoving: () => boolean;
};

export type PostViewBatcher = {
  observe: (postUuid: string) => void;
  flush: () => void;
  reset: (persisted?: Set<string>) => void;
  /** Test/diagnostic view of internal buffers. */
  snapshot: () => {
    persistedSize: number;
    optimisticSize: number;
    pendingCounts: number;
    persistDirty: boolean;
  };
};

export function createPostViewBatcher(deps: PostViewBatcherDeps): PostViewBatcher {
  let persisted = deps.loadPersisted();
  // Ids recorded this session but not yet flushed to MMKV. The on-disk set only
  // ever changes by merging this set during flush, so an id rolled back before
  // a flush never reaches disk and needs no persist.
  const optimistic = new Set<string>();
  // Server counts awaiting a batched React update.
  let pendingCounts: Record<string, number> = {};

  const flush = (): void => {
    if (optimistic.size > 0) {
      for (const id of optimistic) persisted.add(id);
      deps.persist(persisted);
      optimistic.clear();
    }
    const counts = pendingCounts;
    if (Object.keys(counts).length > 0) {
      pendingCounts = {};
      deps.applyCounts(counts);
      if (deps.notifyChange) {
        for (const [id, count] of Object.entries(counts)) deps.notifyChange(id, count);
      }
    }
  };

  const observe = (postUuid: string): void => {
    const id = postUuid.trim();
    if (!id || persisted.has(id) || optimistic.has(id)) return;

    optimistic.add(id);

    void deps
      .send(id)
      .then((result) => {
        if (!result) {
          optimistic.delete(id);
          return;
        }
        pendingCounts = { ...pendingCounts, [id]: result.viewsCount };
        if (!deps.isMoving()) flush();
      })
      .catch(() => {
        optimistic.delete(id);
      });
  };

  const reset = (next?: Set<string>): void => {
    // Persist any dirty state for the outgoing session before switching.
    flush();
    persisted = next ?? deps.loadPersisted();
    optimistic.clear();
    pendingCounts = {};
  };

  return {
    observe,
    flush,
    reset,
    snapshot: () => ({
      persistedSize: persisted.size,
      optimisticSize: optimistic.size,
      pendingCounts: Object.keys(pendingCounts).length,
      persistDirty: optimistic.size > 0,
    }),
  };
}
