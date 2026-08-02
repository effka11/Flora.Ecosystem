import type { ChatListFolderDef, ChatListFolderId } from "@flora/client-core/messaging";
import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, View } from "react-native";
import { floraColors, floraSpacing, floraTabFilter } from "@/lib/theme";

type Props = {
  folders: readonly ChatListFolderDef[];
  activeFolder: ChatListFolderId;
  onSelect: (folder: ChatListFolderId) => void;
  /** Заглушка: создать папку. */
  onCreateFolder?: () => void;
};

const FOLDER_ICONS: Record<ChatListFolderDef["id"], keyof typeof Ionicons.glyphMap> = {
  archived: "archive-outline",
};

/** Совпадает с `iconButton` в TabScreenSearchHeader — «+» под лупой. */
const SEARCH_ICON_SLOT = 45;

/**
 * Папки списка чатов — справа от фильтра.
 * «+» прижат вправо под лупой; папки (архив и др.) левее него.
 * Логика видимости — `@flora/client-core/messaging` (тот же модуль для Web позже).
 */
export function MessagesChatFolders({
  folders,
  activeFolder,
  onSelect,
  onCreateFolder,
}: Props) {
  return (
    <View style={styles.row} accessibilityRole="toolbar" accessibilityLabel="Папки чатов">
      {folders.map((folder) => {
        const active = activeFolder === folder.id;
        return (
          <Pressable
            key={folder.id}
            accessibilityRole="button"
            accessibilityLabel={folder.label}
            accessibilityState={{ selected: active }}
            style={({ pressed }) => [
              styles.folderBtn,
              active && styles.btnActive,
              pressed && styles.btnPressed,
            ]}
            onPress={() => onSelect(active ? "all" : folder.id)}
            hitSlop={6}
          >
            <Ionicons
              name={FOLDER_ICONS[folder.id]}
              size={18}
              color={active ? floraColors.greenLight : floraColors.gray}
            />
          </Pressable>
        );
      })}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Создать папку"
        style={({ pressed }) => [styles.addBtn, pressed && styles.btnPressed]}
        onPress={onCreateFolder}
        hitSlop={6}
      >
        <Ionicons name="add" size={22} color={floraColors.greenLight} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    marginLeft: "auto",
    gap: floraSpacing.gridFine,
    height: floraTabFilter.triggerHeight,
  },
  folderBtn: {
    width: floraSpacing.grid * 2,
    height: floraTabFilter.triggerHeight,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  addBtn: {
    width: SEARCH_ICON_SLOT,
    height: floraTabFilter.triggerHeight,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  btnActive: {
    backgroundColor: "rgba(164, 209, 138, 0.12)",
  },
  btnPressed: {
    backgroundColor: "rgba(250, 250, 250, 0.08)",
  },
});
