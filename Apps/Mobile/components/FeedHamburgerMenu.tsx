import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { router, usePathname, type Href } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FloraAvatar } from "@/components/FloraAvatar";
import {
  SidebarCommunitiesIcon,
  SidebarPeopleIcon,
  SidebarSettingsIcon,
} from "@/components/sidebar/SidebarNavIcons";
import { floraColors, floraMotion, floraSpacing } from "@/lib/theme";
import { useSessionStore } from "@/stores/sessionStore";

const FLORA_MARK_GLYPH = require("../assets/images/logo-mark-glyph.png");

type MenuItemId = "people" | "communities" | "settings" | "github";

type MenuItem = {
  id: MenuItemId;
  href: Href;
  label: string;
};

const MENU_ITEMS: MenuItem[] = [
  { id: "people", href: "/(tabs)/people", label: "Люди" },
  { id: "communities", href: "/(tabs)/communities", label: "Сообщества" },
  { id: "settings", href: "/settings", label: "Настройки" },
  { id: "github", href: "/(tabs)/github", label: "GitHub" },
];

/**
 * Как web dashboardShell: logoMark = 2×grid (30), navIcon = 22;
 * people 24, communities 22×0.92, settings/github 22.
 */
const MENU_ICON_SIZE: Record<MenuItemId, number> = {
  people: 24,
  communities: Math.round(22 * 0.92),
  settings: 22,
  github: 22,
};

function MenuItemIcon({ id, color }: { id: MenuItemId; color: string }) {
  const size = MENU_ICON_SIZE[id];
  switch (id) {
    case "people":
      return <SidebarPeopleIcon size={size} color={color} />;
    case "communities":
      return <SidebarCommunitiesIcon size={size} color={color} />;
    case "settings":
      return <SidebarSettingsIcon size={size} color={color} />;
    case "github":
      return <Ionicons name="logo-github" size={size} color={color} />;
  }
}

/** Как web `isDashboardRouteActive`: активный пункт сайдбара — greenLight. */
function isMenuItemActive(pathname: string, id: MenuItemId): boolean {
  switch (id) {
    case "people":
      return pathname === "/people" || pathname.startsWith("/people/");
    case "communities":
      return pathname === "/communities" || pathname.startsWith("/communities/");
    case "settings":
      return pathname === "/settings" || pathname.startsWith("/settings/");
    case "github":
      return pathname === "/github" || pathname.startsWith("/github/");
  }
}

const PANEL_MAX_WIDTH = 300;
const PANEL_WIDTH_RATIO = 0.78;
/** Как web modal dialogIn: --flora-duration-3 + --flora-ease-out. */
const OPEN_MS = floraMotion.baseMs * 3;
/** Как web modal dialogOut: --flora-duration-2 + --flora-ease-in. */
const CLOSE_MS = floraMotion.baseMs * 2;
/** --flora-ease-out: cubic-bezier(0.33, 1, 0.2, 1) */
const OPEN_EASING = Easing.bezier(0.33, 1, 0.2, 1);
/** --flora-ease-in: cubic-bezier(0.36, 0, 0.64, 1) */
const CLOSE_EASING = Easing.bezier(0.36, 0, 0.64, 1);
const MENU_EDGE_INSET = floraSpacing.grid + floraSpacing.gridFine;
const MENU_LEAD_COL = 2 * floraSpacing.grid;
/** Горизонтальный порог, чтобы не перехватывать тапы по пунктам меню. */
const SWIPE_AXIS_PX = 10;
/** Доля ширины панели / скорость (px/ms) для snap open/close. */
const SWIPE_RATIO = 0.28;
/** Gesture Handler сообщает velocity в points/sec. */
const SWIPE_CLOSE_VX = -650;
const SWIPE_OPEN_VX = 650;
/** Активная зона свайпа открытия: не только у самого края, а с запасом внутрь экрана. */
const EDGE_HIT_WIDTH = 3 * floraSpacing.grid;
/**
 * Ниже chrome шапки (paddingTop grid + row 45): иначе edgeHit поверх гамбургера/«назад»
 * и GestureDetector съедает тапы.
 */
const EDGE_HIT_TOP_CHROME = floraSpacing.grid + 45;
/** Минимальная длительность доводки после свайпа (мс). */
const SETTLE_MIN_MS = floraMotion.baseMs;
/** Максимальная длительность доводки после свайпа (мс). */
const SETTLE_MAX_MS = floraMotion.baseMs * 3;

/**
 * Доводка progress к 0|1 через withTiming: длительность от оставшейся дистанции
 * и скорости пальца. Spring + energyThreshold на диапазоне 0…1 давал мгновенный snap.
 */
