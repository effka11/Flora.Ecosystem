import { liveGridStyles } from "@/lib/liveGridStyles";
import { useRecyclingState } from "@shopify/flash-list";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import {
  Animated,
  Easing,
  PixelRatio,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type NativeSyntheticEvent,
  type StyleProp,
  type TextLayoutEventData,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { LruCache } from "@/lib/lruCache";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { floraColors, floraSpacing } from "@/lib/theme";

type ExpandablePostTextProps = {
  postUuid: string;
  text: string;
  hasMedia?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
};

type TextLineLayout = TextLayoutEventData["lines"][number];

type TextMeasurement = {
  textKey: string;
  lines: readonly TextLineLayout[];
};

const COLLAPSED_TEXT_LINES = 8;
const COLLAPSED_WITH_MEDIA_LINES = 4;
const EXPAND_CHUNK_TEXT_LINES = 30;
const EXPAND_CHUNK_WITH_MEDIA_LINES = 30;
const LAST_PART_EXTRA_LINES = 5;
const TRUNCATION_ELLIPSIS = "...";
const CLIP_ANIM_MS = 380;
const EXPAND_EASING = Easing.bezier(0.22, 1, 0.36, 1);
const TOGGLE_MARGIN_TOP = () => 5 * floraSpacing.gridFine;
const ESTIMATED_LINE_HEIGHT_PX = 25.5;

/** Bump when the text style or truncation math changes so cached layouts invalidate. */
const LAYOUT_SCHEMA = "v2";
const TEXT_LAYOUT_CACHE_CAPACITY = 300;
const VISIBLE_LINES_CACHE_CAPACITY = 400;

const postTextLayoutCache = new LruCache<string, readonly TextLineLayout[]>(
  TEXT_LAYOUT_CACHE_CAPACITY,
);
const postVisibleLinesCache = new LruCache<string, number>(VISIBLE_LINES_CACHE_CAPACITY);

function trimTrailingEmptyLines(value: string): string {
  return value.replace(/(?:\r?\n[ \t]*)+$/, "");
}

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

function resolveSourceEndIndex(value: string, reconstructed: string): number {
  if (!reconstructed) {
    return 0;
  }

  const direct = value.indexOf(reconstructed);
  if (direct >= 0) {
    return direct + reconstructed.length;
  }

  const anchor = reconstructed.slice(0, Math.min(32, reconstructed.length));
  const anchored = anchor ? value.indexOf(anchor) : -1;
  if (anchored >= 0) {
    let matched = 0;
    while (
      matched < reconstructed.length &&
      anchored + matched < value.length &&
      value[anchored + matched] === reconstructed[matched]
    ) {
      matched += 1;
    }
    return anchored + matched;
  }

  return Math.min(value.length, reconstructed.length);
}

function trimToLastCompleteWord(value: string): string {
  const trimmed = value.trimEnd();
  if (!trimmed) {
    return trimmed;
  }

  const wordBoundary = trimmed.search(/\s+\S*$/);
  return wordBoundary > 0 ? trimmed.slice(0, wordBoundary).trimEnd() : trimmed;
}

function buildTruncatedDisplay(
  value: string,
  lines: readonly TextLineLayout[],
  maxLines: number,
): string {
  if (lines.length <= maxLines) {
    return value;
  }

  const reconstructed = lines
    .slice(0, maxLines)
    .map((line) => line.text)
    .join("");

  if (!reconstructed) {
    return "";
  }

  const end = resolveSourceEndIndex(value, reconstructed);
  let body = value.slice(0, end).trimEnd();

  if (body.length >= value.trimEnd().length) {
    body = trimToLastCompleteWord(reconstructed.trimEnd()) || reconstructed.trimEnd();
  } else {
    const wordTrimmed = trimToLastCompleteWord(body);
    if (wordTrimmed.length > 0) {
      body = wordTrimmed;
    }
  }

  return body;
}

function buildDisplayMeasureKey(textKey: string, visibleLines: number, body: string): string {
  return `${textKey}:${visibleLines}:${body.length}`;
}

function resolveTargetHeight(
  lines: readonly TextLineLayout[] | null,
  canExpand: boolean,
  fullyExpanded: boolean,
  visibleLines: number,
): number | undefined {
  if (!lines?.length) {
    return undefined;
  }

  if (!canExpand || fullyExpanded) {
    return heightForLineCount(lines, lines.length);
  }

  return heightForLineCount(lines, Math.min(visibleLines, lines.length));
}

function estimateCollapsedHeight(collapsedLines: number): number {
  return collapsedLines * ESTIMATED_LINE_HEIGHT_PX;
}

function readCachedVisibleLines(postUuid: string, collapsedLines: number): number {
  const saved = postVisibleLinesCache.get(postUuid);
  return saved !== undefined && saved >= collapsedLines ? saved : collapsedLines;
}

function persistVisibleLines(postUuid: string, visibleLines: number): void {
  postVisibleLinesCache.set(postUuid, visibleLines);
}

function readCachedMeasurement(textKey: string): TextMeasurement | null {
  const lines = postTextLayoutCache.get(textKey);
  return lines ? { textKey, lines } : null;
}

export const ExpandablePostText = memo(function ExpandablePostText({
  postUuid,
  text,
  hasMedia = false,
  containerStyle,
  textStyle,
}: ExpandablePostTextProps) {
  const layoutText = useMemo(() => trimTrailingEmptyLines(text), [text]);
  const collapsedLines = hasMedia ? COLLAPSED_WITH_MEDIA_LINES : COLLAPSED_TEXT_LINES;
  const expandChunkLines = hasMedia ? EXPAND_CHUNK_WITH_MEDIA_LINES : EXPAND_CHUNK_TEXT_LINES;
  const { width: windowWidth } = useWindowDimensions();
  // Line layout depends on available width and the OS font scale; folding both
  // (bucketed) into the cache key prevents stale truncation after rotation /
  // accessibility changes without re-measuring on every render.
  const widthBucket = Math.max(1, Math.round(windowWidth / 4));
  const fontScaleBucket = Math.round(PixelRatio.getFontScale() * 100);
  const textKey = `${LAYOUT_SCHEMA}:${widthBucket}:${fontScaleBucket}:${collapsedLines}:${layoutText}`;

  const reduceMotion = useReducedMotion();

  const animFromHeightRef = useRef<number | null>(null);
  const pendingAnimRef = useRef(false);
  const currentClipHeightRef = useRef(0);
  const activeAnimRef = useRef<Animated.CompositeAnimation | null>(null);
  const animatedHeight = useRef(
    new Animated.Value(
      resolveTargetHeight(
        readCachedMeasurement(textKey)?.lines ?? null,
        true,
        false,
        readCachedVisibleLines(postUuid, collapsedLines),
      ) ?? estimateCollapsedHeight(collapsedLines),
    ),
  ).current;

  // Row-local state reset synchronously on recycle (post/text/layout change),
  // avoiding the one-frame stale flash of a post-render effect. The onReset
  // callback re-seeds the clip height imperatively from the cache.
  const [visibleLines, setVisibleLines] = useRecyclingState<number>(
    () => readCachedVisibleLines(postUuid, collapsedLines),
    [postUuid, textKey],
    () => {
      pendingAnimRef.current = false;
      animFromHeightRef.current = null;
      activeAnimRef.current?.stop();
      activeAnimRef.current = null;

      const restored = readCachedVisibleLines(postUuid, collapsedLines);
      const cachedLines = readCachedMeasurement(textKey)?.lines ?? null;
      const total = cachedLines?.length ?? collapsedLines;
      const cachedTarget = resolveTargetHeight(
        cachedLines,
        total > collapsedLines,
        restored >= total,
        restored,
      );
      const nextHeight = cachedTarget ?? estimateCollapsedHeight(collapsedLines);
      animatedHeight.setValue(nextHeight);
      currentClipHeightRef.current = nextHeight;
    },
  );
  const [fullMeasurement, setFullMeasurement] = useRecyclingState<TextMeasurement | null>(
    () => readCachedMeasurement(textKey),
    [postUuid, textKey],
  );
  const [displayMeasurement, setDisplayMeasurement] = useRecyclingState<TextMeasurement | null>(
    null,
    [postUuid, textKey],
  );

  useEffect(() => {
    return () => {
      activeAnimRef.current?.stop();
    };
  }, []);

  const onFullTextLayout = useCallback(
    (event: NativeSyntheticEvent<TextLayoutEventData>) => {
      const lines = event.nativeEvent.lines;
      const cached = postTextLayoutCache.get(textKey);
      if (cached && layoutMetricsEqual(cached, lines)) {
        return;
      }

      postTextLayoutCache.set(textKey, lines);
      setFullMeasurement({ textKey, lines });
    },
    [setFullMeasurement, textKey],
  );

  const fullLines = fullMeasurement?.textKey === textKey ? fullMeasurement.lines : null;
  const totalLines = fullLines?.length ?? collapsedLines;
  const fullyExpanded = visibleLines >= totalLines;
  const canExpand = totalLines > collapsedLines;
  const needsMeasure = !postTextLayoutCache.has(textKey);

  useEffect(() => {
    if (!fullLines?.length) {
      return;
    }

    setVisibleLines((current) => {
      if (current <= fullLines.length) {
        return current;
      }

      const clamped = fullLines.length;
      persistVisibleLines(postUuid, clamped);
      return clamped;
    });
  }, [fullLines, postUuid, setVisibleLines]);

  const truncatedDisplay = useMemo(() => {
    if (fullyExpanded || !fullLines || !canExpand) {
      return { body: layoutText, showEllipsis: false };
    }

    return {
      body: buildTruncatedDisplay(layoutText, fullLines, visibleLines),
      showEllipsis: true,
    };
  }, [canExpand, fullLines, fullyExpanded, layoutText, visibleLines]);

  const displayBody = truncatedDisplay.body;
  const showEllipsis = truncatedDisplay.showEllipsis;
  const displayMeasureKey = buildDisplayMeasureKey(textKey, visibleLines, displayBody);
  const displayMeasureText = showEllipsis ? `${displayBody}${TRUNCATION_ELLIPSIS}` : displayBody;

  const onDisplayTextLayout = useCallback(
    (event: NativeSyntheticEvent<TextLayoutEventData>) => {
      if (!showEllipsis) {
        return;
      }

      const lines = event.nativeEvent.lines;
      const nextKey = buildDisplayMeasureKey(textKey, visibleLines, displayBody);
      setDisplayMeasurement((value) =>
        value?.textKey === nextKey && layoutMetricsEqual(value.lines, lines)
          ? value
          : { textKey: nextKey, lines },
      );
    },
    [displayBody, setDisplayMeasurement, showEllipsis, textKey, visibleLines],
  );

  const displayLines =
    displayMeasurement?.textKey === displayMeasureKey ? displayMeasurement.lines : null;

  const targetHeight = useMemo(() => {
    if (!fullLines?.length) {
      return undefined;
    }

    if (!canExpand || fullyExpanded) {
      return heightForLineCount(fullLines, fullLines.length);
    }

    if (showEllipsis && displayLines?.length) {
      return heightForLineCount(displayLines, displayLines.length);
    }

    return heightForLineCount(fullLines, Math.min(visibleLines, fullLines.length));
  }, [canExpand, displayLines, fullLines, fullyExpanded, showEllipsis, visibleLines]);

  useEffect(() => {
    setDisplayMeasurement(null);
  }, [displayBody, setDisplayMeasurement, showEllipsis, textKey, visibleLines]);

  const queueClipAnimationFromCurrent = useCallback(() => {
    if (currentClipHeightRef.current > 0) {
      animFromHeightRef.current = currentClipHeightRef.current;
    }
  }, []);

  const handleToggle = useCallback(() => {
    pendingAnimRef.current = true;
    queueClipAnimationFromCurrent();

    if (fullyExpanded) {
      persistVisibleLines(postUuid, collapsedLines);
      setVisibleLines(collapsedLines);
      return;
    }

    setVisibleLines((current) => {
      const next = nextVisibleLines(current, totalLines, expandChunkLines);
      persistVisibleLines(postUuid, next);
      return next;
    });
  }, [
    collapsedLines,
    expandChunkLines,
    fullyExpanded,
    postUuid,
    queueClipAnimationFromCurrent,
    setVisibleLines,
    totalLines,
  ]);

  useEffect(() => {
    if (targetHeight === undefined) {
      return;
    }

    const fromHeight = animFromHeightRef.current;
    const shouldAnimate =
      pendingAnimRef.current &&
      !reduceMotion &&
      fromHeight !== null &&
      Math.abs(fromHeight - targetHeight) > 1;

    pendingAnimRef.current = false;
    animFromHeightRef.current = null;
    activeAnimRef.current?.stop();
    activeAnimRef.current = null;

    if (shouldAnimate) {
      animatedHeight.setValue(fromHeight);
      activeAnimRef.current = Animated.timing(animatedHeight, {
        toValue: targetHeight,
        duration: CLIP_ANIM_MS,
        easing: EXPAND_EASING,
        useNativeDriver: false,
      });
      activeAnimRef.current.start(({ finished }) => {
        activeAnimRef.current = null;
        if (finished) {
          currentClipHeightRef.current = targetHeight;
        }
      });
      return;
    }

    if (Math.abs(currentClipHeightRef.current - targetHeight) > 0.5) {
      animatedHeight.setValue(targetHeight);
      currentClipHeightRef.current = targetHeight;
    }
  }, [animatedHeight, reduceMotion, targetHeight]);

  if (layoutText.trim().length === 0) {
    return null;
  }

  const clipStyle = canExpand ? { height: animatedHeight } : undefined;

  return (
    <View style={[styles.root, containerStyle]}>
      <View style={styles.clipWrap} collapsable={false}>
        {needsMeasure ? (
          <View pointerEvents="none" style={styles.measureSlot} collapsable={false}>
            <Text style={textStyle} onTextLayout={onFullTextLayout}>
              {layoutText}
            </Text>
          </View>
        ) : null}
        {showEllipsis ? (
          <View pointerEvents="none" style={styles.measureSlot} collapsable={false}>
            <Text style={textStyle} onTextLayout={onDisplayTextLayout}>
              {displayMeasureText}
            </Text>
          </View>
        ) : null}
        <Animated.View style={[styles.contentClip, clipStyle]} collapsable={false}>
          <Text style={textStyle}>
            {displayBody}
            {showEllipsis ? TRUNCATION_ELLIPSIS : null}
          </Text>
        </Animated.View>
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
});

const styles = liveGridStyles(() => StyleSheet.create({
  root: {
    position: "relative",
  },
  clipWrap: {
    position: "relative",
  },
  measureSlot: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    opacity: 0,
    zIndex: -1,
  },
  contentClip: {
    overflow: "hidden",
  },
  toggle: {
    alignSelf: "flex-start",
    marginTop: TOGGLE_MARGIN_TOP(),
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
}));
