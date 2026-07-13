import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useHamburgerMenu } from "@/components/HamburgerMenuProvider";
import { floraColors, floraSpacing } from "@/lib/theme";

type TabScreenSearchHeaderProps = {
  title: string;
  /** Optional pill next to the title (e.g. build marker). */
  titleBadge?: string;
  placeholder: string;
  value: string;
  onChangeText: (value: string) => void;
  /** Перед открытием меню (закрыть дропдауны фильтров и т.п.). */
  onBeforeMenuOpen?: () => void;
  /** Кнопка создания справа (правее поиска). */
  createAction?: {
    accessibilityLabel: string;
    onPress: () => void;
  };
};

export function TabScreenSearchHeader({
  title,
  titleBadge,
  placeholder,
  value,
  onChangeText,
  onBeforeMenuOpen,
  createAction,
}: TabScreenSearchHeaderProps) {
  const { openMenu } = useHamburgerMenu();
  const [searchOpen, setSearchOpen] = useState(value.length > 0);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (value.length > 0) {
      setSearchOpen(true);
    }
  }, [value]);

  useEffect(() => {
    if (searchOpen) {
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [searchOpen]);

  const closeSearch = () => {
    onChangeText("");
    setSearchOpen(false);
  };

  const handleMenuPressIn = () => {
    onBeforeMenuOpen?.();
    openMenu();
  };

  return (
    <View style={styles.chromeRow}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Меню"
        style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
        onPressIn={handleMenuPressIn}
      >
        <Ionicons name="menu-outline" size={24} color={floraColors.gray} />
      </Pressable>

      {searchOpen ? (
        <View style={styles.searchBox}>
          <Ionicons name="search-outline" size={20} color={floraColors.gray} />
          <TextInput
            ref={inputRef}
            style={styles.searchInput}
            placeholder={placeholder}
            placeholderTextColor={floraColors.gray}
            value={value}
            onChangeText={onChangeText}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
          />
          <Pressable
            style={styles.searchClear}
            onPress={closeSearch}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Закрыть поиск"
          >
            <Ionicons name="close" size={18} color={floraColors.greenLight} />
          </Pressable>
        </View>
      ) : (
        <>
          <View style={styles.titleRow}>
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
            {titleBadge ? (
              <View style={styles.titleBadge} accessibilityRole="text">
                <Text style={styles.titleBadgeText} numberOfLines={1}>
                  {titleBadge}
                </Text>
              </View>
            ) : null}
          </View>
          <View style={styles.spacer} />
        </>
      )}

      <View style={styles.trailingActions}>
        {!searchOpen ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Поиск"
            style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
            onPress={() => setSearchOpen(true)}
          >
            <Ionicons name="search-outline" size={22} color={floraColors.gray} />
          </Pressable>
        ) : null}
        {createAction ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={createAction.accessibilityLabel}
            style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
            onPress={createAction.onPress}
          >
            <Ionicons name="add" size={24} color={floraColors.greenLight} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  chromeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 0,
    minHeight: 45,
  },
  title: {
    flexShrink: 1,
    marginLeft: floraSpacing.grid,
    color: floraColors.whiteTemplate,
    fontSize: 22,
    fontWeight: "300",
    letterSpacing: 0.88,
    lineHeight: 28,
  },
  titleRow: {
    flexShrink: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.gridFine,
  },
  titleBadge: {
    marginLeft: 0,
    paddingHorizontal: floraSpacing.gridFine * 2,
    paddingVertical: 3,
    borderRadius: 9999,
    backgroundColor: "#e8b84a",
  },
  titleBadgeText: {
    color: "#1a1408",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  spacer: {
    flex: 1,
    minWidth: 0,
  },
  trailingActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginLeft: floraSpacing.gridFine,
  },
  iconButton: {
    width: 45,
    minHeight: 45,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  searchBox: {
    flex: 1,
    minWidth: 0,
    minHeight: 45,
    marginLeft: floraSpacing.gridFine * 2,
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
  pressed: {
    opacity: 0.72,
  },
});
