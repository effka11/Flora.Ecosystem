import { liveGridStyles } from "@/lib/liveGridStyles";
import { Ionicons } from "@expo/vector-icons";
import { useCallback, useRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { DropdownMenuOverlay } from "@/components/DropdownMenuOverlay";
import { floraColors, floraSpacing, floraTabFilter } from "@/lib/theme";

export type TabDropdownOption = {
  id: string;
  label: string;
};

type Props = {
  accessibilityLabel: string;
  options: TabDropdownOption[];
  activeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (id: string) => void;
};

export function TabDropdownPicker({
  accessibilityLabel,
  options,
  activeId,
  open,
  onOpenChange,
  onSelect,
}: Props) {
  const anchorRef = useRef<View>(null);
  const activeLabel = options.find((option) => option.id === activeId)?.label ?? options[0]?.label ?? "";

  const close = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const toggle = useCallback(() => {
    onOpenChange(!open);
  }, [onOpenChange, open]);

  const selectOption = useCallback(
    (id: string) => {
      onSelect(id);
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
          accessibilityLabel={`${accessibilityLabel}: ${activeLabel}`}
          accessibilityState={{ expanded: open }}
          style={styles.trigger}
          onPress={toggle}
        >
          <Text style={[styles.triggerLabel, open && styles.triggerLabelOpen]}>{activeLabel}</Text>
          <Ionicons
            name="chevron-down"
            size={16}
            color={floraColors.greenLight}
            style={open ? styles.chevronOpen : undefined}
          />
        </Pressable>
        <View ref={anchorRef} pointerEvents="none" style={styles.anchorMarker} collapsable={false} />
      </View>

      <DropdownMenuOverlay open={open} onClose={close} anchorRef={anchorRef} menuStyle={styles.menu}>
        {options.map((option) => (
          <Pressable
            key={option.id}
            accessibilityRole="menuitem"
            accessibilityState={{ selected: activeId === option.id }}
            style={({ pressed }) => [
              styles.menuItem,
              activeId === option.id && styles.menuItemActive,
              pressed && styles.menuItemPressed,
            ]}
            onPress={() => selectOption(option.id)}
          >
            <Text style={[styles.menuItemLabel, activeId === option.id && styles.menuItemLabelActive]}>
              {option.label}
            </Text>
          </Pressable>
        ))}
      </DropdownMenuOverlay>
    </View>
  );
}

const styles = liveGridStyles(() => StyleSheet.create({
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
    minWidth: 200,
    maxWidth: 280,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(250, 250, 250, 0.06)",
    backgroundColor: floraColors.bg,
    padding: floraSpacing.gridFine * 1.5,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 24,
    elevation: 12,
  },
  menuItem: {
    width: "100%",
    paddingHorizontal: floraSpacing.gridFine * 2,
    paddingVertical: floraSpacing.gridFine * 1.5,
    borderRadius: 8,
  },
  menuItemActive: {
    backgroundColor: "rgba(250, 250, 250, 0.06)",
  },
  menuItemPressed: {
    backgroundColor: "rgba(250, 250, 250, 0.06)",
  },
  menuItemLabel: {
    color: floraColors.gray,
    fontSize: 14,
    fontWeight: "400",
    letterSpacing: 0.42,
  },
  menuItemLabelActive: {
    color: floraColors.greenLight,
  },
}));
