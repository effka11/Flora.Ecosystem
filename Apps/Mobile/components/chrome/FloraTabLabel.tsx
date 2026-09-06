import { liveGridStyles } from "@/lib/liveGridStyles";
import { LinearGradient } from "expo-linear-gradient";
import { memo } from "react";
import { StyleSheet, Text, View } from "react-native";
import Reanimated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { floraColors, floraSpacing, floraTabFilter } from "@/lib/theme";

/**
 * База ширины индикатора: реальная ширина — через scaleX (transform), а не
 * width. Анимация width — layout-свойство: commit shadow-дерева + Yoga на
 * каждом кадре. При высоте 2px деформация скруглений не различима.
 */
export const FLORA_TAB_INDICATOR_BASE_W = 120;

export function floraTabIndicatorTransform(left: number, width: number) {
  "worklet";
  return {
    opacity: 1,
    transform: [
      { translateX: left - (FLORA_TAB_INDICATOR_BASE_W - width) / 2 },
      { scaleX: width / FLORA_TAB_INDICATOR_BASE_W },
    ],
  };
}

export function floraTabIndicatorHidden() {
  "worklet";
  return { opacity: 0, transform: [{ translateX: 0 }, { scaleX: 0 }] };
}

/**
 * Кроссфейд серый↔зелёный — двумя слоями текста через opacity.
 * Анимация color текста на Fabric — UPDATE_STATE-коммит Paragraph на кадр.
 * `progress` — индекс таба (дробный во время settle).
 */
export const FloraTabLabel = memo(function FloraTabLabel({
  index,
  label,
  progress,
}: {
  index: number;
  label: string;
  progress: SharedValue<number>;
}) {
  const overlayStyle = useAnimatedStyle(() => {
    const distance = Math.abs(progress.value - index);
    return { opacity: distance >= 1 ? 0 : 1 - distance };
  });

  return (
    <View style={styles.tabLabelWrap}>
      <Text numberOfLines={1} style={styles.tabLabel}>
        {label}
      </Text>
      <Reanimated.Text
        numberOfLines={1}
        pointerEvents="none"
        style={[styles.tabLabel, styles.tabLabelActive, overlayStyle]}
      >
        {label}
      </Reanimated.Text>
    </View>
  );
});

export const floraTabChrome = liveGridStyles(() => StyleSheet.create({
  tabButton: {
    height: floraTabFilter.triggerHeight,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  tabIndicator: {
    position: "absolute",
    left: 0,
    bottom: 0,
    width: FLORA_TAB_INDICATOR_BASE_W,
    height: floraTabFilter.indicatorHeight,
    borderRadius: 999,
    backgroundColor: floraColors.greenLight,
    zIndex: 2,
  },
  edgeFadeLeft: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: floraSpacing.grid,
    zIndex: 4,
  },
  edgeFadeRight: {
    position: "absolute",
    right: 0,
    top: 0,
    bottom: 0,
    width: floraSpacing.grid,
    zIndex: 4,
  },
}));

const EDGE_FADE_SOLID = floraColors.bg;
const EDGE_FADE_CLEAR = "rgba(12, 12, 12, 0)";

/**
 * Краевые фейды горизонтального ряда вкладок (настройки, люди).
 * `cover` 0…1 прячет их вместе с idle-хромом при открытии поиска.
 */
export function FloraTabStripEdgeFades({
  offset,
  maxOffset,
  cover,
}: {
  offset: SharedValue<number>;
  maxOffset: SharedValue<number>;
  cover?: SharedValue<number>;
}) {
  const leftStyle = useAnimatedStyle(() => {
    const vis = cover ? 1 - cover.value : 1;
    return { opacity: (offset.value > 1 ? 1 : 0) * vis };
  });
  const rightStyle = useAnimatedStyle(() => {
    const vis = cover ? 1 - cover.value : 1;
    const shown = maxOffset.value > 1 && offset.value < maxOffset.value - 1 ? 1 : 0;
    return { opacity: shown * vis };
  });

  return (
    <>
      <Reanimated.View pointerEvents="none" style={[floraTabChrome.edgeFadeLeft, leftStyle]}>
        <LinearGradient
          colors={[EDGE_FADE_SOLID, EDGE_FADE_CLEAR]}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={StyleSheet.absoluteFill}
        />
      </Reanimated.View>
      <Reanimated.View pointerEvents="none" style={[floraTabChrome.edgeFadeRight, rightStyle]}>
        <LinearGradient
          colors={[EDGE_FADE_CLEAR, EDGE_FADE_SOLID]}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={StyleSheet.absoluteFill}
        />
      </Reanimated.View>
    </>
  );
}

const styles = StyleSheet.create({
  tabLabelWrap: {
    position: "relative",
  },
  tabLabel: {
    color: floraColors.gray,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    lineHeight: floraTabFilter.triggerLabelLineHeight,
    includeFontPadding: false,
  },
  tabLabelActive: {
    position: "absolute",
    left: 0,
    top: 0,
    right: 0,
    color: floraColors.greenLight,
  },
});
