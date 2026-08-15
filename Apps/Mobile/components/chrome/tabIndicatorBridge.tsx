import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { Animated, StyleSheet } from "react-native";
import Reanimated, {
  cancelAnimation,
  Extrapolation,
  interpolate,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import {
  floraTabChrome,
  floraTabIndicatorHidden,
  floraTabIndicatorTransform,
} from "@/components/chrome/FloraTabLabel";
import { ENERGETIC_OPEN_EASING, ENERGETIC_OPEN_MS, settleEnergetic } from "@/lib/energeticSettle";

export type TabIndicatorLayout = { x: number; width: number };

export type TabIndicatorPose = {
  left: SharedValue<number>;
  width: SharedValue<number>;
  /** 1 — есть валидный layout слота. */
  ready: SharedValue<number>;
};

export type TabIndicatorBridge = {
  idle: TabIndicatorPose;
  search: TabIndicatorPose;
};

const TabIndicatorBridgeContext = createContext<TabIndicatorBridge | null>(null);

function usePose(): TabIndicatorPose {
  const left = useSharedValue(0);
  const width = useSharedValue(0);
  const ready = useSharedValue(0);
  return useMemo(() => ({ left, width, ready }), [left, ready, width]);
}

export function TabIndicatorBridgeProvider({ children }: { children: ReactNode }) {
  const idle = usePose();
  const search = usePose();
  const value = useMemo(() => ({ idle, search }), [idle, search]);
  return (
    <TabIndicatorBridgeContext.Provider value={value}>{children}</TabIndicatorBridgeContext.Provider>
  );
}

export function useTabIndicatorBridge(): TabIndicatorBridge | null {
  return useContext(TabIndicatorBridgeContext);
}

export function useTabIndicatorPose(slot: keyof TabIndicatorBridge): TabIndicatorPose | null {
  const bridge = useTabIndicatorBridge();
  return bridge ? bridge[slot] : null;
}

/** Пейджер: left/width с scrollX, как у ленты/музыки. */
export function SyncPagerTabIndicator({
  scrollX,
  pageWidth,
  start,
  end,
  insetX = 0,
  stripOffset,
}: {
  scrollX: SharedValue<number>;
  pageWidth: number;
  start: TabIndicatorLayout | null;
  end: TabIndicatorLayout | null;
  /** Pad трека ChipStrip, если overlay в координатах вьюпорта. */
  insetX?: number;
  stripOffset?: SharedValue<number>;
}) {
  const pose = useTabIndicatorPose("idle");
  useAnimatedReaction(
    () => {
      if (!start || !end || pageWidth <= 0) {
        return { ready: 0, left: 0, width: 0 };
      }
      return {
        ready: 1,
        width: interpolate(
          scrollX.value,
          [0, pageWidth],
          [start.width, end.width],
          Extrapolation.CLAMP,
        ),
        left:
          insetX +
          interpolate(scrollX.value, [0, pageWidth], [start.x, end.x], Extrapolation.CLAMP) -
          (stripOffset?.value ?? 0),
      };
    },
    (next) => {
      if (!pose) return;
      pose.ready.value = next.ready;
      if (next.ready) {
        pose.left.value = next.left;
        pose.width.value = next.width;
      }
    },
  );
  return null;
}

/** Индекс таба (0…n-1), как теги поиска. scrollX — сдвиг горизонтального ряда. */
export function SyncIndexTabIndicator({
  progress,
  layouts,
  scrollX,
  insetX = 0,
}: {
  progress: SharedValue<number>;
  layouts: readonly (TabIndicatorLayout | null)[];
  scrollX?: SharedValue<number>;
  /** Pad трека ChipStrip, если overlay в координатах вьюпорта. */
  insetX?: number;
}) {
  const pose = useTabIndicatorPose("idle");
  const ready = layouts.length > 0 && layouts.every(Boolean);
  const inputRange = layouts.map((_, index) => index);
  const indicatorX = layouts.map((layout) => layout?.x ?? 0);
  const indicatorW = layouts.map((layout) => layout?.width ?? 0);
  if (inputRange.length === 1) {
    inputRange.push(1);
    indicatorX.push(indicatorX[0]);
    indicatorW.push(indicatorW[0]);
  }

  useAnimatedReaction(
    () => {
      if (!ready) return { ready: 0, left: 0, width: 0 };
      const offset = scrollX?.value ?? 0;
      return {
        ready: 1,
        width: interpolate(progress.value, inputRange, indicatorW, Extrapolation.CLAMP),
        left:
          insetX +
          interpolate(progress.value, inputRange, indicatorX, Extrapolation.CLAMP) -
          offset,
      };
    },
    (next) => {
      if (!pose) return;
      pose.ready.value = next.ready;
      if (next.ready) {
        pose.left.value = next.left;
        pose.width.value = next.width;
      }
    },
  );
  return null;
}

function animatedCurrent(value: Animated.Value): number {
  const reader = value as Animated.Value & { __getValue?: () => number };
  return Number(reader.__getValue?.() ?? 0);
}

/** RN spring left/width (people/communities) → тот же overlay. */
export function SyncSpringTabIndicator({
  left,
  width,
  ready,
}: {
  left: Animated.Value;
  width: Animated.Value;
  ready: boolean;
}) {
  const pose = useTabIndicatorPose("idle");
  useEffect(() => {
    if (!pose) return;
    if (!ready) {
      pose.ready.value = 0;
      return;
    }
    pose.ready.value = 1;
    pose.left.value = animatedCurrent(left);
    pose.width.value = animatedCurrent(width);
    const idLeft = left.addListener(({ value }) => {
      pose.left.value = value;
    });
    const idWidth = width.addListener(({ value }) => {
      pose.width.value = value;
    });
    return () => {
      left.removeListener(idLeft);
      width.removeListener(idWidth);
    };
  }, [left, pose, ready, width]);
  return null;
}

const LINE_FOLLOW_IDLE = 0;
const LINE_SETTLE_SEARCH = 1;
const LINE_FOLLOW_SEARCH = 2;
const LINE_SETTLE_IDLE = 3;

/**
 * Одна линия на ряд swap: opacity 1.
 * Open/close — settleEnergetic как тап по вкладке, не progress шапки (~210мс).
 * Подписи по-прежнему кроссфейдятся слоями шапки.
 */
export function BlendedSearchTabIndicator({ progress }: { progress: SharedValue<number> }) {
  const bridge = useTabIndicatorBridge();
  const displayLeft = useSharedValue(0);
  const displayWidth = useSharedValue(0);
  const mode = useSharedValue(LINE_FOLLOW_IDLE);
  const settleGen = useSharedValue(0);
  /** 1 — цель линия на тегах поиска; по фронту progress, не по порогу 0.02 (close иначе ждёт конец fade шапки). */
  const wantSearch = useSharedValue(0);

  useAnimatedReaction(
    () => {
      if (!bridge) return { p: 0, idleReady: 0, searchReady: 0, idleL: 0, idleW: 0, searchL: 0, searchW: 0 };
      return {
        p: progress.value,
        idleReady: bridge.idle.ready.value,
        searchReady: bridge.search.ready.value,
        idleL: bridge.idle.left.value,
        idleW: bridge.idle.width.value,
        searchL: bridge.search.left.value,
        searchW: bridge.search.width.value,
      };
    },
    (cur, prev) => {
      if (!bridge) return;

      // Nested worklet: same-file helpers are not captured on the UI runtime.
      const startLineSettle = (targetLeft: number, targetWidth: number, nextMode: number) => {
        mode.value = nextMode;
        settleGen.value += 1;
        const token = settleGen.value;
        cancelAnimation(displayLeft);
        cancelAnimation(displayWidth);
        let remaining = 2;
        const done = (finished?: boolean) => {
          if (!finished || settleGen.value !== token) return;
          remaining -= 1;
          if (remaining !== 0) return;
          mode.value = wantSearch.value > 0.5 ? LINE_FOLLOW_SEARCH : LINE_FOLLOW_IDLE;
        };
        settleEnergetic(
          displayLeft,
          targetLeft,
          1,
          1,
          0,
          ENERGETIC_OPEN_MS,
          ENERGETIC_OPEN_EASING,
          done,
        );
        settleEnergetic(
          displayWidth,
          targetWidth,
          1,
          1,
          0,
          ENERGETIC_OPEN_MS,
          ENERGETIC_OPEN_EASING,
          done,
        );
      };

      if (!prev) {
        if (cur.p >= 0.5) {
          wantSearch.value = 1;
          if (cur.searchW > 0.5) {
            mode.value = LINE_FOLLOW_SEARCH;
            displayLeft.value = cur.searchL;
            displayWidth.value = cur.searchW;
          }
        }
        return;
      }

      const rising = cur.p > prev.p + 0.0001;
      const falling = cur.p < prev.p - 0.0001;

      if (rising && wantSearch.value < 0.5) {
        wantSearch.value = 1;
        if (cur.searchW > 0.5) {
          startLineSettle(cur.searchL, cur.searchW, LINE_SETTLE_SEARCH);
        } else if (cur.searchReady > 0.5) {
          settleGen.value += 1;
          mode.value = LINE_FOLLOW_SEARCH;
          displayLeft.value = cur.searchL;
          displayWidth.value = cur.searchW;
        }
        return;
      }

      if (falling && wantSearch.value > 0.5) {
        wantSearch.value = 0;
        if (cur.idleReady > 0.5) {
          startLineSettle(cur.idleL, cur.idleW, LINE_SETTLE_IDLE);
        } else {
          settleGen.value += 1;
          mode.value = LINE_FOLLOW_IDLE;
        }
        return;
      }

      if (wantSearch.value > 0.5 && mode.value === LINE_SETTLE_SEARCH && cur.searchReady > 0.5 && (prev.searchReady ?? 0) < 0.5) {
        startLineSettle(cur.searchL, cur.searchW, LINE_SETTLE_SEARCH);
        return;
      }

      if (wantSearch.value > 0.5 && mode.value === LINE_FOLLOW_IDLE && cur.searchW > 0.5) {
        startLineSettle(cur.searchL, cur.searchW, LINE_SETTLE_SEARCH);
        return;
      }

      if (mode.value === LINE_FOLLOW_IDLE && cur.idleReady > 0.5) {
        displayLeft.value = cur.idleL;
        displayWidth.value = cur.idleW;
        return;
      }
      if (mode.value === LINE_FOLLOW_SEARCH && cur.searchReady > 0.5) {
        displayLeft.value = cur.searchL;
        displayWidth.value = cur.searchW;
      }
    },
  );

  const style = useAnimatedStyle(() => {
    if (!bridge) return floraTabIndicatorHidden();
    const idleReady = bridge.idle.ready.value > 0.5;
    const searchReady = bridge.search.ready.value > 0.5;
    if (!idleReady && !searchReady) return floraTabIndicatorHidden();
    return floraTabIndicatorTransform(displayLeft.value, displayWidth.value);
  });
  return <Reanimated.View pointerEvents="none" style={[floraTabChrome.tabIndicator, styles.overlay, style]} />;
}

const styles = StyleSheet.create({
  overlay: {
    zIndex: 3,
  },
});
