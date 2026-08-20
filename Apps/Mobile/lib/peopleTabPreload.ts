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
  PEOPLE_FOLLOWERS_SEGMENT,
  PEOPLE_FOLLOWING_SEGMENT,
  PEOPLE_QUERY_ROOT,
  PEOPLE_RECOMMENDED_QUERY_KEY,
  PEOPLE_RECOMMENDED_SEGMENT,
  peopleFollowersQueryKey,
  peopleFollowingQueryKey,
  peopleIndexUsername,
} from "@/lib/people/peopleIndexQueries";
import { isScrollSettled, subscribeScrollSettled } from "@/lib/scrollActivity";

/** Quiet window after the last `settled: true` before Android UI prefetch. */
export const PEOPLE_TAB_PRELOAD_QUIET_MS = IDLE_TAB_PRELOAD_QUIET_MS;

export const PEOPLE_TAB_PRELOAD_HREF = "/(tabs)/people";

/** Index-tab cache keys only — not People search. */
export function isPeopleIndexQueryKey(queryKey: readonly unknown[]): boolean {
  return (
    queryKey[0] === PEOPLE_QUERY_ROOT &&
    (queryKey[1] === PEOPLE_RECOMMENDED_SEGMENT ||
      queryKey[1] === PEOPLE_FOLLOWERS_SEGMENT ||
      queryKey[1] === PEOPLE_FOLLOWING_SEGMENT)
  );
}

export type PeopleTabPreloadGate = {
  platform: string; // "android" | "ios" | ...
  appActive: boolean;
  peopleIndexSuccess: boolean;
  scrollSettled: boolean;
  quietForMs: number;
  peopleTabActive: boolean;
  alreadyPrefetched: boolean;
  musicComplete: boolean;
  musicCompleteForMs: number;
};

export function canPrefetchPeopleTab(gate: PeopleTabPreloadGate): boolean {
  return canPrefetchIdleTab({
    platform: gate.platform,
    appActive: gate.appActive,
    dataSuccess: gate.peopleIndexSuccess,
    scrollSettled: gate.scrollSettled,
    quietForMs: gate.quietForMs,
    tabActive: gate.peopleTabActive,
    alreadyPrefetched: gate.alreadyPrefetched,
    predecessorComplete: gate.musicComplete,
    predecessorCompleteForMs: gate.musicCompleteForMs,
  });
}

export type IdlePeopleTabPreloadSnapshot = {
  platform: string;
  appActive: boolean;
  /**
   * Recommended is success, and either there is no username or both
   * followers and following are success.
   */
  peopleIndexSuccess: boolean;
  peopleTabActive: boolean;
};

export type IdlePeopleTabPreloadController = IdleTabPreloadController;

/** People binding of the generic idle machine in `lib/idleTabPreload.ts`. */
export function createIdlePeopleTabPreloadController(opts: {
  quietMs?: number;
  now?: () => number;
  isScrollSettled: () => boolean;
  getSnapshot: () => IdlePeopleTabPreloadSnapshot;
  prefetch: () => void;
}): IdlePeopleTabPreloadController {
  return createIdleTabPreloadController({
    quietMs: opts.quietMs ?? PEOPLE_TAB_PRELOAD_QUIET_MS,
    now: opts.now ?? Date.now,
    isScrollSettled: opts.isScrollSettled,
    getSnapshot: () => {
      const snapshot = opts.getSnapshot();
      const now = opts.now ?? Date.now;
      const completedAt = getIdleTabPreloadCompleteAt("music");
      return {
        platform: snapshot.platform,
        appActive: snapshot.appActive,
        dataSuccess: snapshot.peopleIndexSuccess,
        tabActive: snapshot.peopleTabActive,
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
  return peopleIndexUsername(store.getState().me?.username ?? "");
}

function peopleIndexQueriesSuccess(
  queryClient: ReturnType<typeof useQueryClient>,
  username: string,
): boolean {
  if (queryClient.getQueryState(PEOPLE_RECOMMENDED_QUERY_KEY)?.status !== "success") {
    return false;
  }
  const ownUsername = peopleIndexUsername(username);
  if (ownUsername.length === 0) {
    return true;
  }
  return (
    queryClient.getQueryState(peopleFollowersQueryKey(ownUsername))?.status === "success" &&
    queryClient.getQueryState(peopleFollowingQueryKey(ownUsername))?.status === "success"
  );
}

/**
 * Once People index queries have succeeded, prefetch the People tab index
 * on Android after scroll has been quiet. Idle is `subscribeScrollSettled`,
 * not InteractionManager (RNGH/Reanimated gestures are invisible to it).
 * Pager touch/pager/strip and the tab-switch overlay also publish into that
 * registry. The mount itself goes through the shared serializer, so it never
 * shares a frame with another tab preload. People waits on the music stamp
 * and does not stamp a People stage (no successor in the idle chain).
 */
export function useIdlePeopleTabPreload(segments: readonly string[]): void {
  const queryClient = useQueryClient();
  const frcOwner = useRef(Symbol("people-tab-preload")).current;
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
    let unsubMusic = () => {};
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
      unsubMusic();
      unsubMusic = () => {};
      unsubSession();
      unsubSession = () => {};
    };

    const readSnapshot = () => ({
      platform: Platform.OS,
      appActive: AppState.currentState === "active",
      peopleIndexSuccess: peopleIndexQueriesSuccess(queryClient, usernameRef.current),
      peopleTabActive: isTabActive(segmentsRef.current, "people"),
    });

    const controller = createIdlePeopleTabPreloadController({
      quietMs: PEOPLE_TAB_PRELOAD_QUIET_MS,
      isScrollSettled,
      getSnapshot: readSnapshot,
      prefetch: () => {
        const serializer = getIdleTabPreloadSerializer();
        serializer.enqueue(
          frcOwner,
          (release) => {
            detachListeners();
            setFrcImageQueuePaused(frcOwner, "drag", true);
            router.prefetch(PEOPLE_TAB_PRELOAD_HREF);
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
              const completedAt = getIdleTabPreloadCompleteAt("music");
              return canRunQueuedIdleTabPrefetch({
                cancelled,
                platform: snap.platform,
                appActive: snap.appActive,
                dataSuccess: snap.peopleIndexSuccess,
                scrollSettled: isScrollSettled(),
                quietForMs: controller.quietForMs(),
                tabActive: snap.peopleTabActive,
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
      if (!isPeopleIndexQueryKey(event.query.queryKey)) return;
      evaluate();
      if (readSnapshot().peopleIndexSuccess !== true) abortQueued();
    });

    unsubMusic = subscribeIdleTabPreloadComplete("music", () => {
      evaluate();
      if (getIdleTabPreloadCompleteAt("music") == null) abortQueued();
    });

    unsubSession = sessionStore.subscribe((state) => {
      const next = peopleIndexUsername(state.me?.username ?? "");
      if (next === usernameRef.current) return;
      usernameRef.current = next;
      evaluate();
      if (readSnapshot().peopleIndexSuccess !== true) abortQueued();
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
