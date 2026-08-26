import { Ionicons } from "@expo/vector-icons";
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Pressable } from "react-native-gesture-handler";
import Reanimated, {
  Easing,
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import {
  resolveAboveDockTop,
  resolveMenuPanelMotion,
  type BubbleAnchorRect,
} from "@/lib/messageBubbleMoreMenuLayout";
import { floraColors, floraMessages, floraMotion, floraSpacing } from "@/lib/theme";
import { useReducedMotion } from "@/lib/useReducedMotion";

export type { BubbleAnchorRect, BubbleBoxRect } from "@/lib/messageBubbleMoreMenuLayout";
export { bubbleAnchorsEqual } from "@/lib/messageBubbleMoreMenuLayout";

export type MessageBubbleMenuPlacement = "above" | "below";

type MenuLatch = {
  targetUuid: string;
  placement: MessageBubbleMenuPlacement;
  shiftY: number;
  visualTop: number | null;
  feedTopY: number | null;
  panelHeight: number;
  menuGap: number;
  feedInset: number;
  isFromMe: boolean;
  canReplyCopy: boolean;
  canReply: boolean;
  canDelete: boolean;
  onClose: () => void;
  onReply?: () => void;
  onCopy?: () => void;
  onDelete?: () => void;
  onReport?: () => void;
  onPanelLayout: (width: number, height: number) => void;
};

type MenuController = MenuLatch & {
  menuOpen: boolean;
  onExitFinished: () => void;
};

const MENU_MOTION_MS = floraMotion.baseMs;
const MENU_IN_EASING = Easing.bezier(0.22, 1, 0.36, 1);
const MENU_OUT_EASING = Easing.bezier(0.36, 0, 0.64, 1);
const MENU_SCALE_FROM = 0.92;

const MessageBubbleMenuContext = createContext<MenuController | null>(null);

type MenuUuidStore = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => string | null;
  setUuid: (uuid: string | null) => void;
};

function createMenuUuidStore(): MenuUuidStore {
  let uuid: string | null = null;
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => uuid,
    setUuid: (next) => {
      if (uuid === next) return;
      uuid = next;
      listeners.forEach((listener) => listener());
    },
  };
}

const MenuUuidStoreContext = createContext<MenuUuidStore | null>(null);

function emptySubscribe(_listener: () => void) {
  return () => {};
}

function emptySnapshot(): string | null {
  return null;
}

export function useOpenMessageMenuUuid(): string | null {
  const store = useContext(MenuUuidStoreContext);
  return useSyncExternalStore(
    store?.subscribe ?? emptySubscribe,
    store?.getSnapshot ?? emptySnapshot,
    emptySnapshot,
  );
}

function useIsMessageMenuOpen(messageUuid: string): boolean {
  const store = useContext(MenuUuidStoreContext);
  return useSyncExternalStore(
    store?.subscribe ?? emptySubscribe,
    () => (store?.getSnapshot() ?? null) === messageUuid,
    () => false,
  );
}

type ProviderProps = {
  open: boolean;
  targetUuid: string | null;
  anchor: BubbleAnchorRect | null;
  placement: MessageBubbleMenuPlacement;
  shiftY: number;
  visualTop?: number | null;
  feedTopY?: number | null;
  panelHeight?: number;
  menuGap?: number;
  feedInset?: number;
  isFromMe: boolean;
  canReplyCopy: boolean;
  canReply?: boolean;
  canDelete: boolean;
  onClose: () => void;
  onReply?: () => void;
  onCopy?: () => void;
  onDelete?: () => void;
  onReport?: () => void;
  children: ReactNode;
};

