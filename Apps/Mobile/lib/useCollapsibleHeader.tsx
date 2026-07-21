import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type Ref,
} from "react";
import type {
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollViewProps,
} from "react-native";
import Reanimated, {
  runOnJS,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedStyle,
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
  useDrawerMomentumController,
  type DrawerMomentumController,
} from "@/lib/drawerMomentum";

/**
 * Collapsing chrome на Reanimated: аккумулятор коллапса — наша shared value
 * на UI-потоке (полный контроль, без чёрного ящика diffClamp).
 *
 * Ключевое: FlashList v2 программно двигает contentOffset (offset-коррекции
 * maintainVisibleContentPosition / ScrollAnchor). Такие скачки неотличимы от
 * скролла по значению y, поэтому:
 *  - дельты применяются в drag (1:1) и в coast — фазе после отпускания
 *    пальца; на momentumBegin не полагаемся (не на всех устройствах/версиях
 *    доходит до worklet-а), вместо этого настоящий momentum распознаём по
 *    непрерывности потока onScroll (малый gap между событиями) и по
 *    направлению жеста (bounces=false => инерция монотонна);
 *  - спорадические скачки offset-коррекций FlashList отфильтровываются: они
 *    одиночные (большой gap по времени) и/или против направления инерции;
 *  - инвариант collapse <= y: у верха ленты хедер всегда открыт (собирает
 *    накопившийся дрейф от игнорированных коррекций).
 *
 * Worklet-обработчик регистрируется на теге скролла через animatedRef.observe
 * (как useScrollOffset), поэтому JS onScroll самого FlashList работает
 * параллельно и recycling не страдает.
 */

type UseCollapsibleHeaderOptions = {
  estimatedHeight?: number;
};

const SCROLL_EVENT_NAMES = [
  "onScroll",
  "onScrollBeginDrag",
  "onScrollEndDrag",
  "onMomentumScrollBegin",
  "onMomentumScrollEnd",
];

/**
 * Максимальный разрыв между onScroll в coast, чтобы считать поток инерцией.
 * Momentum шлёт события каждый кадр (~16 мс при throttle 16); одиночная
 * offset-коррекция FlashList в покое приходит с большим разрывом.
 */
const COAST_GAP_MS = 120;

type PaneScroll = {
  collapse: SharedValue<number>;
  lastY: SharedValue<number>;
  phase: SharedValue<number>;
  /** Направление жеста: +1 вниз (хедер прячется), -1 вверх, 0 неизвестно. */
  dir: SharedValue<number>;
  /** Timestamp последнего onScroll (мс, performance.now на UI-потоке). */
  lastTs: SharedValue<number>;
  velocityY: SharedValue<number>;
  lastCoastVelocityY: SharedValue<number>;
  lastCoastEventTs: SharedValue<number>;
  viewTag: SharedValue<number>;
  headerH: SharedValue<number>;
};

/** Внутренний интерфейс useEvent — регистрация worklet-обработчика на теге view. */
type WorkletEventHandlerHolder = {
  workletEventHandler: {
    registerForEvents: (viewTag: number) => void;
    unregisterFromEvents: (viewTag: number) => void;
  };
};

