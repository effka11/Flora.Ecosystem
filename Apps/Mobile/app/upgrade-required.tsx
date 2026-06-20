import { Linking, StyleSheet, Text, View } from "react-native";
import { floraColors } from "@/lib/theme";

export default function UpgradeRequiredScreen() {
  return (
    <View style={styles.root}>
      <Text style={styles.title}>Требуется обновление</Text>
      <Text style={styles.text}>
        Ваша версия приложения больше не поддерживается. Установите последнюю версию Flora из магазина приложений.
      </Text>
      <Text style={styles.link} onPress={() => Linking.openURL("https://flora.social")}>
        Открыть flora.social
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: floraColors.bg, padding: 24, justifyContent: "center", gap: 12 },
  title: { color: floraColors.text, fontSize: 22, fontWeight: "700" },
  text: { color: floraColors.textMuted, lineHeight: 22 },
  link: { color: floraColors.accent, marginTop: 12 },
});
