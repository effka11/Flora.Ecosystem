import { useEffect, useRef } from "react";
import { isTabActive } from "@/lib/getActiveTabRouteKey";
import {
  abortQueuedIdleTabPrefetch,
  beginIdleTabPreloadEpoch,
  canPrefetchIdleTab,
  canRunQueuedIdleTabPrefetch,
  createIdleTabPreloadController,
  getIdleTabPreloadCompleteAt,
  getIdleTabPreloadSerializer,
  IDLE_TAB_PRELOAD_QUIET_MS,
  markIdleTabPreloadComplete,
  subscribeIdleTabPreloadComplete,
  type IdleTabPreloadController,
} from "@/lib/idleTabPreload";
import { isScrollSettled, subscribeScrollSettled } from "@/lib/scrollActivity";

/** Quiet window after the last `settled: true` before Android UI prefetch. */
export const SETTINGS_TAB_PRELOAD_QUIET_MS = IDLE_TAB_PRELOAD_QUIET_MS;

/** Android prefetch finish: stamp then release so Contribute can wait on `"settings"`. */
export function finishSettingsIdleTabPrefetch(release: () => void): void {
  markIdleTabPreloadComplete("settings");
  release();
}

export const SETTINGS_TAB_PRELOAD_HREF = "/(tabs)/settings";

export type SettingsTabPreloadGate = {
  platform: string; // "android" | "ios" | ...
  appActive: boolean;
  scrollSettled: boolean;
  quietForMs: number;
  settingsTabActive: boolean;
  alreadyPrefetched: boolean;
  communitiesComplete: boolean;
  communitiesCompleteForMs: number;
};

export function canPrefetchSettingsTab(gate: SettingsTabPreloadGate): boolean {
  return canPrefetchIdleTab({
    platform: gate.platform,
    appActive: gate.appActive,
    dataSuccess: true,
    scrollSettled: gate.scrollSettled,
    quietForMs: gate.quietForMs,
    tabActive: gate.settingsTabActive,
    alreadyPrefetched: gate.alreadyPrefetched,
    predecessorComplete: gate.communitiesComplete,
    predecessorCompleteForMs: gate.communitiesCompleteForMs,
  });
}

export type IdleSettingsTabPreloadSnapshot = {
  platform: string;
  appActive: boolean;
  settingsTabActive: boolean;
};

export type IdleSettingsTabPreloadController = IdleTabPreloadController;

/** Settings binding of the generic idle machine in `lib/idleTabPreload.ts`. */
export function createIdleSettingsTabPreloadController(opts: {
  quietMs?: number;
  now?: () => number;
  isScrollSettled: () => boolean;
  getSnapshot: () => IdleSettingsTabPreloadSnapshot;
  prefetch: () => void;
}): IdleSettingsTabPreloadController {
  return createIdleTabPreloadController({
    quietMs: opts.quietMs ?? SETTINGS_TAB_PRELOAD_QUIET_MS,
    now: opts.now ?? Date.now,
    isScrollSettled: opts.isScrollSettled,
    getSnapshot: () => {
      const snapshot = opts.getSnapshot();
      const now = opts.now ?? Date.now;
      const completedAt = getIdleTabPreloadCompleteAt("communities");
      return {
        platform: snapshot.platform,
        appActive: snapshot.appActive,
        dataSuccess: true,
        tabActive: snapshot.settingsTabActive,
        predecessorComplete: completedAt != null,
        predecessorCompleteForMs: completedAt == null ? 0 : now() - completedAt,
      };
    },
    prefetch: opts.prefetch,
    onSkip: () => markIdleTabPreloadComplete("settings"),
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
 * Prefetch the Settings tab on Android after scroll has been quiet.
 * Idle is `subscribeScrollSettled`, not InteractionManager (RNGH/Reanimated
 * gestures are invisible to it). There is no query/session warm-up in this hook:
 * privacy/feed loads run on the screen itself after the hidden mount, and
 * `dataSuccess` is always true. The mount itself goes through the shared
 * serializer, so it never shares a frame with another tab preload. Settings
 * waits on the communities stamp, then stamps `"settings"` for Contribute.
 */
export function useIdleSettingsTabPreload(segments: readonly string[]): void {
  const frcOwner = useRef(Symbol("settings-tab-preload")).current;
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

    beginIdleTabPreloadEpoch("settings");

    let cancelled = false;
    let rafOuter: number | null = null;
    let rafInner: number | null = null;
    let unsubScroll = () => {};
    let unsubApp = () => {};
    let unsubCommunities = () => {};

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
      unsubCommunities();
      unsubCommunities = () => {};
    };

    const readSnapshot = () => ({
      platform: Platform.OS,
      appActive: AppState.currentState === "active",
      settingsTabActive: isTabActive(segmentsRef.current, "settings"),
    });

    const controller = createIdleSettingsTabPreloadController({
      quietMs: SETTINGS_TAB_PRELOAD_QUIET_MS,
      isScrollSettled,
      getSnapshot: readSnapshot,
      prefetch: () => {
        const serializer = getIdleTabPreloadSerializer();
        serializer.enqueue(
          frcOwner,
          (release) => {
            detachListeners();
            setFrcImageQueuePaused(frcOwner, "drag", true);
            router.prefetch(SETTINGS_TAB_PRELOAD_HREF);
            const finish = () => {
              finishSettingsIdleTabPrefetch(release);
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
              const completedAt = getIdleTabPreloadCompleteAt("communities");
              return canRunQueuedIdleTabPrefetch({
                cancelled,
                platform: snap.platform,
                appActive: snap.appActive,
                dataSuccess: true,
                scrollSettled: isScrollSettled(),
                quietForMs: controller.quietForMs(),
                tabActive: snap.settingsTabActive,
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

    unsubCommunities = subscribeIdleTabPreloadComplete("communities", () => {
      evaluate();
      if (getIdleTabPreloadCompleteAt("communities") == null) abortQueued();
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
