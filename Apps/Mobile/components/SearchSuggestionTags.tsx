import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { Pressable as GesturePressable } from "react-native-gesture-handler";
import Reanimated, {
  cancelAnimation,
  Extrapolation,
  interpolate,
  runOnJS,
  runOnUI,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
} from "react-native-reanimated";
import {
  FloraTabChipStrip,
  typicalChipStripOffset,
} from "@/components/chrome/FloraTabChipStrip";
import {
  FloraTabLabel,
  floraTabChrome,
  floraTabIndicatorHidden,
  floraTabIndicatorTransform,
} from "@/components/chrome/FloraTabLabel";
import { useTabIndicatorBridge } from "@/components/chrome/tabIndicatorBridge";
import { ENERGETIC_OPEN_EASING, ENERGETIC_OPEN_MS, settleEnergetic } from "@/lib/energeticSettle";
import { useFloraGrid } from "@/lib/FloraGridProvider";
import { floraTabFilter } from "@/lib/theme";

export type SearchSuggestionTag = {
  id: string;
  label: string;
};

/**
 * Режимы запроса: общий vs точный. На всех вкладках одна ось.
 * Пока только дизайн: тап не меняет скоуп FSA.
 */
const SEARCH_QUERY_MODE_TAGS = [
  { id: "topics", label: "Общий поиск" },
  { id: "exact", label: "Точный поиск" },
] as const satisfies readonly SearchSuggestionTag[];

export const SEARCH_SUGGESTION_TAGS = {
  feed: SEARCH_QUERY_MODE_TAGS,
  people: SEARCH_QUERY_MODE_TAGS,
  music: SEARCH_QUERY_MODE_TAGS,
  communities: SEARCH_QUERY_MODE_TAGS,
  notifications: SEARCH_QUERY_MODE_TAGS,
  messages: SEARCH_QUERY_MODE_TAGS,
} as const satisfies Record<string, readonly SearchSuggestionTag[]>;

type TabLayout = { x: number; width: number };

type TagChromeMotion = {
  ready: boolean;
  inputRange: number[];
  indicatorX: number[];
  indicatorW: number[];
};

function buildTagChromeMotion(
  tags: readonly SearchSuggestionTag[],
  layouts: Partial<Record<string, TabLayout>>,
): TagChromeMotion {
  const empty: TagChromeMotion = {
    ready: false,
    inputRange: [0, 1],
    indicatorX: [0, 0],
    indicatorW: [0, 0],
  };
  const count = tags.length;
  if (count < 1) return empty;
  for (let i = 0; i < count; i++) {
    if (!layouts[tags[i].id]) return empty;
  }

  const inputRange: number[] = [];
  const indicatorX: number[] = [];
  const indicatorW: number[] = [];
  for (let i = 0; i < count; i++) {
    const layout = layouts[tags[i].id]!;
    inputRange.push(i);
    indicatorX.push(layout.x);
    indicatorW.push(layout.width);
  }
  if (inputRange.length === 1) {
    inputRange.push(1);
    indicatorX.push(indicatorX[0]);
    indicatorW.push(indicatorW[0]);
  }
  return { ready: true, inputRange, indicatorX, indicatorW };
}

type Props = {
  tags: readonly SearchSuggestionTag[];
  selectedId: string;
  onSelectedIdChange: (id: string) => void;
  /** Тап по тегу не должен блюрить поле и закрывать поиск. */
  holdFocusRef?: MutableRefObject<(() => void) | null>;
};

