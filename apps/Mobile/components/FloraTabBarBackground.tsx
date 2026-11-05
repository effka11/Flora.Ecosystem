import { useFloraTheme } from "@/lib/FloraThemeProvider";
import { StyleSheet, View } from "react-native";
import { floraColors } from "@/lib/theme";

/**
 * Фон нижнего tab bar — сплошной цвет активной темы с верхней линией,
 * как у topBlock (borderBottom на шапке).
 */
export function FloraTabBarBackground() {
  useFloraTheme();
  return (
    <View style={styles.root} pointerEvents="none">
      <View style={[styles.fill, { backgroundColor: floraColors.bg }]} />
      <View style={[styles.hairline, { backgroundColor: floraColors.hairline }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFill,
  },
  fill: {
    ...StyleSheet.absoluteFill,
  },
  hairline: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 1,
  },
});
