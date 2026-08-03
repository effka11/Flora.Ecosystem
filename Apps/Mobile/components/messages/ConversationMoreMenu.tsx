import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
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

type FolderPickOption = {
  id: string;
  label: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<View | null>;
  /** dm (default) — полный набор; groupChat — архив + выход. */
  kind?: "dm" | "groupChat";
  isMuted?: boolean;
  isArchived?: boolean;
  onMuteForever: () => void;
  onMuteTemporary: () => void;
  onUnmute: () => void;
  onPin?: () => void;
  /** Папки для пунктов «В „…“» (как Web ConversationMoreMenuPanel). */
  folderOptions?: readonly FolderPickOption[];
  onAddToFolder?: (folderId: string) => void;
  onArchive: () => void;
  onUnarchive: () => void;
  /** DM: удалить чат; group: выйти из группы. */
  onDelete: () => void;
};

type Anchor = {
  top: number;
  right: number;
};

export function ConversationMoreMenu({
  open,
  onClose,
  anchorRef,
  kind = "dm",
  isMuted = false,
  isArchived = false,
  onMuteForever,
  onMuteTemporary,
  onUnmute,
  onPin,
  folderOptions = [],
  onAddToFolder,
  onArchive,
  onUnarchive,
  onDelete,
}: Props) {
  const { width: windowWidth } = useWindowDimensions();
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [muteSubmenuOpen, setMuteSubmenuOpen] = useState(false);
  const isGroup = kind === "groupChat";
  const customFolders = folderOptions.filter((f) => f.id !== "archived");

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

  useEffect(() => {
    if (!open) setMuteSubmenuOpen(false);
  }, [open]);

  const runAndClose = useCallback(
    (action?: () => void) => {
      onClose();
      action?.();
    },
    [onClose],
  );

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <TouchableWithoutFeedback onPress={onClose} accessible={false}>
        <View style={styles.modalRoot}>
          {anchor ? (
            <TouchableWithoutFeedback>
              <View
                style={[styles.panel, { top: anchor.top, right: anchor.right }]}
                accessibilityRole="menu"
                accessibilityViewIsModal
              >
                {isGroup ? (
                  <>
                    <MenuRow
                      icon="archive-outline"
                      label={isArchived ? "Разархивировать" : "Архивировать"}
                      onPress={() => runAndClose(isArchived ? onUnarchive : onArchive)}
                    />
                    <MenuRow
                      icon="exit-outline"
                      label="Выйти из группы"
                      danger
                      onPress={() => runAndClose(onDelete)}
                    />
                  </>
                ) : (
                  <>
                    <MenuRow
                      icon="volume-mute-outline"
                      label="Заглушить"
                      chevron
                      active={muteSubmenuOpen}
                      onPress={() => setMuteSubmenuOpen((v) => !v)}
                    />
                    {muteSubmenuOpen ? (
                      <View style={styles.submenu}>
                        <SubmenuRow label="Насовсем" onPress={() => runAndClose(onMuteForever)} />
                        <SubmenuRow label="На время" onPress={() => runAndClose(onMuteTemporary)} />
                        <SubmenuRow
                          label="Размутить"
                          disabled={!isMuted}
                          onPress={() => {
                            if (!isMuted) return;
                            runAndClose(onUnmute);
                          }}
                        />
                        <SubmenuRow label="Параметры" onPress={() => runAndClose()} />
                      </View>
                    ) : null}

                    <MenuRow
                      icon="pin-outline"
                      label="Закрепить"
                      onPress={() => runAndClose(onPin)}
                    />
                    {customFolders.length === 0 ? (
                      <MenuRow
                        icon="folder-outline"
                        label="Добавить в папку"
                        onPress={() => runAndClose(() => onAddToFolder?.(""))}
                      />
                    ) : (
                      customFolders.map((folder) => (
                        <MenuRow
                          key={folder.id}
                          icon="folder-outline"
                          label={`В «${folder.label}»`}
                          onPress={() => runAndClose(() => onAddToFolder?.(folder.id))}
                        />
                      ))
                    )}
                    <MenuRow
                      icon="archive-outline"
                      label={isArchived ? "Разархивировать" : "Архивировать"}
                      onPress={() => runAndClose(isArchived ? onUnarchive : onArchive)}
                    />
                    <MenuRow
                      icon="trash-outline"
                      label="Удалить чат"
                      danger
                      onPress={() => runAndClose(onDelete)}
                    />
                  </>
                )}
              </View>
            </TouchableWithoutFeedback>
          ) : null}
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

function MenuRow({
  icon,
  label,
  onPress,
  danger = false,
  chevron = false,
  active = false,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  danger?: boolean;
  chevron?: boolean;
  active?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="menuitem"
      accessibilityState={chevron ? { expanded: active } : undefined}
      style={({ pressed }) => [
        styles.menuItem,
        active && styles.menuItemActive,
        pressed && styles.menuItemPressed,
      ]}
      onPress={onPress}
    >
      <View style={styles.menuItemIcon}>
        <Ionicons name={icon} size={18} color={danger ? "#f6a8a8" : floraColors.gray} />
      </View>
      <Text style={[styles.menuItemLabel, danger && styles.menuItemDanger]}>{label}</Text>
      {chevron ? <Text style={styles.menuItemChevron}>{">"}</Text> : null}
    </Pressable>
  );
}

function SubmenuRow({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="menuitem"
      disabled={disabled}
      style={({ pressed }) => [
        styles.submenuItem,
        disabled && styles.submenuItemDisabled,
        pressed && !disabled && styles.menuItemPressed,
      ]}
      onPress={onPress}
    >
      <Text style={[styles.submenuItemLabel, disabled && styles.submenuItemLabelDisabled]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  modalRoot: {
    flex: 1,
    backgroundColor: "transparent",
  },
  panel: {
    position: "absolute",
    minWidth: 220,
    maxWidth: 300,
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
  menuItemActive: {
    backgroundColor: "rgba(250, 250, 250, 0.06)",
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
  menuItemChevron: {
    color: floraColors.gray,
    fontSize: 14,
    fontWeight: "400",
    paddingLeft: floraSpacing.gridFine,
  },
  submenu: {
    marginLeft: 24 + floraSpacing.grid,
    marginBottom: floraSpacing.gridFine,
    gap: 2,
  },
  submenuItem: {
    paddingVertical: floraSpacing.gridFine * 1.5,
    paddingHorizontal: floraSpacing.gridFine * 2,
    borderRadius: 8,
  },
  submenuItemDisabled: {
    opacity: 0.45,
  },
  submenuItemLabel: {
    color: "rgba(250, 250, 250, 0.9)",
    fontSize: 14,
    fontWeight: "400",
    letterSpacing: 0.42,
  },
  submenuItemLabelDisabled: {
    color: "rgba(250, 250, 250, 0.45)",
  },
});
