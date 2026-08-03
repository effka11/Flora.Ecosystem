import { apiGetConversations, apiListGroups } from "@flora/client-core/api";
import type { MsgConversationDto } from "@flora/client-core/contracts";
import {
  decryptGroupMessagePreview,
  type FscpBootstrapStatus,
} from "@flora/client-core/fscp";
import {
  canArchiveChatListPeer,
  canCreateChatListFolder,
  CHAT_LIST_ARCHIVE_FOLDER_ID,
  chatListFolderPageIds,
  countArchivedPeers,
  entitiesToFolderDefs,
  filterConversationsByFolder,
  listVisibleChatFolders,
  membershipByEntityId,
  normalizeChatListFolder,
  type ChatListFolderId,
} from "@flora/client-core/messaging";
import { sharedPresenceStore } from "@flora/client-core/presence";
import { Ionicons } from "@expo/vector-icons";
import { FlashList } from "@shopify/flash-list";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useFocusEffect, useNavigation } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ConversationListRow } from "@/components/messages/ConversationListRow";
import { CreateChatFolderSheet } from "@/components/messages/CreateChatFolderSheet";
import { CreateGroupSheet } from "@/components/messages/CreateGroupSheet";
import { GroupConversationListRow } from "@/components/messages/GroupConversationListRow";
import { MessagesChatFolders } from "@/components/messages/MessagesChatFolders";
import {
  MessagesFolderPager,
  type MessagesFolderConversationRow,
  type MessagesFolderListRow,
  type MessagesFolderPagerHandle,
} from "@/components/messages/MessagesFolderPager";
import { DropdownMenuOverlay } from "@/components/DropdownMenuOverlay";
import { FscpUnlockSheet } from "@/components/fscp/FscpUnlockSheet";
import { TabDropdownPicker, type TabDropdownOption } from "@/components/TabDropdownPicker";
import { useHamburgerMenu } from "@/components/HamburgerMenuProvider";
import { TabScreenSearchHeader } from "@/components/TabScreenSearchHeader";
import { useChatListOverlayStore } from "@/lib/chatListOverlayStore";
import {
  clearTemporaryMute,
  pruneExpiredTemporaryMutes,
  setTemporaryMute,
  useTemporaryMuteUntilByPeer,
} from "@/lib/conversationTemporaryMute";
import { mapGroupListItem, mergeGroupListRefresh } from "@/lib/groupChatMap";
import { groupSortAt, type GroupChat } from "@/lib/groupChatTypes";
import { openGroupChat } from "@/lib/openGroupChat";
import { useMessagesListPreviewDecrypt } from "@/lib/useMessagesListPreviewDecrypt";
import { applyMessagesTabBarHidden } from "@/lib/messagesTabBar";
import { floraColors, floraSpacing, floraTabBarContentPadding } from "@/lib/theme";
import { requestTabBadgesRefresh } from "@/lib/useTabBadges";
import { useFscpStore } from "@/stores/fscpStore";
import { useSessionStore } from "@/stores/sessionStore";

type SortBy = "recent" | "unread";

const SORT_OPTIONS: TabDropdownOption[] = [
  { id: "recent", label: "Последние" },
  { id: "unread", label: "Непрочитанные" },
];

function emptyListMessage(
  hasSearch: boolean,
  totalCount: number,
  folder: ChatListFolderId,
): string {
  if (hasSearch) return "Ничего не найдено. Измените запрос в поиске.";
  if (folder === "archived") {
    return "Пока нет переписок в архиве. Перенесите чат в архив из меню ⋮.";
  }
  if (folder !== "all") {
    return "В этой папке пока нет чатов. Добавьте их из меню ⋮ или при создании.";
  }
  if (totalCount === 0) return "Пока нет переписок. Найдите человека во вкладке «Люди».";
  return "Ничего не найдено. Измените запрос в поиске.";
}

