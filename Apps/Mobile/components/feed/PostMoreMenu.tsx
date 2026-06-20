import { Ionicons } from "@expo/vector-icons";
import { useCallback, useLayoutEffect, useRef, useState, type ElementRef } from "react";
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
import { FeedPostCloseIcon, FeedPostMoreIcon } from "./FeedPostIcons";

type Props = {
  isOwnPost?: boolean;
  canDeletePost?: boolean;
  onDeletePost?: () => void;
};

type Anchor = {
  top: number;
  right: number;
};

export function PostMoreMenuTrigger({
  isOwnPost = false,
  canDeletePost = false,
  onDeletePost,
}: Props) {
  const { width: windowWidth } = useWindowDimensions();
  const wrapRef = useRef<View>(null);
  const triggerRef = useRef<ElementRef<typeof Pressable>>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const showDelete = canDeletePost && Boolean(onDeletePost);
  const showHideAuthor = !showDelete && !isOwnPost;

  const close = useCallback(() => {
    setOpen(false);
    setAnchor(null);
  }, []);

  const updateAnchor = useCallback(() => {
    triggerRef.current?.measureInWindow((triggerX, triggerY, triggerWidth, triggerHeight) => {
      const visualBottom = triggerY + triggerHeight + floraFeedPost.moreBtnNudgeY;
      setAnchor({
        top: visualBottom + floraFeedPost.moreMenuGapBelow,
        right: Math.max(floraSpacing.grid, windowWidth - (triggerX + triggerWidth)),
      });
    });
  }, [windowWidth]);

  useLayoutEffect(() => {
    if (!open) return;
    updateAnchor();
  }, [open, updateAnchor]);

  const toggle = useCallback(() => {
    if (open) {
      close();
      return;
    }
    setOpen(true);
  }, [close, open]);

  return (
    <View ref={wrapRef} style={[styles.wrap, open && styles.wrapOpen]} collapsable={false}>
      <Pressable
        ref={triggerRef}
        accessibilityRole="button"
        accessibilityLabel={open ? "Закрыть меню поста" : "Меню поста"}
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => [styles.trigger, pressed && styles.triggerPressed]}
        onPress={toggle}
      >
        {open ? (
          <FeedPostCloseIcon color={floraColors.gray} />
        ) : (
          <FeedPostMoreIcon color={floraColors.gray} />
        )}
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={close}
        statusBarTranslucent
      >
        <TouchableWithoutFeedback onPress={close} accessible={false}>
          <View style={styles.modalRoot}>
            {anchor ? (
              <TouchableWithoutFeedback>
                <View
                  style={[styles.panel, { top: anchor.top, right: anchor.right }]}
                  accessibilityRole="menu"
                  accessibilityViewIsModal
                >
                  <MenuRow icon="bookmark-outline" label="Сохранить" onPress={close} />
                  <MenuRow icon="share-outline" label="Поделиться" onPress={close} />

                  {!showDelete ? (
                    <MenuRow icon="eye-off-outline" label="Не интересно" onPress={close} />
                  ) : null}
                  {showHideAuthor ? (
                    <MenuRow icon="person-remove-outline" label="Скрыть автора" onPress={close} />
                  ) : null}

                  {showDelete ? (
                    <MenuRow
                      icon="trash-outline"
                      label="Удалить пост"
                      danger
                      onPress={() => {
                        onDeletePost!();
                        close();
                      }}
                    />
                  ) : null}

                  {!showDelete ? (
                    <MenuRow icon="flag-outline" label="Пожаловаться" onPress={close} />
                  ) : null}
                </View>
              </TouchableWithoutFeedback>
            ) : null}
          </View>
        </TouchableWithoutFeedback>
      </Modal>
    </View>
  );
}

function MenuRow({
  icon,
  label,
  onPress,
  danger = false,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  danger?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="menuitem"
      style={({ pressed }) => [styles.menuItem, pressed && styles.menuItemPressed]}
      onPress={onPress}
    >
      <View style={styles.menuItemIcon}>
        <Ionicons name={icon} size={18} color={danger ? "#f6a8a8" : floraColors.gray} />
      </View>
      <Text style={[styles.menuItemLabel, danger && styles.menuItemDanger]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "relative",
  },
  wrapOpen: {
    zIndex: 200,
  },
  trigger: {
    width: floraFeedPost.moreBtnSize,
    height: floraFeedPost.moreBtnSize,
    padding: floraFeedPost.moreBtnPadding,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
    transform: [{ translateY: floraFeedPost.moreBtnNudgeY }],
  },
  triggerPressed: {
    backgroundColor: "rgba(250, 250, 250, 0.08)",
  },
  modalRoot: {
    flex: 1,
    backgroundColor: "transparent",
  },
  panel: {
    position: "absolute",
    minWidth: 200,
    maxWidth: 280,
    borderRadius: 12,
    backgroundColor: floraColors.bg,
    borderWidth: 1,
    borderColor: "rgba(250, 250, 250, 0.06)",
    padding: floraSpacing.gridFine * 1.5,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 24,
    elevation: 12,
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
  menuItemDanger: {
    color: "#f6a8a8",
  },
});
