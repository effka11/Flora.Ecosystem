import { liveGridStyles } from "@/lib/liveGridStyles";
import { Ionicons } from "@expo/vector-icons";
import { apiListPostDrafts } from "@flora/client-core/api";
import type { PostDraftDto } from "@flora/client-core/contracts";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ComposeModeTabs } from "@/components/compose/ComposeModeTabs";
import {
  COMPOSE_PROFILE_MODE_ID,
  composeModeCommunityId,
} from "@/lib/compose/composeModes";
import { floraColors, floraSpacing } from "@/lib/theme";

export type ComposeDraftGroup = {
  modeId: string;
  label: string;
};

type Props = {
  visible: boolean;
  groups: readonly ComposeDraftGroup[];
  /** Текущий режим compose (профиль / сообщество) — стартовая группа при открытии. */
  activeScopeModeId: string;
  activeDraftUuid: string | null;
  onClose: () => void;
  onSelect: (draft: PostDraftDto, scopeModeId: string) => void;
  onCreate: (scopeModeId: string) => void;
  onRename: (draft: PostDraftDto, label: string) => void;
  onDelete: (draft: PostDraftDto) => void;
};

export function ComposeDraftsSheet({
  visible,
  groups,
  activeScopeModeId,
  activeDraftUuid,
  onClose,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: Props) {
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [scopeModeId, setScopeModeId] = useState(activeScopeModeId);
  const [renameDraft, setRenameDraft] = useState<PostDraftDto | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const searchInputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (!visible) return;
    setScopeModeId(activeScopeModeId);
    setSearch("");
    setSearchOpen(false);
  }, [visible, activeScopeModeId]);

  useEffect(() => {
    if (!searchOpen) return;
    const id = requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [searchOpen]);

  const scopeCommunityId = composeModeCommunityId(scopeModeId);

  const groupTabs = useMemo(
    () => groups.map((g) => ({ id: g.modeId, label: g.label })),
    [groups],
  );

  const draftsQuery = useQuery({
    queryKey: ["post-drafts", scopeCommunityId ?? "primary"],
    queryFn: () => apiListPostDrafts(scopeCommunityId ? { communityId: scopeCommunityId } : undefined),
    enabled: visible,
  });

  const drafts = draftsQuery.data ?? [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return drafts;
    return drafts.filter(
      (d) => d.label.toLowerCase().includes(q) || d.content.toLowerCase().includes(q),
    );
  }, [drafts, search]);

  const closeSearch = useCallback(() => {
    setSearch("");
    setSearchOpen(false);
  }, []);

  const confirmDelete = (draft: PostDraftDto) => {
    Alert.alert("Удалить черновик?", draft.label || "Без названия", [
      { text: "Отмена", style: "cancel" },
      { text: "Удалить", style: "destructive", onPress: () => onDelete(draft) },
    ]);
  };

  const openRename = (draft: PostDraftDto) => {
    setRenameDraft(draft);
    setRenameValue(draft.label);
  };

  const submitRename = () => {
    if (!renameDraft) return;
    const label = renameValue.trim();
    if (!label) return;
    onRename(renameDraft, label);
    setRenameDraft(null);
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.root, { paddingBottom: insets.bottom + floraSpacing.grid }]}>
        <View style={[styles.topBlock, { paddingTop: insets.top + floraSpacing.grid }]}>
          <View style={styles.chromeRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Закрыть"
              style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
              onPress={onClose}
            >
              <Ionicons name="close" size={24} color={floraColors.gray} />
            </Pressable>

            {searchOpen ? (
              <View style={styles.searchBox}>
                <Ionicons name="search-outline" size={20} color={floraColors.gray} />
                <TextInput
                  ref={searchInputRef}
                  style={styles.searchInput}
                  placeholder="Поиск по тексту"
                  placeholderTextColor={floraColors.gray}
                  value={search}
                  onChangeText={setSearch}
                  returnKeyType="search"
                  autoCorrect={false}
                  autoCapitalize="none"
                />
                <Pressable
                  style={styles.searchClear}
                  onPress={closeSearch}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel="Закрыть поиск"
                >
                  <Ionicons name="close" size={18} color={floraColors.greenLight} />
                </Pressable>
              </View>
            ) : (
              <>
                <Text style={styles.title} numberOfLines={1}>
                  Черновики
                </Text>
                <View style={styles.spacer} />
              </>
            )}

            <View style={styles.trailingActions}>
              {!searchOpen ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Поиск"
                  style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
                  onPress={() => setSearchOpen(true)}
                >
                  <Ionicons name="search-outline" size={22} color={floraColors.gray} />
                </Pressable>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Новый черновик"
                style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
                onPress={() => onCreate(scopeModeId)}
              >
                <Ionicons name="add" size={24} color={floraColors.greenLight} />
              </Pressable>
            </View>
          </View>

          {!searchOpen ? (
            <ComposeModeTabs tabs={groupTabs} activeId={scopeModeId} onSelect={setScopeModeId} />
          ) : null}
        </View>

        {draftsQuery.isLoading ? (
          <View style={styles.loading}>
            <ActivityIndicator color={floraColors.greenLight} />
          </View>
        ) : (
          <FlatList
            data={filtered}
            keyExtractor={(item) => item.draftUuid}
            contentContainerStyle={styles.list}
            showsVerticalScrollIndicator={false}
            ListEmptyComponent={
              <Text style={styles.empty}>
                {search.trim()
                  ? "Ничего не найдено."
                  : scopeModeId === COMPOSE_PROFILE_MODE_ID
                    ? "Нет черновиков профиля."
                    : "Нет черновиков в этом сообществе."}
              </Text>
            }
            renderItem={({ item }) => {
              const active = item.draftUuid === activeDraftUuid && scopeModeId === activeScopeModeId;
              return (
                <Pressable
                  style={({ pressed }) => [
                    styles.row,
                    active && styles.rowActive,
                    pressed && styles.pressed,
                  ]}
                  onPress={() => onSelect(item, scopeModeId)}
                  onLongPress={() => {
                    Alert.alert(item.label || "Черновик", undefined, [
                      { text: "Отмена", style: "cancel" },
                      { text: "Переименовать", onPress: () => openRename(item) },
                      { text: "Удалить", style: "destructive", onPress: () => confirmDelete(item) },
                    ]);
                  }}
                >
                  <View style={styles.rowBody}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {item.label || "Без названия"}
                    </Text>
                    <Text style={styles.rowPreview} numberOfLines={2}>
                      {item.content.trim() || "Пустой черновик"}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Удалить"
                    hitSlop={10}
                    onPress={() => confirmDelete(item)}
                    style={({ pressed }) => [styles.deleteBtn, pressed && styles.pressed]}
                  >
                    <Ionicons name="trash-outline" size={18} color={floraColors.gray} />
                  </Pressable>
                </Pressable>
              );
            }}
          />
        )}

        <Modal visible={renameDraft != null} transparent animationType="fade" onRequestClose={() => setRenameDraft(null)}>
          <Pressable style={styles.renameBackdrop} onPress={() => setRenameDraft(null)}>
            <Pressable style={styles.renameCard} onPress={(e) => e.stopPropagation()}>
              <Text style={styles.renameTitle}>Переименовать</Text>
              <TextInput
                style={styles.renameInput}
                value={renameValue}
                onChangeText={setRenameValue}
                maxLength={50}
                autoFocus
                placeholderTextColor={floraColors.gray}
              />
              <View style={styles.renameActions}>
                <Pressable onPress={() => setRenameDraft(null)} style={styles.renameAction}>
                  <Text style={styles.renameCancel}>Отмена</Text>
                </Pressable>
                <Pressable onPress={submitRename} style={styles.renameAction}>
                  <Text style={styles.renameSave}>Сохранить</Text>
                </Pressable>
              </View>
            </Pressable>
          </Pressable>
        </Modal>
      </View>
    </Modal>
  );
}

