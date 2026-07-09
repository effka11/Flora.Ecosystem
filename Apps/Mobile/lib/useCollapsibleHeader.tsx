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
import {
  Animated,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewProps,
} from "react-native";

type UseCollapsibleHeaderOptions = {
  estimatedHeight?: number;
};

type ScrollHandler = (event: NativeSyntheticEvent<NativeScrollEvent>) => void;

/** Mutable state на стабильном pane-объекте (не вложенные ref — меньше сюрпризов от Fast Refresh). */
type PaneScroll = {
  scrollY: Animated.Value;
  jumpOffset: Animated.Value;
  jumpOffsetJs: number;
  frozenCollapse: Animated.Value;
  liveWeight: Animated.Value;
  collapseJs: number;
  lastY: number;
  pressing: boolean;
  isFrozen: boolean;
  pendingFreezeTimer: ReturnType<typeof setTimeout> | null;
  headerH: number;
};

const ONE = new Animated.Value(1);
/** После endDrag с velocity ждём momentumBegin; иначе freeze. */
const MOMENTUM_PENDING_MS = 50;

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function ensurePane(pane: PaneScroll, headerH = 1): PaneScroll {
  if (!(pane.scrollY instanceof Animated.Value)) pane.scrollY = new Animated.Value(0);
  if (!(pane.jumpOffset instanceof Animated.Value)) pane.jumpOffset = new Animated.Value(0);
  if (typeof pane.jumpOffsetJs !== "number") pane.jumpOffsetJs = 0;
  if (!(pane.frozenCollapse instanceof Animated.Value)) {
    pane.frozenCollapse = new Animated.Value(0);
  }
  if (!(pane.liveWeight instanceof Animated.Value)) pane.liveWeight = new Animated.Value(1);
  if (typeof pane.collapseJs !== "number") pane.collapseJs = 0;
  if (typeof pane.lastY !== "number") pane.lastY = 0;
  if (typeof pane.pressing !== "boolean") pane.pressing = false;
  if (typeof pane.isFrozen !== "boolean") pane.isFrozen = false;
  if (pane.pendingFreezeTimer === undefined) pane.pendingFreezeTimer = null;
  if (typeof pane.headerH !== "number" || pane.headerH < 1) {
    pane.headerH = Math.max(1, headerH);
  }
  return pane;
}

function addJump(pane: PaneScroll, delta: number) {
  if (Math.abs(delta) < 0.5) return;
  pane.jumpOffsetJs += delta;
  pane.jumpOffset.setValue(pane.jumpOffsetJs);
}

function clearPendingFreeze(pane: PaneScroll) {
  if (pane.pendingFreezeTimer != null) {
    clearTimeout(pane.pendingFreezeTimer);
    pane.pendingFreezeTimer = null;
  }
}

function topSync(pane: PaneScroll) {
  const was = pane.collapseJs;
  pane.collapseJs = 0;
  if (pane.isFrozen) pane.frozenCollapse.setValue(0);
  if (was > 0) addJump(pane, was);
}

function freeze(pane: PaneScroll) {
  clearPendingFreeze(pane);
  pane.frozenCollapse.setValue(pane.collapseJs);
  pane.liveWeight.setValue(0);
  pane.isFrozen = true;
  pane.pressing = false;
}

function prepareUnfreeze(pane: PaneScroll, y: number) {
  if (pane.isFrozen) {
    const pending = y - pane.lastY;
    if (Math.abs(pending) > 0.5) addJump(pane, pending);
  }
  pane.lastY = y;
  if (y < 1) topSync(pane);
  clearPendingFreeze(pane);
  pane.pressing = true;
  pane.isFrozen = false;
  pane.liveWeight.setValue(1);
}

function scheduleFreezeIfNoMomentum(pane: PaneScroll) {
  clearPendingFreeze(pane);
  pane.pendingFreezeTimer = setTimeout(() => {
    pane.pendingFreezeTimer = null;
    if (!pane.pressing) return;
    // Всё ещё «ждём momentum», но его не было — freeze.
    freeze(pane);
  }, MOMENTUM_PENDING_MS);
}

/**
 * 1:1 во время жеста. Idle: freeze визуала + absorb diff в jumpOffset.
 */
