import { Ionicons } from "@expo/vector-icons";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  PixelRatio,
  Pressable,
  StyleSheet,
  Text,
  TouchableWithoutFeedback,
  View,
  type LayoutRectangle,
  type ViewStyle,
} from "react-native";
import { floraColors, floraMessages, floraSpacing } from "@/lib/theme";

export type BubbleAnchorRect = {
  top: number;
  left: number;
  right: number;
  bottom: number;
};

export function bubbleAnchorsEqual(a: BubbleAnchorRect, b: BubbleAnchorRect): boolean {
  return a.top === b.top && a.left === b.left && a.right === b.right && a.bottom === b.bottom;
}

type Props = {
  open: boolean;
  anchor: BubbleAnchorRect | null;
  /** Y верхней границы ленты (окно). */
  feedTopY: number | null;
  /** Y линии разделения compose (верх dock, окно). */
  feedBottomY: number | null;
  isFromMe: boolean;
  /** Copy / reply share preview readiness; reply may be narrower (e.g. while sending). */
  canReplyCopy: boolean;
  /** Defaults to canReplyCopy when omitted. */
  canReply?: boolean;
  canDelete: boolean;
  onClose: () => void;
  onReply?: () => void;
  onCopy?: () => void;
  onDelete?: () => void;
};

type MenuPlacement = "below" | "above";

type HostRelativeAnchor = {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
};

function toHostRelative(anchor: BubbleAnchorRect, host: LayoutRectangle): HostRelativeAnchor {
  const top = anchor.top - host.y;
  const bottom = anchor.bottom - host.y;
  return {
    top,
    left: anchor.left - host.x,
    right: anchor.right - host.x,
    bottom,
    width: anchor.right - anchor.left,
  };
}

function menuVerticalBounds(
  host: LayoutRectangle,
  feedTopY: number,
  feedBottomY: number,
  panelHeight: number,
  menuGap: number,
) {
  const minTop = feedTopY - host.y + menuGap;
  const maxTop = feedBottomY - host.y - menuGap - panelHeight;
  return { minTop, maxTop: Math.max(minTop, maxTop) };
}

function resolveMenuPlacement(
  rel: HostRelativeAnchor,
  host: LayoutRectangle,
  feedTopY: number,
  feedBottomY: number,
  panelHeight: number,
  menuGap: number,
): MenuPlacement {
  const { minTop, maxTop } = menuVerticalBounds(host, feedTopY, feedBottomY, panelHeight, menuGap);
  const belowTop = rel.bottom + menuGap;
  const aboveTop = rel.top - menuGap - panelHeight;

  const fitsBelow = belowTop >= minTop && belowTop <= maxTop;
  const fitsAbove = aboveTop >= minTop && aboveTop <= maxTop;

  if (fitsBelow) return "below";
  if (fitsAbove) return "above";

  const spaceBelow = feedBottomY - host.y - menuGap - rel.bottom;
  const spaceAbove = rel.top - (feedTopY - host.y) - menuGap;
  return spaceBelow >= spaceAbove ? "below" : "above";
}

/**
 * Ниже пузыря: идеал = под пузырём; если не влезает — прижать к линии compose (menuGap).
 * Выше пузыря: идеал = над пузырём; если не влезает — прижать к верху ленты (menuGap).
 */
function resolveMenuTop(
  rel: HostRelativeAnchor,
  host: LayoutRectangle,
  feedTopY: number,
  feedBottomY: number,
  panelHeight: number,
  menuGap: number,
  placement: MenuPlacement,
): number {
  const { minTop, maxTop } = menuVerticalBounds(host, feedTopY, feedBottomY, panelHeight, menuGap);

  if (placement === "below") {
    return Math.min(rel.bottom + menuGap, maxTop);
  }

  return Math.max(rel.top - menuGap - panelHeight, minTop);
}

function menuPositionStyle(
  rel: HostRelativeAnchor,
  host: LayoutRectangle,
  feedTopY: number,
  feedBottomY: number,
  menuGap: number,
  panelHeight: number,
  isFromMe: boolean,
): ViewStyle {
  const placement = resolveMenuPlacement(rel, host, feedTopY, feedBottomY, panelHeight, menuGap);
  return {
    left: rel.left,
    width: rel.width,
    alignItems: isFromMe ? "flex-end" : "flex-start",
    top: resolveMenuTop(rel, host, feedTopY, feedBottomY, panelHeight, menuGap, placement),
  };
}

