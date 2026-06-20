import {
  apiDeleteAllNotifications,
  apiListNotifications,
  apiMarkAllNotificationsRead,
  apiMarkNotificationRead,
} from "@flora/client-core/api";
import type { NotificationDto } from "@flora/client-core/contracts";
import { FlashList } from "@shopify/flash-list";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router/react-navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Ionicons } from "@expo/vector-icons";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  NOTIFICATION_CATEGORY_TABS,
  NotificationCategoryPicker,
} from "@/components/notifications/NotificationCategoryPicker";
import { NotificationRow } from "@/components/notifications/NotificationRow";
import { TabScreenSearchHeader } from "@/components/TabScreenSearchHeader";
import { subscribeNotificationRealtime } from "@/lib/realtimeSync";
import { requestTabBadgesRefresh } from "@/lib/useTabBadges";
import { floraColors, floraSpacing } from "@/lib/theme";

const TABS = NOTIFICATION_CATEGORY_TABS;

function emptyMessage(activeTab: number, hasSearch: boolean): string {
  if (hasSearch) return "Ничего не найдено. Измените запрос в поиске.";
  if (activeTab === 1) {
    return "Пока нет социальных уведомлений. Подпишитесь на людей во вкладке «Люди».";
  }
  if (activeTab === 2) {
    return "Пока нет уведомлений от разработчика. Здесь будут новости и обновления Flora.";
  }
  return "Пока нет уведомлений. Здесь появятся лайки, комментарии и другие события.";
}

const EMPTY_NOTIFICATIONS: NotificationDto[] = [];

