import { useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { floraTabFilter } from "@/lib/theme";

type Anchor = {
  left: number;
  width: number;
  pageY: number;
  height: number;
};

type Props = {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<View | null>;
  menuStyle: StyleProp<ViewStyle>;
  /** Выравнивание меню по правому краю якоря (для кнопок у правого края экрана). */
  alignEnd?: boolean;
  /** below — под якорем (по умолчанию); above — над якорем. */
  placement?: "below" | "above";
  children: ReactNode;
};

function measureAnchor(ref: View, onMeasured: (anchor: Anchor) => void) {
  ref.measure((_x, _y, width, height, pageX, pageY) => {
    onMeasured({
      left: pageX,
      width,
      pageY,
      height,
    });
  });
}

/** Modal: backdrop закрывает по тапу снаружи, меню — внутри поверх backdrop. */
export function DropdownMenuOverlay({
  open,
  onClose,
  anchorRef,
  menuStyle,
  alignEnd = false,
  placement = "below",
  children,
}: Props) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }

    let cancelled = false;

    const update = () => {
      const node = anchorRef.current;
      if (!node || cancelled) return;
      measureAnchor(node, (next) => {
        if (!cancelled) setAnchor(next);
      });
    };

    update();
    const frame = requestAnimationFrame(update);

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [anchorRef, open]);

  const horizontal = anchor
    ? alignEnd
      ? { right: Math.max(0, windowWidth - (anchor.left + anchor.width)) }
      : { left: anchor.left }
    : null;

  const vertical = anchor
    ? placement === "above"
      ? { bottom: windowHeight - anchor.pageY + floraTabFilter.menuGapBelow }
      : { top: anchor.pageY + anchor.height + floraTabFilter.menuGapBelow }
    : null;

  const menuPosition = horizontal && vertical ? { ...horizontal, ...vertical } : null;

  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.root}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel="Закрыть меню" />
        {menuPosition ? (
          <View
            style={[menuStyle, styles.menu, menuPosition]}
            accessibilityRole="menu"
            accessibilityViewIsModal
          >
            {children}
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
  },
  menu: {
    position: "absolute",
  },
});
