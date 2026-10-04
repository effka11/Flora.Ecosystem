import type { ReactNode } from "react";
import type { ColorValue } from "react-native";
import { StyleSheet, Text, View } from "react-native";
import { liveGridStyles } from "@/lib/liveGridStyles";
import { kegl, sPx } from "@/lib/floraGridRuntime";
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

const styles = liveGridStyles(() => StyleSheet.create({
  wrap: {
    width: sPx(28),
    height: sPx(28),
    alignItems: "center",
    justifyContent: "center",
    overflow: "visible",
  },
  badge: {
    position: "absolute",
    top: -sPx(3),
    right: -sPx(8),
    minWidth: sPx(14),
    height: sPx(14),
    paddingHorizontal: sPx(3),
    borderRadius: sPx(7),
    backgroundColor: floraColors.greenLight,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    color: "#10200e",
    fontSize: kegl(9),
    fontWeight: "700",
    lineHeight: kegl(11),
  },
}));
