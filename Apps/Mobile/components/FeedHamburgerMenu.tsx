import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { router, type Href } from "expo-router";
import { useLayoutEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FloraAvatar } from "@/components/FloraAvatar";
import { floraColors, floraMotion, floraSpacing } from "@/lib/theme";
import { useSessionStore } from "@/stores/sessionStore";

const FLORA_MARK_GLYPH = require("../assets/images/logo-mark-glyph.png");

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

const PANEL_MAX_WIDTH = 300;
const PANEL_WIDTH_RATIO = 0.78;
/** Как web modal dialogIn: --flora-duration-3 + --flora-ease-out. */
const OPEN_MS = floraMotion.baseMs * 3;
/** Как web modal dialogOut: --flora-duration-2 + --flora-ease-in. */
const CLOSE_MS = floraMotion.baseMs * 2;
/** Backdrop: --flora-duration-2 (чуть короче панели на open — мягче слои). */
const BACKDROP_OPEN_MS = floraMotion.baseMs * 2;
const BACKDROP_CLOSE_MS = floraMotion.baseMs * 2;
/** --flora-ease-out: cubic-bezier(0.33, 1, 0.2, 1) */
const OPEN_EASING = Easing.bezier(0.33, 1, 0.2, 1);
/** --flora-ease-in: cubic-bezier(0.36, 0, 0.64, 1) */
const CLOSE_EASING = Easing.bezier(0.36, 0, 0.64, 1);
const MENU_EDGE_INSET = floraSpacing.grid + floraSpacing.gridFine;
const MENU_LEAD_COL = 2 * floraSpacing.grid;

type Props = {
  visible: boolean;
  onClose: () => void;
};

/**
 * Полноэкранный drawer без RN Modal — системный Modal даёт заметный лаг до первого кадра.
 * Монтируется у корня табов (HamburgerMenuProvider), поэтому absoluteFill кроет весь экран.
 */
