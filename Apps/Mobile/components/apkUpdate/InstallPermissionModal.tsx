import { Ionicons } from "@expo/vector-icons";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { floraColors, floraSpacing } from "@/lib/theme";

type Props = {
  visible: boolean;
  busy?: boolean;
  onDismiss: () => void;
  onDecline: () => void;
  onAllow: () => void;
};

export function InstallPermissionModal({
  visible,
  busy = false,
  onDismiss,
  onDecline,
  onAllow,
}: Props) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={busy ? undefined : onDismiss}
    >
      <View style={styles.backdrop}>
        <View style={styles.card} accessibilityViewIsModal>
          <View style={styles.iconWrap}>
            <Ionicons name="shield-checkmark-outline" size={28} color={floraColors.greenLight} />
          </View>

          <Text style={styles.title}>Обновления приложения</Text>
          <Text style={styles.body}>
            Разрешите установку из этого источника, чтобы Flora могла обновляться без Google Play.
          </Text>

          <Pressable
            style={({ pressed }) => [
              styles.primaryBtn,
              (pressed || busy) && styles.btnPressed,
              busy && styles.btnDisabled,
            ]}
            onPress={onAllow}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Разрешить"
          >
            <Text style={styles.primaryBtnText}>{busy ? "Открываем настройки…" : "Разрешить"}</Text>
          </Pressable>

          <Pressable
            style={({ pressed }) => [styles.secondaryBtn, pressed && !busy && styles.btnPressed]}
            onPress={onDecline}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Нет, спасибо"
          >
            <Text style={styles.secondaryBtnText}>Нет, спасибо</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.55)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: floraSpacing.grid * 2,
  },
  card: {
    width: "100%",
    maxWidth: 320,
    borderRadius: floraSpacing.grid,
    backgroundColor: floraColors.surfaceElevated,
    borderWidth: 1,
    borderColor: floraColors.border,
    paddingHorizontal: floraSpacing.grid * 2,
    paddingTop: floraSpacing.grid * 2,
    paddingBottom: floraSpacing.grid * 2 - floraSpacing.gridFine,
    alignItems: "center",
    gap: floraSpacing.grid,
  },
  iconWrap: {
    width: floraSpacing.grid * 3,
    height: floraSpacing.grid * 3,
    borderRadius: (floraSpacing.grid * 3) / 2,
    backgroundColor: "rgba(164, 209, 138, 0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    color: floraColors.whiteTemplate,
    fontSize: 17,
    fontWeight: "500",
    letterSpacing: 0.34,
    textAlign: "center",
    lineHeight: 22,
  },
  body: {
    color: floraColors.gray,
    fontSize: 14,
    fontWeight: "300",
    letterSpacing: 0.42,
    textAlign: "center",
    lineHeight: 20,
  },
  primaryBtn: {
    marginTop: floraSpacing.gridFine,
    width: "100%",
    paddingVertical: floraSpacing.gridFine * 2 + 2,
    borderRadius: 9999,
    backgroundColor: floraColors.greenLight,
    alignItems: "center",
  },
  primaryBtnText: {
    color: floraColors.bg,
    fontSize: 14,
    fontWeight: "400",
    letterSpacing: 0.42,
  },
  secondaryBtn: {
    width: "100%",
    paddingVertical: floraSpacing.gridFine * 2,
    borderRadius: 9999,
    alignItems: "center",
  },
  secondaryBtnText: {
    color: floraColors.gray,
    fontSize: 14,
    fontWeight: "300",
    letterSpacing: 0.42,
  },
  btnPressed: {
    opacity: 0.85,
  },
  btnDisabled: {
    opacity: 0.7,
  },
});
