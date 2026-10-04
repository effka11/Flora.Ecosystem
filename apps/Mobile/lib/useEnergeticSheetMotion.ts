import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useWindowDimensions } from "react-native";
import {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import {
  ENERGETIC_OPEN_EASING,
  ENERGETIC_OPEN_MS,
} from "@/lib/energeticSettle";
import {
  ENERGETIC_SHEET_DIM,
  sheetCloseFalling,
  sheetFirstPaintProgress,
  sheetOpenRising,
  sheetShouldCommitClose,
  sheetShouldPresent,
} from "@/lib/energeticSheetMotion";
import { shouldSkipFloraMotion, useFloraReduceMotion } from "@/lib/useFloraReduceMotion";

export {
  ENERGETIC_SHEET_DIM,
  sheetCloseFalling,
  sheetFirstPaintProgress,
  sheetOpenRising,
  sheetShouldCommitClose,
  sheetShouldPresent,
} from "@/lib/energeticSheetMotion";

const EXIT_MS = ENERGETIC_OPEN_MS;
const EXIT_EASING = ENERGETIC_OPEN_EASING;

type Options = {
  onClosed?: () => void;
};

/**
 * Телеграмный push чата, но снизу вверх: progress 0 — лист за экраном,
 * 1 — на месте; та же длительность и ease-out, что chatPushTransition / вкладки.
 */
export function useEnergeticSheetMotion(open: boolean, { onClosed }: Options = {}) {
  const { height: windowHeight } = useWindowDimensions();
  const reduceMotion = useFloraReduceMotion();
  const skipMotion = shouldSkipFloraMotion(reduceMotion);
  const openRef = useRef(open);
  openRef.current = open;

  const [presented, setPresented] = useState(open);
  if (open && !presented) {
    setPresented(true);
  }

  const progress = useSharedValue(open ? sheetFirstPaintProgress(skipMotion) : 0);
  const prevOpenRef = useRef<boolean | null>(null);
  const skipRef = useRef(skipMotion);
  skipRef.current = skipMotion;

  const finishClose = useCallback(() => {
    if (!sheetShouldCommitClose(openRef.current)) return;
    setPresented(false);
    onClosed?.();
  }, [onClosed]);

  useLayoutEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    if (sheetOpenRising(wasOpen, open)) {
      cancelAnimation(progress);
      if (skipRef.current) {
        progress.value = 1;
        return;
      }
      progress.value = sheetFirstPaintProgress(false);
      progress.value = withTiming(1, {
        duration: ENERGETIC_OPEN_MS,
        easing: ENERGETIC_OPEN_EASING,
      });
      return;
    }
    if (sheetCloseFalling(wasOpen, open)) {
      if (skipRef.current) {
        progress.value = 0;
        finishClose();
        return;
      }
      cancelAnimation(progress);
      progress.value = withTiming(
        0,
        { duration: EXIT_MS, easing: EXIT_EASING },
        () => {
          "worklet";
          runOnJS(finishClose)();
        },
      );
    }
  }, [finishClose, open, progress]);

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: (1 - progress.value) * windowHeight }],
  }));

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: progress.value * ENERGETIC_SHEET_DIM,
  }));

  return { presented: sheetShouldPresent(open, presented), sheetStyle, backdropStyle };
}
