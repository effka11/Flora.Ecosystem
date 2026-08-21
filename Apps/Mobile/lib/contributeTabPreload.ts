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
export const CONTRIBUTE_TAB_PRELOAD_QUIET_MS = IDLE_TAB_PRELOAD_QUIET_MS;

export const CONTRIBUTE_TAB_PRELOAD_HREF = "/(tabs)/contribute";

export type ContributeTabPreloadGate = {
  platform: string; // "android" | "ios" | ...
  appActive: boolean;
  scrollSettled: boolean;
  quietForMs: number;
  contributeTabActive: boolean;
  alreadyPrefetched: boolean;
  settingsComplete: boolean;
  settingsCompleteForMs: number;
};

export function canPrefetchContributeTab(gate: ContributeTabPreloadGate): boolean {
  return canPrefetchIdleTab({
    platform: gate.platform,
    appActive: gate.appActive,
    dataSuccess: true,
    scrollSettled: gate.scrollSettled,
    quietForMs: gate.quietForMs,
    tabActive: gate.contributeTabActive,
    alreadyPrefetched: gate.alreadyPrefetched,
    predecessorComplete: gate.settingsComplete,
    predecessorCompleteForMs: gate.settingsCompleteForMs,
  });
}

export type IdleContributeTabPreloadSnapshot = {
  platform: string;
  appActive: boolean;
  contributeTabActive: boolean;
};

export type IdleContributeTabPreloadController = IdleTabPreloadController;

/** Contribute binding of the generic idle machine in `lib/idleTabPreload.ts`. */
export function createIdleContributeTabPreloadController(opts: {
  quietMs?: number;
  now?: () => number;
  isScrollSettled: () => boolean;
  getSnapshot: () => IdleContributeTabPreloadSnapshot;
  prefetch: () => void;
}): IdleContributeTabPreloadController {
  return createIdleTabPreloadController({
    quietMs: opts.quietMs ?? CONTRIBUTE_TAB_PRELOAD_QUIET_MS,
    now: opts.now ?? Date.now,
    isScrollSettled: opts.isScrollSettled,
    getSnapshot: () => {
      const snapshot = opts.getSnapshot();
      const now = opts.now ?? Date.now;
      const completedAt = getIdleTabPreloadCompleteAt("settings");
      return {
        platform: snapshot.platform,
        appActive: snapshot.appActive,
        dataSuccess: true,
        tabActive: snapshot.contributeTabActive,
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

/**
 * Prefetch the static Contribute tab on Android after scroll has been quiet.
 * Idle is `subscribeScrollSettled`, not InteractionManager (RNGH/Reanimated
 * gestures are invisible to it). There is no query/session warm-up: the screen
 * is static, so `dataSuccess` is always true. The mount itself goes through
 * the shared serializer, so it never shares a frame with another tab preload.
 * Contribute waits on the settings stamp and does not stamp a stage.
 */
export function useIdleContributeTabPreload(segments: readonly string[]): void {
  const frcOwner = useRef(Symbol("contribute-tab-preload")).current;
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
    let unsubSettings = () => {};

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
      unsubSettings();
      unsubSettings = () => {};
    };

    const readSnapshot = () => ({
      platform: Platform.OS,
      appActive: AppState.currentState === "active",
      contributeTabActive: isTabActive(segmentsRef.current, "contribute"),
    });

    const controller = createIdleContributeTabPreloadController({
      quietMs: CONTRIBUTE_TAB_PRELOAD_QUIET_MS,
      isScrollSettled,
      getSnapshot: readSnapshot,
      prefetch: () => {
        const serializer = getIdleTabPreloadSerializer();
        serializer.enqueue(
          frcOwner,
          (release) => {
            detachListeners();
            setFrcImageQueuePaused(frcOwner, "drag", true);
            router.prefetch(CONTRIBUTE_TAB_PRELOAD_HREF);
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
              const completedAt = getIdleTabPreloadCompleteAt("settings");
              return canRunQueuedIdleTabPrefetch({
                cancelled,
                platform: snap.platform,
                appActive: snap.appActive,
                dataSuccess: true,
                scrollSettled: isScrollSettled(),
                quietForMs: controller.quietForMs(),
                tabActive: snap.contributeTabActive,
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

    unsubSettings = subscribeIdleTabPreloadComplete("settings", () => {
      evaluate();
      if (getIdleTabPreloadCompleteAt("settings") == null) abortQueued();
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
  }, [frcOwner]);

  useEffect(() => {
    evaluateRef.current();
  }, [segments]);
}
