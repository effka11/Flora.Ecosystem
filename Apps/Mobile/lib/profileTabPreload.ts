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
import { isScrollSettled, subscribeScrollSettled } from "@/lib/scrollActivity";

/** Quiet window after the last `settled: true` before Android UI prefetch. */
export const PROFILE_TAB_PRELOAD_QUIET_MS = IDLE_TAB_PRELOAD_QUIET_MS;

const PROFILE_TAB_PRELOAD_HREF = "/(tabs)/profile";

/** Own-profile posts cache key — not a prefix match on `profile-posts`. */
export function isOwnProfilePostsQueryKey(
  queryKey: readonly unknown[],
  username: string,
): boolean {
  return username.length > 0 && queryKey[0] === "profile-posts" && queryKey[1] === username;
}

export type ProfileTabPreloadGate = {
  platform: string; // "android" | "ios" | ...
  appActive: boolean;
  profilePostsSuccess: boolean;
  scrollSettled: boolean;
  quietForMs: number;
  profileTabActive: boolean;
  alreadyPrefetched: boolean;
  notificationsComplete: boolean;
  notificationsCompleteForMs: number;
};

export function canPrefetchProfileTab(gate: ProfileTabPreloadGate): boolean {
  return canPrefetchIdleTab({
    platform: gate.platform,
    appActive: gate.appActive,
    dataSuccess: gate.profilePostsSuccess,
    scrollSettled: gate.scrollSettled,
    quietForMs: gate.quietForMs,
    tabActive: gate.profileTabActive,
    alreadyPrefetched: gate.alreadyPrefetched,
    predecessorComplete: gate.notificationsComplete,
    predecessorCompleteForMs: gate.notificationsCompleteForMs,
  });
}

export type IdleProfileTabPreloadSnapshot = {
  platform: string;
  appActive: boolean;
  profilePostsSuccess: boolean;
  profileTabActive: boolean;
};

export type IdleProfileTabPreloadController = IdleTabPreloadController;

/** Profile binding of the generic idle machine in `lib/idleTabPreload.ts`. */
export function createIdleProfileTabPreloadController(opts: {
  quietMs?: number;
  now?: () => number;
  isScrollSettled: () => boolean;
  getSnapshot: () => IdleProfileTabPreloadSnapshot;
  prefetch: () => void;
}): IdleProfileTabPreloadController {
  return createIdleTabPreloadController({
    quietMs: opts.quietMs ?? PROFILE_TAB_PRELOAD_QUIET_MS,
    now: opts.now ?? Date.now,
    isScrollSettled: opts.isScrollSettled,
    getSnapshot: () => {
      const snapshot = opts.getSnapshot();
      const now = opts.now ?? Date.now;
      const completedAt = getIdleTabPreloadCompleteAt("notifications");
      return {
        platform: snapshot.platform,
        appActive: snapshot.appActive,
        dataSuccess: snapshot.profilePostsSuccess,
        tabActive: snapshot.profileTabActive,
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

function loadSessionStore() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { useSessionStore } =
    require("@/stores/sessionStore") as typeof import("@/stores/sessionStore");
  /* eslint-enable @typescript-eslint/no-require-imports */
  return useSessionStore;
}

function sessionUsername(store: ReturnType<typeof loadSessionStore>): string {
  return store.getState().me?.username ?? "";
}

/**
 * Once the signed-in user's profile-posts query has succeeded, prefetch the
 * Profile tab index on Android after scroll has been quiet. Idle is
 * `subscribeScrollSettled`, not InteractionManager (RNGH/Reanimated gestures
 * are invisible to it). Pager touch/pager/strip and the tab-switch overlay
 * also publish into that registry. The mount itself goes through the shared
 * serializer, so it never shares a frame with another tab preload. Profile is
 * last: it waits on the notifications stamp and does not stamp a stage.
 */
export function useIdleProfileTabPreload(segments: readonly string[]): void {
  const queryClient = useQueryClient();
  const frcOwner = useRef(Symbol("profile-tab-preload")).current;
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;
  const usernameRef = useRef("");
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

    const sessionStore = loadSessionStore();
    usernameRef.current = sessionUsername(sessionStore);

    let cancelled = false;
    let rafOuter: number | null = null;
    let rafInner: number | null = null;
    let unsubScroll = () => {};
    let unsubApp = () => {};
    let unsubQuery = () => {};
    let unsubNotifications = () => {};
    let unsubSession = () => {};

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
      unsubNotifications();
      unsubNotifications = () => {};
      unsubSession();
      unsubSession = () => {};
    };

    const readSnapshot = () => {
      const ownUsername = usernameRef.current;
      return {
        platform: Platform.OS,
        appActive: AppState.currentState === "active",
        profilePostsSuccess:
          ownUsername.length > 0 &&
          queryClient.getQueryState(["profile-posts", ownUsername])?.status === "success",
        profileTabActive: isTabActive(segmentsRef.current, "profile"),
      };
    };

    const controller = createIdleProfileTabPreloadController({
      quietMs: PROFILE_TAB_PRELOAD_QUIET_MS,
      isScrollSettled,
      getSnapshot: readSnapshot,
      prefetch: () => {
        const serializer = getIdleTabPreloadSerializer();
        serializer.enqueue(
          frcOwner,
          (release) => {
            detachListeners();
            setFrcImageQueuePaused(frcOwner, "drag", true);
            router.prefetch(PROFILE_TAB_PRELOAD_HREF);
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
              const completedAt = getIdleTabPreloadCompleteAt("notifications");
              return canRunQueuedIdleTabPrefetch({
                cancelled,
                platform: snap.platform,
                appActive: snap.appActive,
                dataSuccess: snap.profilePostsSuccess,
                scrollSettled: isScrollSettled(),
                quietForMs: controller.quietForMs(),
                tabActive: snap.profileTabActive,
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
      if (!isOwnProfilePostsQueryKey(event.query.queryKey, usernameRef.current)) return;
      evaluate();
      if (readSnapshot().profilePostsSuccess !== true) abortQueued();
    });

    unsubNotifications = subscribeIdleTabPreloadComplete("notifications", () => {
      evaluate();
      if (getIdleTabPreloadCompleteAt("notifications") == null) abortQueued();
    });

    unsubSession = sessionStore.subscribe((state) => {
      const next = state.me?.username ?? "";
      if (next === usernameRef.current) return;
      usernameRef.current = next;
      evaluate();
      if (readSnapshot().profilePostsSuccess !== true) abortQueued();
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