function createFlashListScrollComponent(
  pane: PaneScroll,
  edgePanRef: DrawerMomentumController["edgePanRef"],
): ComponentType<ScrollViewProps> {
  const FlashListScroll = forwardRef(function FlashListScroll(
    props: ScrollViewProps,
    ref: Ref<Reanimated.ScrollView>,
  ) {
    const animatedRef = useAnimatedRef<Reanimated.ScrollView>();
    const mediaPauseOwner = useRef(Symbol("feed-scroll")).current;
    const momentumFallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const {
      onMomentumScrollBegin: onMomentumScrollBeginProp,
      onMomentumScrollEnd: onMomentumScrollEndProp,
      onScrollBeginDrag: onScrollBeginDragProp,
      onScrollEndDrag: onScrollEndDragProp,
    } = props;

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
        const headerH = Math.max(1, pane.headerH.value);

        const now = performance.now();

        if (name.endsWith("onScrollBeginDrag")) {
          pane.phase.value = SCROLL_PHASE_DRAG;
          pane.velocityY.value = 0;
          pane.dir.value = 0;
          pane.lastY.value = y;
          pane.lastTs.value = now;
        } else if (name.endsWith("onScrollEndDrag")) {
          // Инерция может продолжиться без onMomentumScrollBegin в worklet-е —
          // остаёмся в coast, фильтруем по направлению и непрерывности потока.
          pane.phase.value = SCROLL_PHASE_COAST;
          const reportedVelocity = event.velocity?.y ?? 0;
          if (Math.abs(reportedVelocity) > 0.1) {
            pane.velocityY.value = reportedVelocity;
          }
          if (Math.abs(pane.velocityY.value) > 0.1) {
            pane.lastCoastVelocityY.value = pane.velocityY.value;
            pane.lastCoastEventTs.value = now;
          }
          pane.lastY.value = y;
          pane.lastTs.value = now;
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
          pane.lastY.value = y;
          pane.lastTs.value = now;
        } else if (name.endsWith("onMomentumScrollEnd")) {
          pane.phase.value = SCROLL_PHASE_IDLE;
          pane.velocityY.value = 0;
          pane.lastY.value = y;
        } else {
          const delta = y - pane.lastY.value;
          const gap = now - pane.lastTs.value;
          pane.lastY.value = y;
          pane.lastTs.value = now;
          const phase = pane.phase.value;

          if (phase === SCROLL_PHASE_DRAG) {
            if (gap > 0 && gap <= COAST_GAP_MS && Math.abs(delta) > 0.1) {
              const instantaneousVelocity = (delta / gap) * 1000;
              pane.velocityY.value =
                pane.velocityY.value * 0.35 + instantaneousVelocity * 0.65;
            }
            pane.collapse.value = Math.min(
              headerH,
              Math.max(0, pane.collapse.value + delta),
            );
            if (Math.abs(delta) > 0.5) pane.dir.value = delta > 0 ? 1 : -1;
          } else if (phase === SCROLL_PHASE_COAST) {
            if (gap > COAST_GAP_MS) {
              // Поток прервался — инерция закончилась, это offset-коррекция.
              pane.phase.value = SCROLL_PHASE_IDLE;
              pane.velocityY.value = 0;
            } else {
              let dir = pane.dir.value;
              if (dir === 0 && Math.abs(delta) > 1) {
                dir = delta > 0 ? 1 : -1;
                pane.dir.value = dir;
              }
              // Дельта против направления инерции — коррекция FlashList.
              if (dir !== 0 && delta * dir > 0) {
                if (gap > 0 && Math.abs(delta) > 0.1) {
                  const instantaneousVelocity = (delta / gap) * 1000;
                  pane.velocityY.value =
                    pane.velocityY.value * 0.35 + instantaneousVelocity * 0.65;
                  pane.lastCoastVelocityY.value = pane.velocityY.value;
                  pane.lastCoastEventTs.value = now;
                }
                pane.collapse.value = Math.min(
                  headerH,
                  Math.max(0, pane.collapse.value + delta),
                );
              }
            }
          }
        }

        // Инвариант: у верха ленты хедер всегда открыт.
        if (pane.collapse.value > y) {
          pane.collapse.value = Math.max(0, y);
        }
      },
      SCROLL_EVENT_NAMES,
    );

    useEffect(() => {
      return animatedRef.observe((viewTag) => {
        if (viewTag == null) return undefined;
        pane.viewTag.value = viewTag;
        const handler = (scrollEvents as unknown as WorkletEventHandlerHolder)
          .workletEventHandler;
        handler.registerForEvents(viewTag);
        // Нативная защита fling в edge-зоне гамбургера (см. flora-scroll-fling).
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
    }, [animatedRef, scrollEvents]);

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

    /**
     * Edge-guard может проглотить DOWN..UP над летящей лентой: ScrollView
     * тогда не отправит onScrollEndDrag и «drag»-пауза застряла бы включённой.
     * Любой выход из фазы DRAG (в т.ч. worklet-флип DRAG → COAST из
     * FeedHamburgerMenu) снимает её; повторное снятие после обычного
     * onScrollEndDrag идемпотентно.
     */
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
          }, COAST_GAP_MS * 2);
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
        overScrollMode="never"
        bounces={false}
        onScrollBeginDrag={onScrollBeginDrag}
        onScrollEndDrag={onScrollEndDrag}
        onMomentumScrollBegin={onMomentumScrollBegin}
        onMomentumScrollEnd={onMomentumScrollEnd}
      />
    );
  });

  FlashListScroll.displayName = "FlashListCollapsibleScroll";
  return FlashListScroll as ComponentType<ScrollViewProps>;
}

