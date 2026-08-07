import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { router, usePathname, type Href } from "expo-router";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import {
  Gesture,
  GestureDetector,
  Pressable,
} from "react-native-gesture-handler";
import {
  ensureVerticalFlingAlive,
  setDrawerOverlayPresented,
} from "flora-scroll-fling";
import Animated, {
  cancelAnimation,
  runOnJS,
  runOnUI,
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
import {
  clearFrcImageQueuePauseOwner,
  setFrcImageQueuePaused,
} from "@/lib/frcImage";
import {
  classifyDrawerEdgeIntent,
  DRAWER_EDGE_FAIL_OFFSET_Y,
  DRAWER_EDGE_HIT_WIDTH,
  shouldClaimDrawerEdgeTouch,
  shouldOpenDrawer,
} from "@/lib/drawerEdgeGesture";
import {
  ENERGETIC_CLOSE_EASING,
  ENERGETIC_CLOSE_MS,
  ENERGETIC_OPEN_EASING,
  ENERGETIC_OPEN_MS,
  settleEnergetic,
} from "@/lib/energeticSettle";
import {
  SCROLL_PHASE_COAST,
  SCROLL_PHASE_DRAG,
  useDrawerMomentumController,
} from "@/lib/drawerMomentum";
import { eligibleVerticalFling } from "@/lib/drawerFlingPolicy";
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
  { id: "settings", href: "/(tabs)/settings", label: "Настройки" },
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
const OPEN_MS = ENERGETIC_OPEN_MS;
const CLOSE_MS = ENERGETIC_CLOSE_MS;
const OPEN_EASING = ENERGETIC_OPEN_EASING;
const CLOSE_EASING = ENERGETIC_CLOSE_EASING;
const MENU_EDGE_INSET = floraSpacing.grid + floraSpacing.gridFine;
const MENU_LEAD_COL = 2 * floraSpacing.grid;
/** Горизонтальный порог, чтобы не перехватывать тапы по пунктам меню. */
const SWIPE_AXIS_PX = 10;
/** Быстрый vertical fail edge-pan: ScrollView не ждёт PENDING при waitFor. */
const EDGE_AXIS_PX = DRAWER_EDGE_FAIL_OFFSET_Y;
const EDGE_FAIL_OFFSET_Y = DRAWER_EDGE_FAIL_OFFSET_Y;
/** Порог закрытия от полностью открытой панели. */
const SWIPE_CLOSE_RATIO = 0.28;
/** Мягкий порог открытия: медленный осознанный drag тоже коммитится. */
const SWIPE_OPEN_RATIO = 0.12;
const SWIPE_OPEN_MIN_PX = 2 * floraSpacing.grid;
/** Gesture Handler сообщает velocity в points/sec. */
const SWIPE_CLOSE_VX = -650;
const SWIPE_OPEN_VX = 220;
/**
 * Зона edge-swipe (60px на всю высоту, без вырезов).
 * Pan на обёртке контента (не absolute overlay): тапы остаются детям,
 * свайп забирается через manualActivation после горизонтального сдвига.
 */
const EDGE_HIT_WIDTH = DRAWER_EDGE_HIT_WIDTH;
/** Высота chromeRow / iconButton — floor для исключения гамбургера из edge claim. */
const EDGE_CHROME_ROW_PX = 45;
/**
 * Доводка progress к 0|1 — та же energetic-политика, что у свайпа подвкладок ленты.
 */
function settleProgress(
  progress: { value: number },
  target: 0 | 1,
  panelWidth: number,
  velocityX: number,
  onFinished?: (finished?: boolean) => void,
) {
  "worklet";
  settleEnergetic(
    progress,
    target,
    1,
    panelWidth,
    velocityX,
    target === 1 ? OPEN_MS : CLOSE_MS,
    target === 1 ? OPEN_EASING : CLOSE_EASING,
    onFinished,
  );
}

/** Стабильный слот: open-state меню не ререндерит tabs children. */
const MenuContentSlot = memo(function MenuContentSlot({ children }: { children: ReactNode }) {
  return <>{children}</>;
});

type Props = {
  visible: boolean;
  onOpen: () => void;
  onClose: () => void;
  children: ReactNode;
};

/**
 * Drawer без RN Modal — системный Modal даёт заметный лаг до первого кадра.
 * Контент табов — children ( Pan edge-swipe через manualActivation по X ).
 * Оверлей панели/backdrop — sibling поверх, pointerEvents только когда открыт.
 *
 * Анимация только на UI-потоке (Reanimated). React-state `presented` не трогаем во время
 * edge-drag — иначе setState на onStart даёт кадр лага под пальцем.
 */
export function FeedHamburgerMenu({ visible, onOpen, onClose, children }: Props) {
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const pathname = usePathname();
  const momentumController = useDrawerMomentumController();
  const edgePanRef = momentumController.edgePanRef;
  const edgeChromeBottomY = momentumController.edgeChromeBottomY;
  const activeMomentumPane = momentumController.activePane;
  const pane0Momentum = momentumController.panes[0];
  const pane1Momentum = momentumController.panes[1];
  const me = useSessionStore((s) => s.me);
  const panelWidth = Math.min(PANEL_MAX_WIDTH, Math.round(windowWidth * PANEL_WIDTH_RATIO));

  const [presented, setPresented] = useState(visible);
  const progress = useSharedValue(visible ? 1 : 0);
  const dragStartProgress = useSharedValue(0);
  const panelWidthSV = useSharedValue(panelWidth);
  const edgeMaxX = useSharedValue(insets.left + EDGE_HIT_WIDTH);
  const edgeEnabled = useSharedValue(visible ? 0 : 1);
  /** Старт касания — translationX до activate() часто 0, считаем delta сами. */
  const touchStartX = useSharedValue(0);
  const touchStartY = useSharedValue(0);
  /** Касание в edge-зоне реально заклеймлено этим жестом (не fail на down). */
  const edgeClaimed = useSharedValue(0);
  /** Жест ушёл в вертикаль → лента отдана нативному скроллу (handover). */
  const edgeVerticalHandover = useSharedValue(0);
  /** visible уже обработан жестом; React-effect не запускает вторую анимацию. */
  const gestureTargetRef = useRef<0 | 1 | null>(null);
  const mediaPauseOwner = useRef(Symbol("drawer")).current;
  const jsRef = useRef({ onOpen, onClose });
  jsRef.current = { onOpen, onClose };

  useEffect(() => {
    panelWidthSV.value = panelWidth;
  }, [panelWidth, panelWidthSV]);

  useEffect(() => {
    edgeMaxX.value = insets.left + EDGE_HIT_WIDTH;
  }, [edgeMaxX, insets.left]);

  useEffect(() => {
    const floor = insets.top + floraSpacing.grid + EDGE_CHROME_ROW_PX;
    if (edgeChromeBottomY.value < floor) {
      edgeChromeBottomY.value = floor;
    }
  }, [edgeChromeBottomY, insets.top]);

  useEffect(() => {
    edgeEnabled.value = !visible && !presented ? 1 : 0;
  }, [edgeEnabled, presented, visible]);

  useEffect(() => {
    setDrawerOverlayPresented(presented);
  }, [presented]);

  useEffect(
    () => () => {
      setDrawerOverlayPresented(false);
    },
    [],
  );

  useEffect(() => {
    setFrcImageQueuePaused(mediaPauseOwner, "drawer", presented);
    return () => clearFrcImageQueuePauseOwner(mediaPauseOwner);
  }, [mediaPauseOwner, presented]);

  const beginDrawerMediaPause = useCallback(() => {
    setFrcImageQueuePaused(mediaPauseOwner, "drawer", true);
  }, [mediaPauseOwner]);

  const endDrawerMediaPause = useCallback(() => {
    setFrcImageQueuePaused(mediaPauseOwner, "drawer", false);
  }, [mediaPauseOwner]);

  /**
   * Флип presented/overlay (и при открытии, и при закрытии меню) может
   * погасить живой coast ленты, даже когда палец её не касался. Страховка:
   * если у активной панели свежая инерция — нативная отложенная проверка
   * перезапустит fling, когда coast умер, и не тронет ленту, когда он жив.
   */
  const ensureFeedCoastAfterOpen = useCallback(() => {
    runOnUI(() => {
      "worklet";
      const pane = activeMomentumPane.value === 0 ? pane0Momentum : pane1Momentum;
      if (
        eligibleVerticalFling(
          pane.viewTag.value,
          pane.lastCoastVelocityY.value,
          pane.lastCoastEventTs.value,
          performance.now(),
        )
      ) {
        runOnJS(ensureVerticalFlingAlive)(
          pane.viewTag.value,
          pane.lastCoastVelocityY.value,
        );
      }
    })();
  }, [activeMomentumPane, pane0Momentum, pane1Momentum]);

  const markPresented = useCallback(() => {
    setPresented(true);
  }, []);

  const markDismissed = useCallback(() => {
    setPresented(false);
    // Флип overlay на закрытии гасит coast так же, как на открытии.
    ensureFeedCoastAfterOpen();
  }, [ensureFeedCoastAfterOpen]);

  const commitGestureOpen = useCallback(() => {
    gestureTargetRef.current = 1;
    setPresented(true);
    jsRef.current.onOpen();
    ensureFeedCoastAfterOpen();
  }, [ensureFeedCoastAfterOpen]);

  const commitGestureClose = useCallback(() => {
    gestureTargetRef.current = 0;
    jsRef.current.onClose();
    // Kill coast-а может прилететь уже от React-коммита начала закрытия.
    ensureFeedCoastAfterOpen();
  }, [ensureFeedCoastAfterOpen]);

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
    ensureFeedCoastAfterOpen();
  }, [ensureFeedCoastAfterOpen, markDismissed, progress]);

  const closeGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX(-SWIPE_AXIS_PX)
        .failOffsetY([-SWIPE_AXIS_PX * 2, SWIPE_AXIS_PX * 2])
        .onStart(() => {
          "worklet";
          cancelAnimation(progress);
          dragStartProgress.value = progress.value;
          runOnJS(beginDrawerMediaPause)();
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
            progress.value < 1 - SWIPE_CLOSE_RATIO || event.velocityX < SWIPE_CLOSE_VX;
          if (shouldClose) {
            settleProgress(progress, 0, width, event.velocityX, (finished) => {
              if (finished) runOnJS(markDismissed)();
            });
            runOnJS(commitGestureClose)();
            return;
          }
          settleProgress(progress, 1, width, event.velocityX);
        }),
    [
      beginDrawerMediaPause,
      commitGestureClose,
      dragStartProgress,
      markDismissed,
      panelWidthSV,
      progress,
    ],
  );

  /**
   * Pan на обёртке контента (вся высота, полоса EDGE_HIT_WIDTH):
   * — тап / вертикальный скролл → fail, дети (гамбургер, таббар, список) получают жест;
   * — горизонтальный сдвиг из левой полосы → activate;
   * — едущую ленту (fling) защищает нативный edge-guard (flora-scroll-fling):
   *   касание в полосе проглатывается до onTouchEvent, fling не прерывается
   *   вовсе; вертикальный сдвиг отдаёт ленту нативной «поимке» пальцем.
   *   Здесь остаётся только бухгалтерия фазы: проглоченный DOWN..UP не даёт
   *   ScrollView отправить onScrollEndDrag, поэтому после жеста возвращаем
   *   фазу DRAG → COAST (fling-то жив и события идут).
   */
  const edgeGesture = useMemo(
    () =>
      Gesture.Pan()
        .withRef(edgePanRef)
        .manualActivation(true)
        .cancelsTouchesInView(false)
        .failOffsetY([-EDGE_FAIL_OFFSET_Y, EDGE_FAIL_OFFSET_Y])
        .onTouchesDown((event, state) => {
          "worklet";
          if (edgeEnabled.value < 0.5) {
            state.fail();
            return;
          }
          const touch = event.allTouches[0];
          if (
            !touch ||
            !shouldClaimDrawerEdgeTouch(
              touch.absoluteX,
              touch.absoluteY,
              edgeMaxX.value,
              edgeChromeBottomY.value,
            )
          ) {
            state.fail();
            return;
          }
          touchStartX.value = touch.absoluteX;
          touchStartY.value = touch.absoluteY;
          edgeClaimed.value = 1;
          edgeVerticalHandover.value = 0;
        })
        .onTouchesMove((event, state) => {
          "worklet";
          const touch = event.allTouches[0];
          if (!touch) return;
          const dx = touch.absoluteX - touchStartX.value;
          const dy = touch.absoluteY - touchStartY.value;
          const intent = classifyDrawerEdgeIntent(dx, dy, EDGE_AXIS_PX);
          if (intent === "fail") {
            edgeVerticalHandover.value = 1;
            state.fail();
            return;
          }
          if (intent === "activate") state.activate();
        })
        .onStart(() => {
          "worklet";
          cancelAnimation(progress);
          dragStartProgress.value = progress.value;
          runOnJS(beginDrawerMediaPause)();
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
          const shouldOpen = shouldOpenDrawer(
            progress.value,
            width,
            event.velocityX,
            SWIPE_OPEN_RATIO,
            SWIPE_OPEN_MIN_PX,
            SWIPE_OPEN_VX,
          );
          if (shouldOpen) {
            settleProgress(progress, 1, width, event.velocityX);
            runOnJS(commitGestureOpen)();
            return;
          }
          settleProgress(progress, 0, width, event.velocityX);
          runOnJS(endDrawerMediaPause)();
        })
        .onFinalize((_event, success) => {
          "worklet";
          /**
           * Edge-guard проглотил DOWN..UP/CANCEL: ScrollView не отправит
           * onScrollEndDrag, и фаза застряла бы в DRAG (её выставил
           * onScrollBeginDrag из onInterceptTouchEvent). Если жест не был
           * отдан ленте вертикальным handover-ом — палец ленту не трогал,
           * поток onScroll это живой coast: возвращаем фазу COAST.
           */
          if (edgeClaimed.value === 1 && edgeVerticalHandover.value === 0) {
            const pane = activeMomentumPane.value === 0 ? pane0Momentum : pane1Momentum;
            if (pane.phase.value === SCROLL_PHASE_DRAG) {
              pane.phase.value = SCROLL_PHASE_COAST;
            }
          }
          edgeClaimed.value = 0;
          if (!success) {
            if (progress.value > 0 && progress.value < 1) {
              settleProgress(progress, 0, panelWidthSV.value, 0);
            }
            runOnJS(endDrawerMediaPause)();
          }
        }),
    [
      commitGestureOpen,
      activeMomentumPane,
      beginDrawerMediaPause,
      dragStartProgress,
      edgeChromeBottomY,
      edgeClaimed,
      edgeEnabled,
      edgeMaxX,
      edgePanRef,
      edgeVerticalHandover,
      endDrawerMediaPause,
      pane0Momentum,
      pane1Momentum,
      panelWidthSV,
      progress,
      touchStartX,
      touchStartY,
    ],
  );

  useEffect(() => {
    const target = visible ? 1 : 0;
    if (gestureTargetRef.current === target) {
      gestureTargetRef.current = null;
      return;
    }

    cancelAnimation(progress);
    if (visible) {
      // Pause cancellable production media work before the first animated
      // frame. Waiting for the presented-state effect leaves one React commit
      // where FRC completion can invalidate the feed under the drawer.
      beginDrawerMediaPause();
      markPresented();
      ensureFeedCoastAfterOpen();
      const distance = Math.abs(1 - progress.value);
      progress.value = withTiming(1, {
        duration: Math.max(floraMotion.baseMs, Math.round(OPEN_MS * distance)),
        easing: OPEN_EASING,
      });
      return;
    }

    ensureFeedCoastAfterOpen();
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
  }, [
    beginDrawerMediaPause,
    ensureFeedCoastAfterOpen,
    markDismissed,
    markPresented,
    progress,
    visible,
  ]);

  const panelAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -panelWidthSV.value * (1 - progress.value) }],
  }));

  const backdropAnimatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
  }));

  /**
   * Не включаем absoluteFill hit-test во время edge-drag: смена pointerEvents
   * по progress посылает ScrollView ACTION_CANCEL и гасит текущий coast.
   */
  const overlayPointerEvents = presented ? ("auto" as const) : ("none" as const);

  const openItem = (href: Href) => {
    finishClose();
    router.navigate(href);
  };

  const openAccountSettings = () => {
    finishClose();
    router.push({ pathname: "/(tabs)/settings", params: { section: "account" } });
  };

  const displayName = me?.displayName?.trim() || me?.username || "Профиль";
  const handle = me?.username ? `@${me.username}` : "";

  return (
    <>
      <GestureDetector gesture={edgeGesture}>
        <View style={styles.contentSlot} collapsable={false}>
          <MenuContentSlot>{children}</MenuContentSlot>
        </View>
      </GestureDetector>

      <View style={styles.root} pointerEvents="box-none" accessibilityViewIsModal={presented}>
        <Animated.View
          pointerEvents={overlayPointerEvents}
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
            pointerEvents={overlayPointerEvents}
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
    </>
  );
}

const styles = StyleSheet.create({
  contentSlot: {
    flex: 1,
  },
  root: {
    ...StyleSheet.absoluteFill,
    zIndex: 1000,
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
