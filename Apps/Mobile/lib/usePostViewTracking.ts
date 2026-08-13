import { apiRecordPostView } from "@flora/client-core/api";
import type { FeedPostDto } from "@flora/client-core/contracts";
import type { FlashListRef } from "@shopify/flash-list";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, type ViewToken, type ViewabilityConfigCallbackPair } from "react-native";
import { mmkv } from "@/lib/mmkv";
import { createPostViewBatcher, type PostViewBatcher } from "@/lib/postViewBatcher";
import { isScrollSettled, subscribeScrollSettled } from "@/lib/scrollActivity";
import {
  createVisibleRangePublisher,
  type VisibleIndexRange,
  type VisibleRangePublisher,
} from "@/lib/visibleRangePublisher";
import { useSessionStore } from "@/stores/sessionStore";

const LEGACY_SESSION_STORAGE_KEY = "flora.postViews.session";

const ANALYTICS_VIEWABILITY_CONFIG = {
  itemVisiblePercentThreshold: 25,
  minimumViewTime: 300,
} as const;

const DECODE_VIEWABILITY_CONFIG = {
  itemVisiblePercentThreshold: 25,
  minimumViewTime: 0,
} as const;

type PostViewSource = Pick<FeedPostDto, "postUuid" | "viewCount">;

export type { VisibleIndexRange } from "@/lib/visibleRangePublisher";

type UsePostViewTrackingOptions = {
  enabled?: boolean;
  onViewsCountChange?: (postUuid: string, viewsCount: number) => void;
};

let legacyKeyMigrated = false;

