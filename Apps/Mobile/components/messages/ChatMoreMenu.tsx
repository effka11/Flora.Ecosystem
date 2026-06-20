import { Ionicons } from "@expo/vector-icons";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableWithoutFeedback,
  useWindowDimensions,
  View,
} from "react-native";
import { floraColors, floraFeedPost, floraSpacing } from "@/lib/theme";

type Props = {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<View | null>;
  onMute: () => void;
  onArchive: () => void;
};

type Anchor = {
  top: number;
  right: number;
};

export function ChatMoreMenu({ open, onClose, anchorRef, onMute, onArchive }: Props) {
  const { width: windowWidth } = useWindowDimensions();
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  const updateAnchor = useCallback(() => {
    anchorRef.current?.measureInWindow((x, y, w, h) => {
      setAnchor({
        top: y + h + floraFeedPost.moreMenuGapBelow,
        right: Math.max(floraSpacing.grid, windowWidth - (x + w)),
      });
    });
  }, [anchorRef, windowWidth]);

  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    updateAnchor();
  }, [open, updateAnchor]);

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.overlay}>
          {anchor ? (
            <View style={[styles.panel, { top: anchor.top, right: anchor.right }]}>
              <Pressable
                style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
                onPress={() => {
                  onClose();
                  onMute();
                }}
              >
                <Text style={styles.itemText}>Без звука</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
                onPress={() => {
                  onClose();
                  onArchive();
                }}
              >
                <Text style={styles.itemText}>В архив</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

export function ChatMoreMenuButton({
  onPress,
  buttonRef,
}: {
  onPress: () => void;
  buttonRef: React.RefObject<View | null>;
}) {
  return (
    <View ref={buttonRef} collapsable={false}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Меню чата"
        style={({ pressed }) => [styles.trigger, pressed && styles.triggerPressed]}
        onPress={onPress}
        hitSlop={8}
      >
        <Ionicons name="ellipsis-vertical" size={18} color={floraColors.gray} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.35)",
  },
  panel: {
    position: "absolute",
    minWidth: 180,
    backgroundColor: floraColors.surfaceElevated,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: floraColors.border,
    overflow: "hidden",
  },
  item: {
    paddingHorizontal: floraSpacing.grid,
    paddingVertical: floraSpacing.grid,
  },
  itemPressed: {
    backgroundColor: "rgba(250, 250, 250, 0.06)",
  },
  itemText: {
    color: floraColors.text,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
  },
  trigger: {
    width: floraSpacing.gridFine * 2 + 18,
    height: floraSpacing.gridFine * 2 + 18,
    alignItems: "center",
    justifyContent: "center",
  },
  triggerPressed: {
    opacity: 0.72,
  },
});