export function MessageBubbleMoreMenu({
  open,
  anchor,
  feedTopY,
  feedBottomY,
  isFromMe,
  canReplyCopy,
  canReply,
  canDelete,
  onClose,
  onReply,
  onCopy,
  onDelete,
}: Props) {
  const replyEnabled = canReply ?? canReplyCopy;
  const hostRef = useRef<View>(null);
  const [hostFrame, setHostFrame] = useState<LayoutRectangle | null>(null);
  const [panelHeight, setPanelHeight] = useState(0);
  const menuGap = PixelRatio.roundToNearestPixel(floraMessages.bubbleRowGap / 2);

  const syncHostFrame = useCallback(() => {
    hostRef.current?.measureInWindow((x, y, width, height) => {
      setHostFrame((prev) =>
        prev?.x === x && prev?.y === y && prev?.width === width && prev?.height === height
          ? prev
          : { x, y, width, height },
      );
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setHostFrame(null);
      setPanelHeight(0);
      return;
    }
    syncHostFrame();
    const frame = requestAnimationFrame(syncHostFrame);
    return () => cancelAnimationFrame(frame);
  }, [open, anchor?.top, anchor?.bottom, anchor?.left, anchor?.right, syncHostFrame]);

  const pick = useCallback(
    (handler?: () => void) => () => {
      handler?.();
      onClose();
    },
    [onClose],
  );

  const rel = anchor && hostFrame ? toHostRelative(anchor, hostFrame) : null;
  const boundsReady = feedTopY != null && feedBottomY != null;
  const measuring = panelHeight <= 0;
  const positionStyle =
    rel && hostFrame && boundsReady && !measuring
      ? menuPositionStyle(rel, hostFrame, feedTopY, feedBottomY, menuGap, panelHeight, isFromMe)
      : null;

  if (!open || !anchor) return null;

  const panel = (
    <View
      style={styles.panel}
      onLayout={(e) => {
        const h = e.nativeEvent.layout.height;
        if (h > 0 && h !== panelHeight) setPanelHeight(h);
      }}
    >
      <MenuRow
        icon="arrow-undo-outline"
        label="Ответить"
        disabled={!replyEnabled}
        onPress={pick(replyEnabled ? onReply : undefined)}
      />
      <MenuRow
        icon="copy-outline"
        label="Копировать"
        disabled={!canReplyCopy}
        onPress={pick(canReplyCopy ? onCopy : undefined)}
      />
      <MenuRow icon="arrow-redo-outline" label="Переслать" onPress={pick()} />
      <MenuRow icon="pin-outline" label="Закрепить" onPress={pick()} />
      {isFromMe ? (
        <MenuRow icon="create-outline" label="Редактировать" onPress={pick()} />
      ) : null}
      {isFromMe && canDelete ? (
        <MenuRow icon="trash-outline" label="Удалить" danger onPress={pick(onDelete)} />
      ) : null}
    </View>
  );

  return (
    <View ref={hostRef} style={styles.host} pointerEvents="box-none" collapsable={false}>
      <TouchableWithoutFeedback onPress={onClose} accessible={false}>
        <View style={styles.backdrop} />
      </TouchableWithoutFeedback>
      {positionStyle ? (
        <TouchableWithoutFeedback>
          <View
            style={[styles.menuAnchor, positionStyle]}
            accessibilityRole="menu"
            accessibilityViewIsModal
          >
            {panel}
          </View>
        </TouchableWithoutFeedback>
      ) : (
        <View style={styles.menuMeasuring} pointerEvents="none">
          {panel}
        </View>
      )}
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
  host: {
    ...StyleSheet.absoluteFill,
    zIndex: 30,
    elevation: 30,
    overflow: "hidden",
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
  },
  menuAnchor: {
    position: "absolute",
  },
  menuMeasuring: {
    position: "absolute",
    top: -10_000,
    left: -10_000,
    opacity: 0,
  },
  panel: {
    minWidth: 200,
    maxWidth: 280,
    borderRadius: 12,
    backgroundColor: floraColors.bg,
    borderWidth: 1,
    borderColor: "rgba(250, 250, 250, 0.06)",
    padding: floraSpacing.gridFine * 1.5,
    // Без elevation — иначе на Android тень вылезает за линию compose.
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