function migrateLegacySessionKey(): void {
  if (legacyKeyMigrated) return;
  legacyKeyMigrated = true;
  try {
    mmkv.delete(LEGACY_SESSION_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function sessionStorageKey(userUuid: string): string {
  return `flora.postViews.session.${userUuid.trim().toLowerCase()}`;
}

function readSessionRecorded(key: string): Set<string> {
  try {
    const raw = mmkv.getString(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((value): value is string => typeof value === "string"));
    }
  } catch {
    /* ignore */
  }
  return new Set();
}

function writeSessionRecorded(key: string, ids: Set<string>): void {
  try {
    mmkv.set(key, JSON.stringify([...ids]));
  } catch {
    /* ignore */
  }
}

export function usePostViewTracking(options: UsePostViewTrackingOptions = {}) {
  const enabled = options.enabled ?? true;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const userUuid = useSessionStore((s) => s.me?.userUuid ?? "");
  const onChangeRef = useRef(options.onViewsCountChange);
  onChangeRef.current = options.onViewsCountChange;

  const storageKeyRef = useRef<string | null>(null);
  const flashListRef = useRef<FlashListRef<FeedPostDto>>(null);
  const [viewCounts, setViewCounts] = useState<Record<string, number>>({});
  const batcherRef = useRef<PostViewBatcher | null>(null);

  // Visible index band — tracked cheaply on every viewability change. During
  // active scroll, publication to React state is coalesced to ~100ms (each
  // publish rebuilds the media-mode map and re-renders rows, so the rate is
  // the cost); on settle it is immediate, never waiting behind that window.
  const visibleRangeRef = useRef<VisibleIndexRange>({ min: null, max: null });
  const [visibleRange, setVisibleRange] = useState<VisibleIndexRange>({ min: null, max: null });
  const commitRange = useCallback((next: VisibleIndexRange) => {
    setVisibleRange((prev) => (prev.min === next.min && prev.max === next.max ? prev : { ...next }));
  }, []);
  const commitRangeRef = useRef(commitRange);
  commitRangeRef.current = commitRange;

  const rangePublisherRef = useRef<VisibleRangePublisher | null>(null);
  if (rangePublisherRef.current === null) {
    rangePublisherRef.current = createVisibleRangePublisher({
      publish: (range) => commitRangeRef.current(range),
    });
  }
  useEffect(() => {
    return () => rangePublisherRef.current?.dispose();
  }, []);

  if (batcherRef.current === null) {
    batcherRef.current = createPostViewBatcher({
      loadPersisted: () => {
        const key = storageKeyRef.current;
        return key ? readSessionRecorded(key) : new Set<string>();
      },
      persist: (ids) => {
        const key = storageKeyRef.current;
        if (key) writeSessionRecorded(key, ids);
      },
      send: (postUuid) => apiRecordPostView(postUuid),
      applyCounts: (counts) => {
        setViewCounts((prev) => ({ ...prev, ...counts }));
      },
      notifyChange: (postUuid, viewsCount) => onChangeRef.current?.(postUuid, viewsCount),
      isMoving: () => !isScrollSettled(),
    });
  }

  useEffect(() => {
    migrateLegacySessionKey();
    const batcher = batcherRef.current;
    // Persist outgoing session under the *previous* key before switching.
    batcher?.flush();
    const key = userUuid.trim() ? sessionStorageKey(userUuid) : null;
    storageKeyRef.current = key;
    batcher?.reset(key ? readSessionRecorded(key) : new Set<string>());
    setViewCounts({});
  }, [userUuid]);

  // Flush buffered records/counts and publish the visible band once settled.
  useEffect(() => {
    return subscribeScrollSettled((settled) => {
      if (!settled) return;
      batcherRef.current?.flush();
      rangePublisherRef.current?.flush(visibleRangeRef.current);
    });
  }, []);

  // Mandatory flush on background / inactive.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") batcherRef.current?.flush();
    });
    return () => sub.remove();
  }, []);

  // Mandatory flush on unmount.
  useEffect(() => {
    return () => batcherRef.current?.flush();
  }, []);

  const recordViewRef = useRef<(postUuid: string) => void>(() => {});
  recordViewRef.current = (postUuid: string) => {
    if (!enabledRef.current || !storageKeyRef.current) return;
    batcherRef.current?.observe(postUuid);
  };

  const viewabilityConfigCallbackPairs = useRef<ViewabilityConfigCallbackPair[]>([
    {
      // Keep the delayed threshold exclusively for recorded post views.
      viewabilityConfig: ANALYTICS_VIEWABILITY_CONFIG,
      onViewableItemsChanged: ({ viewableItems }: { viewableItems: ViewToken[] }) => {
        for (const token of viewableItems) {
          if (!token.isViewable) continue;
          if (typeof token.item !== "object" || token.item === null) continue;
          const post = token.item as PostViewSource;
          const id = post.postUuid?.trim();
          if (!id) continue;
          recordViewRef.current(id);
        }
      },
    },
    {
      // The decode band must update as soon as rows satisfy visibility.
      viewabilityConfig: DECODE_VIEWABILITY_CONFIG,
      onViewableItemsChanged: ({ viewableItems }: { viewableItems: ViewToken[] }) => {
        let min: number | null = null;
        let max: number | null = null;
        for (const token of viewableItems) {
          if (!token.isViewable || typeof token.index !== "number") continue;
          min = min === null ? token.index : Math.min(min, token.index);
          max = max === null ? token.index : Math.max(max, token.index);
        }
        visibleRangeRef.current = { min, max };
        // Settled: publish immediately (no window to wait behind). Moving:
        // let the coalescing publisher bound the rate of the resulting
        // re-renders instead of firing on every viewability pass.
        if (isScrollSettled()) {
          rangePublisherRef.current?.flush(visibleRangeRef.current);
        } else {
          rangePublisherRef.current?.update(visibleRangeRef.current);
        }
      },
    },
  ]);

  const viewsCountFor = useCallback(
    (post: PostViewSource) => {
      const local = viewCounts[post.postUuid];
      return local != null ? Math.max(local, post.viewCount) : post.viewCount;
    },
    [viewCounts],
  );

  const refreshViewability = useCallback((): (() => void) | void => {
    if (!enabledRef.current) return;
    let rafId: ReturnType<typeof requestAnimationFrame> | null = null;
    // Deferred to after the current commit, then aligned to a frame — a
    // cancellable pairing that (unlike InteractionManager/requestIdleCallback)
    // is guaranteed to run and to be cancellable on unmount.
    const immediate = setImmediate(() => {
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const list = flashListRef.current;
        if (!list) return;
        list.recordInteraction();
        try {
          list.recomputeViewableItems();
        } catch {
          // FlashList throws "not enough layouts" if called before first measure pass.
        }
      });
    });
    return () => {
      clearImmediate(immediate);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, []);

  return {
    viewsCountFor,
    viewabilityConfigCallbackPairs: viewabilityConfigCallbackPairs.current,
    flashListRef,
    refreshViewability,
    visibleRange,
  };
}