const styles = liveGridStyles(() => StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: floraColors.bg,
  },
  topBlock: {
    backgroundColor: floraColors.bg,
    borderBottomColor: "rgba(250, 250, 250, 0.08)",
    borderBottomWidth: 1,
    paddingHorizontal: floraSpacing.grid,
    paddingBottom: 0,
    gap: floraSpacing.gridFine,
  },
  chromeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 0,
    minHeight: 45,
  },
  iconButton: {
    width: 45,
    minHeight: 45,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  title: {
    flexShrink: 1,
    marginLeft: floraSpacing.grid,
    color: floraColors.whiteTemplate,
    fontSize: 22,
    fontWeight: "300",
    letterSpacing: 0.88,
    lineHeight: 28,
  },
  spacer: {
    flex: 1,
    minWidth: 0,
  },
  trailingActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginLeft: floraSpacing.gridFine,
  },
  searchBox: {
    flex: 1,
    minWidth: 0,
    minHeight: 45,
    marginLeft: floraSpacing.gridFine * 2,
    borderColor: floraColors.greenDark,
    borderWidth: 1,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    backgroundColor: "transparent",
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    color: floraColors.whiteTemplate,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    paddingVertical: 0,
  },
  searchClear: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(164, 209, 138, 0.12)",
  },
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  list: {
    paddingHorizontal: floraSpacing.grid,
    paddingTop: floraSpacing.grid,
    paddingBottom: floraSpacing.grid * 2,
    gap: floraSpacing.gridFine,
  },
  empty: {
    color: floraColors.gray,
    fontSize: 15,
    fontWeight: "300",
    textAlign: "center",
    marginTop: floraSpacing.grid * 2,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(250, 250, 250, 0.08)",
    backgroundColor: floraColors.surface,
  },
  rowActive: {
    borderColor: floraColors.greenDark,
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  rowTitle: {
    color: floraColors.whiteTemplate,
    fontSize: 15,
    fontWeight: "400",
  },
  rowPreview: {
    color: floraColors.gray,
    fontSize: 13,
    fontWeight: "300",
    lineHeight: 18,
  },
  deleteBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: {
    opacity: 0.72,
  },
  renameBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
    padding: floraSpacing.grid * 2,
  },
  renameCard: {
    width: "100%",
    maxWidth: 360,
    borderRadius: 14,
    backgroundColor: floraColors.surfaceElevated,
    padding: floraSpacing.grid,
    gap: floraSpacing.gridFine * 2,
  },
  renameTitle: {
    color: floraColors.whiteTemplate,
    fontSize: 16,
    fontWeight: "400",
  },
  renameInput: {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: floraColors.greenDark,
    paddingHorizontal: 12,
    color: floraColors.whiteTemplate,
    fontSize: 15,
  },
  renameActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: floraSpacing.grid,
  },
  renameAction: {
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  renameCancel: {
    color: floraColors.gray,
    fontSize: 15,
  },
  renameSave: {
    color: floraColors.greenLight,
    fontSize: 15,
  },
}));
