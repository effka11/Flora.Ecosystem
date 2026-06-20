import { apiGetConversations } from "@flora/client-core/api";
import type { MsgConversationDto } from "@flora/client-core/contracts";
import type { FscpBootstrapStatus } from "@flora/client-core/fscp";
import { FlashList } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ConversationListRow } from "@/components/messages/ConversationListRow";
import { FscpUnlockSheet } from "@/components/fscp/FscpUnlockSheet";
import { TabDropdownPicker, type TabDropdownOption } from "@/components/TabDropdownPicker";
import { TabScreenSearchHeader } from "@/components/TabScreenSearchHeader";
import { useMessagesListPreviewDecrypt } from "@/lib/useMessagesListPreviewDecrypt";
import { floraColors, floraSpacing } from "@/lib/theme";
import { useFscpStore } from "@/stores/fscpStore";
import { useSessionStore } from "@/stores/sessionStore";

type SortBy = "recent" | "unread";
type FilterFrom = "all" | "people" | "communities" | "dev";

const SORT_OPTIONS: TabDropdownOption[] = [
  { id: "recent", label: "Последние" },
  { id: "unread", label: "Непрочитанные" },
];

const FILTER_OPTIONS: TabDropdownOption[] = [
  { id: "all", label: "От всех" },
  { id: "people", label: "От людей" },
  { id: "communities", label: "От сообществ" },
  { id: "dev", label: "От разработчика" },
];

function emptyListMessage(hasSearch: boolean, totalCount: number): string {
  if (hasSearch) return "Ничего не найдено. Измените запрос в поиске.";
  if (totalCount === 0) return "Пока нет переписок. Найдите человека во вкладке «Люди».";
  return "Ничего не найдено. Измените запрос в поиске.";
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

type ConversationRow = MsgConversationDto & { preview: string };

const EMPTY_CONVERSATIONS: MsgConversationDto[] = [];

export default function MessagesScreen() {
  const insets = useSafeAreaInsets();
  const me = useSessionStore((s) => s.me);
  const fscpStatus = useFscpStore((s) => s.status);
  const publishLocalKeyConfirmed = useFscpStore((s) => s.publishLocalKeyConfirmed);
  const retryPendingOperation = useFscpStore((s) => s.retryPendingOperation);

  const [search, setSearch] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortBy, setSortBy] = useState<SortBy>("recent");
  const [filterFrom, setFilterFrom] = useState<FilterFrom>("all");
  const [unlockOpen, setUnlockOpen] = useState(false);
  /** Пользователь закрыл sheet — не открывать автоматически снова, пока статус не сменится. */
  const unlockDismissedRef = useRef(false);

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

  const items = query.data?.items ?? EMPTY_CONVERSATIONS;
  const previews = useMessagesListPreviewDecrypt(items, me?.userUuid);

  useFocusEffect(
    useCallback(() => {
      if (fscpStatus === "registration_pending") {
        void retryPendingOperation();
      }
    }, [fscpStatus, retryPendingOperation]),
  );

  const banner = fscpBannerMessage(fscpStatus);

  const filteredItems = useMemo(() => {
    const queryText = search.trim().toLowerCase();
    let list = [...items];

    if (sortBy === "unread") {
      list = list.filter((item) => item.unreadCount > 0);
    }

    if (filterFrom === "communities" || filterFrom === "dev") {
      list = list.filter(() => false);
    }

    if (!queryText) return list;

    return list.filter((item) => {
      const preview = (previews[item.conversationUuid] ?? item.lastMessageContent ?? "…").toLowerCase();
      return (
        item.otherDisplayName.toLowerCase().includes(queryText) ||
        item.otherUsername.toLowerCase().includes(queryText) ||
        preview.includes(queryText)
      );
    });
  }, [filterFrom, items, previews, search, sortBy]);

  const listData = useMemo<ConversationRow[]>(
    () =>
      filteredItems.map((item) => {
        const preview =
          previews[item.conversationUuid] ??
          item.lastMessageContent ??
          (item.lastMessageEncryptedForMe ? "Расшифровка…" : "Нет сообщений");
        return { ...item, preview };
      }),
    [filteredItems, previews],
  );

  const closeDropdowns = useCallback(() => {
    setSortOpen(false);
    setFilterOpen(false);
  }, []);

  const handleSortOpenChange = useCallback((open: boolean) => {
    setSortOpen(open);
    if (open) {
      setFilterOpen(false);
      setMenuOpen(false);
    }
  }, []);

  const handleFilterOpenChange = useCallback((open: boolean) => {
    setFilterOpen(open);
    if (open) {
      setSortOpen(false);
      setMenuOpen(false);
    }
  }, []);

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
          placeholder="Поиск чатов и сообщений"
          value={search}
          onChangeText={(value) => {
            setSearch(value);
            closeDropdowns();
          }}
          menuOpen={menuOpen}
          onMenuOpen={() => {
            closeDropdowns();
            setMenuOpen(true);
          }}
          onMenuClose={() => setMenuOpen(false)}
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
            <TabDropdownPicker
              accessibilityLabel="Фильтр"
              options={FILTER_OPTIONS}
              activeId={filterFrom}
              open={filterOpen}
              onOpenChange={handleFilterOpenChange}
              onSelect={(id) => setFilterFrom(id as FilterFrom)}
            />
          </View>
        ) : null}
      </View>

      <FlashList
        style={styles.list}
        data={listData}
        keyExtractor={(item) => item.conversationUuid}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={query.isRefetching}
            onRefresh={() => query.refetch()}
            tintColor={floraColors.greenLight}
          />
        }
        renderItem={({ item }) => <ConversationListRow item={item} />}
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
              {emptyListMessage(hasSearch, items.length)}
            </Text>
          )
        }
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
    justifyContent: "flex-start",
    width: "100%",
    gap: 0,
    overflow: "visible",
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: floraSpacing.grid * 2,
  },
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
