import { useCallback, useMemo, useRef, useState } from "react";
import type { LayoutChangeEvent } from "react-native";
import { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { useDrawerMomentumController, useDrawerScreenActiveSv } from "@/lib/drawerMomentum";
import { createPagerFlashListScroll } from "@/lib/pagerFlashListScroll";

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
 * Скролл-компонент — createPagerFlashListScroll с collapse; только главная лента.
 */

type UseCollapsibleHeaderOptions = {
  estimatedHeight?: number;
};

export function useCollapsibleHeader(options: UseCollapsibleHeaderOptions = {}) {
  const estimated = options.estimatedHeight ?? 0;
  const momentumController = useDrawerMomentumController();
  const screenActiveSv = useDrawerScreenActiveSv();
  const activePaneSv = momentumController.activePane;
  const edgePanRef = momentumController.edgePanRef;
  const edgeChromeBottomY = momentumController.edgeChromeBottomY;
  const [headerHeightPx, setHeaderHeightPx] = useState(estimated);
  const measuredOnceRef = useRef(false);

  const headerH = useSharedValue(Math.max(1, estimated));

  const collapse0 = useSharedValue(0);
  const lastY0 = useSharedValue(0);
  const collapse1 = useSharedValue(0);
  const lastY1 = useSharedValue(0);
  const pane0Momentum = momentumController.panes[0];
  const pane1Momentum = momentumController.panes[1];

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
    () =>
      createPagerFlashListScroll({
        pane: pane0Momentum,
        edgePanRef,
        activePaneSv,
        paneIndex: 0,
        screenActiveSv,
        collapse: { collapse: collapse0, headerH, lastY: lastY0 },
      }),
    [activePaneSv, collapse0, edgePanRef, headerH, lastY0, pane0Momentum, screenActiveSv],
  );
  const renderScrollComponent1 = useMemo(
    () =>
      createPagerFlashListScroll({
        pane: pane1Momentum,
        edgePanRef,
        activePaneSv,
        paneIndex: 1,
        screenActiveSv,
        collapse: { collapse: collapse1, headerH, lastY: lastY1 },
      }),
    [activePaneSv, collapse1, edgePanRef, headerH, lastY1, pane1Momentum, screenActiveSv],
  );

  const setActivePane = useCallback(
    (index: number) => {
      activePaneSv.value = index;
    },
    [activePaneSv],
  );

  /** Open chrome after programmatic scroll-to-top (onScroll may not clamp in time). */
  const expandChrome = useCallback(
    (paneIndex: number) => {
      if (paneIndex === 0) {
        collapse0.value = 0;
        lastY0.value = 0;
      } else {
        collapse1.value = 0;
        lastY1.value = 0;
      }
    },
    [collapse0, collapse1, lastY0, lastY1],
  );

  return {
    headerHeightPx,
    onHeaderLayout,
    headerAnimatedStyle,
    renderScrollComponents: [renderScrollComponent0, renderScrollComponent1] as const,
    setActivePane,
    expandChrome,
  };
}
