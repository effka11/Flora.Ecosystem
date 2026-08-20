import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { isTabActive } from "@/lib/getActiveTabRouteKey";
import { isScrollSettled, subscribeScrollSettled } from "@/lib/scrollActivity";

/** Quiet window after the last `settled: true` before Android UI prefetch. */
export const MESSAGES_TAB_PRELOAD_QUIET_MS = 400;

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
  return (
    gate.platform === "android" &&
    gate.appActive &&
    gate.conversationsSuccess &&
    gate.scrollSettled &&
    gate.quietForMs >= MESSAGES_TAB_PRELOAD_QUIET_MS &&
    !gate.messagesTabActive &&
    !gate.alreadyPrefetched
  );
}

export type IdleMessagesTabPreloadSnapshot = {
  platform: string;
  appActive: boolean;
  conversationsSuccess: boolean;
  messagesTabActive: boolean;
};

export type IdleMessagesTabPreloadController = {
  evaluate: () => void;
  onScrollSettled: (settled: boolean) => void;
  onAppActive: (active: boolean) => void;
  dispose: () => void;
  hasPendingTimer: () => boolean;
  hasPrefetched: () => boolean;
};

/**
 * Testable idle/prefetch machine. The React hook only binds RN/query to this.
 * Prefetch is not latched until `canPrefetchMessagesTab` is true at fire time
 * and scroll is still settled (RNGH is invisible to InteractionManager).
 */
export function createIdleMessagesTabPreloadController(opts: {
  quietMs?: number;
  now?: () => number;
  isScrollSettled: () => boolean;
  getSnapshot: () => IdleMessagesTabPreloadSnapshot;
  prefetch: () => void;
}): IdleMessagesTabPreloadController {
  const quietMs = opts.quietMs ?? MESSAGES_TAB_PRELOAD_QUIET_MS;
  const now = opts.now ?? Date.now;
  let alreadyPrefetched = false;
  let lastSettledAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const cancelTimer = () => {
    if (timer == null) return;
    clearTimeout(timer);
    timer = null;
  };

  const evaluate = () => {
    if (disposed || alreadyPrefetched) {
      cancelTimer();
      return;
    }

    const snapshot = opts.getSnapshot();
    if (snapshot.messagesTabActive) {
      alreadyPrefetched = true;
      cancelTimer();
      return;
    }

    if (!opts.isScrollSettled()) {
      lastSettledAt = null;
      cancelTimer();
      return;
    }
    if (lastSettledAt == null) {
      lastSettledAt = now();
    }

    const gate: MessagesTabPreloadGate = {
      platform: snapshot.platform,
      appActive: snapshot.appActive,
      conversationsSuccess: snapshot.conversationsSuccess,
      scrollSettled: true,
      quietForMs: now() - lastSettledAt,
      messagesTabActive: snapshot.messagesTabActive,
      alreadyPrefetched,
    };

    if (canPrefetchMessagesTab(gate)) {
      alreadyPrefetched = true;
      cancelTimer();
      opts.prefetch();
      return;
    }

    const readyAfterQuiet = canPrefetchMessagesTab({
      ...gate,
      quietForMs: quietMs,
    });
    if (!readyAfterQuiet) {
      cancelTimer();
      return;
    }

    const wait = quietMs - gate.quietForMs;
    cancelTimer();
    timer = setTimeout(() => {
      timer = null;
      evaluate();
    }, wait);
  };

  return {
    evaluate,
    onScrollSettled(settled) {
      if (settled) {
        lastSettledAt = now();
      } else {
        lastSettledAt = null;
        cancelTimer();
      }
      evaluate();
    },
    onAppActive(active) {
      if (!active) {
        lastSettledAt = null;
        cancelTimer();
        return;
      }
      lastSettledAt = opts.isScrollSettled() ? now() : null;
      evaluate();
    },
    dispose() {
      disposed = true;
      cancelTimer();
    },
    hasPendingTimer: () => timer != null,
    hasPrefetched: () => alreadyPrefetched,
  };
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

    const controller = createIdleMessagesTabPreloadController({
      quietMs: MESSAGES_TAB_PRELOAD_QUIET_MS,
      isScrollSettled,
      getSnapshot: () => ({
        platform: Platform.OS,
        appActive: AppState.currentState === "active",
        conversationsSuccess:
          queryClient.getQueryState(CONVERSATIONS_QUERY_KEY)?.status === "success",
        messagesTabActive: isTabActive(segmentsRef.current, "messages"),
      }),
      prefetch: () => {
        detachListeners();
        setFrcImageQueuePaused(frcOwner, "drag", true);
        router.prefetch(MESSAGES_TAB_PRELOAD_HREF);
        rafOuter = requestAnimationFrame(() => {
          rafOuter = null;
          if (cancelled) return;
          rafInner = requestAnimationFrame(() => {
            rafInner = null;
            if (cancelled) return;
            setFrcImageQueuePaused(frcOwner, "drag", false);
          });
        });
      },
    });

    const evaluate = () => {
      if (cancelled) return;
      controller.evaluate();
      if (controller.hasPrefetched()) detachListeners();
    };
    evaluateRef.current = evaluate;

    unsubScroll = subscribeScrollSettled((settled) => {
      controller.onScrollSettled(settled);
      if (controller.hasPrefetched()) detachListeners();
    });

    const appSub = AppState.addEventListener("change", (state) => {
      controller.onAppActive(state === "active");
      if (controller.hasPrefetched()) detachListeners();
    });
    unsubApp = () => appSub.remove();

    unsubQuery = queryClient.getQueryCache().subscribe((event) => {
      if (event.query.queryKey[0] !== "conversations") return;
      evaluate();
    });

    evaluate();

    return () => {
      cancelled = true;
      evaluateRef.current = () => {};
      controller.dispose();
      cancelRafs();
      detachListeners();
      clearFrcImageQueuePauseOwner(frcOwner);
    };
  }, [frcOwner, queryClient]);

  useEffect(() => {
    evaluateRef.current();
  }, [segments]);
}