export function MessageBubbleMoreMenu({
  open,
  targetUuid,
  anchor,
  placement,
  shiftY,
  visualTop = null,
  feedTopY = null,
  panelHeight = 0,
  menuGap = floraMessages.bubbleMenuGap,
  feedInset = floraMessages.bubbleMenuFeedInset,
  isFromMe,
  canReplyCopy,
  canReply,
  canDelete,
  onClose,
  onReply,
  onCopy,
  onDelete,
  onReport,
  children,
}: ProviderProps) {
  const onPanelLayout = useCallback((_width: number, _height: number) => {}, []);
  const uuidStoreRef = useRef<MenuUuidStore | null>(null);
  if (uuidStoreRef.current == null) {
    uuidStoreRef.current = createMenuUuidStore();
  }
  const uuidStore = uuidStoreRef.current;
  const openRef = useRef(open);
  openRef.current = open;
  const [latched, setLatched] = useState<MenuLatch | null>(null);

  const live = useMemo((): MenuLatch | null => {
    if (!open || !anchor || !targetUuid) return null;
    return {
      targetUuid,
      placement,
      shiftY,
      visualTop,
      feedTopY,
      panelHeight,
      menuGap,
      feedInset,
      isFromMe,
      canReplyCopy,
      canReply: canReply ?? canReplyCopy,
      canDelete,
      onClose,
      onReply,
      onCopy,
      onDelete,
      onReport,
      onPanelLayout,
    };
  }, [
    open,
    targetUuid,
    anchor,
    placement,
    shiftY,
    visualTop,
    feedTopY,
    panelHeight,
    menuGap,
    feedInset,
    isFromMe,
    canReplyCopy,
    canReply,
    canDelete,
    onClose,
    onReply,
    onCopy,
    onDelete,
    onReport,
    onPanelLayout,
  ]);

  const onExitFinished = useCallback(() => {
    if (openRef.current) return;
    uuidStore.setUuid(null);
    setLatched(null);
  }, [uuidStore]);

  useLayoutEffect(() => {
    if (!live) return;
    setLatched(live);
    uuidStore.setUuid(live.targetUuid);
  }, [live, uuidStore]);

  const value = useMemo((): MenuController | null => {
    if (!latched) return null;
    return { ...latched, menuOpen: open, onExitFinished };
  }, [latched, open, onExitFinished]);

  return (
    <MenuUuidStoreContext.Provider value={uuidStore}>
      <MessageBubbleMenuContext.Provider value={value}>
        <View style={styles.providerRoot} collapsable={false}>
          {children}
        </View>
      </MessageBubbleMenuContext.Provider>
    </MenuUuidStoreContext.Provider>
  );
}

/**
 * Positions the panel relative to the bubble box in the same transform tree
 * as the inverted list (`bottom: 100%` / `top: 100%` + 5px). Window-space
 * overlays cannot pin edge-to-edge after nested `scaleY: -1`.
 */
export function MessageBubbleMenuDock({
  messageUuid,
  isFromMe,
  style,
  children,
}: {
  messageUuid: string;
  isFromMe: boolean;
  /**
   * Стили якоря пузыря кладутся прямо на хост дока (тот же бокс): отдельная
   * обёртка была лишним узлом на каждую ячейку ленты — дорогой фазе монтажа.
   */
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const show = useIsMessageMenuOpen(messageUuid);
  return (
    <View style={[styles.dockHost, style]} collapsable={false} pointerEvents="box-none">
      <View pointerEvents={show ? "none" : "auto"} collapsable={false}>
        {children}
      </View>
      {show ? <MessageBubbleMenuChrome isFromMe={isFromMe} /> : null}
    </View>
  );
}

function MessageBubbleMenuChrome({ isFromMe }: { isFromMe: boolean }) {
  const menu = useContext(MessageBubbleMenuContext);
  const [measuredHeight, setMeasuredHeight] = useState(0);
  useLayoutEffect(() => {
    setMeasuredHeight(0);
  }, [menu?.targetUuid]);

  if (!menu) return null;
  const panelHeight = Math.max(measuredHeight, menu.panelHeight);
  const dock = resolveAboveDockTop({
    visualTop: menu.visualTop,
    feedTopY: menu.feedTopY,
    panelHeight,
    menuGap: menu.menuGap,
    feedInset: menu.feedInset,
  });
  const aboveTop = menu.placement === "above" ? dock.aboveAnchorTop : 0;
  const shiftY = menu.placement === "below" ? menu.shiftY : 0;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Закрыть меню"
        style={StyleSheet.absoluteFill}
        onPress={menu.onClose}
      />
      <View
        pointerEvents="box-none"
        style={[
          menu.placement === "below" ? styles.dockAnchorBelow : styles.dockAnchorAbove,
          menu.placement === "above" ? { top: aboveTop } : null,
        ]}
      >
        <MessageBubbleMenuPanelMotion
          menuOpen={menu.menuOpen}
          placement={menu.placement}
          isFromMe={isFromMe}
          shiftY={shiftY}
          onExitFinished={menu.onExitFinished}
        >
          <MessageBubbleMenuPanel
            onHeight={(height) => {
              setMeasuredHeight((prev) => (height > prev ? height : prev));
            }}
          />
        </MessageBubbleMenuPanelMotion>
      </View>
    </>
  );
}

