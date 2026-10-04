import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { isTabActive } from "@/lib/getActiveTabRouteKey";
import {
  abortQueuedIdleTabPrefetch,
  beginMessagesIdlePreloadEpoch,
  canPrefetchIdleTab,
  canRunQueuedIdleTabPrefetch,
  createIdleTabPreloadController,
  getIdleTabPreloadSerializer,
  IDLE_TAB_PRELOAD_QUIET_MS,
  IDLE_TAB_PRELOAD_SERIAL_GAP_MS,
  markMessagesIdlePreloadComplete,
  type IdleTabPreloadController,
} from "@/lib/idleTabPreload";
import { isScrollSettled, subscribeScrollSettled } from "@/lib/scrollActivity";

/** Quiet window after the last `settled: true` before Android UI prefetch. */
export const MESSAGES_TAB_PRELOAD_QUIET_MS = IDLE_TAB_PRELOAD_QUIET_MS;

const CONVERSATIONS_QUERY_KEY = ["conversations"] as const;
const MESSAGES_TAB_PRELOAD_HREF = "/(tabs)/messages";

export type MessagesTabPreloadGate = {
  platform: string; // "android" | "ios" | ...
  appActive: boolean;
  conversationsSuccess: boolean;
  scrollSettled: boolean;
  quietForMs: number;
  messagesTabActive: boolean;
  alreadyPrefetched: boolean;
};

export function canPrefetchMessagesTab(gate: MessagesTabPreloadGate): boolean {
  return canPrefetchIdleTab({
    platform: gate.platform,
    appActive: gate.appActive,
    dataSuccess: gate.conversationsSuccess,
    scrollSettled: gate.scrollSettled,
    quietForMs: gate.quietForMs,
    tabActive: gate.messagesTabActive,
    alreadyPrefetched: gate.alreadyPrefetched,
    predecessorComplete: true,
    predecessorCompleteForMs: IDLE_TAB_PRELOAD_SERIAL_GAP_MS,
  });
}

export type IdleMessagesTabPreloadSnapshot = {
  platform: string;
  appActive: boolean;
  conversationsSuccess: boolean;
  messagesTabActive: boolean;
};

export type IdleMessagesTabPreloadController = IdleTabPreloadController;

/** Messages binding of the generic idle machine in `lib/idleTabPreload.ts`. */
export function createIdleMessagesTabPreloadController(opts: {
  quietMs?: number;
  now?: () => number;
  isScrollSettled: () => boolean;
  getSnapshot: () => IdleMessagesTabPreloadSnapshot;
  prefetch: () => void;
}): IdleMessagesTabPreloadController {
  return createIdleTabPreloadController({
    quietMs: opts.quietMs ?? MESSAGES_TAB_PRELOAD_QUIET_MS,
    now: opts.now ?? Date.now,
    isScrollSettled: opts.isScrollSettled,
    getSnapshot: () => {
      const snapshot = opts.getSnapshot();
      return {
        platform: snapshot.platform,
        appActive: snapshot.appActive,
        dataSuccess: snapshot.conversationsSuccess,
        tabActive: snapshot.messagesTabActive,
        predecessorComplete: true,
        predecessorCompleteForMs: IDLE_TAB_PRELOAD_SERIAL_GAP_MS,
      };
    },
    prefetch: opts.prefetch,
    onSkip: markMessagesIdlePreloadComplete,
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
 * Once the conversations query has succeeded, prefetch the Messages tab index
 * on Android after scroll has been quiet. Idle is `subscribeScrollSettled`,
 * not InteractionManager (RNGH/Reanimated gestures are invisible to it).
 * Pager touch/pager/strip and the tab-switch overlay also publish into that registry.
 * The mount itself goes through the shared serializer, so it never shares a
 * frame with another tab preload.
 */
export function useIdleMessagesTabPreload(segments: readonly string[]): void {
  const queryClient = useQueryClient();
  const frcOwner = useRef(Symbol("messages-tab-preload")).current;
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

    beginMessagesIdlePreloadEpoch();

    let cancelled = false;
    let rafOuter: number | null = null;
    let rafInner: number | null = null;
    let unsubScroll = () => {};
    let unsubApp = () => {};
    let unsubQuery = () => {};

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
    };

    const readSnapshot = () => ({
      platform: Platform.OS,
      appActive: AppState.currentState === "active",
      conversationsSuccess:
        queryClient.getQueryState(CONVERSATIONS_QUERY_KEY)?.status === "success",
      messagesTabActive: isTabActive(segmentsRef.current, "messages"),
    });

    const controller = createIdleMessagesTabPreloadController({
      quietMs: MESSAGES_TAB_PRELOAD_QUIET_MS,
      isScrollSettled,
      getSnapshot: readSnapshot,
      prefetch: () => {
        const serializer = getIdleTabPreloadSerializer();
        serializer.enqueue(
          frcOwner,
          (release) => {
            detachListeners();
            setFrcImageQueuePaused(frcOwner, "drag", true);
            router.prefetch(MESSAGES_TAB_PRELOAD_HREF);
            const finish = () => {
              markMessagesIdlePreloadComplete();
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
              return canRunQueuedIdleTabPrefetch({
                cancelled,
                platform: snap.platform,
                appActive: snap.appActive,
                dataSuccess: snap.conversationsSuccess,
                scrollSettled: isScrollSettled(),
                quietForMs: controller.quietForMs(),
                tabActive: snap.messagesTabActive,
                predecessorComplete: true,
                predecessorCompleteForMs: IDLE_TAB_PRELOAD_SERIAL_GAP_MS,
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
      if (event.query.queryKey[0] !== "conversations") return;
      evaluate();
      if (readSnapshot().conversationsSuccess !== true) abortQueued();
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