function settleProgress(
  progress: { value: number },
  target: 0 | 1,
  panelWidth: number,
  velocityX: number,
  onFinished?: (finished?: boolean) => void,
) {
  "worklet";
  const distance = Math.abs(target - progress.value);
  if (distance < 0.001) {
    progress.value = target;
    if (onFinished) onFinished(true);
    return;
  }
  const remainingPx = distance * panelWidth;
  const speedPx = Math.max(180, Math.abs(velocityX));
  const fromVelocityMs = Math.round((remainingPx / speedPx) * 1000);
  const fromDistanceMs = Math.round((target === 1 ? OPEN_MS : CLOSE_MS) * distance);
  const duration = Math.max(
    SETTLE_MIN_MS,
    Math.min(SETTLE_MAX_MS, Math.max(fromVelocityMs, fromDistanceMs)),
  );
  progress.value = withTiming(
    target,
    {
      duration,
      easing: target === 1 ? OPEN_EASING : CLOSE_EASING,
    },
    onFinished,
  );
}

type Props = {
  visible: boolean;
  onOpen: () => void;
  onClose: () => void;
};

/**
 * Полноэкранный drawer без RN Modal — системный Modal даёт заметный лаг до первого кадра.
 * Монтируется у корня табов (HamburgerMenuProvider), поэтому absoluteFill кроет весь экран.
 * Закрыт: тонкая hit-зона слева открывает меню свайпом вправо.
 *
 * Анимация только на UI-потоке (Reanimated). React-state `presented` не трогаем во время
 * edge-drag — иначе setState на onStart даёт кадр лага под пальцем.
 */
