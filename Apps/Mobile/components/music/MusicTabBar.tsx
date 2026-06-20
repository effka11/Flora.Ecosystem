import { Pressable, StyleSheet, Text, View } from "react-native";
import { floraColors, floraSpacing } from "@/lib/theme";

export type MusicBrowseTab = "recommendations" | "myMusic";
export type MusicUploadTab = "forSelf" | "forPlatform";

type TabItem<T extends string> = {
  id: T;
  label: string;
};

type Props<T extends string> = {
  tabs: readonly TabItem<T>[];
  active: T;
  onSelect: (tab: T) => void;
  compact?: boolean;
};

export const MUSIC_UPLOAD_TABS: readonly TabItem<MusicUploadTab>[] = [
  { id: "forSelf", label: "Для себя" },
  { id: "forPlatform", label: "На площадку" },
];

export function MusicTabBar<T extends string>({ tabs, active, onSelect, compact = false }: Props<T>) {
  return (
    <View style={styles.tabs}>
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            style={({ pressed }) => [
              styles.tabButton,
              compact && styles.tabButtonCompact,
              selected && styles.tabButtonActive,
              pressed && styles.pressed,
            ]}
            onPress={() => onSelect(tab.id)}
          >
            <Text style={[styles.tabLabel, selected && styles.tabLabelActive]}>{tab.label}</Text>
            {selected ? <View style={styles.indicator} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  tabs: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
  },
  tabButton: {
    height: 35,
    minWidth: 92,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: floraSpacing.grid,
    position: "relative",
  },
  tabButtonCompact: {
    minWidth: 0,
    paddingHorizontal: floraSpacing.grid,
  },
  tabButtonActive: {
    backgroundColor: "rgba(164, 209, 138, 0.05)",
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
  indicator: {
    position: "absolute",
    left: floraSpacing.grid,
    right: floraSpacing.grid,
    bottom: 0,
    height: 2,
    borderRadius: 999,
    backgroundColor: floraColors.greenLight,
  },
  pressed: {
    opacity: 0.72,
  },
});
