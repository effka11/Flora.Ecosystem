import { Linking, StyleSheet, Text, View } from "react-native";
import { liveGridStyles } from "@/lib/liveGridStyles";
import { floraColors, kegl, sPx } from "@/lib/theme";

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

const styles = liveGridStyles(() => StyleSheet.create({
  root: { flex: 1, backgroundColor: floraColors.bg, padding: sPx(24), justifyContent: "center", gap: sPx(12) },
  title: { color: floraColors.text, fontSize: kegl(22), fontWeight: "700" },
  text: { color: floraColors.textMuted, lineHeight: sPx(22) },
  link: { color: floraColors.accent, marginTop: sPx(12) },
}));
