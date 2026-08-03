import {
  CHAT_LIST_ARCHIVE_FOLDER_ID,
  orderChatListFolders,
  type ChatListFolderDef,
  type ChatListFolderId,
} from "@flora/client-core/messaging";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Pressable,
  StyleSheet,
  View,
  type LayoutChangeEvent,
} from "react-native";
import Reanimated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import type { MessagesFolderPagerScroll } from "@/components/messages/messagesFolderPagerScroll";
import { floraColors, floraTabFilter } from "@/lib/theme";

type Props = {
  folders: readonly ChatListFolderDef[];
  activeFolder: ChatListFolderId;
  onSelect: (folder: ChatListFolderId) => void;
  onDeleteFolder?: (folderId: string) => void;
  /** scrollX pager’а — иконки/подчёркивание как подвкладки ленты при свайпе. */
  pagerScroll?: MessagesFolderPagerScroll | null;
};

type TabLayout = { x: number; width: number };

/** all + до 4 иконок папок. */
const MAX_PAGER_PAGES = 5;
/** Как `iconButton` в TabScreenSearchHeader — правая папка центрируется под «+». */
const HEADER_TRAILING_ICON_SLOT = 45;
/** Тап-зона папки: плотнее 45; padding ряда выравнивает центр последней под «+». */
const FOLDER_ICON_SLOT = 36;
const FOLDER_ICON_GAP = 8;

function resolveFolderIcon(folder: ChatListFolderDef): keyof typeof Ionicons.glyphMap {
  if (folder.id === CHAT_LIST_ARCHIVE_FOLDER_ID) return "archive-outline";
  if (folder.kind === "group") return "people-outline";
  if (folder.icon && folder.icon in Ionicons.glyphMap) {
    return folder.icon as keyof typeof Ionicons.glyphMap;
  }
  return "folder-outline";
}

/**
 * Две статичные иконки + opacity на UI-thread — дешевле interpolateColor/animatedProps.
 */
function FolderIconSynced({
  name,
  pageIndex,
  scrollX,
  pageWidthSV,
  returnFromPageSV,
  returnProgressSV,
}: {
  name: keyof typeof Ionicons.glyphMap;
  pageIndex: number;
  scrollX: SharedValue<number>;
  pageWidthSV: SharedValue<number>;
  returnFromPageSV: SharedValue<number>;
  returnProgressSV: SharedValue<number>;
}) {
  const idleStyle = useAnimatedStyle(() => {
    const retFrom = returnFromPageSV.value;
    if (retFrom >= 1) {
      // Тап all↔иконка: fade только на якоре.
      const active = pageIndex === retFrom ? returnProgressSV.value : 0;
      return { opacity: 1 - active };
    }
    const width = pageWidthSV.value;
    const page = width > 0 ? scrollX.value / width : 0;
    const dist = Math.min(1, Math.abs(page - pageIndex));
    return { opacity: dist };
  });

  const activeStyle = useAnimatedStyle(() => {
    const retFrom = returnFromPageSV.value;
    if (retFrom >= 1) {
      const active = pageIndex === retFrom ? returnProgressSV.value : 0;
      return { opacity: active };
    }
    const width = pageWidthSV.value;
    const page = width > 0 ? scrollX.value / width : 0;
    const dist = Math.min(1, Math.abs(page - pageIndex));
    return { opacity: 1 - dist };
  });

  return (
    <View style={styles.iconStack}>
      <Reanimated.View style={[styles.iconLayer, idleStyle]}>
        <Ionicons name={name} size={18} color={floraColors.gray} />
      </Reanimated.View>
      <Reanimated.View style={[styles.iconLayer, styles.iconLayerActive, activeStyle]}>
        <Ionicons name={name} size={18} color={floraColors.greenLight} />
      </Reanimated.View>
    </View>
  );
}

/**
 * Папки списка чатов — справа от фильтра.
 * Подчёркивание и заливка синхронизированы с pager scrollX (как Рекомендации/Подписки).
 */
