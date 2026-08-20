import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { isTabActive } from "@/lib/getActiveTabRouteKey";
import {
  abortQueuedIdleTabPrefetch,
  canPrefetchIdleTab,
  canRunQueuedIdleTabPrefetch,
  createIdleTabPreloadController,
  getIdleTabPreloadCompleteAt,
  getIdleTabPreloadSerializer,
  IDLE_TAB_PRELOAD_QUIET_MS,
  subscribeIdleTabPreloadComplete,
  type IdleTabPreloadController,
} from "@/lib/idleTabPreload";
import {
  MUSIC_LIBRARY_QUERY_KEY,
  MUSIC_PLAYLISTS_QUERY_KEY,
} from "@/lib/music/musicIndexQueries";
import { isScrollSettled, subscribeScrollSettled } from "@/lib/scrollActivity";

/** Quiet window after the last `settled: true` before Android UI prefetch. */
export const MUSIC_TAB_PRELOAD_QUIET_MS = IDLE_TAB_PRELOAD_QUIET_MS;

export const MUSIC_TAB_PRELOAD_HREF = "/(tabs)/music";

/** Index-tab cache keys only — not playlist/genre/artist nested routes. */
export function isMusicIndexQueryKey(queryKey: readonly unknown[]): boolean {
  return (
    queryKey[0] === MUSIC_LIBRARY_QUERY_KEY[0] || queryKey[0] === MUSIC_PLAYLISTS_QUERY_KEY[0]
  );
}

export type MusicTabPreloadGate = {
  platform: string; // "android" | "ios" | ...
  appActive: boolean;
  musicIndexSuccess: boolean;
  scrollSettled: boolean;
  quietForMs: number;
  musicTabActive: boolean;
  alreadyPrefetched: boolean;
  profileComplete: boolean;
  profileCompleteForMs: number;
};

export function canPrefetchMusicTab(gate: MusicTabPreloadGate): boolean {
  return canPrefetchIdleTab({
    platform: gate.platform,
    appActive: gate.appActive,
    dataSuccess: gate.musicIndexSuccess,
    scrollSettled: gate.scrollSettled,
    quietForMs: gate.quietForMs,
    tabActive: gate.musicTabActive,
    alreadyPrefetched: gate.alreadyPrefetched,
    predecessorComplete: gate.profileComplete,
    predecessorCompleteForMs: gate.profileCompleteForMs,
  });
}

export type IdleMusicTabPreloadSnapshot = {
  platform: string;
  appActive: boolean;
  /** Both `music-library` and `music-playlists` are success; false if either is not. */
  musicIndexSuccess: boolean;
  musicTabActive: boolean;
};

export type IdleMusicTabPreloadController = IdleTabPreloadController;

/** Music binding of the generic idle machine in `lib/idleTabPreload.ts`. Last in the chain — no own stage stamp. */
export function createIdleMusicTabPreloadController(opts: {
  quietMs?: number;
  now?: () => number;
  isScrollSettled: () => boolean;
  getSnapshot: () => IdleMusicTabPreloadSnapshot;
  prefetch: () => void;
}): IdleMusicTabPreloadController {
  return createIdleTabPreloadController({
    quietMs: opts.quietMs ?? MUSIC_TAB_PRELOAD_QUIET_MS,
    now: opts.now ?? Date.now,
    isScrollSettled: opts.isScrollSettled,
    getSnapshot: () => {
      const snapshot = opts.getSnapshot();
      const now = opts.now ?? Date.now;
      const completedAt = getIdleTabPreloadCompleteAt("profile");
      return {
        platform: snapshot.platform,
        appActive: snapshot.appActive,
        dataSuccess: snapshot.musicIndexSuccess,
        tabActive: snapshot.musicTabActive,
        predecessorComplete: completedAt != null,
        predecessorCompleteForMs: completedAt == null ? 0 : now() - completedAt,
      };
    },
    prefetch: opts.prefetch,
  });
}

function loadIdlePreloadBindings() {
  // Lazy require: vitest cannot parse react-native's flow entry, and
  // predicate tests must stay free of RN / expo-router / frcImage.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { AppState, Platform } = require("react-native") as typeof import("react-native");
  const { router } = require("expo-router") as typeof import("expo-router");
  const { clearFrcImageQueuePauseOwner, setFrcImageQueuePaused } =
    require("@/lib/frcImage") as typeof import("@/lib/frcImage");
  /* eslint-enable @typescript-eslint/no-require-imports */
  return { AppState, Platform, router, clearFrcImageQueuePauseOwner, setFrcImageQueuePaused };
}

function musicIndexQueriesSuccess(
  queryClient: ReturnType<typeof useQueryClient>,
): boolean {
  return (
    queryClient.getQueryState(MUSIC_LIBRARY_QUERY_KEY)?.status === "success" &&
    queryClient.getQueryState(MUSIC_PLAYLISTS_QUERY_KEY)?.status === "success"
  );
}

/**
 * Once both Music index queries have succeeded, prefetch the Music tab index
 * on Android after scroll has been quiet. Idle is `subscribeScrollSettled`,
 * not InteractionManager (RNGH/Reanimated gestures are invisible to it).
 * Pager touch/pager/strip and the tab-switch overlay also publish into that
 * registry. The mount itself goes through the shared serializer, so it never
 * shares a frame with another tab preload. Music waits on the profile stamp
 * and does not stamp a successor stage.
 */
