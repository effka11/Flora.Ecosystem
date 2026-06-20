import { useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { floraTabFilter } from "@/lib/theme";

type Anchor = {
  left: number;
  top: number;
};

type Props = {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<View | null>;
  menuStyle: StyleProp<ViewStyle>;
  children: ReactNode;
};

function measureAnchor(ref: View, onMeasured: (anchor: Anchor) => void) {
  ref.measure((_x, _y, _width, height, pageX, pageY) => {
    onMeasured({
      left: pageX,
      top: pageY + height + floraTabFilter.menuGapBelow,
    });
  });
}

/** Modal: backdrop закрывает по тапу снаружи, меню — внутри поверх backdrop. */
export function DropdownMenuOverlay({ open, onClose, anchorRef, menuStyle, children }: Props) {
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
        {anchor ? (
          <View
            style={[menuStyle, styles.menu, { left: anchor.left, top: anchor.top }]}
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