export function MessagesChatFolders({
  folders,
  activeFolder,
  onSelect,
  onDeleteFolder,
  pagerScroll = null,
}: Props) {
  const ordered = useMemo(() => orderChatListFolders(folders), [folders]);
  const knownIds = useMemo(() => new Set(ordered.map((f) => f.id)), [ordered]);
  const pages = pagerScroll?.pages ?? null;

  const pageIndexById = useMemo(() => {
    const map = new Map<string, number>();
    if (!pages) return map;
    pages.forEach((id, index) => map.set(id, index));
    return map;
  }, [pages]);

  const [layouts, setLayouts] = useState<Record<string, TabLayout>>({});
  /** Layout'ы на UI-thread — indicator не читает JS-объект каждый кадр. */
  const layoutXSV = useSharedValue<number[]>(Array.from({ length: MAX_PAGER_PAGES }, () => -1));
  const layoutWSV = useSharedValue<number[]>(Array.from({ length: MAX_PAGER_PAGES }, () => -1));
  const pageCountSV = useSharedValue(0);

  const recordLayout = useCallback((folderId: string, event: LayoutChangeEvent) => {
    const { x, width } = event.nativeEvent.layout;
    if (width <= 0) return;
    setLayouts((prev) => {
      const existing = prev[folderId];
      if (existing?.x === x && existing?.width === width) return prev;
      return { ...prev, [folderId]: { x, width } };
    });
  }, []);

  useEffect(() => {
    setLayouts((prev) => {
      let changed = false;
      const next: Record<string, TabLayout> = {};
      for (const [id, layout] of Object.entries(prev)) {
        if (knownIds.has(id)) next[id] = layout;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [knownIds]);

  useEffect(() => {
    if (!pages) {
      pageCountSV.value = 0;
      return;
    }
    const xs = Array.from({ length: MAX_PAGER_PAGES }, () => -1);
    const ws = Array.from({ length: MAX_PAGER_PAGES }, () => -1);
    for (let i = 0; i < pages.length && i < MAX_PAGER_PAGES; i++) {
      const id = pages[i];
      const L = id ? layouts[id] : undefined;
      if (!L) continue;
      xs[i] = L.x;
      ws[i] = L.width;
    }
    layoutXSV.value = xs;
    layoutWSV.value = ws;
    pageCountSV.value = pages.length;
  }, [layoutWSV, layoutXSV, layouts, pageCountSV, pages]);

  const scrollX = pagerScroll?.scrollX;
  const pageWidthSV = pagerScroll?.pageWidthSV;
  const returnFromPageSV = pagerScroll?.returnFromPageSV;
  const returnProgressSV = pagerScroll?.returnProgressSV;

  const indicatorStyle = useAnimatedStyle(() => {
    if (!scrollX || !pageWidthSV || !returnFromPageSV || !returnProgressSV) {
      return { opacity: 0, width: 0, transform: [{ translateX: 0 }] };
    }

    const width = pageWidthSV.value;
    const count = pageCountSV.value;
    if (width <= 0 || count < 2) {
      return { opacity: 0, width: 0, transform: [{ translateX: 0 }] };
    }

    const xs = layoutXSV.value;
    const ws = layoutWSV.value;
    const retFrom = returnFromPageSV.value;

    // Тап all↔иконка: underline fade на якоре (не едет по промежуточным).
    if (retFrom >= 1) {
      const x = xs[retFrom] ?? -1;
      const w = ws[retFrom] ?? -1;
      if (x < 0 || w <= 0) return { opacity: 0, width: 0, transform: [{ translateX: 0 }] };
      return {
        opacity: returnProgressSV.value,
        width: w,
        transform: [{ translateX: x }],
      };
    }

    const page = scrollX.value / width;
    const maxPage = count - 1;

    // [all=0 → first folder]: fade-in на позиции первой папки.
    if (page <= 1) {
      const x = xs[1] ?? -1;
      const w = ws[1] ?? -1;
      if (x < 0 || w <= 0) return { opacity: 0, width: 0, transform: [{ translateX: 0 }] };
      return {
        opacity: interpolate(page, [0, 1], [0, 1], Extrapolation.CLAMP),
        width: w,
        transform: [{ translateX: x }],
      };
    }

    const i0 = Math.min(Math.max(Math.floor(page), 1), maxPage);
    const i1 = Math.min(i0 + 1, maxPage);
    const t = Math.min(Math.max(page - i0, 0), 1);
    const x0 = xs[i0] ?? -1;
    const w0 = ws[i0] ?? -1;
    const x1 = xs[i1] ?? -1;
    const w1 = ws[i1] ?? -1;
    if (x0 < 0 || w0 <= 0) return { opacity: 0, width: 0, transform: [{ translateX: 0 }] };
    if (x1 < 0 || w1 <= 0 || i0 === i1) {
      return { opacity: 1, width: w0, transform: [{ translateX: x0 }] };
    }
    return {
      opacity: 1,
      width: w0 + (w1 - w0) * t,
      transform: [{ translateX: x0 + (x1 - x0) * t }],
    };
  });

  const requestDelete = (folder: ChatListFolderDef) => {
    Alert.alert(
      "Удалить папку?",
      `«${folder.label}» будет удалена. Чаты останутся в общем списке.`,
      [
        { text: "Отмена", style: "cancel" },
        {
          text: "Удалить",
          style: "destructive",
          onPress: () => onDeleteFolder?.(folder.id),
        },
      ],
    );
  };

  return (
    <View style={styles.row} accessibilityLabel="Папки чатов">
      <View style={styles.foldersTrack}>
        <Reanimated.View pointerEvents="none" style={[styles.underline, indicatorStyle]} />

        {ordered.map((folder) => {
          const active = activeFolder === folder.id;
          const avatarUri = folder.kind === "group" ? folder.avatarUri : null;
          const canDelete = folder.id !== CHAT_LIST_ARCHIVE_FOLDER_ID;
          const pageIndex = pageIndexById.get(folder.id) ?? -1;
          return (
            <Pressable
              key={folder.id}
              accessibilityRole="button"
              accessibilityLabel={folder.label}
              accessibilityState={{ selected: active }}
              accessibilityHint={canDelete ? "Удерживайте, чтобы удалить папку" : undefined}
              style={styles.folderBtn}
              onLayout={(event) => recordLayout(folder.id, event)}
              onPress={() => onSelect(active ? "all" : folder.id)}
              onLongPress={canDelete ? () => requestDelete(folder) : undefined}
              delayLongPress={380}
              hitSlop={6}
            >
              {avatarUri ? (
                <Image source={{ uri: avatarUri }} style={styles.groupAvatar} />
              ) : scrollX &&
                pageWidthSV &&
                returnFromPageSV &&
                returnProgressSV &&
                pageIndex >= 0 ? (
                <FolderIconSynced
                  name={resolveFolderIcon(folder)}
                  pageIndex={pageIndex}
                  scrollX={scrollX}
                  pageWidthSV={pageWidthSV}
                  returnFromPageSV={returnFromPageSV}
                  returnProgressSV={returnProgressSV}
                />
              ) : (
                <Ionicons
                  name={resolveFolderIcon(folder)}
                  size={18}
                  color={active ? floraColors.greenLight : floraColors.gray}
                />
              )}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    marginLeft: "auto",
    // Сдвиг: центр последней иконки совпадает с центром «+» (slot 45).
    paddingRight: (HEADER_TRAILING_ICON_SLOT - FOLDER_ICON_SLOT) / 2,
    height: floraTabFilter.triggerHeight,
  },
  foldersTrack: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    gap: FOLDER_ICON_GAP,
    height: floraTabFilter.triggerHeight,
    overflow: "visible",
  },
  folderBtn: {
    width: FOLDER_ICON_SLOT,
    height: floraTabFilter.triggerHeight,
    alignItems: "center",
    justifyContent: "center",
  },
  iconStack: {
    width: 18,
    height: 18,
  },
  iconLayer: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
  },
  iconLayerActive: {
    zIndex: 1,
  },
  groupAvatar: {
    width: 22,
    height: 22,
    borderRadius: 11,
  },
  underline: {
    position: "absolute",
    left: 0,
    bottom: 0,
    height: floraTabFilter.indicatorHeight,
    borderRadius: 999,
    backgroundColor: floraColors.greenLight,
    zIndex: 2,
  },
});