export function useIdleMusicTabPreload(segments: readonly string[]): void {
  const queryClient = useQueryClient();
  const frcOwner = useRef(Symbol("music-tab-preload")).current;
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;
  const evaluateRef = useRef<() => void>(() => {});

  useEffect(() => {
    const {
      AppState,
      Platform,
      router,
      clearFrcImageQueuePauseOwner,
      setFrcImageQueuePaused,
    } = loadIdlePreloadBindings();

    if (Platform.OS !== "android") {
      return () => clearFrcImageQueuePauseOwner(frcOwner);
    }

    let cancelled = false;
    let rafOuter: number | null = null;
    let rafInner: number | null = null;
    let unsubScroll = () => {};
    let unsubApp = () => {};
    let unsubQuery = () => {};
    let unsubProfile = () => {};

    const cancelRafs = () => {
      if (rafOuter != null) {
        cancelAnimationFrame(rafOuter);
        rafOuter = null;
      }
      if (rafInner != null) {
        cancelAnimationFrame(rafInner);
        rafInner = null;
      }
    };

    const detachListeners = () => {
      unsubScroll();
      unsubScroll = () => {};
      unsubApp();
      unsubApp = () => {};
      unsubQuery();
      unsubQuery = () => {};
      unsubProfile();
      unsubProfile = () => {};
    };

    const readSnapshot = () => ({
      platform: Platform.OS,
      appActive: AppState.currentState === "active",
      musicIndexSuccess: musicIndexQueriesSuccess(queryClient),
      musicTabActive: isTabActive(segmentsRef.current, "music"),
    });

    const controller = createIdleMusicTabPreloadController({
      quietMs: MUSIC_TAB_PRELOAD_QUIET_MS,
      isScrollSettled,
      getSnapshot: readSnapshot,
      prefetch: () => {
        const serializer = getIdleTabPreloadSerializer();
        serializer.enqueue(
          frcOwner,
          (release) => {
            detachListeners();
            setFrcImageQueuePaused(frcOwner, "drag", true);
            router.prefetch(MUSIC_TAB_PRELOAD_HREF);
            const finish = () => {
              release();
            };
            rafOuter = requestAnimationFrame(() => {
              rafOuter = null;
              if (cancelled) {
                finish();
                return;
              }
              rafInner = requestAnimationFrame(() => {
                rafInner = null;
                if (cancelled) {
                  finish();
                  return;
                }
                setFrcImageQueuePaused(frcOwner, "drag", false);
                finish();
              });
            });
          },
          {
            shouldRun: () => {
              const snap = readSnapshot();
              const completedAt = getIdleTabPreloadCompleteAt("profile");
              return canRunQueuedIdleTabPrefetch({
                cancelled,
                platform: snap.platform,
                appActive: snap.appActive,
                dataSuccess: snap.musicIndexSuccess,
                scrollSettled: isScrollSettled(),
                quietForMs: controller.quietForMs(),
                tabActive: snap.musicTabActive,
                predecessorComplete: completedAt != null,
                predecessorCompleteForMs:
                  completedAt == null ? 0 : Date.now() - completedAt,
              });
            },
            onAbort: () => {
              controller.unlatch();
              evaluateRef.current();
            },
          },
        );
      },
    });

    const abortQueued = () =>
      abortQueuedIdleTabPrefetch(getIdleTabPreloadSerializer(), frcOwner, () =>
        controller.unlatch(),
      );

    const evaluate = () => {
      if (cancelled) return;
      controller.evaluate();
      const serializer = getIdleTabPreloadSerializer();
      if (controller.hasPrefetched() && !serializer.isOwnerQueuedOrInFlight(frcOwner)) {
        detachListeners();
      }
    };
    evaluateRef.current = evaluate;

    unsubScroll = subscribeScrollSettled((settled) => {
      if (!settled) abortQueued();
      controller.onScrollSettled(settled);
      const serializer = getIdleTabPreloadSerializer();
      if (controller.hasPrefetched() && !serializer.isOwnerQueuedOrInFlight(frcOwner)) {
        detachListeners();
      }
    });

    const appSub = AppState.addEventListener("change", (state) => {
      if (state !== "active") abortQueued();
      controller.onAppActive(state === "active");
      const serializer = getIdleTabPreloadSerializer();
      if (controller.hasPrefetched() && !serializer.isOwnerQueuedOrInFlight(frcOwner)) {
        detachListeners();
      }
    });
    unsubApp = () => appSub.remove();

    unsubQuery = queryClient.getQueryCache().subscribe((event) => {
      if (!isMusicIndexQueryKey(event.query.queryKey)) return;
      evaluate();
      if (readSnapshot().musicIndexSuccess !== true) abortQueued();
    });

    unsubProfile = subscribeIdleTabPreloadComplete("profile", () => {
      evaluate();
      if (getIdleTabPreloadCompleteAt("profile") == null) abortQueued();
    });

    evaluate();

    return () => {
      cancelled = true;
      evaluateRef.current = () => {};
      controller.dispose();
      cancelRafs();
      detachListeners();
      getIdleTabPreloadSerializer().release(frcOwner);
      clearFrcImageQueuePauseOwner(frcOwner);
    };
  }, [frcOwner, queryClient]);

  useEffect(() => {
    evaluateRef.current();
  }, [segments]);
}
