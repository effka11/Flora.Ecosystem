import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { floraColors, floraSpacing } from "@/lib/theme";

const GITHUB_REPO_URL = "https://github.com/effka11/Flora.Ecosystem";

const DESCRIPTION =
  "Следите за обновлениями, сообщайте о проблемах и участвуйте в разработке некоммерческой экосистемы FLORA на нашем GitHub!";

export default function GitHubScreen() {
  const insets = useSafeAreaInsets();

  const openRepo = () => {
    void Linking.openURL(GITHUB_REPO_URL);
  };

  return (
    <View style={styles.root}>
      <View style={[styles.topBlock, { paddingTop: insets.top + floraSpacing.grid }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Назад к ленте"
          style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
          onPress={() => router.navigate("/(tabs)/feed")}
        >
          <Ionicons name="arrow-back" size={22} color={floraColors.gray} />
        </Pressable>
        <View style={styles.titleRow}>
          <Ionicons name="logo-github" size={28} color={floraColors.greenLight} />
          <Text style={styles.title}>GitHub</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.description}>{DESCRIPTION}</Text>

        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Открыть репозиторий Flora.Ecosystem на GitHub"
          style={({ pressed }) => [styles.linkCard, pressed && styles.pressed]}
          onPress={openRepo}
        >
          <Text style={styles.linkLabel}>effka11/Flora.Ecosystem</Text>
          <Ionicons name="open-outline" size={20} color={floraColors.greenLight} />
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Открыть на GitHub"
          style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
          onPress={openRepo}
        >
          <Ionicons name="logo-github" size={20} color={floraColors.bg} />
          <Text style={styles.primaryBtnLabel}>Открыть на GitHub</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: floraColors.bg,
  },
  topBlock: {
    paddingHorizontal: floraSpacing.grid,
    paddingBottom: floraSpacing.grid,
    gap: floraSpacing.grid,
    borderBottomColor: "rgba(250, 250, 250, 0.08)",
    borderBottomWidth: 1,
  },
  backBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: -8,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.grid,
  },
  title: {
    color: floraColors.whiteTemplate,
    fontSize: 22,
    fontWeight: "300",
    letterSpacing: 0.66,
  },
  content: {
    padding: floraSpacing.grid,
    gap: floraSpacing.grid * 2,
  },
  description: {
    color: floraColors.gray,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    lineHeight: 22,
  },
  linkCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: floraSpacing.grid,
    borderColor: floraColors.greenDark,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: floraSpacing.grid,
    paddingVertical: floraSpacing.grid * 2 - 2,
    backgroundColor: "rgba(164, 209, 138, 0.06)",
  },
  linkLabel: {
    flex: 1,
    color: floraColors.greenLight,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
  },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: floraSpacing.gridFine * 2,
    minHeight: 45,
    borderRadius: 12,
    backgroundColor: floraColors.greenLight,
    paddingHorizontal: floraSpacing.grid * 2,
  },
  primaryBtnLabel: {
    color: floraColors.bg,
    fontSize: 15,
    fontWeight: "400",
    letterSpacing: 0.45,
  },
  pressed: {
    opacity: 0.72,
  },
});
