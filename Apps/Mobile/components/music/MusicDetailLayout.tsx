import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { floraColors, floraSpacing } from "@/lib/theme";

export function MusicDetailLayout({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string | null;
  action?: ReactNode;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + floraSpacing.grid }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Назад"
          style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
          onPress={() => router.back()}
        >
          <Ionicons name="chevron-back" size={24} color={floraColors.greenLight} />
        </Pressable>
        <View style={styles.titleBlock}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={styles.subtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {action}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: floraColors.bg,
  },
  header: {
    minHeight: 72,
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.gridFine * 2,
    paddingHorizontal: floraSpacing.grid,
    paddingBottom: floraSpacing.gridFine * 2,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(250, 250, 250, 0.08)",
    backgroundColor: floraColors.bg,
  },
  backBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: floraColors.greenDark,
  },
  titleBlock: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: floraColors.whiteTemplate,
    fontSize: 19,
    fontWeight: "300",
    letterSpacing: 0.57,
  },
  subtitle: {
    color: floraColors.gray,
    fontSize: 12,
    marginTop: 2,
  },
  pressed: {
    opacity: 0.72,
  },
});
