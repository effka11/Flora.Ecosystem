import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LayoutChangeEvent } from "react-native";
import { Gesture } from "react-native-gesture-handler";
import {
  cancelAnimation,
  runOnJS,
  runOnUI,
  useDerivedValue,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import {
  ENERGETIC_OPEN_EASING,
  ENERGETIC_OPEN_MS,
  settleEnergetic,
  snapPagerOffset,
} from "@/lib/energeticSettle";
import { nextFeedPageWidth } from "@/lib/feedImageGeometry";
import { imeStableWindowWidth, isImeVisible } from "@/lib/imeVisible";

/** Как SWIPE_AXIS_PX у drawer — не перехватывать вертикальный скролл. */
export const PAGER_AXIS_PX = 10;

type UseTabPagerOptions = {
  pageCount: number;
  enabled?: boolean;
  initialIndex?: number;
  onTouchBegin?: () => void;
  onTouchEnd?: () => void;
  onPagerStart?: () => void;
  onMotionEnd?: () => void;
  onCommitIndex: (index: number) => void;
};

export function useTabPager({
  pageCount,
  enabled = true,
  initialIndex = 0,
  onTouchBegin,
  onTouchEnd,
  onPagerStart,
  onMotionEnd,
  onCommitIndex,
}: UseTabPagerOptions): {
  scrollX: SharedValue<number>;
  pageWidth: number;
  pageWidthSV: SharedValue<number>;
  tabProgress: SharedValue<number>;
  pagerPan: ReturnType<typeof Gesture.Pan>;
  onBodyLayout: (event: LayoutChangeEvent) => void;
  settleToIndex: (index: number) => void;
  pagerTargetRef: { current: number };
} {
  const [pageWidth, setPageWidth] = useState(imeStableWindowWidth);
  const scrollX = useSharedValue(initialIndex * imeStableWindowWidth());
  const dragStartX = useSharedValue(0);
  const pageWidthSV = useSharedValue(pageWidth);
  const pageCountSV = useSharedValue(pageCount);
  pageCountSV.value = pageCount;
  const pagerTargetRef = useRef(initialIndex);
  /** Pan onStart — cancelAnimation already killed a tap settle. */
  const panActivatedRef = useRef(false);
  /** Pan onEnd — this finger set pager, not settleToIndex. */
  const panSetPagerRef = useRef(false);
  const onCommitIndexRef = useRef(onCommitIndex);
  onCommitIndexRef.current = onCommitIndex;
  const onTouchBeginRef = useRef(onTouchBegin);
  onTouchBeginRef.current = onTouchBegin;
  const onTouchEndRef = useRef(onTouchEnd);
  onTouchEndRef.current = onTouchEnd;
  const onPagerStartRef = useRef(onPagerStart);
  onPagerStartRef.current = onPagerStart;
  const onMotionEndRef = useRef(onMotionEnd);
  onMotionEndRef.current = onMotionEnd;

  const tabProgress = useDerivedValue(() => {
    const w = pageWidthSV.value;
    return w > 0 ? scrollX.value / w : 0;
  });

  const onBodyLayout = useCallback((event: LayoutChangeEvent) => {
    const w = event.nativeEvent.layout.width;
    setPageWidth((prev) => nextFeedPageWidth(prev, w, isImeVisible()));
  }, []);

  useEffect(() => {
    const prev = pageWidthSV.value;
    pageWidthSV.value = pageWidth;
    if (prev > 0 && pageWidth > 0) {
      scrollX.value = scrollX.value * (pageWidth / prev);
    } else {
      scrollX.value = pagerTargetRef.current * pageWidth;
    }
  }, [pageWidth, pageWidthSV, scrollX]);

  const commitIndex = useCallback((index: number) => {
    pagerTargetRef.current = index;
    onCommitIndexRef.current(index);
  }, []);

  const beginTouch = useCallback(() => {
    panActivatedRef.current = false;
    panSetPagerRef.current = false;
    onTouchBeginRef.current?.();
  }, []);

  const markPanActivated = useCallback(() => {
    panActivatedRef.current = true;
  }, []);

  const endTouch = useCallback(() => {
    onTouchEndRef.current?.();
  }, []);

  const startPanPager = useCallback(() => {
    panSetPagerRef.current = true;
    onPagerStartRef.current?.();
  }, []);

  const startTapPager = useCallback(() => {
    onPagerStartRef.current?.();
  }, []);

  const failPanPager = useCallback(() => {
    if (!panSetPagerRef.current && !panActivatedRef.current) return;
    panSetPagerRef.current = false;
    panActivatedRef.current = false;
    onMotionEndRef.current?.();
  }, []);

  const endPagerSettled = useCallback(() => {
    panSetPagerRef.current = false;
    panActivatedRef.current = false;
    onMotionEndRef.current?.();
  }, []);

  const pagerPan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-PAGER_AXIS_PX, PAGER_AXIS_PX])
        .failOffsetY([-PAGER_AXIS_PX * 2, PAGER_AXIS_PX * 2])
        .onBegin(() => {
          "worklet";
          runOnJS(beginTouch)();
        })
        .onStart(() => {
          "worklet";
          cancelAnimation(scrollX);
          dragStartX.value = scrollX.value;
          runOnJS(markPanActivated)();
        })
        .onUpdate((event) => {
          "worklet";
          const width = pageWidthSV.value;
          if (width <= 0) return;
          const max = Math.max(0, (pageCountSV.value - 1) * width);
          scrollX.value = Math.max(0, Math.min(max, dragStartX.value - event.translationX));
        })
        .onEnd((event) => {
          "worklet";
          const width = pageWidthSV.value;
          const count = pageCountSV.value;
          if (width <= 0 || count < 1) return;
          const target = snapPagerOffset(scrollX.value, width, count, event.velocityX);
          runOnJS(startPanPager)();
          settleEnergetic(
            scrollX,
            target,
            width,
            1,
            event.velocityX,
            ENERGETIC_OPEN_MS,
            ENERGETIC_OPEN_EASING,
            (finished) => {
              if (finished !== true) return;
              runOnJS(endPagerSettled)();
              runOnJS(commitIndex)(Math.round(target / width));
            },
          );
        })
        .onFinalize((_event, success) => {
          "worklet";
          runOnJS(endTouch)();
          if (!success) runOnJS(failPanPager)();
        })
        .enabled(enabled),
    [
      beginTouch,
      commitIndex,
      dragStartX,
      enabled,
      endPagerSettled,
      endTouch,
      failPanPager,
      markPanActivated,
      pageCountSV,
      pageWidthSV,
      scrollX,
      startPanPager,
    ],
  );

  const settleToIndex = useCallback(
    (index: number) => {
      if (index === pagerTargetRef.current) return;
      pagerTargetRef.current = index;
      startTapPager();
      runOnUI(() => {
        "worklet";
        cancelAnimation(scrollX);
        const width = pageWidthSV.value;
        const target = index * (width > 0 ? width : 1);
        settleEnergetic(
          scrollX,
          target,
          width > 0 ? width : 1,
          1,
          0,
          ENERGETIC_OPEN_MS,
          ENERGETIC_OPEN_EASING,
          (finished) => {
            if (finished !== true) return;
            runOnJS(endPagerSettled)();
            runOnJS(commitIndex)(index);
          },
        );
      })();
    },
    [commitIndex, endPagerSettled, pageWidthSV, scrollX, startTapPager],
  );

  return {
    scrollX,
    pageWidth,
    pageWidthSV,
    tabProgress,
    pagerPan,
    onBodyLayout,
    settleToIndex,
    pagerTargetRef,
  };
}
