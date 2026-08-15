import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentRef,
  type ComponentType,
  type Ref,
} from "react";
import type {
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollViewProps,
} from "react-native";
import Reanimated, {
  runOnJS,
  useAnimatedReaction,
  useAnimatedRef,
  useEvent,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import { ScrollView as GestureHandlerScrollView } from "react-native-gesture-handler";
import {
  installEdgeFlingGuard,
  uninstallEdgeFlingGuard,
} from "flora-scroll-fling";
import {
  clearFrcImageQueuePauseOwner,
  setFrcImageQueuePaused,
} from "@/lib/frcImage";
import {
  DRAWER_EDGE_GUARD_VERTICAL_SLOP,
  DRAWER_EDGE_HIT_WIDTH,
} from "@/lib/drawerEdgeGesture";
import {
  clearScrollActivityOwner,
  setScrollActivity,
} from "@/lib/scrollActivity";
import {
  SCROLL_PHASE_COAST,
  SCROLL_PHASE_DRAG,
  SCROLL_PHASE_IDLE,
  type DrawerMomentumController,
  type DrawerMomentumPane,
} from "@/lib/drawerMomentum";

const SCROLL_EVENT_NAMES = [
  "onScroll",
  "onScrollBeginDrag",
  "onScrollEndDrag",
  "onMomentumScrollBegin",
  "onMomentumScrollEnd",
];

/** Максимальный разрыв между onScroll в coast, чтобы считать поток инерцией. */
export const PAGER_SCROLL_COAST_GAP_MS = 120;

type WorkletEventHandlerHolder = {
  workletEventHandler: {
    registerForEvents: (viewTag: number) => void;
    unregisterFromEvents: (viewTag: number) => void;
  };
};

export type PagerListCollapse = {
  collapse: SharedValue<number>;
  headerH: SharedValue<number>;
  lastY: SharedValue<number>;
};

export type CreatePagerFlashListScrollOptions = {
  pane: DrawerMomentumPane;
  edgePanRef: DrawerMomentumController["edgePanRef"];
  activePaneSv: SharedValue<number>;
  paneIndex: number;
  /** 1 — экран в фокусе и владеет drawer viewTag; иначе не перехватывать слот соседней вкладки. */
  screenActiveSv: SharedValue<number>;
  /** Только лента: аккумулятор скрытия шапки. */
  collapse?: PagerListCollapse;
};

/**
 * RNGH ScrollView для FlashList внутри пейджера: overScrollMode после settle,
 * edge fling, пауза FRC. Collapse — опционально (только главная лента).
 */
export function createPagerFlashListScroll(
  options: CreatePagerFlashListScrollOptions,
): ComponentType<ScrollViewProps> {
  const { pane, edgePanRef, activePaneSv, paneIndex, screenActiveSv, collapse } = options;

  const FlashListScroll = forwardRef(function FlashListScroll(
    props: ScrollViewProps,
    ref: Ref<Reanimated.ScrollView>,
  ) {
    const animatedRef = useAnimatedRef<Reanimated.ScrollView>();
    const mediaPauseOwner = useRef(Symbol("pager-scroll")).current;
    const momentumFallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const localLastY = useSharedValue(0);
    const lastY = collapse?.lastY ?? localLastY;
    const dir = useSharedValue(0);
    const [armed, setArmed] = useState(() => screenActiveSv.value === 1);
    const [overScrollMode, setOverScrollMode] = useState<"auto" | "never">(
      paneIndex === 0 ? "auto" : "never",
    );
    const {
      onMomentumScrollBegin: onMomentumScrollBeginProp,
      onMomentumScrollEnd: onMomentumScrollEndProp,
      onScrollBeginDrag: onScrollBeginDragProp,
      onScrollEndDrag: onScrollEndDragProp,
    } = props;

    useAnimatedReaction(
      () => screenActiveSv.value,
      (next, prev) => {
        if (next === prev) return;
        runOnJS(setArmed)(next === 1);
      },
      [screenActiveSv],
    );

    useAnimatedReaction(
      () => (activePaneSv.value === paneIndex ? 1 : 0),
      (allow, prev) => {
        if (allow === prev) return;
        runOnJS(setOverScrollMode)(allow === 1 ? "auto" : "never");
      },
      [activePaneSv, paneIndex],
    );

    const composedRef = useCallback(
      (instance: Reanimated.ScrollView | null) => {
        if (instance) animatedRef(instance);
        if (typeof ref === "function") {
          ref(instance);
        } else if (ref) {
          (ref as { current: Reanimated.ScrollView | null }).current = instance;
        }
      },
      [animatedRef, ref],
    );

    const scrollEvents = useEvent<NativeScrollEvent>(
      (event) => {
        "worklet";
        const name = event.eventName;
        const y = Math.max(0, event.contentOffset.y);
        const now = performance.now();
        const headerH = collapse ? Math.max(1, collapse.headerH.value) : 1;

        if (name.endsWith("onScrollBeginDrag")) {
          pane.phase.value = SCROLL_PHASE_DRAG;
          pane.velocityY.value = 0;
          dir.value = 0;
          lastY.value = y;
          pane.lastEventTs.value = now;
        } else if (name.endsWith("onScrollEndDrag")) {
          pane.phase.value = SCROLL_PHASE_COAST;
          const reportedVelocity = event.velocity?.y ?? 0;
          if (Math.abs(reportedVelocity) > 0.1) {
            pane.velocityY.value = reportedVelocity;
          }
          if (Math.abs(pane.velocityY.value) > 0.1) {
            pane.lastCoastVelocityY.value = pane.velocityY.value;
            pane.lastCoastEventTs.value = now;
          }
          lastY.value = y;
          pane.lastEventTs.value = now;
        } else if (name.endsWith("onMomentumScrollBegin")) {
          pane.phase.value = SCROLL_PHASE_COAST;
          const reportedVelocity = event.velocity?.y ?? 0;
          if (Math.abs(reportedVelocity) > 0.1) {
            pane.velocityY.value = reportedVelocity;
          }
          if (Math.abs(pane.velocityY.value) > 0.1) {
            pane.lastCoastVelocityY.value = pane.velocityY.value;
            pane.lastCoastEventTs.value = now;
          }
          lastY.value = y;
          pane.lastEventTs.value = now;
        } else if (name.endsWith("onMomentumScrollEnd")) {
          pane.phase.value = SCROLL_PHASE_IDLE;
          pane.velocityY.value = 0;
          lastY.value = y;
        } else {
          const delta = y - lastY.value;
          const gap = now - pane.lastEventTs.value;
          lastY.value = y;
          pane.lastEventTs.value = now;
          const phase = pane.phase.value;

          if (phase === SCROLL_PHASE_DRAG) {
            if (gap > 0 && gap <= PAGER_SCROLL_COAST_GAP_MS && Math.abs(delta) > 0.1) {
              const instantaneousVelocity = (delta / gap) * 1000;
              pane.velocityY.value =
                pane.velocityY.value * 0.35 + instantaneousVelocity * 0.65;
            }
            if (collapse) {
              collapse.collapse.value = Math.min(
                headerH,
                Math.max(0, collapse.collapse.value + delta),
              );
            }
            if (Math.abs(delta) > 0.5) dir.value = delta > 0 ? 1 : -1;
          } else if (phase === SCROLL_PHASE_COAST) {
            if (gap > PAGER_SCROLL_COAST_GAP_MS) {
              pane.phase.value = SCROLL_PHASE_IDLE;
              pane.velocityY.value = 0;
            } else {
              let nextDir = dir.value;
              if (nextDir === 0 && Math.abs(delta) > 1) {
                nextDir = delta > 0 ? 1 : -1;
                dir.value = nextDir;
              }
              if (nextDir !== 0 && delta * nextDir > 0) {
                if (gap > 0 && Math.abs(delta) > 0.1) {
                  const instantaneousVelocity = (delta / gap) * 1000;
                  pane.velocityY.value =
                    pane.velocityY.value * 0.35 + instantaneousVelocity * 0.65;
                  pane.lastCoastVelocityY.value = pane.velocityY.value;
                  pane.lastCoastEventTs.value = now;
                }
                if (collapse) {
                  collapse.collapse.value = Math.min(
                    headerH,
                    Math.max(0, collapse.collapse.value + delta),
                  );
                }
              }
            }
          }
        }

        if (collapse && collapse.collapse.value > y) {
          collapse.collapse.value = Math.max(0, y);
        }
      },
      SCROLL_EVENT_NAMES,
    );

    useEffect(() => {
      if (!armed) return;
      return animatedRef.observe((viewTag) => {
        if (viewTag == null) return undefined;
        pane.viewTag.value = viewTag;
        const handler = (scrollEvents as unknown as WorkletEventHandlerHolder)
          .workletEventHandler;
        handler.registerForEvents(viewTag);
        installEdgeFlingGuard(
          viewTag,
          DRAWER_EDGE_HIT_WIDTH,
          DRAWER_EDGE_GUARD_VERTICAL_SLOP,
        );
        return () => {
          uninstallEdgeFlingGuard(viewTag);
          handler.unregisterFromEvents(viewTag);
          if (pane.viewTag.value === viewTag) pane.viewTag.value = 0;
        };
      });
    }, [animatedRef, armed, scrollEvents]);

    useEffect(
      () => () => {
        if (momentumFallbackTimer.current) clearTimeout(momentumFallbackTimer.current);
        clearFrcImageQueuePauseOwner(mediaPauseOwner);
        clearScrollActivityOwner(mediaPauseOwner);
      },
      [mediaPauseOwner],
    );

    const clearDragPause = useCallback(() => {
      setFrcImageQueuePaused(mediaPauseOwner, "drag", false);
      setScrollActivity(mediaPauseOwner, "drag", false);
    }, [mediaPauseOwner]);

    useAnimatedReaction(
      () => pane.phase.value,
      (phase, prevPhase) => {
        if (prevPhase === SCROLL_PHASE_DRAG && phase !== SCROLL_PHASE_DRAG) {
          runOnJS(clearDragPause)();
        }
      },
      [clearDragPause],
    );

    const onScrollBeginDrag = useCallback(
      (event: NativeSyntheticEvent<NativeScrollEvent>) => {
        if (momentumFallbackTimer.current) {
          clearTimeout(momentumFallbackTimer.current);
          momentumFallbackTimer.current = null;
        }
        setFrcImageQueuePaused(mediaPauseOwner, "momentum", false);
        setFrcImageQueuePaused(mediaPauseOwner, "drag", true);
        setScrollActivity(mediaPauseOwner, "momentum", false);
        setScrollActivity(mediaPauseOwner, "drag", true);
        onScrollBeginDragProp?.(event);
      },
      [mediaPauseOwner, onScrollBeginDragProp],
    );

    const onScrollEndDrag = useCallback(
      (event: NativeSyntheticEvent<NativeScrollEvent>) => {
        setFrcImageQueuePaused(mediaPauseOwner, "drag", false);
        setScrollActivity(mediaPauseOwner, "drag", false);
        const velocityY = Math.abs(event.nativeEvent.velocity?.y ?? 0);
        if (velocityY > 0.01) {
          pane.lastCoastVelocityY.value = event.nativeEvent.velocity?.y ?? 0;
          pane.lastCoastEventTs.value = performance.now();
          setFrcImageQueuePaused(mediaPauseOwner, "momentum", true);
          setScrollActivity(mediaPauseOwner, "momentum", true);
          momentumFallbackTimer.current = setTimeout(() => {
            momentumFallbackTimer.current = null;
            setFrcImageQueuePaused(mediaPauseOwner, "momentum", false);
            setScrollActivity(mediaPauseOwner, "momentum", false);
          }, PAGER_SCROLL_COAST_GAP_MS * 2);
        }
        onScrollEndDragProp?.(event);
      },
      [mediaPauseOwner, onScrollEndDragProp],
    );

    const onMomentumScrollBegin = useCallback(
      (event: NativeSyntheticEvent<NativeScrollEvent>) => {
        if (momentumFallbackTimer.current) {
          clearTimeout(momentumFallbackTimer.current);
          momentumFallbackTimer.current = null;
        }
        const velocityY = event.nativeEvent.velocity?.y ?? 0;
        if (Math.abs(velocityY) > 0.01) {
          pane.lastCoastVelocityY.value = velocityY;
          pane.lastCoastEventTs.value = performance.now();
        }
        setFrcImageQueuePaused(mediaPauseOwner, "momentum", true);
        setScrollActivity(mediaPauseOwner, "momentum", true);
        onMomentumScrollBeginProp?.(event);
      },
      [mediaPauseOwner, onMomentumScrollBeginProp],
    );

    const onMomentumScrollEnd = useCallback(
      (event: NativeSyntheticEvent<NativeScrollEvent>) => {
        if (momentumFallbackTimer.current) {
          clearTimeout(momentumFallbackTimer.current);
          momentumFallbackTimer.current = null;
        }
        setFrcImageQueuePaused(mediaPauseOwner, "momentum", false);
        setScrollActivity(mediaPauseOwner, "momentum", false);
        onMomentumScrollEndProp?.(event);
      },
      [mediaPauseOwner, onMomentumScrollEndProp],
    );

    return (
      <GestureHandlerScrollView
        {...props}
        ref={composedRef}
        waitFor={edgePanRef}
        scrollEventThrottle={16}
        overScrollMode={overScrollMode}
        bounces={false}
        nestedScrollEnabled={false}
        showsVerticalScrollIndicator={false}
        onScrollBeginDrag={onScrollBeginDrag}
        onScrollEndDrag={onScrollEndDrag}
        onMomentumScrollBegin={onMomentumScrollBegin}
        onMomentumScrollEnd={onMomentumScrollEnd}
      />
    );
  });

  FlashListScroll.displayName = collapse
    ? "FlashListCollapsibleScroll"
    : "FlashListPagerScroll";
  return FlashListScroll as ComponentType<ScrollViewProps>;
}

/** Overlay поиска: не steal pane viewTag у пейджера. */
export const PagerOverlayScroll = forwardRef<
  ComponentRef<typeof GestureHandlerScrollView>,
  ScrollViewProps
>(function PagerOverlayScroll(props, ref) {
  return (
    <GestureHandlerScrollView
      {...props}
      ref={ref}
      nestedScrollEnabled={false}
      keyboardShouldPersistTaps="handled"
      overScrollMode="never"
    />
  );
});
