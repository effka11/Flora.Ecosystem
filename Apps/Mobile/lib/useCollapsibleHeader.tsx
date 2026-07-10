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
  ScrollViewProps,
} from "react-native";
import Reanimated, {
  useAnimatedRef,
  useAnimatedStyle,
  useEvent,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";

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

const PHASE_IDLE = 0;
const PHASE_DRAG = 1;
/** После отпускания пальца: инерция, докрут — дельты по направлению жеста. */
const PHASE_COAST = 2;

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
  headerH: SharedValue<number>;
};

/** Внутренний интерфейс useEvent — регистрация worklet-обработчика на теге view. */
type WorkletEventHandlerHolder = {
  workletEventHandler: {
    registerForEvents: (viewTag: number) => void;
    unregisterFromEvents: (viewTag: number) => void;
  };
};

function createFlashListScrollComponent(pane: PaneScroll): ComponentType<ScrollViewProps> {
  const FlashListScroll = forwardRef(function FlashListScroll(
    props: ScrollViewProps,
    ref: Ref<Reanimated.ScrollView>,
  ) {
    const animatedRef = useAnimatedRef<Reanimated.ScrollView>();

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
          pane.phase.value = PHASE_DRAG;
          pane.dir.value = 0;
          pane.lastY.value = y;
          pane.lastTs.value = now;
        } else if (name.endsWith("onScrollEndDrag")) {
          // Инерция может продолжиться без onMomentumScrollBegin в worklet-е —
          // остаёмся в coast, фильтруем по направлению и непрерывности потока.
          pane.phase.value = PHASE_COAST;
          pane.lastY.value = y;
          pane.lastTs.value = now;
        } else if (name.endsWith("onMomentumScrollBegin")) {
          pane.phase.value = PHASE_COAST;
          pane.lastY.value = y;
          pane.lastTs.value = now;
        } else if (name.endsWith("onMomentumScrollEnd")) {
          pane.phase.value = PHASE_IDLE;
          pane.lastY.value = y;
        } else {
          const delta = y - pane.lastY.value;
          const gap = now - pane.lastTs.value;
          pane.lastY.value = y;
          pane.lastTs.value = now;
          const phase = pane.phase.value;

          if (phase === PHASE_DRAG) {
            pane.collapse.value = Math.min(
              headerH,
              Math.max(0, pane.collapse.value + delta),
            );
            if (Math.abs(delta) > 0.5) pane.dir.value = delta > 0 ? 1 : -1;
          } else if (phase === PHASE_COAST) {
            if (gap > COAST_GAP_MS) {
              // Поток прервался — инерция закончилась, это offset-коррекция.
              pane.phase.value = PHASE_IDLE;
            } else {
              let dir = pane.dir.value;
              if (dir === 0 && Math.abs(delta) > 1) {
                dir = delta > 0 ? 1 : -1;
                pane.dir.value = dir;
              }
              // Дельта против направления инерции — коррекция FlashList.
              if (dir !== 0 && delta * dir > 0) {
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
        const handler = (scrollEvents as unknown as WorkletEventHandlerHolder)
          .workletEventHandler;
        handler.registerForEvents(viewTag);
        return () => handler.unregisterFromEvents(viewTag);
      });
    }, [animatedRef, scrollEvents]);

    return (
      <Reanimated.ScrollView
        {...props}
        ref={composedRef}
        scrollEventThrottle={16}
        overScrollMode="never"
        bounces={false}
      />
    );
  });

  FlashListScroll.displayName = "FlashListCollapsibleScroll";
  return FlashListScroll as ComponentType<ScrollViewProps>;
}

export function useCollapsibleHeader(options: UseCollapsibleHeaderOptions = {}) {
  const estimated = options.estimatedHeight ?? 0;
  const [headerHeightPx, setHeaderHeightPx] = useState(estimated);
  const measuredOnceRef = useRef(false);

  const headerH = useSharedValue(Math.max(1, estimated));
  const activePaneSv = useSharedValue(0);

  const collapse0 = useSharedValue(0);
  const lastY0 = useSharedValue(0);
  const phase0 = useSharedValue(PHASE_IDLE);
  const dir0 = useSharedValue(0);
  const lastTs0 = useSharedValue(0);

  const collapse1 = useSharedValue(0);
  const lastY1 = useSharedValue(0);
  const phase1 = useSharedValue(PHASE_IDLE);
  const dir1 = useSharedValue(0);
  const lastTs1 = useSharedValue(0);

  const pane0 = useMemo<PaneScroll>(
    () => ({
      collapse: collapse0,
      lastY: lastY0,
      phase: phase0,
      dir: dir0,
      lastTs: lastTs0,
      headerH,
    }),
    [collapse0, dir0, headerH, lastTs0, lastY0, phase0],
  );
  const pane1 = useMemo<PaneScroll>(
    () => ({
      collapse: collapse1,
      lastY: lastY1,
      phase: phase1,
      dir: dir1,
      lastTs: lastTs1,
      headerH,
    }),
    [collapse1, dir1, headerH, lastTs1, lastY1, phase1],
  );

  const onHeaderLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const next = Math.ceil(event.nativeEvent.layout.height);
      if (next <= 0 || measuredOnceRef.current) return;
      measuredOnceRef.current = true;
      headerH.value = Math.max(1, next);
      if (Math.abs(next - estimated) >= 1) {
        setHeaderHeightPx(next);
      }
    },
    [estimated, headerH],
  );

  const headerAnimatedStyle = useAnimatedStyle(() => {
    const collapse = activePaneSv.value === 0 ? collapse0.value : collapse1.value;
    return {
      transform: [{ translateY: -collapse }],
    };
  });

  const renderScrollComponent0 = useMemo(
    () => createFlashListScrollComponent(pane0),
    [pane0],
  );
  const renderScrollComponent1 = useMemo(
    () => createFlashListScrollComponent(pane1),
    [pane1],
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
