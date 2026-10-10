import { liveGridStyles } from "@/lib/liveGridStyles";
import { Ionicons } from "@expo/vector-icons";
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
  ENERGETIC_OPEN_EASING,
  ENERGETIC_OPEN_MS,
  settleEnergetic,
} from "@/lib/energeticSettle";
import {
  SCROLL_PHASE_COAST,
  SCROLL_PHASE_DRAG,
  drawerPaneAt,
  useDrawerMomentumController,
} from "@/lib/drawerMomentum";
import { eligibleVerticalFling } from "@/lib/drawerFlingPolicy";
import { useSPx } from "@/lib/FloraGridProvider";
import { floraColors, floraMotion, floraSpacing, kegl, sPx, tracking } from "@/lib/theme";
import {
  isHamburgerTabPathActive,
  requestTabRouteCover,
  requestTabRouteReveal,
  tabNameFromHamburgerTarget,
} from "@/lib/tabRouteCover";
import { FLORA_THEME_TOKENS } from "@flora/client-core/display";
import Svg, { G, Path, Rect } from "react-native-svg";
import { useSessionStore } from "@/stores/sessionStore";

/** Same mark as flora-logo-v1, without the black plate, so the chip behind it shows. */
const FLORA_LOGO_MARK_D =
  "M 645.152 273.786 C 615.243 309.285 589.49584 329.23709 557.921 352.304 C 503.37518 392.15229 472.7554 452.16121 473.38 564.76152 C 473.4502 577.45249 471.607 596.056 468.68 614.299 C 461.459 659.297 466.541 696.835 484.482 738.729 C 488.694 748.564 460.386 737.951 441.82 732.66 C 380.345 715.141 356.478 669.553 322.77 620.72 C 305.3 595.411 277.507 591.582 250.744 590.239 C 257.60091 584.02516 264.13597 575.31727 268.14758 569.02847 C 283.72411 544.60995 305.14512 523.32215 330.81428 521.2088 C 355.68567 519.16113 371.16166 527.00905 382.87988 537.21305 C 392.59583 545.67351 396.54063 549.86032 401.28517 554.2926 C 404.00173 556.83036 402.48173 539.00273 404.0588 510.5418 C 405.13154 491.18221 406.74249 475.73993 410.02764 458.01415 C 419.04282 409.37075 437.6628 370.21869 473.13188 331.94803 C 497.50272 305.6522 523.82825 288.52517 574.82059 257.63857 C 614.31525 233.71624 635.9544 215.83424 656.99503 196.56502 C 678.64327 176.73934 689.92287 160.75309 691.70422 158.84133 C 693.94103 156.48421 696.972 186.33 697.258 188.548 C 705.121 249.426 696.72963 336.34563 674.90063 396.31363 C 663.98663 426.29663 649.78412 448.33853 615.05112 464.77353 C 595.56104 473.99612 574.34294 479.12864 554.3542 487.15634 C 525.1642 498.87834 506.83559 521.33825 507.62359 514.46225 C 513.18959 465.90725 529.62144 414.8383 572.955 381.152 C 645.85009 324.48539 669.14 245.314 645.152 273.786 Z M 596.98 562.659 C 577.82 572.47 565.927 585.129 555.873 601.454 C 546.157 617.231 540.785 641.944 543.021 664.982 C 550.162 738.533 618.92439 775.67598 686.57623 811.15702 C 687.81796 811.80827 680.49974 813.5998 677.75 814.27 C 636.222 824.395 590.331 823.083 556.28 795.28 C 482.2 734.792 465.08112 592.24674 544.48631 529.57171 C 559.82766 517.4627 580.50022 510.54459 599.14731 505.39584 C 620.86216 499.40002 642.67714 487.47777 660.72677 473.89221 C 666.93231 469.22144 674.07641 465.20156 678.144 458.384 C 682.287 451.441 696.711 563.649 631.71 631.27 C 605.8188 658.2052 594.08478 672.71014 592.62018 702.49703 C 592.35745 707.84039 592.09473 713.18375 591.832 718.52711 C 590.01789 716.0583 588.20379 713.58949 586.38969 711.12069 C 580.1495 702.62844 571.19975 684.122 569.873 671.177 C 566.861 641.786 569.127 628.992 584.318 607.271 C 599.694 585.285 623.401 582.689 641.636 549.272 C 655.864 523.198 657.419 515.315 639.891 533.551 C 628.826 545.064 616.949 552.434 596.98 562.659 Z";

