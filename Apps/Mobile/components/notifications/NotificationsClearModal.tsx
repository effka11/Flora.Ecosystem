import { liveGridStyles } from "@/lib/liveGridStyles";
import { Ionicons } from "@expo/vector-icons";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { floraColors, floraSpacing } from "@/lib/theme";

type Props = {
  visible: boolean;
  busy?: boolean;
  error?: string | null;
  onDismiss: () => void;
  onConfirm: () => void;
};

/** Стирание всех уведомлений — визуально как SettingsConfirmModal (danger). */
export function NotificationsClearModal({
  visible,
  busy = false,
  error = null,
  onDismiss,
  onConfirm,
}: Props) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={busy ? undefined : onDismiss}
    >
      <View style={styles.backdrop}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={busy ? undefined : onDismiss}
          accessibilityRole="button"
          accessibilityLabel="Закрыть"
        />
        <View style={styles.card} accessibilityViewIsModal>
          <View style={styles.iconWrap}>
            {busy ? (
              <ActivityIndicator color="#f6a8a8" />
            ) : (
              <Ionicons name="trash-outline" size={28} color="#f6a8a8" />
            )}
          </View>

          <Text style={styles.title}>Стереть уведомления</Text>
          <Text style={styles.body}>Удалить все уведомления? Это действие нельзя отменить.</Text>
          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable
            style={({ pressed }) => [
              styles.confirmBtn,
              (pressed || busy) && styles.btnPressed,
              busy && styles.btnDisabled,
            ]}
            onPress={onConfirm}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Удалить все"
          >
            <Text style={styles.confirmBtnText}>{busy ? "Удаление…" : "Удалить все"}</Text>
          </Pressable>

          <Pressable
            style={({ pressed }) => [styles.secondaryBtn, pressed && !busy && styles.btnPressed]}
            onPress={onDismiss}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Отмена"
          >
            <Text style={styles.secondaryBtnText}>Отмена</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = liveGridStyles(() => StyleSheet.create({
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
    backgroundColor: "rgba(246, 168, 168, 0.15)",
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
  error: {
    color: "#f6a8a8",
    fontSize: 12,
    fontWeight: "300",
    textAlign: "center",
    lineHeight: 17,
  },
  confirmBtn: {
    marginTop: floraSpacing.gridFine,
    width: "100%",
    paddingVertical: floraSpacing.gridFine * 2 + 2,
    borderRadius: 9999,
    backgroundColor: "rgba(246, 168, 168, 0.18)",
    alignItems: "center",
  },
  confirmBtnText: {
    color: "#f6a8a8",
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
}));
