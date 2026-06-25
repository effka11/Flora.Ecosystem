import { useCallback, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
  type NativeSyntheticEvent,
  type StyleProp,
  type TextLayoutEventData,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { floraColors, floraSpacing } from "@/lib/theme";

type ExpandablePostTextProps = {
  text: string;
  hasMedia?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
};

type TextLineLayout = TextLayoutEventData["lines"][number];

type TextMeasurement = {
  textKey: string;
  lines: TextLineLayout[];
};

const COLLAPSED_TEXT_LINES = 8;
const COLLAPSED_WITH_MEDIA_LINES = 4;
const EXPAND_CHUNK_TEXT_LINES = 30;
const EXPAND_CHUNK_WITH_MEDIA_LINES = 30;
const LAST_PART_EXTRA_LINES = 5;
const EXPAND_ANIM_MS = 380;
const FADE_ANIM_MS = 280;
const EXPAND_EASING = Easing.bezier(0.22, 1, 0.36, 1);

function nextVisibleLines(current: number, total: number, chunk: number): number {
  const remaining = total - current;

  if (remaining <= chunk) {
    return total;
  }

  if (remaining - chunk < LAST_PART_EXTRA_LINES) {
    return Math.min(total, current + chunk + LAST_PART_EXTRA_LINES);
  }

  return current + chunk;
}

function heightForLineCount(lines: readonly TextLineLayout[], lineCount: number): number {
  if (lines.length === 0) {
    return 0;
  }

  const count = Math.min(lineCount, lines.length);
  const lastLine = lines[count - 1];
  return lastLine.y + lastLine.height;
}

function layoutMetricsEqual(a: readonly TextLineLayout[], b: readonly TextLineLayout[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  if (a.length === 0) {
    return true;
  }

  const lastA = a[a.length - 1];
  const lastB = b[b.length - 1];
  return lastA.y === lastB.y && lastA.height === lastB.height;
}

export function ExpandablePostText({
  text,
  hasMedia = false,
  containerStyle,
  textStyle,
}: ExpandablePostTextProps) {
  const collapsedLines = hasMedia ? COLLAPSED_WITH_MEDIA_LINES : COLLAPSED_TEXT_LINES;
  const expandChunkLines = hasMedia ? EXPAND_CHUNK_WITH_MEDIA_LINES : EXPAND_CHUNK_TEXT_LINES;
  const textKey = `${collapsedLines}:${text}`;

  const [visibleLines, setVisibleLines] = useState(collapsedLines);
  const [measurement, setMeasurement] = useState<TextMeasurement | null>(null);
  const [reduceMotion, setReduceMotion] = useState(false);

  const animatedHeight = useRef(new Animated.Value(0)).current;
  const fadeOpacity = useRef(new Animated.Value(1)).current;
  const metricsReadyRef = useRef(false);

  useEffect(() => {
    setVisibleLines(collapsedLines);
    metricsReadyRef.current = false;
  }, [collapsedLines, textKey]);

  useEffect(() => {
    let mounted = true;

    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted) {
        setReduceMotion(enabled);
      }
    });

    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  const onMeasureTextLayout = useCallback(
    (event: NativeSyntheticEvent<TextLayoutEventData>) => {
      const lines = event.nativeEvent.lines;
      setMeasurement((value) =>
        value?.textKey === textKey && layoutMetricsEqual(value.lines, lines)
          ? value
          : { textKey, lines },
      );
    },
    [textKey],
  );

  const lines = measurement?.textKey === textKey ? measurement.lines : null;
  const totalLines = lines?.length ?? collapsedLines;
  const fullyExpanded = visibleLines >= totalLines;
  const canExpand = totalLines > collapsedLines;

  const targetHeight =
    lines && canExpand ? heightForLineCount(lines, fullyExpanded ? totalLines : visibleLines) : undefined;

  useEffect(() => {
    if (targetHeight === undefined) {
      return;
    }

    if (!metricsReadyRef.current) {
      animatedHeight.setValue(targetHeight);
      fadeOpacity.setValue(fullyExpanded ? 0 : 1);
      metricsReadyRef.current = true;
      return;
    }

    if (reduceMotion) {
      animatedHeight.setValue(targetHeight);
      fadeOpacity.setValue(fullyExpanded ? 0 : 1);
      return;
    }

    Animated.parallel([
      Animated.timing(animatedHeight, {
        toValue: targetHeight,
        duration: EXPAND_ANIM_MS,
        easing: EXPAND_EASING,
        useNativeDriver: false,
      }),
      Animated.timing(fadeOpacity, {
        toValue: fullyExpanded ? 0 : 1,
        duration: FADE_ANIM_MS,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }),
    ]).start();
  }, [animatedHeight, fadeOpacity, fullyExpanded, reduceMotion, targetHeight]);

  const handleToggle = useCallback(() => {
    if (fullyExpanded) {
      setVisibleLines(collapsedLines);
      return;
    }

    setVisibleLines((current) => nextVisibleLines(current, totalLines, expandChunkLines));
  }, [collapsedLines, expandChunkLines, fullyExpanded, totalLines]);

  if (text.trim().length === 0) {
    return null;
  }

  const textNode = <Text style={textStyle}>{text}</Text>;

  return (
    <View style={[styles.root, containerStyle]}>
      <View style={styles.clipWrap}>
        {canExpand ? (
          <Animated.View style={[styles.contentClip, { maxHeight: animatedHeight }]}>
            {textNode}
          </Animated.View>
        ) : (
          textNode
        )}
        {canExpand ? (
          <Animated.View
            pointerEvents="none"
            style={[styles.fade, { opacity: fadeOpacity }]}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          />
        ) : null}
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          style={[textStyle, styles.measureText]}
          onTextLayout={onMeasureTextLayout}
        >
          {text}
        </Text>
      </View>
      {canExpand ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={fullyExpanded ? "Свернуть текст поста" : "Показать текст поста полностью"}
          hitSlop={floraSpacing.gridFine}
          style={({ pressed }) => [styles.toggle, pressed && styles.pressed]}
          onPress={handleToggle}
        >
          <Text style={styles.toggleText}>{fullyExpanded ? "Свернуть" : "Показать полностью"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: "relative",
  },
  clipWrap: {
    position: "relative",
  },
  contentClip: {
    overflow: "hidden",
  },
  measureText: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    opacity: 0,
  },
  fade: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: floraSpacing.grid * 2,
    backgroundColor: floraColors.bg,
  },
  toggle: {
    alignSelf: "flex-start",
    marginTop: floraSpacing.gridFine,
  },
  toggleText: {
    color: floraColors.greenLight,
    fontSize: 14,
    fontWeight: "300",
    lineHeight: 18,
    letterSpacing: 0.42,
  },
  pressed: {
    opacity: 0.72,
  },
});