export function useCollapsibleHeader(options: UseCollapsibleHeaderOptions = {}) {
  const estimated = options.estimatedHeight ?? 0;
  const momentumController = useDrawerMomentumController();
  const activePaneSv = momentumController.activePane;
  const edgePanRef = momentumController.edgePanRef;
  const edgeChromeBottomY = momentumController.edgeChromeBottomY;
  const [headerHeightPx, setHeaderHeightPx] = useState(estimated);
  const measuredOnceRef = useRef(false);

  const headerH = useSharedValue(Math.max(1, estimated));

  const collapse0 = useSharedValue(0);
  const lastY0 = useSharedValue(0);
  const dir0 = useSharedValue(0);

  const collapse1 = useSharedValue(0);
  const lastY1 = useSharedValue(0);
  const dir1 = useSharedValue(0);
  const pane0Momentum = momentumController.panes[0];
  const pane1Momentum = momentumController.panes[1];

  const pane0 = useMemo<PaneScroll>(
    () => ({
      collapse: collapse0,
      lastY: lastY0,
      phase: pane0Momentum.phase,
      dir: dir0,
      lastTs: pane0Momentum.lastEventTs,
      velocityY: pane0Momentum.velocityY,
      lastCoastVelocityY: pane0Momentum.lastCoastVelocityY,
      lastCoastEventTs: pane0Momentum.lastCoastEventTs,
      viewTag: pane0Momentum.viewTag,
      headerH,
    }),
    [collapse0, dir0, headerH, lastY0, pane0Momentum],
  );
  const pane1 = useMemo<PaneScroll>(
    () => ({
      collapse: collapse1,
      lastY: lastY1,
      phase: pane1Momentum.phase,
      dir: dir1,
      lastTs: pane1Momentum.lastEventTs,
      velocityY: pane1Momentum.velocityY,
      lastCoastVelocityY: pane1Momentum.lastCoastVelocityY,
      lastCoastEventTs: pane1Momentum.lastCoastEventTs,
      viewTag: pane1Momentum.viewTag,
      headerH,
    }),
    [collapse1, dir1, headerH, lastY1, pane1Momentum],
  );

  const onHeaderLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const next = Math.ceil(event.nativeEvent.layout.height);
      if (next <= 0) return;
      // topBlock от верха экрана → bottom chrome ≈ height (исключаем гамбургер/табы из edge claim).
      if (next > edgeChromeBottomY.value) {
        edgeChromeBottomY.value = next;
      }
      if (measuredOnceRef.current) return;
      measuredOnceRef.current = true;
      headerH.value = Math.max(1, next);
      if (Math.abs(next - estimated) >= 1) {
        setHeaderHeightPx(next);
      }
    },
    [edgeChromeBottomY, estimated, headerH],
  );

  const headerAnimatedStyle = useAnimatedStyle(() => {
    const collapse =
      activePaneSv.value === 0 ? collapse0.value : collapse1.value;
    return {
      transform: [{ translateY: -collapse }],
    };
  });

  const renderScrollComponent0 = useMemo(
    () => createFlashListScrollComponent(pane0, edgePanRef),
    [edgePanRef, pane0],
  );
  const renderScrollComponent1 = useMemo(
    () => createFlashListScrollComponent(pane1, edgePanRef),
    [edgePanRef, pane1],
  );

  const setActivePane = useCallback(
    (index: number) => {
      activePaneSv.value = index;
    },
    [activePaneSv],
  );

  return {
    headerHeightPx,
    onHeaderLayout,
    headerAnimatedStyle,
    renderScrollComponents: [renderScrollComponent0, renderScrollComponent1] as const,
    setActivePane,
  };
}