function MessageBubbleMenuPanelMotion({
  menuOpen,
  placement,
  isFromMe,
  shiftY,
  onExitFinished,
  children,
}: {
  menuOpen: boolean;
  placement: MessageBubbleMenuPlacement;
  isFromMe: boolean;
  shiftY: number;
  onExitFinished: () => void;
  children: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(reduceMotion ? 1 : 0);
  const motion = useMemo(
    () => resolveMenuPanelMotion(placement, isFromMe),
    [placement, isFromMe],
  );
  const onExitFinishedRef = useRef(onExitFinished);
  onExitFinishedRef.current = onExitFinished;
  const finishExit = useCallback(() => {
    onExitFinishedRef.current();
  }, []);

  useLayoutEffect(() => {
    if (reduceMotion) {
      progress.value = menuOpen ? 1 : 0;
      if (!menuOpen) finishExit();
      return;
    }
    cancelAnimation(progress);
    if (menuOpen) {
      progress.value = withTiming(1, { duration: MENU_MOTION_MS, easing: MENU_IN_EASING });
      return;
    }
    progress.value = withTiming(
      0,
      { duration: MENU_MOTION_MS, easing: MENU_OUT_EASING },
      (finished) => {
        if (finished) runOnJS(finishExit)();
      },
    );
  }, [finishExit, menuOpen, progress, reduceMotion]);

  const emergeX = motion.emergeX;
  const emergeY = motion.emergeY;
  const animatedStyle = useAnimatedStyle(() => {
    const p = progress.value;
    return {
      opacity: p,
      transform: [
        { translateY: shiftY },
        { translateX: emergeX * (1 - p) },
        { translateY: emergeY * (1 - p) },
        { scale: MENU_SCALE_FROM + (1 - MENU_SCALE_FROM) * p },
      ],
    };
  });

  return (
    <Reanimated.View
      pointerEvents={menuOpen ? "auto" : "none"}
      style={[
        placement === "below" ? styles.dockPanelBelow : styles.dockPanelAbove,
        isFromMe ? styles.dockEnd : styles.dockStart,
        { transformOrigin: motion.transformOrigin },
        animatedStyle,
      ]}
    >
      {children}
    </Reanimated.View>
  );
}

function MessageBubbleMenuPanel({ onHeight }: { onHeight?: (height: number) => void }) {
  const menu = useContext(MessageBubbleMenuContext);
  const pick = useCallback(
    (handler?: () => void) => () => {
      if (!menu?.menuOpen) return;
      handler?.();
      menu.onClose();
    },
    [menu],
  );

  if (!menu) return null;
  const {
    canReply,
    canReplyCopy,
    canDelete,
    isFromMe,
    onReply,
    onCopy,
    onDelete,
    onReport,
    onPanelLayout,
  } = menu;

  return (
    <View
      style={styles.panel}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        onHeight?.(height);
        onPanelLayout(width, height);
      }}
    >
      <MenuRow
        icon="arrow-undo-outline"
        label="Ответить"
        disabled={!canReply}
        onPress={pick(canReply ? onReply : undefined)}
      />
      <MenuRow
        icon="copy-outline"
        label="Копировать"
        disabled={!canReplyCopy}
        onPress={pick(canReplyCopy ? onCopy : undefined)}
      />
      <MenuRow icon="arrow-redo-outline" label="Переслать" onPress={pick()} />
      <MenuRow icon="pin-outline" label="Закрепить" onPress={pick()} />
      {isFromMe ? <MenuRow icon="create-outline" label="Редактировать" onPress={pick()} /> : null}
      {isFromMe && canDelete ? (
        <MenuRow icon="trash-outline" label="Удалить" danger onPress={pick(onDelete)} />
      ) : null}
      {!isFromMe && onReport ? (
        <MenuRow icon="flag-outline" label="Пожаловаться" danger onPress={pick(onReport)} />
      ) : null}
    </View>
  );
}

