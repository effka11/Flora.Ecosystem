import type { ReactNode } from "react";
import type { ColorValue } from "react-native";
import { StyleSheet, Text, View } from "react-native";
import { floraColors } from "@/lib/theme";

type Props = {
  color: ColorValue;
  size: number;
  badge?: number;
  children: ReactNode;
};

function formatBadge(count: number): string {
  if (count > 99) return "99+";
  return String(count);
}

export function TabBarIconWithBadge({ badge = 0, children }: Props) {
  const showBadge = badge > 0;

  return (
    <View style={styles.wrap}>
      {children}
      {showBadge ? (
        <View style={styles.badge} accessibilityLabel={`Непрочитанных: ${badge > 99 ? 99 : badge}`}>
          <Text style={styles.badgeText}>{formatBadge(badge)}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    overflow: "visible",
  },
  badge: {
    position: "absolute",
    top: -3,
    right: -8,
    minWidth: 14,
    height: 14,
    paddingHorizontal: 3,
    borderRadius: 7,
    backgroundColor: floraColors.greenLight,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    color: "#10200e",
    fontSize: 9,
    fontWeight: "700",
    lineHeight: 11,
  },
});
