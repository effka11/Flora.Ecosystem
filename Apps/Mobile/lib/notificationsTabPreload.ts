import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { isTabActive } from "@/lib/getActiveTabRouteKey";
import {
  abortQueuedIdleTabPrefetch,
  beginIdleTabPreloadEpoch,
  canPrefetchIdleTab,
  canRunQueuedIdleTabPrefetch,
  createIdleTabPreloadController,
  getIdleTabPreloadSerializer,
  getMessagesIdlePreloadCompleteAt,
  IDLE_TAB_PRELOAD_QUIET_MS,
  markIdleTabPreloadComplete,
  subscribeMessagesIdlePreloadComplete,
  type IdleTabPreloadController,
} from "@/lib/idleTabPreload";
import { isScrollSettled, subscribeScrollSettled } from "@/lib/scrollActivity";

/** Quiet window after the last `settled: true` before Android UI prefetch. */
export const NOTIFICATIONS_TAB_PRELOAD_QUIET_MS = IDLE_TAB_PRELOAD_QUIET_MS;

const NOTIFICATIONS_ALL_QUERY_KEY = ["notifications", "all", ""] as const;
const NOTIFICATIONS_TAB_PRELOAD_HREF = "/(tabs)/notifications";

export type NotificationsTabPreloadGate = {
  platform: string; // "android" | "ios" | ...
  appActive: boolean;
  notificationsSuccess: boolean;
  scrollSettled: boolean;
  quietForMs: number;
  notificationsTabActive: boolean;
  alreadyPrefetched: boolean;
  /** Messages skip/prefetch stamp — this wrapper still waits on Messages. */
  messagesComplete: boolean;
  messagesCompleteForMs: number;
};

export function canPrefetchNotificationsTab(gate: NotificationsTabPreloadGate): boolean {
  return canPrefetchIdleTab({
    platform: gate.platform,
    appActive: gate.appActive,
    dataSuccess: gate.notificationsSuccess,
    scrollSettled: gate.scrollSettled,
    quietForMs: gate.quietForMs,
    tabActive: gate.notificationsTabActive,
    alreadyPrefetched: gate.alreadyPrefetched,
    predecessorComplete: gate.messagesComplete,
    predecessorCompleteForMs: gate.messagesCompleteForMs,
  });
}

export type IdleNotificationsTabPreloadSnapshot = {
  platform: string;
  appActive: boolean;
  notificationsSuccess: boolean;
  notificationsTabActive: boolean;
};

export type IdleNotificationsTabPreloadController = IdleTabPreloadController;

/** Notifications binding of the generic idle machine in `lib/idleTabPreload.ts`. */
export function createIdleNotificationsTabPreloadController(opts: {
  quietMs?: number;
  now?: () => number;
  isScrollSettled: () => boolean;
  getSnapshot: () => IdleNotificationsTabPreloadSnapshot;
  prefetch: () => void;
}): IdleNotificationsTabPreloadController {
  return createIdleTabPreloadController({
    quietMs: opts.quietMs ?? NOTIFICATIONS_TAB_PRELOAD_QUIET_MS,
    now: opts.now ?? Date.now,
    isScrollSettled: opts.isScrollSettled,
    getSnapshot: () => {
      const snapshot = opts.getSnapshot();
      const now = opts.now ?? Date.now;
      const completedAt = getMessagesIdlePreloadCompleteAt();
      return {
        platform: snapshot.platform,
        appActive: snapshot.appActive,
        dataSuccess: snapshot.notificationsSuccess,
        tabActive: snapshot.notificationsTabActive,
        predecessorComplete: completedAt != null,
        predecessorCompleteForMs: completedAt == null ? 0 : now() - completedAt,
      };
    },
    prefetch: opts.prefetch,
    onSkip: () => markIdleTabPreloadComplete("notifications"),
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

/**
 * Once the notifications all-list query has succeeded, prefetch the
 * Notifications tab index on Android after scroll has been quiet. Idle is
 * `subscribeScrollSettled`, not InteractionManager (RNGH/Reanimated gestures
 * are invisible to it). Pager touch/pager/strip and the tab-switch overlay
 * also publish into that registry. The mount itself goes through the shared
 * serializer, so it never shares a frame with another tab preload.
 */
export function useIdleNotificationsTabPreload(segments: readonly string[]): void {
  const queryClient = useQueryClient();
  const frcOwner = useRef(Symbol("notifications-tab-preload")).current;
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

    beginIdleTabPreloadEpoch("notifications");

    let cancelled = false;
    let rafOuter: number | null = null;
    let rafInner: number | null = null;
    let unsubScroll = () => {};
    let unsubApp = () => {};
    let unsubQuery = () => {};
    let unsubMessages = () => {};

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
      unsubMessages();
      unsubMessages = () => {};
    };

    const readSnapshot = () => ({
      platform: Platform.OS,
      appActive: AppState.currentState === "active",
      notificationsSuccess:
        queryClient.getQueryState(NOTIFICATIONS_ALL_QUERY_KEY)?.status === "success",
      notificationsTabActive: isTabActive(segmentsRef.current, "notifications"),
    });

    const controller = createIdleNotificationsTabPreloadController({
      quietMs: NOTIFICATIONS_TAB_PRELOAD_QUIET_MS,
      isScrollSettled,
      getSnapshot: readSnapshot,
      prefetch: () => {
        const serializer = getIdleTabPreloadSerializer();
        serializer.enqueue(
          frcOwner,
          (release) => {
            detachListeners();
            setFrcImageQueuePaused(frcOwner, "drag", true);
            router.prefetch(NOTIFICATIONS_TAB_PRELOAD_HREF);
            const finish = () => {
              markIdleTabPreloadComplete("notifications");
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
              const completedAt = getMessagesIdlePreloadCompleteAt();
              return canRunQueuedIdleTabPrefetch({
                cancelled,
                platform: snap.platform,
                appActive: snap.appActive,
                dataSuccess: snap.notificationsSuccess,
                scrollSettled: isScrollSettled(),
                quietForMs: controller.quietForMs(),
                tabActive: snap.notificationsTabActive,
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
      if (event.query.queryKey[0] !== "notifications") return;
      evaluate();
      if (readSnapshot().notificationsSuccess !== true) abortQueued();
    });

    unsubMessages = subscribeMessagesIdlePreloadComplete(() => {
      evaluate();
      if (getMessagesIdlePreloadCompleteAt() == null) abortQueued();
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