export default function NotificationsScreen() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [activeTab, setActiveTab] = useState(0);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const markAllReadInFlightRef = useRef(false);

  const hasSearch = search.trim().length > 0;
  const activeCategory = TABS[activeTab]?.category ?? "all";

  const {
    data,
    isFetched,
    isFetching,
    isError,
    refetch,
  } = useQuery({
    queryKey: ["notifications", hasSearch ? "search" : activeCategory, search.trim()],
    queryFn: () =>
      apiListNotifications(
        hasSearch
          ? { category: "all", search: search.trim(), take: 100 }
          : { category: activeCategory, take: 100 },
      ),
    placeholderData: keepPreviousData,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });

  const items = data ?? EMPTY_NOTIFICATIONS;
  const showFirstLoadSpinner = !isFetched && isFetching;

  const markAllVisibleAsRead = useCallback(async () => {
    if (markAllReadInFlightRef.current) return;
    markAllReadInFlightRef.current = true;
    try {
      await apiMarkAllNotificationsRead();
      queryClient.setQueriesData<NotificationDto[]>(
        { queryKey: ["notifications"] },
        (old) => (old ? old.map((item) => (item.isRead ? item : { ...item, isRead: true })) : old),
      );
      requestTabBadgesRefresh();
    } catch {
      /* keep list as-is */
    } finally {
      markAllReadInFlightRef.current = false;
    }
  }, [queryClient]);

  useFocusEffect(
    useCallback(() => {
      void markAllVisibleAsRead();
    }, [markAllVisibleAsRead]),
  );

  useEffect(() => {
    return subscribeNotificationRealtime(() => {
      void refetch();
    });
  }, [refetch]);

  const handleRefresh = useCallback(async () => {
    if (isPullRefreshing) return;
    setIsPullRefreshing(true);
    try {
      await refetch();
      requestTabBadgesRefresh();
    } finally {
      setIsPullRefreshing(false);
    }
  }, [isPullRefreshing, refetch]);

  const listEmptyContent = useMemo(() => {
    if (showFirstLoadSpinner) {
      return (
        <View style={styles.loading}>
          <ActivityIndicator color={floraColors.greenLight} />
          <Text style={styles.emptyHint}>Загрузка уведомлений…</Text>
        </View>
      );
    }
    if (isError) {
      return <Text style={styles.emptyHint}>Не удалось загрузить уведомления.</Text>;
    }
    return <Text style={styles.emptyHint}>{emptyMessage(activeTab, hasSearch)}</Text>;
  }, [activeTab, hasSearch, isError, showFirstLoadSpinner]);

  const handleFilterOpenChange = useCallback((open: boolean) => {
    setFilterOpen(open);
    if (open) setMenuOpen(false);
  }, []);

  const markAsRead = useCallback(
    async (item: NotificationDto) => {
      if (!item.isRead) {
        await apiMarkNotificationRead(item.notificationUuid).catch(() => undefined);
        void queryClient.invalidateQueries({ queryKey: ["notifications"] });
        requestTabBadgesRefresh();
      }
    },
    [queryClient],
  );

  const confirmClearAll = useCallback(async () => {
    setClearing(true);
    try {
      await apiDeleteAllNotifications();
      setClearOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["notifications"] });
    } finally {
      setClearing(false);
    }
  }, [queryClient]);

  return (
    <View style={styles.root}>
      <View style={[styles.topBlock, { paddingTop: insets.top + floraSpacing.grid }]}>
        <TabScreenSearchHeader
          placeholder="Поиск по уведомлениям"
          value={search}
          onChangeText={(value) => {
            setSearch(value);
            if (value.trim().length > 0) setFilterOpen(false);
          }}
          menuOpen={menuOpen}
          onMenuOpen={() => {
            setFilterOpen(false);
            setMenuOpen(true);
          }}
          onMenuClose={() => setMenuOpen(false)}
        />

        {!hasSearch ? (
          <View style={styles.navigationRow}>
            <NotificationCategoryPicker
              activeTab={activeTab}
              open={filterOpen}
              onOpenChange={handleFilterOpenChange}
              onSelect={setActiveTab}
            />
            <Pressable
              style={({ pressed }) => [styles.clearBtn, pressed && styles.pressed]}
              onPress={() => {
                setFilterOpen(false);
                setClearOpen(true);
              }}
              disabled={showFirstLoadSpinner}
              accessibilityRole="button"
              accessibilityLabel="Очистить"
            >
              <Text style={styles.clearBtnText}>Очистить</Text>
              <Ionicons name="close" size={16} color={floraColors.greenLight} />
            </Pressable>
          </View>
        ) : null}
      </View>

      {items.length === 0 ? (
        <View style={styles.listFlex}>{listEmptyContent}</View>
      ) : (
        <FlashList
          data={items}
          keyExtractor={(item) => item.notificationUuid}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={isPullRefreshing}
              onRefresh={() => {
                void handleRefresh();
              }}
              tintColor={floraColors.greenLight}
            />
          }
          renderItem={({ item }) => (
            <NotificationRow item={item} onPress={() => void markAsRead(item)} />
          )}
        />
      )}

      <Modal
        visible={clearOpen}
        transparent
        animationType="fade"
        onRequestClose={() => !clearing && setClearOpen(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => !clearing && setClearOpen(false)}>
          <Pressable style={styles.modalDialog} onPress={(e) => e.stopPropagation()}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Стереть уведомления</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Закрыть"
                hitSlop={10}
                onPress={() => !clearing && setClearOpen(false)}
              >
                <Text style={styles.modalClose}>×</Text>
              </Pressable>
            </View>
            <Text style={styles.modalText}>
              Удалить все уведомления? Это действие нельзя отменить.
            </Text>
            <View style={styles.modalActions}>
              <Pressable
                style={({ pressed }) => [styles.modalConfirm, pressed && styles.pressed, clearing && styles.disabled]}
                onPress={() => void confirmClearAll()}
                disabled={clearing}
              >
                <Text style={styles.modalConfirmText}>{clearing ? "Удаление…" : "Удалить все"}</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.modalCancel, pressed && styles.pressed, clearing && styles.disabled]}
                onPress={() => setClearOpen(false)}
                disabled={clearing}
              >
                <Text style={styles.modalCancelText}>Отмена</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
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
  navigationRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    width: "100%",
    gap: floraSpacing.grid,
    overflow: "visible",
  },
  clearBtn: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: floraSpacing.gridFine,
    height: 35,
    paddingHorizontal: floraSpacing.grid,
  },
  clearBtnText: {
    color: floraColors.gray,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
  },
  listFlex: {
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
  pressed: {
    opacity: 0.72,
  },
  disabled: {
    opacity: 0.5,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.65)",
    alignItems: "center",
    justifyContent: "center",
    padding: floraSpacing.grid * 2,
  },
  modalDialog: {
    width: "100%",
    maxWidth: 520,
    borderRadius: 16,
    backgroundColor: floraColors.surface,
    borderWidth: 1,
    borderColor: "rgba(250, 250, 250, 0.12)",
    padding: floraSpacing.grid * 2,
    gap: floraSpacing.grid * 2,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  modalTitle: {
    color: floraColors.whiteTemplate,
    fontSize: 19,
    fontWeight: "300",
    letterSpacing: 0.57,
  },
  modalClose: {
    color: floraColors.gray,
    fontSize: 28,
    lineHeight: 28,
  },
  modalText: {
    color: "rgba(250, 250, 250, 0.85)",
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    lineHeight: 22,
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 12,
  },
  modalConfirm: {
    paddingHorizontal: floraSpacing.grid * 2,
    paddingVertical: floraSpacing.gridFine * 2,
    borderRadius: 9999,
    backgroundColor: floraColors.greenLight,
  },
  modalConfirmText: {
    color: "#10200e",
    fontSize: 15,
    fontWeight: "300",
  },
  modalCancel: {
    paddingHorizontal: floraSpacing.grid * 2,
    paddingVertical: floraSpacing.gridFine * 2,
    borderRadius: 9999,
    borderWidth: 1,
    borderColor: "rgba(250, 250, 250, 0.2)",
  },
  modalCancelText: {
    color: "rgba(250, 250, 250, 0.8)",
    fontSize: 15,
    fontWeight: "300",
  },
});
