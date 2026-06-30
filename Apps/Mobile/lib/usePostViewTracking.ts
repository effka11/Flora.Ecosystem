import { apiRecordPostView } from "@flora/client-core/api";
import type { FeedPostDto } from "@flora/client-core/contracts";
import type { FlashListRef } from "@shopify/flash-list";
import { useCallback, useEffect, useRef, useState } from "react";
import { InteractionManager, type ViewToken, type ViewabilityConfigCallbackPair } from "react-native";
import { mmkv } from "@/lib/mmkv";
import { useSessionStore } from "@/stores/sessionStore";

const LEGACY_SESSION_STORAGE_KEY = "flora.postViews.session";

const VIEWABILITY_CONFIG = {
  itemVisiblePercentThreshold: 25,
  minimumViewTime: 300,
} as const;

type PostViewSource = Pick<FeedPostDto, "postUuid" | "viewCount">;

type UsePostViewTrackingOptions = {
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
  const userUuid = useSessionStore((s) => s.me?.userUuid ?? "");
  const onChangeRef = useRef(options.onViewsCountChange);
  onChangeRef.current = options.onViewsCountChange;

  const storageKeyRef = useRef<string | null>(null);
  const recordedRef = useRef<Set<string>>(new Set());
  const flashListRef = useRef<FlashListRef<FeedPostDto>>(null);
  const [viewCounts, setViewCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    migrateLegacySessionKey();
    const key = userUuid.trim() ? sessionStorageKey(userUuid) : null;
    storageKeyRef.current = key;
    recordedRef.current = key ? readSessionRecorded(key) : new Set();
    setViewCounts({});
  }, [userUuid]);

  const recordViewRef = useRef<(postUuid: string) => void>(() => {});

  recordViewRef.current = (postUuid: string) => {
    const storageKey = storageKeyRef.current;
    const recorded = recordedRef.current;
    if (!storageKey || !recorded || recorded.has(postUuid)) return;

    recorded.add(postUuid);
    writeSessionRecorded(storageKey, recorded);

    void apiRecordPostView(postUuid)
      .then((result) => {
        if (!result) {
          recorded.delete(postUuid);
          writeSessionRecorded(storageKey, recorded);
          return;
        }
        if (__DEV__) {
          console.debug("[post-view] recorded", postUuid, result.viewsCount);
        }
        setViewCounts((prev) => ({ ...prev, [postUuid]: result.viewsCount }));
        onChangeRef.current?.(postUuid, result.viewsCount);
      })
      .catch(() => {
        recorded.delete(postUuid);
        writeSessionRecorded(storageKey, recorded);
      });
  };

  const viewabilityConfigCallbackPairs = useRef<ViewabilityConfigCallbackPair[]>([
    {
      viewabilityConfig: VIEWABILITY_CONFIG,
      onViewableItemsChanged: ({ viewableItems }: { viewableItems: ViewToken[] }) => {
        for (const token of viewableItems) {
          if (!token.isViewable || typeof token.item !== "object" || token.item === null) continue;
          const post = token.item as PostViewSource;
          const id = post.postUuid?.trim();
          if (!id) continue;
          recordViewRef.current(id);
        }
      },
    },
  ]);

  const viewsCountFor = useCallback(
    (post: PostViewSource) => viewCounts[post.postUuid] ?? post.viewCount,
    [viewCounts],
  );

  const refreshViewability = useCallback((): (() => void) | void => {
    const task = InteractionManager.runAfterInteractions(() => {
      requestAnimationFrame(() => {
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
    return () => task.cancel();
  }, []);

  return {
    viewsCountFor,
    viewabilityConfigCallbackPairs: viewabilityConfigCallbackPairs.current,
    flashListRef,
    refreshViewability,
  };
}
