import type { ReactNode } from "react";
import { useCallback, useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { GestureDetector, type GestureType } from "react-native-gesture-handler";
import Reanimated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import { typicalChipStripOffset } from "@/components/chrome/FloraTabChipStrip";
import { useFloraGrid } from "@/lib/FloraGridProvider";

type TabPagerTrackProps = {
  pageCount: number;
  pageWidth: number;
  pagerPan: GestureType;
  scrollX: SharedValue<number>;
  children: ReactNode;
};

/** Трек пейджера: только translateX, без removeClippedSubviews. */
export function TabPagerTrack({
  pageCount,
  pageWidth,
  pagerPan,
  scrollX,
  children,
}: TabPagerTrackProps) {
  const pagerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -scrollX.value }],
  }));

  return (
    <GestureDetector gesture={pagerPan}>
      <Reanimated.View
        style={[styles.row, { width: Math.max(pageWidth, 1) * pageCount }, pagerStyle]}
      >
        {children}
      </Reanimated.View>
    </GestureDetector>
  );
}

type ChipLayout = { x: number; width: number } | null;

/**
 * Полоса чипов follow от pager scrollX (как настройки): активный чип не уезжает за край.
 */
export function PagerChipStripFollow({
  scrollX,
  pageWidthSV,
  offset,
  maxOffset,
  viewportW,
  layouts,
}: {
  scrollX: SharedValue<number>;
  pageWidthSV: SharedValue<number>;
  offset: SharedValue<number>;
  maxOffset: SharedValue<number>;
  viewportW: SharedValue<number>;
  layouts: readonly ChipLayout[];
}) {
  const typicalOffsetsSV = useSharedValue<number[]>([]);
  const rangeSV = useSharedValue<number[]>([]);
  const ready = layouts.length > 0 && layouts.every(Boolean);
  const stripPadX = useFloraGrid().step;

  const syncTypicals = useCallback(
    (vw: number, max: number) => {
      if (!ready) return;
      typicalOffsetsSV.value = layouts.map((layout) =>
        typicalChipStripOffset(layout?.x ?? 0, layout?.width ?? 0, vw, max, stripPadX),
      );
    },
    [layouts, ready, stripPadX, typicalOffsetsSV],
  );

  useEffect(() => {
    if (!ready) return;
    rangeSV.value = layouts.map((_, index) => index);
    syncTypicals(viewportW.value, maxOffset.value);
  }, [layouts, maxOffset, rangeSV, ready, syncTypicals, viewportW]);

  useAnimatedReaction(
    () => [viewportW.value, maxOffset.value] as const,
    ([vw, max]) => {
      runOnJS(syncTypicals)(vw, max);
    },
  );

  useAnimatedReaction(
    () => {
      const width = pageWidthSV.value;
      const typicals = typicalOffsetsSV.value;
      const range = rangeSV.value;
      if (width <= 0 || typicals.length === 0) return offset.value;
      if (range.length < 2) return typicals[0] ?? 0;
      return interpolate(scrollX.value / width, range, typicals, Extrapolation.CLAMP);
    },
    (next) => {
      offset.value = next;
    },
  );

  return null;
}

export function TabPagerPage({
  pageWidth,
  children,
}: {
  pageWidth: number;
  children?: ReactNode;
}) {
  return <View style={[styles.page, { width: pageWidth }]}>{children}</View>;
}

const styles = StyleSheet.create({
  row: {
    flex: 1,
    flexDirection: "row",
    alignItems: "stretch",
  },
  page: {
    flex: 1,
    alignSelf: "stretch",
  },
});