export function FeedHamburgerMenu({ visible, onOpen, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const pathname = usePathname();
  const me = useSessionStore((s) => s.me);
  const panelWidth = Math.min(PANEL_MAX_WIDTH, Math.round(windowWidth * PANEL_WIDTH_RATIO));

  const [presented, setPresented] = useState(visible);
  const progress = useSharedValue(visible ? 1 : 0);
  const dragStartProgress = useSharedValue(0);
  const panelWidthSV = useSharedValue(panelWidth);
  /** visible уже обработан жестом; React-effect не запускает вторую анимацию. */
  const gestureTargetRef = useRef<0 | 1 | null>(null);
  const jsRef = useRef({ onOpen, onClose });
  jsRef.current = { onOpen, onClose };

  useEffect(() => {
    panelWidthSV.value = panelWidth;
  }, [panelWidth, panelWidthSV]);

  const markPresented = useCallback(() => {
    setPresented(true);
  }, []);

  const markDismissed = useCallback(() => {
    setPresented(false);
  }, []);

  const commitGestureOpen = useCallback(() => {
    gestureTargetRef.current = 1;
    setPresented(true);
    jsRef.current.onOpen();
  }, []);

  const commitGestureClose = useCallback(() => {
    gestureTargetRef.current = 0;
    jsRef.current.onClose();
  }, []);

  const finishClose = useCallback(() => {
    gestureTargetRef.current = 0;
    const distance = Math.abs(progress.value);
    progress.value = withTiming(
      0,
      {
        duration: Math.max(floraMotion.baseMs, Math.round(CLOSE_MS * distance)),
        easing: CLOSE_EASING,
      },
      (finished) => {
        if (finished) runOnJS(markDismissed)();
      },
    );
    jsRef.current.onClose();
  }, [markDismissed, progress]);

  const closeGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX(-SWIPE_AXIS_PX)
        .failOffsetY([-SWIPE_AXIS_PX * 2, SWIPE_AXIS_PX * 2])
        .onStart(() => {
          "worklet";
          cancelAnimation(progress);
          dragStartProgress.value = progress.value;
        })
        .onUpdate((event) => {
          "worklet";
          const width = panelWidthSV.value;
          progress.value = Math.min(
            1,
            Math.max(0, dragStartProgress.value + event.translationX / width),
          );
        })
        .onEnd((event) => {
          "worklet";
          const width = panelWidthSV.value;
          const shouldClose =
            progress.value < 1 - SWIPE_RATIO || event.velocityX < SWIPE_CLOSE_VX;
          if (shouldClose) {
            settleProgress(progress, 0, width, event.velocityX, (finished) => {
              if (finished) runOnJS(markDismissed)();
            });
            runOnJS(commitGestureClose)();
            return;
          }
          settleProgress(progress, 1, width, event.velocityX);
        }),
    [commitGestureClose, dragStartProgress, markDismissed, panelWidthSV, progress],
  );

  const edgeGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX(SWIPE_AXIS_PX)
        .failOffsetY([-SWIPE_AXIS_PX * 2, SWIPE_AXIS_PX * 2])
        .onStart(() => {
          "worklet";
          cancelAnimation(progress);
          dragStartProgress.value = progress.value;
        })
        .onUpdate((event) => {
          "worklet";
          const width = panelWidthSV.value;
          progress.value = Math.min(
            1,
            Math.max(0, dragStartProgress.value + event.translationX / width),
          );
        })
        .onEnd((event) => {
          "worklet";
          const width = panelWidthSV.value;
          const shouldOpen = progress.value > SWIPE_RATIO || event.velocityX > SWIPE_OPEN_VX;
          if (shouldOpen) {
            settleProgress(progress, 1, width, event.velocityX);
            runOnJS(commitGestureOpen)();
            return;
          }
          settleProgress(progress, 0, width, event.velocityX);
        }),
    [commitGestureOpen, dragStartProgress, panelWidthSV, progress],
  );

  useEffect(() => {
    const target = visible ? 1 : 0;
    if (gestureTargetRef.current === target) {
      gestureTargetRef.current = null;
      return;
    }

    cancelAnimation(progress);
    if (visible) {
      markPresented();
      const distance = Math.abs(1 - progress.value);
      progress.value = withTiming(1, {
        duration: Math.max(floraMotion.baseMs, Math.round(OPEN_MS * distance)),
        easing: OPEN_EASING,
      });
      return;
    }

    const distance = Math.abs(progress.value);
    progress.value = withTiming(
      0,
      {
        duration: Math.max(floraMotion.baseMs, Math.round(CLOSE_MS * distance)),
        easing: CLOSE_EASING,
      },
      (finished) => {
        if (finished) runOnJS(markDismissed)();
      },
    );
  }, [markDismissed, markPresented, progress, visible]);

  const panelAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -panelWidthSV.value * (1 - progress.value) }],
  }));

  const backdropAnimatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
  }));

  /** Hit-test без React re-render: панель/backdrop активны когда progress > 0. */
  const overlayAnimatedProps = useAnimatedProps(() => ({
    pointerEvents: progress.value > 0.001 ? ("auto" as const) : ("none" as const),
  }));

  const openItem = (href: Href) => {
    finishClose();
    router.navigate(href);
  };

  const openAccountSettings = () => {
    finishClose();
    router.push({ pathname: "/settings", params: { section: "account" } });
  };

  const displayName = me?.displayName?.trim() || me?.username || "Профиль";
  const handle = me?.username ? `@${me.username}` : "";
  const showEdgeHit = !visible && !presented;

  return (
    <View style={styles.root} pointerEvents="box-none" accessibilityViewIsModal={presented}>
      {showEdgeHit ? (
        <GestureDetector gesture={edgeGesture}>
          <Animated.View
            collapsable={false}
            style={[
              styles.edgeHit,
              {
                width: insets.left + EDGE_HIT_WIDTH,
                top: insets.top + EDGE_HIT_TOP_CHROME,
              },
            ]}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          />
        </GestureDetector>
      ) : null}

      <Animated.View
        animatedProps={overlayAnimatedProps}
        style={StyleSheet.absoluteFill}
        accessibilityElementsHidden={!presented}
        importantForAccessibility={presented ? "yes" : "no-hide-descendants"}
      >
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={finishClose}
          accessibilityRole="button"
          accessibilityLabel="Закрыть меню"
        >
          <Animated.View style={[styles.backdrop, backdropAnimatedStyle]} />
        </Pressable>
      </Animated.View>

      <GestureDetector gesture={closeGesture}>
        <Animated.View
          animatedProps={overlayAnimatedProps}
          collapsable={false}
          style={[
            styles.panel,
            {
              width: panelWidth,
              paddingTop: insets.top + floraSpacing.grid,
              paddingBottom: insets.bottom + floraSpacing.grid,
            },
            panelAnimatedStyle,
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
          </View>

          <View style={styles.navList}>
            {MENU_ITEMS.map((item) => {
              const active = isMenuItemActive(pathname, item.id);
              const itemColor = active ? floraColors.greenLight : floraColors.whiteTemplate;
              return (
                <Pressable
                  key={item.id}
                  accessibilityRole="menuitem"
                  accessibilityState={{ selected: active }}
                  style={({ pressed }) => [styles.navItem, pressed && styles.navItemPressed]}
                  onPress={() => openItem(item.href)}
                >
                  <View style={styles.navIconWrap}>
                    <MenuItemIcon id={item.id} color={itemColor} />
                  </View>
                  <Text style={[styles.navLabel, active && styles.navLabelActive]}>
                    {item.label}
                  </Text>
                </Pressable>
              );
            })}
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
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFill,
    zIndex: 1000,
  },
  edgeHit: {
    position: "absolute",
    left: 0,
    bottom: 0,
    zIndex: 1001,
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
  navLabelActive: {
    color: floraColors.greenLight,
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
});