export function FeedHamburgerMenu({ visible, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const me = useSessionStore((s) => s.me);
  const panelWidth = Math.min(PANEL_MAX_WIDTH, Math.round(windowWidth * PANEL_WIDTH_RATIO));

  const [presented, setPresented] = useState(visible);
  if (visible && !presented) {
    setPresented(true);
  }

  const translateX = useRef(new Animated.Value(-panelWidth)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;
  const panelWidthRef = useRef(panelWidth);
  const presentedRef = useRef(presented);
  const animRef = useRef<Animated.CompositeAnimation | null>(null);
  panelWidthRef.current = panelWidth;
  presentedRef.current = presented;

  useLayoutEffect(() => {
    animRef.current?.stop();

    if (visible) {
      translateX.setValue(-panelWidthRef.current);
      backdropOpacity.setValue(0);
      const anim = Animated.parallel([
        Animated.timing(translateX, {
          toValue: 0,
          duration: OPEN_MS,
          easing: OPEN_EASING,
          useNativeDriver: true,
        }),
        Animated.timing(backdropOpacity, {
          toValue: 1,
          duration: BACKDROP_OPEN_MS,
          easing: OPEN_EASING,
          useNativeDriver: true,
        }),
      ]);
      animRef.current = anim;
      anim.start();
      return;
    }

    if (!presentedRef.current) return;

    const anim = Animated.parallel([
      Animated.timing(translateX, {
        toValue: -panelWidthRef.current,
        duration: CLOSE_MS,
        easing: CLOSE_EASING,
        useNativeDriver: true,
      }),
      Animated.timing(backdropOpacity, {
        toValue: 0,
        duration: BACKDROP_CLOSE_MS,
        easing: CLOSE_EASING,
        useNativeDriver: true,
      }),
    ]);
    animRef.current = anim;
    anim.start(({ finished }) => {
      if (finished) setPresented(false);
    });
  }, [visible, translateX, backdropOpacity]);

  const openItem = (href: Href) => {
    onClose();
    router.navigate(href);
  };

  const openAccountSettings = () => {
    onClose();
    router.push({ pathname: "/settings", params: { section: "account" } });
  };

  const displayName = me?.displayName?.trim() || me?.username || "Профиль";
  const handle = me?.username ? `@${me.username}` : "";

  if (!presented) return null;

  return (
    <View style={styles.root} pointerEvents="box-none" accessibilityViewIsModal>
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Закрыть меню"
      >
        <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]} />
      </Pressable>

      <Animated.View
        style={[
          styles.panel,
          {
            width: panelWidth,
            paddingTop: insets.top + floraSpacing.grid,
            paddingBottom: insets.bottom + floraSpacing.grid,
            transform: [{ translateX }],
          },
        ]}
      >
        <View style={styles.header}>
          <View style={styles.logoRow}>
            <View style={styles.logoMark} accessibilityElementsHidden>
              <Image
                source={FLORA_MARK_GLYPH}
                style={styles.logoMarkGlyph}
                contentFit="contain"
                accessibilityIgnoresInvertColors
              />
            </View>
            <Text style={styles.logoText}>FLORA</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Закрыть"
            onPress={onClose}
            hitSlop={10}
            style={({ pressed }) => [styles.closeBtn, pressed && styles.pressed]}
          >
            <Ionicons name="close-outline" size={24} color={floraColors.gray} />
          </Pressable>
        </View>

        <View style={styles.navList}>
          {MENU_ITEMS.map((item) => (
            <Pressable
              key={item.label}
              accessibilityRole="menuitem"
              style={({ pressed }) => [styles.navItem, pressed && styles.navItemPressed]}
              onPress={() => openItem(item.href)}
            >
              <View style={styles.navIconWrap}>
                <Ionicons name={item.icon} size={20} color={floraColors.whiteTemplate} />
              </View>
              <Text style={styles.navLabel}>{item.label}</Text>
            </Pressable>
          ))}
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={me ? `Настройки аккаунта: ${displayName}` : "Настройки аккаунта"}
          style={({ pressed }) => [styles.userCard, pressed && styles.navItemPressed]}
          onPress={openAccountSettings}
        >
          <FloraAvatar
            size={3 * floraSpacing.grid}
            avatarUuid={me?.avatarUuid}
            displayName={displayName}
            username={me?.username ?? ""}
            seed={me?.userUuid}
          />
          <View style={styles.userMeta}>
            <Text style={styles.userDisplayName} numberOfLines={1}>
              {displayName}
            </Text>
            {handle ? (
              <Text style={styles.userHandle} numberOfLines={1}>
                {handle}
              </Text>
            ) : null}
          </View>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFill,
    zIndex: 1000,
    elevation: 1000,
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(6, 10, 12, 0.55)",
  },
  panel: {
    height: "100%",
    backgroundColor: floraColors.bg,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: "rgba(250, 250, 250, 0.06)",
    paddingLeft: MENU_EDGE_INSET,
    paddingRight: MENU_EDGE_INSET,
    justifyContent: "flex-start",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 45,
    marginBottom: floraSpacing.grid * 3,
  },
  logoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.grid,
  },
  logoMark: {
    width: MENU_LEAD_COL,
    height: MENU_LEAD_COL,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(164, 209, 138, 0.2)",
  },
  logoMarkGlyph: {
    width: floraSpacing.grid,
    height: floraSpacing.grid,
    transform: [{ rotate: "7deg" }],
  },
  logoText: {
    color: floraColors.greenLight,
    fontSize: 17,
    fontWeight: "300",
    letterSpacing: 4,
  },
  closeBtn: {
    width: 45,
    height: 45,
    marginRight: -((45 - 24) / 2),
    alignItems: "center",
    justifyContent: "center",
  },
  navList: {
    flex: 1,
    gap: floraSpacing.grid * 2,
    paddingTop: floraSpacing.grid,
  },
  navItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.grid,
    minHeight: 45,
    paddingRight: floraSpacing.grid,
    borderRadius: 12,
  },
  navItemPressed: {
    backgroundColor: "rgba(250, 250, 250, 0.06)",
  },
  navIconWrap: {
    width: MENU_LEAD_COL,
    height: MENU_LEAD_COL,
    alignItems: "center",
    justifyContent: "center",
  },
  navLabel: {
    color: floraColors.whiteTemplate,
    fontSize: 16,
    fontWeight: "300",
    letterSpacing: 0.48,
  },
  userCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.grid,
    paddingVertical: floraSpacing.grid - 6,
    borderRadius: 12,
    marginTop: floraSpacing.grid,
  },
  userMeta: {
    flex: 1,
    minWidth: 0,
    justifyContent: "center",
    gap: floraSpacing.gridFine,
  },
  userDisplayName: {
    color: floraColors.whiteTemplate,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
  },
  userHandle: {
    color: floraColors.gray,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
  },
  pressed: {
    opacity: 0.72,
  },
});