export function SearchSuggestionTags({
  tags,
  selectedId,
  onSelectedIdChange,
  holdFocusRef,
}: Props) {
  const stripPadX = useFloraGrid().step;
  const [layouts, setLayouts] = useState<Partial<Record<string, TabLayout>>>({});
  const progress = useSharedValue(0);
  const hasPositioned = useRef(false);
  const tagsKey = tags.map((tag) => tag.id).join("|");
  const prevTagsKeyRef = useRef(tagsKey);
  const bridge = useTabIndicatorBridge();
  const searchPose = bridge?.search ?? null;
  const shareIndicatorSV = useSharedValue((bridge?.idle.ready.value ?? 0) > 0.5 ? 1 : 0);
  const [shareIndicator, setShareIndicator] = useState(
    () => (bridge?.idle.ready.value ?? 0) > 0.5,
  );
  const stripOffset = useSharedValue(0);
  const stripViewportW = useSharedValue(0);
  const stripContentW = useSharedValue(0);
  const maxStripOffset = useDerivedValue(() =>
    Math.max(0, stripContentW.value - stripViewportW.value),
  );
  const holdFocus = useCallback(() => {
    holdFocusRef?.current?.();
  }, [holdFocusRef]);

  const chrome = useMemo(() => buildTagChromeMotion(tags, layouts), [layouts, tags]);

  useAnimatedReaction(
    () => bridge?.idle.ready.value ?? 0,
    (ready) => {
      const share = ready > 0.5 ? 1 : 0;
      shareIndicatorSV.value = share;
      runOnJS(setShareIndicator)(share > 0.5);
    },
  );

  useAnimatedReaction(
    () => {
      if (!searchPose || shareIndicatorSV.value < 0.5 || !chrome.ready) {
        return { ready: 0, left: 0, width: 0 };
      }
      return {
        ready: 1,
        width: interpolate(
          progress.value,
          chrome.inputRange,
          chrome.indicatorW,
          Extrapolation.CLAMP,
        ),
        left:
          stripPadX +
          interpolate(
            progress.value,
            chrome.inputRange,
            chrome.indicatorX,
            Extrapolation.CLAMP,
          ) -
          stripOffset.value,
      };
    },
    (next) => {
      if (!searchPose) return;
      searchPose.ready.value = next.ready;
      if (next.ready) {
        searchPose.left.value = next.left;
        searchPose.width.value = next.width;
      }
    },
  );

  useEffect(() => {
    if (prevTagsKeyRef.current === tagsKey) return;
    prevTagsKeyRef.current = tagsKey;
    hasPositioned.current = false;
    setLayouts({});
    progress.value = 0;
    stripOffset.value = 0;
  }, [progress, stripOffset, tagsKey]);

  useEffect(() => {
    if (!chrome.ready || hasPositioned.current) return;
    const index = Math.max(
      0,
      tags.findIndex((tag) => tag.id === selectedId),
    );
    progress.value = index;
    hasPositioned.current = true;
  }, [chrome.ready, progress, selectedId, tags]);

  const recordTabLayout = useCallback((tagId: string, event: LayoutChangeEvent) => {
    const { x, width } = event.nativeEvent.layout;
    setLayouts((prev) => {
      const existing = prev[tagId];
      if (existing?.x === x && existing?.width === width) return prev;
      return { ...prev, [tagId]: { x, width } };
    });
  }, []);

  const tabIndicatorStyle = useAnimatedStyle(() => {
    if (!chrome.ready) {
      return floraTabIndicatorHidden();
    }
    const width = interpolate(
      progress.value,
      chrome.inputRange,
      chrome.indicatorW,
      Extrapolation.CLAMP,
    );
    const left = interpolate(
      progress.value,
      chrome.inputRange,
      chrome.indicatorX,
      Extrapolation.CLAMP,
    );
    return floraTabIndicatorTransform(left, width);
  });

  const selectTag = (id: string) => {
    holdFocus();
    if (id === selectedId) return;
    const index = tags.findIndex((tag) => tag.id === id);
    if (index < 0) return;
    onSelectedIdChange(id);
    const layout = layouts[id];
    const layoutX = layout?.x ?? 0;
    const layoutW = layout?.width ?? 0;
    if (!hasPositioned.current) {
      progress.value = index;
      return;
    }
    runOnUI((target: number, x: number, width: number, padX: number) => {
      "worklet";
      cancelAnimation(progress);
      settleEnergetic(
        progress,
        target,
        1,
        1,
        0,
        ENERGETIC_OPEN_MS,
        ENERGETIC_OPEN_EASING,
      );
      cancelAnimation(stripOffset);
      const typical = typicalChipStripOffset(
        x,
        width,
        stripViewportW.value,
        maxStripOffset.value,
        padX,
      );
      settleEnergetic(
        stripOffset,
        typical,
        Math.max(maxStripOffset.value, 1),
        1,
        0,
        ENERGETIC_OPEN_MS,
        ENERGETIC_OPEN_EASING,
      );
    })(index, layoutX, layoutW, stripPadX);
  };

  return (
    <View style={styles.row} accessibilityRole="tablist">
      <FloraTabChipStrip
        offset={stripOffset}
        maxOffset={maxStripOffset}
        viewportW={stripViewportW}
        contentW={stripContentW}
        onPanBegin={holdFocus}
      >
        <View style={styles.tabs}>
          {chrome.ready && !shareIndicator ? (
            <Reanimated.View
              pointerEvents="none"
              style={[floraTabChrome.tabIndicator, tabIndicatorStyle]}
            />
          ) : null}
          {tags.map((tag, index) => {
            const selected = tag.id === selectedId;
            return (
              <GesturePressable
                key={tag.id}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                accessibilityLabel={tag.label}
                onLayout={(event) => recordTabLayout(tag.id, event)}
                onPressIn={holdFocus}
                onPress={() => selectTag(tag.id)}
                style={floraTabChrome.tabButton}
              >
                <FloraTabLabel index={index} label={tag.label} progress={progress} />
              </GesturePressable>
            );
          })}
        </View>
      </FloraTabChipStrip>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: floraTabFilter.triggerHeight,
    justifyContent: "center",
  },
  tabs: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    overflow: "visible",
    minHeight: floraTabFilter.triggerHeight,
  },
});
