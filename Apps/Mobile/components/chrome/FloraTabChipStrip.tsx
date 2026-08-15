import { type ReactNode, useMemo } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Reanimated, {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
  withDecay,
} from "react-native-reanimated";
import { FloraTabStripEdgeFades } from "@/components/chrome/FloraTabLabel";
import { floraSpacing, floraTabFilter } from "@/lib/theme";

/** Как settings `TABS_PAD_X`: отступ на треке, не на вьюпорте. */
export const FLORA_TAB_STRIP_PAD_X = floraSpacing.grid;
/** Чипы: выше порог, чем pager — тап не уезжает в pan. */
const CHIP_PAN_AXIS_PX = 24;
/** Ниже — без withDecay (короткий жест/тап не запускает инерцию). */
const CHIP_DECAY_MIN_VX = 320;

/**
 * Целевой offset полосы, чтобы чип оказался в центре вьюпорта.
 * `layoutX` — onLayout кнопки относительно ряда табов (без pad трека).
 */
export function typicalChipStripOffset(
  layoutX: number,
  layoutW: number,
  viewportW: number,
  maxOffset: number,
): number {
  "worklet";
  if (maxOffset <= 0 || viewportW <= 0) return 0;
  const focus = FLORA_TAB_STRIP_PAD_X + layoutX + layoutW / 2;
  const next = focus - viewportW / 2;
  return next < 0 ? 0 : next > maxOffset ? maxOffset : next;
}

/**
 * Полоса чипов как в настройках: overflow hidden, padding на треке,
 * translateX + pan/decay, фейды у края вьюпорта. В потоке на всю ширину
 * родителя (без absolute bleed).
 */
export function FloraTabChipStrip({
  offset,
  maxOffset,
  viewportW,
  contentW,
  children,
  cover,
  onPanBegin,
  onPanFinalize,
  onPanDecayEnd,
}: {
  offset: SharedValue<number>;
  maxOffset: SharedValue<number>;
  viewportW: SharedValue<number>;
  contentW: SharedValue<number>;
  children: ReactNode;
  cover?: SharedValue<number>;
  onPanBegin?: () => void;
  onPanFinalize?: (success: boolean) => void;
  onPanDecayEnd?: () => void;
}) {
  const dragStart = useSharedValue(0);

  const trackStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -offset.value }],
  }));

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-CHIP_PAN_AXIS_PX, CHIP_PAN_AXIS_PX])
        .failOffsetY([-CHIP_PAN_AXIS_PX, CHIP_PAN_AXIS_PX])
        .onBegin(() => {
          "worklet";
          cancelAnimation(offset);
          if (onPanBegin) runOnJS(onPanBegin)();
        })
        .onStart(() => {
          "worklet";
          dragStart.value = offset.value;
        })
        .onUpdate((event) => {
          "worklet";
          const max = Math.max(0, maxOffset.value);
          const next = dragStart.value - event.translationX;
          offset.value = next < 0 ? 0 : next > max ? max : next;
        })
        .onEnd((event) => {
          "worklet";
          if (Math.abs(event.velocityX) < CHIP_DECAY_MIN_VX) {
            if (onPanDecayEnd) runOnJS(onPanDecayEnd)();
            return;
          }
          offset.value = withDecay(
            {
              velocity: -event.velocityX,
              clamp: [0, Math.max(0, maxOffset.value)],
            },
            (finished) => {
              if (finished === true && onPanDecayEnd) runOnJS(onPanDecayEnd)();
            },
          );
        })
        .onFinalize((_event, success) => {
          "worklet";
          if (onPanFinalize) runOnJS(onPanFinalize)(success);
        }),
    [dragStart, maxOffset, offset, onPanBegin, onPanDecayEnd, onPanFinalize],
  );

  const onViewportLayout = (event: LayoutChangeEvent) => {
    viewportW.value = event.nativeEvent.layout.width;
  };

  const onTrackLayout = (event: LayoutChangeEvent) => {
    contentW.value = event.nativeEvent.layout.width;
  };

  return (
    <View style={styles.wrap} onLayout={onViewportLayout}>
      <GestureDetector gesture={pan}>
        <Reanimated.View style={[styles.track, trackStyle]} onLayout={onTrackLayout}>
          {children}
        </Reanimated.View>
      </GestureDetector>
      <FloraTabStripEdgeFades offset={offset} maxOffset={maxOffset} cover={cover} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "relative",
    overflow: "hidden",
    minHeight: floraTabFilter.triggerHeight,
  },
  track: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: FLORA_TAB_STRIP_PAD_X,
    alignSelf: "flex-start",
  },
});
