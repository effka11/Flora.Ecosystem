import { StyleSheet, View } from "react-native";
import { floraColors } from "@/lib/theme";

/**
 * Фон нижнего tab bar — сплошной чёрный с верхней линией,
 * как у topBlock (borderBottom на шапке).
 */
export function FloraTabBarBackground() {
  return (
    <View style={styles.root} pointerEvents="none">
      <View style={styles.fill} />
      <View style={styles.hairline} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFill,
  },
  fill: {
    ...StyleSheet.absoluteFill,
    backgroundColor: floraColors.bg,
  },
  hairline: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: "rgba(250, 250, 250, 0.08)",
  },
});
