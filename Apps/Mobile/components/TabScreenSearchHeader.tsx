import { Ionicons } from "@expo/vector-icons";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { FeedHamburgerMenu } from "@/components/FeedHamburgerMenu";
import { floraColors } from "@/lib/theme";

type TabScreenSearchHeaderProps = {
  placeholder: string;
  value: string;
  onChangeText: (value: string) => void;
  menuOpen: boolean;
  onMenuOpen: () => void;
  onMenuClose: () => void;
  prefix?: ReactNode;
};

export function TabScreenSearchHeader({
  placeholder,
  value,
  onChangeText,
  menuOpen,
  onMenuOpen,
  onMenuClose,
  prefix,
}: TabScreenSearchHeaderProps) {
  return (
    <>
      <View style={styles.searchRow}>
        {prefix}
        <View style={styles.searchBox}>
          <Ionicons name="search-outline" size={20} color={floraColors.gray} />
          <TextInput
            style={styles.searchInput}
            placeholder={placeholder}
            placeholderTextColor={floraColors.gray}
            value={value}
            onChangeText={onChangeText}
          />
          {value.length > 0 ? (
            <Pressable style={styles.searchClear} onPress={() => onChangeText("")} hitSlop={10}>
              <Ionicons name="close" size={18} color={floraColors.greenLight} />
            </Pressable>
          ) : null}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Меню"
          style={({ pressed }) => [styles.menuButton, pressed && styles.pressed]}
          onPress={onMenuOpen}
        >
          <Ionicons name="menu-outline" size={24} color={floraColors.gray} />
        </Pressable>
      </View>
      <FeedHamburgerMenu visible={menuOpen} onClose={onMenuClose} />
    </>
  );
}

const styles = StyleSheet.create({
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  searchBox: {
    flex: 1,
    minHeight: 45,
    borderColor: floraColors.greenDark,
    borderWidth: 1,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    backgroundColor: "transparent",
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    color: floraColors.whiteTemplate,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    paddingVertical: 0,
  },
  searchClear: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(164, 209, 138, 0.12)",
  },
  menuButton: {
    width: 45,
    minHeight: 45,
    borderColor: floraColors.greenDark,
    borderWidth: 1,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  pressed: {
    opacity: 0.72,
  },
});