function createFlashListScrollComponent(pane: PaneScroll): ComponentType<ScrollViewProps> {
  ensurePane(pane);

  const FlashListScroll = forwardRef(function FlashListScroll(
    props: ScrollViewProps,
    ref: Ref<unknown>,
  ) {
    const { onScroll: flashListOnScroll, ...rest } = props;

    const onScroll = useMemo(() => {
      const listener: ScrollHandler = (event) => {
        flashListOnScroll?.(event);

        const y = Math.max(0, event.nativeEvent.contentOffset.y);
        const diff = y - pane.lastY;
        pane.lastY = y;
        const H = Math.max(1, pane.headerH);

        if (!pane.isFrozen) {
          pane.collapseJs = clamp(pane.collapseJs + diff, 0, H);
        } else {
          addJump(pane, diff);
        }

        if (y <= 0) topSync(pane);
      };

      return Animated.event([{ nativeEvent: { contentOffset: { y: pane.scrollY } } }], {
        useNativeDriver: true,
        listener,
      });
    }, [flashListOnScroll]);

    return (
      <Animated.ScrollView
        {...rest}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ref={ref as any}
        onScroll={onScroll}
        scrollEventThrottle={16}
        overScrollMode="never"
        bounces={false}
        onScrollBeginDrag={(event) => {
          const y = Math.max(0, event.nativeEvent.contentOffset.y);
          prepareUnfreeze(pane, y);
          rest.onScrollBeginDrag?.(event);
        }}
        onScrollEndDrag={(event) => {
          const y = Math.max(0, event.nativeEvent.contentOffset.y);
          pane.lastY = y;
          const vy = event.nativeEvent.velocity?.y ?? 0;
          if (Math.abs(vy) < 0.05) {
            freeze(pane);
          } else {
            // Ждём momentumBegin; если его нет — freeze через pending.
            pane.pressing = true;
            scheduleFreezeIfNoMomentum(pane);
          }
          rest.onScrollEndDrag?.(event);
        }}
        onMomentumScrollBegin={(event) => {
          const y = Math.max(0, event.nativeEvent.contentOffset.y);
          prepareUnfreeze(pane, y);
          rest.onMomentumScrollBegin?.(event);
        }}
        onMomentumScrollEnd={(event) => {
          pane.lastY = Math.max(0, event.nativeEvent.contentOffset.y);
          freeze(pane);
          rest.onMomentumScrollEnd?.(event);
        }}
      />
    );
  });

  FlashListScroll.displayName = "FlashListCollapsibleScroll";
  return FlashListScroll;
}

function createPane(headerH: number): PaneScroll {
  return {
    scrollY: new Animated.Value(0),
    jumpOffset: new Animated.Value(0),
    jumpOffsetJs: 0,
    frozenCollapse: new Animated.Value(0),
    liveWeight: new Animated.Value(1),
    collapseJs: 0,
    lastY: 0,
    pressing: false,
    isFrozen: false,
    pendingFreezeTimer: null,
    headerH: Math.max(1, headerH),
  };
}

function buildDisplayCollapse(pane: PaneScroll, headerH: number) {
  const h = Math.max(1, headerH);
  const live = Animated.diffClamp(
    Animated.subtract(pane.scrollY, pane.jumpOffset),
    0,
    h,
  );
  const frozenWeight = Animated.subtract(ONE, pane.liveWeight);
  return Animated.add(
    Animated.multiply(live, pane.liveWeight),
    Animated.multiply(pane.frozenCollapse, frozenWeight),
  );
}

/**
 * 1:1 collapsing chrome — Animated.diffClamp (native).
 * Idle: sync freeze (liveWeight) + absorb layout jumps в jumpOffset.
 */
export function useCollapsibleHeader(options: UseCollapsibleHeaderOptions = {}) {
  const estimated = options.estimatedHeight ?? 0;
  const [headerHeightPx, setHeaderHeightPx] = useState(estimated);
  const measuredOnceRef = useRef(false);
  const activePaneRef = useRef(0);
  const [activePane, setActivePaneState] = useState(0);

  const pane0 = useRef(createPane(estimated)).current;
  const pane1 = useRef(createPane(estimated)).current;
  ensurePane(pane0, estimated);
  ensurePane(pane1, estimated);
  pane0.headerH = Math.max(1, headerHeightPx);
  pane1.headerH = Math.max(1, headerHeightPx);

  useEffect(() => {
    return () => {
      clearPendingFreeze(pane0);
      clearPendingFreeze(pane1);
    };
  }, [pane0, pane1]);

  const onHeaderLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const next = Math.ceil(event.nativeEvent.layout.height);
      if (next <= 0) return;
      if (!measuredOnceRef.current) {
        measuredOnceRef.current = true;
        pane0.headerH = Math.max(1, next);
        pane1.headerH = Math.max(1, next);
        if (Math.abs(next - estimated) >= 1) {
          setHeaderHeightPx(next);
        }
      }
    },
    [estimated, pane0, pane1],
  );

  const display0 = useMemo(
    () => buildDisplayCollapse(pane0, headerHeightPx),
    [headerHeightPx, pane0],
  );
  const display1 = useMemo(
    () => buildDisplayCollapse(pane1, headerHeightPx),
    [headerHeightPx, pane1],
  );

  const headerAnimatedStyle = useMemo(() => {
    const display = activePane === 0 ? display0 : display1;
    const h = Math.max(1, headerHeightPx);
    return {
      transform: [
        {
          translateY: display.interpolate({
            inputRange: [0, h],
            outputRange: [0, -h],
            extrapolate: "clamp",
          }),
        },
      ],
    };
  }, [activePane, display0, display1, headerHeightPx]);

  const renderScrollComponent0 = useMemo(
    () => createFlashListScrollComponent(pane0),
    [pane0],
  );
  const renderScrollComponent1 = useMemo(
    () => createFlashListScrollComponent(pane1),
    [pane1],
  );

  const setActivePane = useCallback((index: number) => {
    if (activePaneRef.current === index) return;
    activePaneRef.current = index;
    setActivePaneState(index);
  }, []);

  return {
    headerHeightPx,
    onHeaderLayout,
    headerAnimatedStyle,
    renderScrollComponents: [renderScrollComponent0, renderScrollComponent1] as const,
    setActivePane,
  };
}
