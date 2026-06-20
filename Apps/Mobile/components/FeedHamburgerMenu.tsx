import { Ionicons } from "@expo/vector-icons";
import { router, type Href } from "expo-router";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { floraColors, floraSpacing } from "@/lib/theme";

type MenuItem = {
  href: Href;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
};

const MENU_ITEMS: MenuItem[] = [
  { href: "/(tabs)/people", label: "Люди", icon: "people-outline" },
  { href: "/(tabs)/communities", label: "Сообщества", icon: "planet-outline" },
  { href: "/settings", label: "Настройки", icon: "settings-outline" },
  { href: "/(tabs)/github", label: "GitHub", icon: "logo-github" },
];

type Props = {
  visible: boolean;
  onClose: () => void;
};

export function FeedHamburgerMenu({ visible, onClose }: Props) {
  const insets = useSafeAreaInsets();

  const openItem = (href: Href) => {
    onClose();
    router.navigate(href);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          style={[styles.panel, { paddingTop: insets.top + floraSpacing.grid, paddingBottom: insets.bottom + 16 }]}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={styles.header}>
            <Text style={styles.headerTitle}>Меню</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Закрыть" onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={22} color={floraColors.gray} />
            </Pressable>
          </View>

          {MENU_ITEMS.map((item) => (
            <Pressable
              key={item.label}
              style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
              onPress={() => openItem(item.href)}
            >
              <Ionicons name={item.icon} size={20} color={floraColors.greenLight} />
              <Text style={styles.itemLabel}>{item.label}</Text>
              <Ionicons name="chevron-forward" size={18} color={floraColors.gray} />
            </Pressable>
          ))}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
    alignItems: "flex-end",
  },
  panel: {
    width: "78%",
    maxWidth: 320,
    height: "100%",
    backgroundColor: floraColors.surface,
    borderLeftColor: floraColors.border,
    borderLeftWidth: 1,
    paddingHorizontal: floraSpacing.grid,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 18,
  },
  headerTitle: {
    color: floraColors.whiteTemplate,
    fontSize: 18,
    fontWeight: "300",
    letterSpacing: 0.54,
  },
  item: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderBottomColor: floraColors.border,
    borderBottomWidth: 1,
    paddingVertical: 12,
  },
  itemPressed: {
    opacity: 0.72,
  },
  itemLabel: {
    flex: 1,
    color: floraColors.whiteTemplate,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
  },
});