function MenuRow({
  icon,
  label,
  onPress,
  danger = false,
  disabled = false,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="menuitem"
      disabled={disabled}
      style={({ pressed }) => [
        styles.menuItem,
        disabled && styles.menuItemDisabled,
        pressed && !disabled && styles.menuItemPressed,
      ]}
      onPress={onPress}
    >
      <View style={styles.menuItemIcon}>
        <Ionicons
          name={icon}
          size={18}
          color={danger ? "#f6a8a8" : disabled ? "rgba(250,250,250,0.35)" : floraColors.gray}
        />
      </View>
      <Text style={[styles.menuItemLabel, danger && styles.menuItemDanger, disabled && styles.menuItemLabelDisabled]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  providerRoot: {
    flex: 1,
    minHeight: 0,
  },
  dockHost: {
    position: "relative",
    overflow: "visible",
  },
  /**
   * Zero-height edge so the panel is out of Yoga flow. `top/bottom: '100%'`
   * with intrinsic panel height inflates the FlashList cell and squashes
   * neighboring bubbles.
   */
  dockAnchorBelow: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 0,
    overflow: "visible",
    zIndex: 8,
  },
  dockAnchorAbove: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    overflow: "visible",
    height: 0,
    zIndex: 8,
  },
  dockPanelBelow: {
    position: "absolute",
    left: 0,
    right: 0,
    top: floraMessages.bubbleMenuGap,
  },
  dockPanelAbove: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: floraMessages.bubbleMenuGap,
  },
  dockStart: {
    alignItems: "flex-start",
  },
  dockEnd: {
    alignItems: "flex-end",
  },
  panel: {
    width: 200,
    borderRadius: 12,
    backgroundColor: floraColors.bg,
    borderWidth: 1,
    borderColor: "rgba(250, 250, 250, 0.06)",
    padding: floraSpacing.gridFine * 1.5,
    shadowOpacity: 0,
    elevation: 0,
  },
  menuItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.grid,
    width: "100%",
    paddingVertical: floraSpacing.gridFine * 1.5,
    paddingHorizontal: floraSpacing.gridFine * 2,
    borderRadius: 8,
  },
  menuItemPressed: {
    backgroundColor: "rgba(250, 250, 250, 0.06)",
  },
  menuItemDisabled: {
    opacity: 0.45,
  },
  menuItemIcon: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  menuItemLabel: {
    flex: 1,
    color: "rgba(250, 250, 250, 0.9)",
    fontSize: 14,
    fontWeight: "400",
    letterSpacing: 0.42,
  },
  menuItemLabelDisabled: {
    color: "rgba(250, 250, 250, 0.45)",
  },
  menuItemDanger: {
    color: "#f6a8a8",
  },
});