type MenuItemId = "people" | "communities" | "settings" | "contribute";

type MenuItem = {
  id: MenuItemId;
  href: Href;
  label: string;
};

const MENU_ITEMS: MenuItem[] = [
  { id: "people", href: "/(tabs)/people", label: "Люди" },
  { id: "communities", href: "/(tabs)/communities", label: "Сообщества" },
  { id: "settings", href: "/(tabs)/settings", label: "Настройки" },
  { id: "contribute", href: "/(tabs)/contribute", label: "Помощь проекту" },
];

/**
 * Как web dashboardShell: logoMark = 2×grid (30), navIcon = 22;
 * people 24, communities 22×0.92, settings/contribute 22.
 */
function MenuItemIcon({ id, color }: { id: MenuItemId; color: string }) {
  const sp = useSPx();
  const size =
    id === "people" ? sp(24) : id === "communities" ? Math.round(sp(22) * 0.92) : sp(22);
  switch (id) {
    case "people":
      return <SidebarPeopleIcon size={size} color={color} />;
    case "communities":
      return <SidebarCommunitiesIcon size={size} color={color} />;
    case "settings":
      return <SidebarSettingsIcon size={size} color={color} />;
    case "contribute":
      return <Ionicons name="heart" size={size} color={color} />;
  }
}

/** Как web `isDashboardRouteActive`: активный пункт сайдбара — greenLight. */
function isMenuItemActive(pathname: string, id: MenuItemId): boolean {
  return isHamburgerTabPathActive(pathname, id);
}

const PANEL_MAX_WIDTH = () => 20 * floraSpacing.grid;
const PANEL_WIDTH_RATIO = 0.78;
const OPEN_MS = ENERGETIC_OPEN_MS;
const OPEN_EASING = ENERGETIC_OPEN_EASING;
/** Парирует выдвижение: тот же duration-3 и ease-out, удар сразу в обе стороны. */
const CLOSE_MS = OPEN_MS;
const CLOSE_EASING = OPEN_EASING;
const MENU_EDGE_INSET = () => floraSpacing.grid + floraSpacing.gridFine;
const MENU_LEAD_COL = () => 2 * floraSpacing.grid;
/** Горизонтальный порог, чтобы не перехватывать тапы по пунктам меню. */
const SWIPE_AXIS_PX = 10;
/** Быстрый vertical fail edge-pan: ScrollView не ждёт PENDING при waitFor. */
const EDGE_AXIS_PX = DRAWER_EDGE_FAIL_OFFSET_Y;
const EDGE_FAIL_OFFSET_Y = DRAWER_EDGE_FAIL_OFFSET_Y;
/** Порог закрытия от полностью открытой панели. */
const SWIPE_CLOSE_RATIO = 0.28;
/** Мягкий порог открытия: медленный осознанный drag тоже коммитится. */
const SWIPE_OPEN_RATIO = 0.12;
/** 2×grid. В worklet — уже число: с UI-потока функцию звать нельзя. */
const SWIPE_OPEN_MIN_PX = () => 2 * floraSpacing.grid;
/** Gesture Handler сообщает velocity в points/sec. */
const SWIPE_CLOSE_VX = -650;
const SWIPE_OPEN_VX = 220;
/**
 * Зона edge-swipe (60px на всю высоту, без вырезов).
 * Pan на обёртке контента (не absolute overlay): тапы остаются детям,
 * свайп забирается через manualActivation после горизонтального сдвига.
 */
