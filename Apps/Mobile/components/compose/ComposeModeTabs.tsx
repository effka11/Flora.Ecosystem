import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { floraColors, floraMotion } from "@/lib/theme";

export type ComposeModeTab = {
  id: string;
  label: string;
};

type TabLayout = { x: number; width: number };

type Props = {
  tabs: readonly ComposeModeTab[];
  activeId: string;
  onSelect: (id: string) => void;
};

export function ComposeModeTabs({ tabs, activeId, onSelect }: Props) {
  const [tabLayouts, setTabLayouts] = useState<Record<string, TabLayout | null>>({});
  const indicatorLeft = useRef(new Animated.Value(0)).current;
  const indicatorWidth = useRef(new Animated.Value(0)).current;
  const hasPositioned = useRef(false);

  const recordTabLayout = useCallback((tabId: string, event: LayoutChangeEvent) => {
    const { x, width } = event.nativeEvent.layout;
    setTabLayouts((prev) => {
      const existing = prev[tabId];
      if (existing?.x === x && existing?.width === width) return prev;
      return { ...prev, [tabId]: { x, width } };
    });
  }, []);

  const activeTabLayout = tabLayouts[activeId] ?? null;

  useEffect(() => {
    if (!activeTabLayout) return;
    if (!hasPositioned.current) {
      indicatorLeft.setValue(activeTabLayout.x);
      indicatorWidth.setValue(activeTabLayout.width);
      hasPositioned.current = true;
      return;
    }
    Animated.parallel([
      Animated.timing(indicatorLeft, {
        toValue: activeTabLayout.x,
        duration: floraMotion.baseMs,
        useNativeDriver: false,
      }),
      Animated.timing(indicatorWidth, {
        toValue: activeTabLayout.width,
        duration: floraMotion.baseMs,
        useNativeDriver: false,
      }),
    ]).start();
  }, [activeTabLayout, indicatorLeft, indicatorWidth]);

  useEffect(() => {
    hasPositioned.current = false;
    setTabLayouts({});
  }, [tabs]);

  const tabIndicatorStyle = useMemo(() => {
    if (!activeTabLayout) return null;
    return {
      width: indicatorWidth,
      transform: [{ translateX: indicatorLeft }],
    };
  }, [activeTabLayout, indicatorLeft, indicatorWidth]);

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
    >
      <View style={styles.tabs}>
        {tabIndicatorStyle ? (
          <Animated.View pointerEvents="none" style={[styles.tabIndicator, tabIndicatorStyle]} />
        ) : null}
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          return (
            <Pressable
              key={tab.id}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              style={({ pressed }) => [styles.tabButton, pressed && styles.tabPressed]}
              onLayout={(event) => recordTabLayout(tab.id, event)}
              onPress={() => onSelect(tab.id)}
            >
              <Text style={[styles.tabLabel, active && styles.tabLabelActive]} numberOfLines={1}>
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flexGrow: 0,
  },
  scrollContent: {
    flexGrow: 1,
  },
  tabs: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    overflow: "visible",
    minHeight: 35,
  },
  tabButton: {
    height: 35,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  tabPressed: {
    opacity: 0.72,
  },
  tabLabel: {
    color: floraColors.gray,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    lineHeight: 15,
  },
  tabLabelActive: {
    color: floraColors.greenLight,
  },
  tabIndicator: {
    position: "absolute",
    left: 0,
    bottom: 0,
    height: 2,
    borderRadius: 999,
    backgroundColor: floraColors.greenLight,
    zIndex: 2,
  },
});
