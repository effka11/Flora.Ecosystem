import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import {
  COMMUNITIES_OWNED_QUERY_KEY,
  COMMUNITIES_OWNED_SEGMENT,
  COMMUNITIES_QUERY_ROOT,
  COMMUNITIES_RECOMMENDED_QUERY_KEY,
  COMMUNITIES_RECOMMENDED_SEGMENT,
  COMMUNITIES_SUBSCRIPTIONS_SEGMENT,
  communitiesIndexUsername,
  communitiesSubscriptionsQueryKey,
} from "@/lib/communities/communitiesIndexQueries";
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
export const COMMUNITIES_TAB_PRELOAD_QUIET_MS = IDLE_TAB_PRELOAD_QUIET_MS;

export const COMMUNITIES_TAB_PRELOAD_HREF = "/(tabs)/communities";

/** Index-tab cache keys only — not Communities search. */
export function isCommunitiesIndexQueryKey(queryKey: readonly unknown[]): boolean {
  return (
    queryKey[0] === COMMUNITIES_QUERY_ROOT &&
    (queryKey[1] === COMMUNITIES_RECOMMENDED_SEGMENT ||
      queryKey[1] === COMMUNITIES_OWNED_SEGMENT ||
      queryKey[1] === COMMUNITIES_SUBSCRIPTIONS_SEGMENT)
  );
}

export type CommunitiesTabPreloadGate = {
  platform: string; // "android" | "ios" | ...
  appActive: boolean;
  communitiesIndexSuccess: boolean;
  scrollSettled: boolean;
  quietForMs: number;
  communitiesTabActive: boolean;
  alreadyPrefetched: boolean;
  peopleComplete: boolean;
  peopleCompleteForMs: number;
};

export function canPrefetchCommunitiesTab(gate: CommunitiesTabPreloadGate): boolean {
  return canPrefetchIdleTab({
    platform: gate.platform,
    appActive: gate.appActive,
    dataSuccess: gate.communitiesIndexSuccess,
    scrollSettled: gate.scrollSettled,
    quietForMs: gate.quietForMs,
    tabActive: gate.communitiesTabActive,
    alreadyPrefetched: gate.alreadyPrefetched,
    predecessorComplete: gate.peopleComplete,
    predecessorCompleteForMs: gate.peopleCompleteForMs,
  });
}

export type IdleCommunitiesTabPreloadSnapshot = {
  platform: string;
  appActive: boolean;
  /**
   * Recommended and owned are success, and either there is no username or
   * subscriptions is success.
   */
  communitiesIndexSuccess: boolean;
  communitiesTabActive: boolean;
};

export type IdleCommunitiesTabPreloadController = IdleTabPreloadController;

/** Communities binding of the generic idle machine in `lib/idleTabPreload.ts`. */
export function createIdleCommunitiesTabPreloadController(opts: {
  quietMs?: number;
  now?: () => number;
  isScrollSettled: () => boolean;
  getSnapshot: () => IdleCommunitiesTabPreloadSnapshot;
  prefetch: () => void;
}): IdleCommunitiesTabPreloadController {
  return createIdleTabPreloadController({
    quietMs: opts.quietMs ?? COMMUNITIES_TAB_PRELOAD_QUIET_MS,
    now: opts.now ?? Date.now,
    isScrollSettled: opts.isScrollSettled,
    getSnapshot: () => {
      const snapshot = opts.getSnapshot();
      const now = opts.now ?? Date.now;
      const completedAt = getIdleTabPreloadCompleteAt("people");
      return {
        platform: snapshot.platform,
        appActive: snapshot.appActive,
        dataSuccess: snapshot.communitiesIndexSuccess,
        tabActive: snapshot.communitiesTabActive,
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
  return communitiesIndexUsername(store.getState().me?.username ?? "");
}

function communitiesIndexQueriesSuccess(
  queryClient: ReturnType<typeof useQueryClient>,
  username: string,
): boolean {
  if (queryClient.getQueryState(COMMUNITIES_RECOMMENDED_QUERY_KEY)?.status !== "success") {
    return false;
  }
  if (queryClient.getQueryState(COMMUNITIES_OWNED_QUERY_KEY)?.status !== "success") {
    return false;
  }
  const ownUsername = communitiesIndexUsername(username);
  if (ownUsername.length === 0) {
    return true;
  }
  return (
    queryClient.getQueryState(communitiesSubscriptionsQueryKey(ownUsername))?.status === "success"
  );
}

/**
 * Once Communities index queries have succeeded, prefetch the Communities tab
 * index on Android after scroll has been quiet. Idle is `subscribeScrollSettled`,
 * not InteractionManager (RNGH/Reanimated gestures are invisible to it).
 * Pager touch/pager/strip and the tab-switch overlay also publish into that
 * registry. The mount itself goes through the shared serializer, so it never
 * shares a frame with another tab preload. Communities waits on the people
 * stamp and is last in the chain — it does not stamp a stage.
 */
export function useIdleCommunitiesTabPreload(segments: readonly string[]): void {
  const queryClient = useQueryClient();
  const frcOwner = useRef(Symbol("communities-tab-preload")).current;
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
    let unsubPeople = () => {};
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
      unsubPeople();
      unsubPeople = () => {};
      unsubSession();
      unsubSession = () => {};
    };

    const readSnapshot = () => ({
      platform: Platform.OS,
      appActive: AppState.currentState === "active",
      communitiesIndexSuccess: communitiesIndexQueriesSuccess(queryClient, usernameRef.current),
      communitiesTabActive: isTabActive(segmentsRef.current, "communities"),
    });

    const controller = createIdleCommunitiesTabPreloadController({
      quietMs: COMMUNITIES_TAB_PRELOAD_QUIET_MS,
      isScrollSettled,
      getSnapshot: readSnapshot,
      prefetch: () => {
        const serializer = getIdleTabPreloadSerializer();
        serializer.enqueue(
          frcOwner,
          (release) => {
            detachListeners();
            setFrcImageQueuePaused(frcOwner, "drag", true);
            router.prefetch(COMMUNITIES_TAB_PRELOAD_HREF);
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
              const completedAt = getIdleTabPreloadCompleteAt("people");
              return canRunQueuedIdleTabPrefetch({
                cancelled,
                platform: snap.platform,
                appActive: snap.appActive,
                dataSuccess: snap.communitiesIndexSuccess,
                scrollSettled: isScrollSettled(),
                quietForMs: controller.quietForMs(),
                tabActive: snap.communitiesTabActive,
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
      if (!isCommunitiesIndexQueryKey(event.query.queryKey)) return;
      evaluate();
      if (readSnapshot().communitiesIndexSuccess !== true) abortQueued();
    });

    unsubPeople = subscribeIdleTabPreloadComplete("people", () => {
      evaluate();
      if (getIdleTabPreloadCompleteAt("people") == null) abortQueued();
    });

    unsubSession = sessionStore.subscribe((state) => {
      const next = communitiesIndexUsername(state.me?.username ?? "");
      if (next === usernameRef.current) return;
      usernameRef.current = next;
      evaluate();
      if (readSnapshot().communitiesIndexSuccess !== true) abortQueued();
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