const EDGE_HIT_WIDTH = () => DRAWER_EDGE_HIT_WIDTH();
/** Высота chromeRow / iconButton — floor для исключения гамбургера из edge claim. */
/** Высота chromeRow / iconButton — floor для исключения гамбургера из edge claim. */
const EDGE_CHROME_ROW_PX = () => 3 * floraSpacing.grid;
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
  const momentumPanes = momentumController.panes;
  const me = useSessionStore((s) => s.me);
  const panelWidth = Math.min(PANEL_MAX_WIDTH(), Math.round(windowWidth * PANEL_WIDTH_RATIO));
  const swipeOpenMinPx = SWIPE_OPEN_MIN_PX();

  const [presented, setPresented] = useState(visible);
  const progress = useSharedValue(visible ? 1 : 0);
  const dragStartProgress = useSharedValue(0);
  const panelWidthSV = useSharedValue(panelWidth);
  const edgeMaxX = useSharedValue(insets.left + EDGE_HIT_WIDTH());
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
    edgeMaxX.value = insets.left + EDGE_HIT_WIDTH();
  }, [edgeMaxX, insets.left, windowWidth]);

  useEffect(() => {
    const floor = insets.top + floraSpacing.grid + EDGE_CHROME_ROW_PX();
    if (edgeChromeBottomY.value < floor) {
      edgeChromeBottomY.value = floor;
    }
  }, [edgeChromeBottomY, insets.top, windowWidth]);

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
      const pane = drawerPaneAt(momentumPanes, activeMomentumPane.value);
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
  }, [activeMomentumPane, momentumPanes]);

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
            swipeOpenMinPx,
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
            const pane = drawerPaneAt(momentumPanes, activeMomentumPane.value);
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
      momentumPanes,
      panelWidthSV,
      progress,
      swipeOpenMinPx,
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
    const tabName = typeof href === "string" ? tabNameFromHamburgerTarget(href) : null;
    if (tabName != null && isHamburgerTabPathActive(pathname, tabName)) {
      finishClose();
      return;
    }
    if (tabName != null) requestTabRouteCover(tabName);
    finishClose();
    router.navigate(href);
    if (tabName != null) {
      requestAnimationFrame(() => {
        requestTabRouteReveal();
      });
    }
  };

  const openAccountSettings = () => {
    if (isHamburgerTabPathActive(pathname, "settings")) {
      finishClose();
      return;
    }
    requestTabRouteCover("settings");
    finishClose();
    router.push({ pathname: "/(tabs)/settings", params: { section: "account" } });
    requestAnimationFrame(() => {
      requestTabRouteReveal();
    });
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
                  <Svg
                    width={MENU_LEAD_COL()}
                    height={MENU_LEAD_COL()}
                    viewBox="0 0 1024 1024"
                    style={styles.logoMarkSvg}
                  >
                    <Rect width="1024" height="1024" fill={FLORA_THEME_TOKENS.accentGreenOverlay20} />
                    <G transform="matrix(0.88713921, 0, 0, 0.88713921, 42.574128, 58.006452)">
                      <Path
                        d={FLORA_LOGO_MARK_D}
                        fill="#a1cd87"
                        stroke="#a1cd87"
                        strokeWidth={0.5}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />
                    </G>
                  </Svg>
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
                accountBlocked={me?.accountBlocked}
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

const styles = liveGridStyles(() => StyleSheet.create({
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
    paddingLeft: MENU_EDGE_INSET(),
    paddingRight: MENU_EDGE_INSET(),
    justifyContent: "flex-start",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 3 * floraSpacing.grid,
    marginBottom: floraSpacing.grid * 3,
  },
  logoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.grid,
  },
  logoMark: {
    width: MENU_LEAD_COL(),
    height: MENU_LEAD_COL(),
    borderRadius: 2 * floraSpacing.gridFine,
    overflow: "hidden",
    backgroundColor: FLORA_THEME_TOKENS.accentGreenOverlay20,
  },
  logoMarkSvg: {
    backgroundColor: "transparent",
  },
  logoText: {
    color: floraColors.greenLight,
    fontSize: kegl(17),
    fontWeight: "300",
    letterSpacing: tracking(4),
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
    minHeight: 3 * floraSpacing.grid,
    paddingRight: floraSpacing.grid,
    borderRadius: sPx(12),
  },
  navItemPressed: {
    backgroundColor: "rgba(250, 250, 250, 0.06)",
  },
  navIconWrap: {
    width: MENU_LEAD_COL(),
    height: MENU_LEAD_COL(),
    alignItems: "center",
    justifyContent: "center",
  },
  navLabel: {
    color: floraColors.whiteTemplate,
    fontSize: kegl(16),
    fontWeight: "300",
    letterSpacing: tracking(0.48),
  },
  navLabelActive: {
    color: floraColors.greenLight,
  },
  userCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.grid,
    paddingVertical: floraSpacing.grid - sPx(6),
    borderRadius: sPx(12),
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
    fontSize: kegl(15),
    fontWeight: "300",
    letterSpacing: tracking(0.45),
  },
  userHandle: {
    color: floraColors.gray,
    fontSize: kegl(15),
    fontWeight: "300",
    letterSpacing: tracking(0.45),
  },
}));