function toFolderListRows(
  list: readonly MsgConversationDto[],
  previews: Readonly<Record<string, string>>,
  groups: readonly GroupChat[],
  groupPreviews: Readonly<Record<string, string>>,
  folder: ChatListFolderId,
  sortBy: SortBy,
): MessagesFolderListRow[] {
  const dmRows: MessagesFolderListRow[] = toConversationRows(list, previews).map((item) => ({
    kind: "dm",
    item,
  }));
  // Groups only appear in «все» (not ORG folders / archive).
  if (folder !== "all") return dmRows;

  let groupRows: MessagesFolderListRow[] = groups.map((g) => ({
    kind: "groupChat",
    group: g,
    preview: groupPreviews[g.conversationUuid] ?? g.lastMessagePreview ?? "",
  }));
  if (sortBy === "unread") {
    groupRows = groupRows.filter((r) => r.kind === "groupChat" && r.group.unreadCount > 0);
  }

  const merged = [...dmRows, ...groupRows];
  merged.sort((a, b) => {
    const aAt =
      a.kind === "dm" ? a.item.lastMessageAt || "" : groupSortAt(a.group);
    const bAt =
      b.kind === "dm" ? b.item.lastMessageAt || "" : groupSortAt(b.group);
    return bAt.localeCompare(aAt);
  });
  return merged;
}

function toConversationRows(
  list: readonly MsgConversationDto[],
  previews: Readonly<Record<string, string>>,
): MessagesFolderConversationRow[] {
  return list.map((item) => {
    const preview =
      previews[item.conversationUuid] ??
      item.lastMessageContent ??
      (item.lastMessageEncryptedForMe ? "Расшифровка…" : "Нет сообщений");
    return { ...item, preview };
  });
}

function fscpBannerMessage(status: FscpBootstrapStatus): { text: string; action?: string } | null {
  switch (status) {
    case "needs_restore":
      return {
        text: "Ключей нет на этом устройстве. Введите пароль аккаунта, чтобы восстановить доступ.",
        action: "Ввести пароль",
      };
    case "wrong_password":
      return {
        text: "Ключи не открылись паролем входа (смена пароля?). Введите актуальный пароль.",
        action: "Ввести пароль",
      };
    case "key_mismatch":
      return {
        text: "Ключи на устройстве и на аккаунте различаются. Восстановите паролем аккаунта.",
        action: "Ввести пароль",
      };
    case "orphan_local_profile":
      return {
        text: "Локальные ключи не связаны с аккаунтом на сервере.",
        action: "Опубликовать",
      };
    case "backup_not_found":
      return { text: "Backup ключей на сервере не найден.", action: "Ввести пароль" };
    case "registration_pending":
      return {
        text: "Ключи сохранены, синхронизация с сервером не завершена.",
        action: "Повторить",
      };
    default:
      return null;
  }
}

const EMPTY_CONVERSATIONS: MsgConversationDto[] = [];
// Matches the global staleTime in providers/FloraProviders.tsx.
const CONVERSATIONS_STALE_REFETCH_MS = 15_000;

