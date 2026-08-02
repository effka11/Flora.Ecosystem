import { Ionicons } from "@expo/vector-icons";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { floraColors, floraSpacing } from "@/lib/theme";

type Props = {
  visible: boolean;
  onClose: () => void;
};

/** Заглушка создания группы после развилки «+». */
export function CreateChatGroupComingSoonModal({ visible, onClose }: Props) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Закрыть"
        style={styles.backdrop}
        onPress={onClose}
      >
        <Pressable
          accessibilityViewIsModal
          style={styles.card}
          onPress={(event) => event.stopPropagation()}
        >
          <View style={styles.iconWrap}>
            <Ionicons name="people-outline" size={32} color={floraColors.greenLight} />
          </View>
          <Text style={styles.title}>Группы скоро</Text>
          <Text style={styles.text}>
            Создание групп появится в следующих версиях Flora.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Понятно"
            style={styles.ok}
            onPress={onClose}
          >
            <Text style={styles.okText}>Понятно</Text>
          </Pressable>
        </Pressable>
      </Pressable>
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
    maxWidth: 360,
    borderRadius: 16,
    backgroundColor: floraColors.bg,
    borderWidth: 1,
    borderColor: "rgba(250, 250, 250, 0.08)",
    paddingHorizontal: floraSpacing.grid * 2,
    paddingVertical: floraSpacing.grid * 2,
    alignItems: "center",
    gap: floraSpacing.grid,
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(164, 209, 138, 0.12)",
  },
  title: {
    color: floraColors.whiteTemplate,
    fontSize: 18,
    fontWeight: "300",
    letterSpacing: 0.54,
  },
  text: {
    color: floraColors.gray,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    lineHeight: 22,
    textAlign: "center",
  },
  ok: {
    marginTop: floraSpacing.gridFine,
    minHeight: 44,
    paddingHorizontal: floraSpacing.grid * 2,
    alignItems: "center",
    justifyContent: "center",
  },
  okText: {
    color: floraColors.greenLight,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
  },
});
