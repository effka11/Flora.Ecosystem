import { Ionicons } from "@expo/vector-icons";
import { useCallback, useRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { DropdownMenuOverlay } from "@/components/DropdownMenuOverlay";
import { floraColors, floraSpacing, floraTabFilter } from "@/lib/theme";

export const NOTIFICATION_CATEGORY_TABS = [
  { id: 0, label: "Все", category: "all" as const },
  { id: 1, label: "Социальные", category: "social" as const },
  { id: 2, label: "От разработчика", category: "developer" as const },
];

type Props = {
  activeTab: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (tabId: number) => void;
};

export function NotificationCategoryPicker({ activeTab, open, onOpenChange, onSelect }: Props) {
  const anchorRef = useRef<View>(null);
  const activeLabel = NOTIFICATION_CATEGORY_TABS[activeTab]?.label ?? "Все";

  const close = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const toggle = useCallback(() => {
    onOpenChange(!open);
  }, [onOpenChange, open]);

  const selectTab = useCallback(
    (tabId: number) => {
      onSelect(tabId);
      onOpenChange(false);
    },
    [onOpenChange, onSelect],
  );

  return (
    <View style={styles.wrap} collapsable={false}>
      <View style={styles.triggerTabs}>
        {open ? <View pointerEvents="none" style={styles.triggerIndicator} /> : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Фильтр уведомлений: ${activeLabel}`}
          accessibilityState={{ expanded: open }}
          style={({ pressed }) => [styles.trigger, pressed && styles.pressed]}
          onPress={toggle}
        >
          <Text style={[styles.triggerLabel, open && styles.triggerLabelOpen]}>{activeLabel}</Text>
          <Ionicons
            name="chevron-down"
            size={16}
            color={open ? floraColors.greenLight : floraColors.gray}
            style={open ? styles.chevronOpen : undefined}
          />
        </Pressable>
        <View ref={anchorRef} pointerEvents="none" style={styles.anchorMarker} collapsable={false} />
      </View>

      <DropdownMenuOverlay open={open} onClose={close} anchorRef={anchorRef} menuStyle={styles.menu}>
        {NOTIFICATION_CATEGORY_TABS.map((tab, index) => (
          <Pressable
            key={tab.id}
            accessibilityRole="menuitem"
            accessibilityState={{ selected: activeTab === tab.id }}
            style={({ pressed }) => [
              styles.menuItem,
              index === 0 && styles.menuItemFirst,
              index === NOTIFICATION_CATEGORY_TABS.length - 1 && styles.menuItemLast,
              activeTab === tab.id && styles.menuItemActive,
              pressed && styles.pressed,
            ]}
            onPress={() => selectTab(tab.id)}
          >
            <Text style={[styles.menuItemLabel, activeTab === tab.id && styles.menuItemLabelActive]}>
              {tab.label}
            </Text>
          </Pressable>
        ))}
      </DropdownMenuOverlay>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "relative",
    flexShrink: 1,
    minWidth: 0,
  },
  triggerTabs: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    overflow: "visible",
  },
  anchorMarker: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 0,
  },
  triggerIndicator: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: floraTabFilter.indicatorHeight,
    borderRadius: 999,
    backgroundColor: floraColors.greenLight,
    zIndex: 2,
  },
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: floraSpacing.gridFine,
    height: floraTabFilter.triggerHeight,
    paddingHorizontal: 30,
  },
  triggerLabel: {
    color: floraColors.gray,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    lineHeight: floraTabFilter.triggerLabelLineHeight,
  },
  triggerLabelOpen: {
    color: floraColors.greenLight,
  },
  chevronOpen: {
    transform: [{ rotate: "180deg" }],
  },
  menu: {
    minWidth: 220,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(250, 250, 250, 0.12)",
    backgroundColor: floraColors.surface,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 16,
  },
  menuItem: {
    paddingHorizontal: floraSpacing.grid,
    paddingVertical: floraSpacing.gridFine * 2,
  },
  menuItemFirst: {
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
  },
  menuItemLast: {
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 12,
  },
  menuItemActive: {
    backgroundColor: "rgba(164, 209, 138, 0.08)",
  },
  menuItemLabel: {
    color: floraColors.gray,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    lineHeight: 20,
  },
  menuItemLabelActive: {
    color: floraColors.greenLight,
  },
  pressed: {
    opacity: 0.72,
  },
});