export default function MessagesScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const tabBarBottomInset = Math.max(insets.bottom, 8);
  const listPaddingBottom = floraTabBarContentPadding(tabBarBottomInset);
  const me = useSessionStore((s) => s.me);
  const fscpStatus = useFscpStore((s) => s.status);
  const publishLocalKeyConfirmed = useFscpStore((s) => s.publishLocalKeyConfirmed);
  const retryPendingOperation = useFscpStore((s) => s.retryPendingOperation);

  const [search, setSearch] = useState("");
  const [sortOpen, setSortOpen] = useState(false);
  const { closeMenu } = useHamburgerMenu();
  const [sortBy, setSortBy] = useState<SortBy>("recent");
  const [listFolder, setListFolder] = useState<ChatListFolderId>("all");
  const folderPagerRef = useRef<MessagesFolderPagerHandle>(null);
  const createAnchorRef = useRef<View>(null);
  const { width: windowWidth } = useWindowDimensions();
  const folderScrollX = useSharedValue(0);
  const folderPageWidthSV = useSharedValue(windowWidth);
  /** Тап с иконки N обратно в «все» — fade chrome на N, без проезда по промежуточным. */
  const folderReturnFromPageSV = useSharedValue(0);
  const folderReturnProgressSV = useSharedValue(0);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const queryClient = useQueryClient();
  const [groupChats, setGroupChats] = useState<GroupChat[]>([]);
  const [groupPreviews, setGroupPreviews] = useState<Record<string, string>>({});
  const overlayState = useChatListOverlayStore((s) => s.state);
  const hydrateOverlay = useChatListOverlayStore((s) => s.hydrate);
  const setOverlayFscpKeys = useChatListOverlayStore((s) => s.setFscpKeys);
  const refreshOverlay = useChatListOverlayStore((s) => s.refreshFromServer);
  const createFolder = useChatListOverlayStore((s) => s.createFolder);
  const addPeerToEntity = useChatListOverlayStore((s) => s.addPeerToEntity);
  const removeEntity = useChatListOverlayStore((s) => s.removeEntity);
  const setArchived = useChatListOverlayStore((s) => s.setArchived);
  const setMuted = useChatListOverlayStore((s) => s.setMuted);
  const fscpMaterial = useFscpStore((s) => s.material);
  const fscpCanDecrypt = useFscpStore((s) => s.canDecrypt);
  /** Пользователь закрыл sheet — не открывать автоматически снова, пока статус не сменится. */
  const unlockDismissedRef = useRef(false);
  const [presenceEpoch, setPresenceEpoch] = useState(() => sharedPresenceStore.getSessionEpoch());

  useEffect(() => {
    hydrateOverlay(me?.userUuid ?? null);
  }, [hydrateOverlay, me?.userUuid]);

  useEffect(() => {
    if (fscpMaterial && fscpCanDecrypt()) {
      setOverlayFscpKeys({
        agreementPrivateKey: fscpMaterial.agreementPrivateKey,
        signingPrivateKey: fscpMaterial.signingPrivateKey,
      });
    } else {
      setOverlayFscpKeys(null);
    }
  }, [fscpMaterial, fscpCanDecrypt, fscpStatus, setOverlayFscpKeys]);

  useEffect(() => {
    if (!me?.userUuid || !fscpMaterial || !fscpCanDecrypt()) return;
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshOverlay();
    });
    return () => sub.remove();
  }, [me?.userUuid, refreshOverlay, fscpMaterial, fscpCanDecrypt]);

  useEffect(
    () =>
      sharedPresenceStore.subscribe(() => {
        setPresenceEpoch(sharedPresenceStore.getSessionEpoch());
      }),
    [],
  );

  const hasSearch = search.trim().length > 0;

  // Авто-показ строго по «нужен пароль» статусам; сетевые/500/registration не триггерят (ревью п.5).
  const needsPassword =
    fscpStatus === "needs_restore" ||
    fscpStatus === "wrong_password" ||
    fscpStatus === "backup_not_found";

  useEffect(() => {
    if (needsPassword && !unlockDismissedRef.current) {
      setUnlockOpen(true);
    } else if (!needsPassword) {
      unlockDismissedRef.current = false;
      setUnlockOpen(false);
    }
  }, [needsPassword]);

  const query = useQuery({
    queryKey: ["conversations"],
    queryFn: () => apiGetConversations(),
  });
  const groupsQuery = useQuery({
    queryKey: ["groups"],
    queryFn: async () => {
      try {
        return await apiListGroups();
      } catch {
        return [];
      }
    },
  });
  const conversationQueryRef = useRef(query);

  useEffect(() => {
    conversationQueryRef.current = query;
  }, [query]);

  const items = query.data?.items ?? EMPTY_CONVERSATIONS;
  const previews = useMessagesListPreviewDecrypt(items, me?.userUuid);

  useEffect(() => {
    const list = groupsQuery.data;
    if (!list) return;
    setGroupChats((prev) =>
      mergeGroupListRefresh(
        prev,
        list.map((item) => mapGroupListItem(item)),
      ),
    );
  }, [groupsQuery.data]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!me?.userUuid || !fscpMaterial || groupChats.length === 0) return;
      const next: Record<string, string> = {};
      for (const g of groupChats) {
        const wire = g.lastMessageEncryptedWire?.trim();
        if (!wire) {
          next[g.conversationUuid] = g.lastMessagePreview ?? "";
          continue;
        }
        const preview = await decryptGroupMessagePreview({
          encryptedPayload: wire,
          viewerUserUuid: me.userUuid,
          agreementPrivateKey: fscpMaterial.agreementPrivateKey,
        });
        next[g.conversationUuid] = preview ?? "🔒";
      }
      if (!cancelled) setGroupPreviews(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [fscpMaterial, groupChats, me?.userUuid]);

  const archivedByPeer = overlayState.archivedByPeer;
  const mutedByPeer = overlayState.mutedByPeer;
  const customEntities = overlayState.entities;
  const customFolderDefs = useMemo(() => entitiesToFolderDefs(customEntities), [customEntities]);
  const membership = useMemo(() => membershipByEntityId(customEntities), [customEntities]);
  const knownCustomIds = useMemo(
    () => new Set(customEntities.map((e) => e.id)),
    [customEntities],
  );

  // Иконка Архива / лимит слотов — по серверному overlay, не по загруженному списку чатов.
  const archivedCount = useMemo(() => countArchivedPeers(archivedByPeer), [archivedByPeer]);
  const visibleFolders = useMemo(
    () => listVisibleChatFolders(archivedCount, customFolderDefs),
    [archivedCount, customFolderDefs],
  );
  /** Pager: «все» слева (0), затем иконки папок слева→направо. */
  const folderPages = useMemo(
    () => chatListFolderPageIds(visibleFolders),
    [visibleFolders],
  );

  useEffect(() => {
    folderPageWidthSV.value = windowWidth;
  }, [folderPageWidthSV, windowWidth]);

  const folderPagerScroll = useMemo(
    () => ({
      scrollX: folderScrollX,
      pageWidthSV: folderPageWidthSV,
      pages: folderPages,
      returnFromPageSV: folderReturnFromPageSV,
      returnProgressSV: folderReturnProgressSV,
    }),
    [
      folderPageWidthSV,
      folderPages,
      folderReturnFromPageSV,
      folderReturnProgressSV,
      folderScrollX,
    ],
  );
  const canCreateFolder = useMemo(
    () => canCreateChatListFolder(archivedCount, customFolderDefs.length),
    [archivedCount, customFolderDefs.length],
  );
  const canArchivePeer = useMemo(
    () => canArchiveChatListPeer(archivedCount, customFolderDefs.length),
    [archivedCount, customFolderDefs.length],
  );

  const temporaryUntilByPeer = useTemporaryMuteUntilByPeer();
  const mutedDisplayByPeer = useMemo(() => {
    const now = Date.now();
    const next: Record<string, true> = { ...mutedByPeer };
    for (const [peerUuid, untilMs] of Object.entries(temporaryUntilByPeer)) {
      if (untilMs > now) next[peerUuid] = true;
    }
    return next;
  }, [mutedByPeer, temporaryUntilByPeer]);

  useEffect(() => {
    const id = setInterval(() => pruneExpiredTemporaryMutes(), 30_000);
    return () => clearInterval(id);
  }, []);

  const handleMuteForever = useCallback(
    (peerUuid: string, conversationUuid: string) => {
      clearTemporaryMute(peerUuid);
      void setMuted(peerUuid, conversationUuid, true);
    },
    [setMuted],
  );

  const handleMuteTemporary = useCallback(
    (peerUuid: string, conversationUuid: string) => {
      setTemporaryMute(peerUuid);
      void setMuted(peerUuid, conversationUuid, true);
    },
    [setMuted],
  );

  const handleUnmute = useCallback(
    (peerUuid: string, conversationUuid: string) => {
      clearTemporaryMute(peerUuid);
      void setMuted(peerUuid, conversationUuid, false);
    },
    [setMuted],
  );

  const handleArchivedChange = useCallback(
    (peerUuid: string, conversationUuid: string, archived: boolean) => {
      if (archived && !canArchivePeer) {
        Alert.alert(
          "Лимит папок",
          "Нельзя архивировать: уже заняты все четыре слота иконок. Удалите папку, чтобы освободить место для Архива.",
        );
        return;
      }
      void (async () => {
        const ok = await setArchived(peerUuid, conversationUuid, archived);
        if (archived && !ok) {
          Alert.alert(
            "Лимит папок",
            "Нельзя архивировать: уже заняты все четыре слота иконок. Удалите папку, чтобы освободить место для Архива.",
          );
          return;
        }
        requestTabBadgesRefresh();
      })();
    },
    [canArchivePeer, setArchived],
  );
  const activeFolder = normalizeChatListFolder(listFolder, archivedCount, knownCustomIds);
  const folderPickOptions = useMemo(
    () =>
      visibleFolders
        .filter((f) => f.id !== CHAT_LIST_ARCHIVE_FOLDER_ID)
        .map((f) => ({ id: f.id, label: f.label })),
    [visibleFolders],
  );

  useEffect(() => {
    if (listFolder !== activeFolder) setListFolder(activeFolder);
  }, [activeFolder, listFolder]);

  useFocusEffect(
    useCallback(() => {
      applyMessagesTabBarHidden(navigation, tabBarBottomInset, false);
      // Папки/архив с сервера (Web мог создать, пока Mobile был в фоне).
      void refreshOverlay();
      const conversationQuery = conversationQueryRef.current;
      if (
        Date.now() - conversationQuery.dataUpdatedAt >
        CONVERSATIONS_STALE_REFETCH_MS
      ) {
        void conversationQuery.refetch();
      }
      void queryClient.invalidateQueries({ queryKey: ["groups"] });
      if (fscpStatus === "registration_pending") {
        void retryPendingOperation();
      }
    }, [fscpStatus, navigation, queryClient, refreshOverlay, retryPendingOperation, tabBarBottomInset]),
  );

  const banner = fscpBannerMessage(fscpStatus);

  const filterFolderList = useCallback(
    (folder: ChatListFolderId) => {
      let list = filterConversationsByFolder(items, folder, archivedByPeer, membership);
      if (sortBy === "unread") {
        list = list.filter((item) => item.unreadCount > 0);
      }
      return list;
    },
    [archivedByPeer, items, membership, sortBy],
  );

  const dataByPage = useMemo(() => {
    const map = new Map<ChatListFolderId, MessagesFolderListRow[]>();
    for (const folder of folderPages) {
      map.set(
        folder,
        toFolderListRows(
          filterFolderList(folder),
          previews,
          groupChats,
          groupPreviews,
          folder,
          sortBy,
        ),
      );
    }
    return map;
  }, [filterFolderList, folderPages, groupChats, groupPreviews, previews, sortBy]);

  /** Поиск — один список без pager (папки скрыты). */
  const searchListData = useMemo(() => {
    const queryText = search.trim().toLowerCase();
    if (!queryText) return [] as MessagesFolderListRow[];
    let rows = toFolderListRows(
      filterFolderList(activeFolder),
      previews,
      groupChats,
      groupPreviews,
      activeFolder,
      sortBy,
    );
    rows = rows.filter((row) => {
      if (row.kind === "groupChat") {
        const preview = (row.preview || row.group.lastMessagePreview || "").toLowerCase();
        return row.group.title.toLowerCase().includes(queryText) || preview.includes(queryText);
      }
      const preview = (
        previews[row.item.conversationUuid] ??
        row.item.lastMessageContent ??
        "…"
      ).toLowerCase();
      return (
        row.item.otherDisplayName.toLowerCase().includes(queryText) ||
        row.item.otherUsername.toLowerCase().includes(queryText) ||
        preview.includes(queryText)
      );
    });
    return rows;
  }, [activeFolder, filterFolderList, groupChats, groupPreviews, previews, search, sortBy]);

  useEffect(() => {
    const uuids = items.map((c) => c.otherUserUuid).filter(Boolean);
    if (!sharedPresenceStore.surfacesAccepted) {
      return () => sharedPresenceStore.unregisterSurface("messages-list");
    }
    sharedPresenceStore.registerSurface("messages-list", uuids);
    void sharedPresenceStore.resyncSnapshots().catch(() => {});
    return () => sharedPresenceStore.unregisterSurface("messages-list");
  }, [items, presenceEpoch]);

  const closeDropdowns = useCallback(() => {
    setSortOpen(false);
    setCreateMenuOpen(false);
  }, []);

  const handleSortOpenChange = useCallback((open: boolean) => {
    setSortOpen(open);
    if (open) {
      setCreateMenuOpen(false);
      closeMenu();
    }
  }, [closeMenu]);

  const onBannerAction = () => {
    if (fscpStatus === "orphan_local_profile") {
      void publishLocalKeyConfirmed();
      return;
    }
    if (fscpStatus === "registration_pending") {
      void retryPendingOperation();
      return;
    }
    // Парольные статусы (needs_restore/wrong_password/backup_not_found/key_mismatch) →
    // inline-восстановление на месте, без перехода в Настройки → Безопасность.
    unlockDismissedRef.current = false;
    setUnlockOpen(true);
  };

  return (
    <View style={styles.root}>
      <View style={[styles.topBlock, { paddingTop: insets.top + floraSpacing.grid }]}>
        <TabScreenSearchHeader
          title="Сообщения"
          placeholder="Поиск чатов и сообщений"
          value={search}
          onChangeText={(value) => {
            setSearch(value);
            closeDropdowns();
          }}
          onBeforeMenuOpen={closeDropdowns}
          createAction={{
            accessibilityLabel: "Создать папку или группу",
            anchorRef: createAnchorRef,
            onPress: () => {
              setSortOpen(false);
              closeMenu();
              setCreateMenuOpen(true);
            },
          }}
        />

        {banner ? (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>{banner.text}</Text>
            {banner.action ? (
              <Pressable onPress={onBannerAction}>
                <Text style={styles.bannerAction}>{banner.action}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {!hasSearch ? (
          <View style={styles.navigationRow}>
            <TabDropdownPicker
              accessibilityLabel="Сортировка"
              options={SORT_OPTIONS}
              activeId={sortBy}
              open={sortOpen}
              onOpenChange={handleSortOpenChange}
              onSelect={(id) => setSortBy(id as SortBy)}
            />
            <MessagesChatFolders
              folders={visibleFolders}
              activeFolder={activeFolder}
              pagerScroll={folderPagerScroll}
              onSelect={(folder) => {
                // Как switchKind на ленте: цель + cancel предыдущего settle.
                folderPagerRef.current?.selectFolder(folder);
              }}
              onDeleteFolder={(folderId) => {
                void removeEntity(folderId);
                if (listFolder === folderId) {
                  folderPagerRef.current?.selectFolder("all");
                }
              }}
            />
          </View>
        ) : null}
      </View>

      <DropdownMenuOverlay
        open={createMenuOpen}
        onClose={() => setCreateMenuOpen(false)}
        anchorRef={createAnchorRef}
        menuStyle={styles.createMenu}
        alignEnd
      >
        <Pressable
          accessibilityRole="menuitem"
          style={({ pressed }) => [styles.createMenuItem, pressed && styles.createMenuItemPressed]}
          onPress={() => {
            setCreateMenuOpen(false);
            if (!canCreateFolder) {
              Alert.alert(
                "Лимит папок",
                "Можно показать не больше четырёх иконок, включая Архив. Удалите папку или уберите чаты из архива.",
              );
              return;
            }
            setCreateFolderOpen(true);
          }}
        >
          <View style={styles.createMenuItemIcon}>
            <Ionicons name="folder-outline" size={18} color={floraColors.gray} />
          </View>
          <Text style={styles.createMenuLabel}>Папка</Text>
        </Pressable>
        <Pressable
          accessibilityRole="menuitem"
          style={({ pressed }) => [styles.createMenuItem, pressed && styles.createMenuItemPressed]}
          onPress={() => {
            setCreateMenuOpen(false);
            setCreateGroupOpen(true);
          }}
        >
          <View style={styles.createMenuItemIcon}>
            <Ionicons name="people-outline" size={18} color={floraColors.gray} />
          </View>
          <Text style={styles.createMenuLabel}>Группа</Text>
        </Pressable>
      </DropdownMenuOverlay>

      {hasSearch ? (
        <FlashList
          style={styles.list}
          data={searchListData}
          keyExtractor={(item) =>
            item.kind === "groupChat"
              ? `g:${item.group.conversationUuid}`
              : item.item.conversationUuid
          }
          contentContainerStyle={[styles.listContent, { paddingBottom: listPaddingBottom }]}
          refreshControl={
            <RefreshControl
              refreshing={query.isRefetching || groupsQuery.isRefetching}
              onRefresh={() => {
                void query.refetch();
                void groupsQuery.refetch();
              }}
              tintColor={floraColors.greenLight}
            />
          }
          renderItem={({ item }) =>
            item.kind === "groupChat" ? (
              <GroupConversationListRow group={item.group} preview={item.preview} />
            ) : (
              <ConversationListRow
                item={item.item}
                isMuted={item.item.otherUserUuid in mutedDisplayByPeer}
                isArchived={item.item.otherUserUuid in archivedByPeer}
                folderOptions={folderPickOptions}
                onMuteForever={() =>
                  handleMuteForever(item.item.otherUserUuid, item.item.conversationUuid)
                }
                onMuteTemporary={() =>
                  handleMuteTemporary(item.item.otherUserUuid, item.item.conversationUuid)
                }
                onUnmute={() => handleUnmute(item.item.otherUserUuid, item.item.conversationUuid)}
                onArchivedChange={(archived) =>
                  handleArchivedChange(
                    item.item.otherUserUuid,
                    item.item.conversationUuid,
                    archived,
                  )
                }
                onAddToFolder={(folderId) => void addPeerToEntity(folderId, item.item.otherUserUuid)}
              />
            )
          }
          ListEmptyComponent={
            query.isLoading ? (
              <View style={styles.loading}>
                <ActivityIndicator color={floraColors.greenLight} />
                <Text style={styles.emptyHint}>Загрузка чатов…</Text>
              </View>
            ) : query.isError ? (
              <Text style={styles.emptyHint}>Не удалось загрузить чаты.</Text>
            ) : (
              <Text style={styles.emptyHint}>
                {emptyListMessage(true, items.length, activeFolder)}
              </Text>
            )
          }
        />
      ) : (
        <MessagesFolderPager
          ref={folderPagerRef}
          pages={folderPages}
          activeFolder={activeFolder}
          onActiveFolderChange={setListFolder}
          scrollX={folderScrollX}
          pageWidthSV={folderPageWidthSV}
          returnFromPageSV={folderReturnFromPageSV}
          returnProgressSV={folderReturnProgressSV}
          dataByPage={dataByPage}
          listPaddingBottom={listPaddingBottom}
          refreshing={query.isRefetching || groupsQuery.isRefetching}
          onRefresh={() => {
            void query.refetch();
            void groupsQuery.refetch();
          }}
          loading={query.isLoading}
          error={query.isError}
          emptyMessage={(folder) => emptyListMessage(false, items.length + groupChats.length, folder)}
          mutedByPeer={mutedDisplayByPeer}
          archivedByPeer={archivedByPeer}
          folderOptions={folderPickOptions}
          onMuteForever={handleMuteForever}
          onMuteTemporary={handleMuteTemporary}
          onUnmute={handleUnmute}
          onArchivedChange={handleArchivedChange}
          onAddToFolder={(folderId, peerUuid) => {
            void addPeerToEntity(folderId, peerUuid);
          }}
        />
      )}

      <CreateChatFolderSheet
        visible={createFolderOpen}
        onClose={() => setCreateFolderOpen(false)}
        conversations={items}
        onCreate={(result) => {
          void (async () => {
            const created = await createFolder({
              label: result.name,
              icon: result.icon,
              memberPeerUuids: result.memberUserUuids,
            });
            if (created) {
              folderPagerRef.current?.selectFolder(created.id);
              return;
            }
            Alert.alert(
              "Не удалось создать папку",
              "Возможно, заняты все слоты иконок — удалите папку или очистите архив.",
            );
          })();
        }}
      />

      <CreateGroupSheet
        visible={createGroupOpen}
        conversations={items}
        onClose={() => setCreateGroupOpen(false)}
        onCreated={(detail) => {
          void queryClient.invalidateQueries({ queryKey: ["groups"] });
          openGroupChat(detail.conversationUuid, detail.title);
        }}
      />

      <FscpUnlockSheet
        visible={unlockOpen}
        userUuid={me?.userUuid ?? null}
        onClose={() => {
          unlockDismissedRef.current = true;
          setUnlockOpen(false);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: floraColors.bg },
  topBlock: {
    backgroundColor: floraColors.bg,
    borderBottomColor: "rgba(250, 250, 250, 0.08)",
    borderBottomWidth: 1,
    paddingHorizontal: floraSpacing.grid,
    paddingBottom: 0,
    gap: 13,
    overflow: "visible",
  },
  banner: {
    backgroundColor: "rgba(255, 180, 60, 0.12)",
    borderRadius: 8,
    padding: 12,
    gap: 8,
  },
  bannerText: {
    color: floraColors.text,
    fontSize: 13,
    lineHeight: 18,
  },
  bannerAction: {
    color: floraColors.greenLight,
    fontSize: 14,
    fontWeight: "600",
  },
  navigationRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    width: "100%",
    gap: floraSpacing.grid,
    overflow: "visible",
  },
  /** Как PostMoreMenu / TabDropdown — не popoverInset из compose. */
  createMenu: {
    minWidth: 200,
    maxWidth: 280,
    borderRadius: 12,
    backgroundColor: floraColors.bg,
    borderWidth: 1,
    borderColor: "rgba(250, 250, 250, 0.06)",
    padding: floraSpacing.gridFine * 1.5,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 24,
    elevation: 12,
  },
  createMenuItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.grid,
    width: "100%",
    paddingVertical: floraSpacing.gridFine * 1.5,
    paddingHorizontal: floraSpacing.gridFine * 2,
    borderRadius: 8,
  },
  createMenuItemPressed: {
    backgroundColor: "rgba(250, 250, 250, 0.06)",
  },
  createMenuItemIcon: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  createMenuLabel: {
    flex: 1,
    color: "rgba(250, 250, 250, 0.9)",
    fontSize: 14,
    fontWeight: "400",
    letterSpacing: 0.42,
  },
  list: {
    flex: 1,
  },
  listContent: {},
  loading: {
    alignItems: "center",
    gap: floraSpacing.grid,
    paddingVertical: floraSpacing.grid * 3,
  },
  emptyHint: {
    color: floraColors.gray,
    textAlign: "center",
    marginTop: floraSpacing.grid * 3,
    paddingHorizontal: floraSpacing.grid * 2,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    lineHeight: 22,
  },
});
