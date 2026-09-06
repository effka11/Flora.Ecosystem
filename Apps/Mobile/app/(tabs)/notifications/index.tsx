import { liveGridStyles } from "@/lib/liveGridStyles";
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
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { RefreshControl } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  NOTIFICATION_CATEGORY_TABS,
  NotificationCategoryPicker,
} from "@/components/notifications/NotificationCategoryPicker";
import { NotificationsClearModal } from "@/components/notifications/NotificationsClearModal";
import { NotificationRow } from "@/components/notifications/NotificationRow";
import { useHamburgerMenu } from "@/components/HamburgerMenuProvider";
import { SEARCH_SUGGESTION_TAGS } from "@/components/SearchSuggestionTags";
import { TabScreenHeader } from "@/components/TabScreenHeader";
import { setNotificationsListFocused } from "@/lib/notificationsPushCoalesce";
import { dismissPresentedSocialPushNotifications } from "@/lib/pushNotifications";
import { requestTabBadgesRefresh } from "@/lib/useTabBadges";
import { floraColors, floraSpacing, floraTabBarContentPadding } from "@/lib/theme";
import { usePagerListScroll } from "@/lib/usePagerListScroll";

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
  const listPaddingBottom = floraTabBarContentPadding(Math.max(insets.bottom, 8));
  const { renderScrollComponents, setActivePane } = usePagerListScroll(1);
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [searchTagId, setSearchTagId] = useState<string>(SEARCH_SUGGESTION_TAGS.notifications[0].id);
  const holdSearchFocusRef = useRef<(() => void) | null>(null);
  const [searchDismissEpoch, setSearchDismissEpoch] = useState(0);
  const bumpSearchDismiss = useCallback(() => {
    setSearchDismissEpoch((n) => n + 1);
  }, []);
  const [filterOpen, setFilterOpen] = useState(false);
  const { closeMenu } = useHamburgerMenu();
  const [activeTab, setActiveTab] = useState(0);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
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
    queryKey: ["notifications", activeCategory, hasSearch ? search.trim() : ""],
    queryFn: () =>
      apiListNotifications(
        hasSearch
          ? { category: activeCategory, search: search.trim(), take: 100 }
          : { category: activeCategory, take: 100 },
      ),
    placeholderData: keepPreviousData,
    refetchOnMount: false,
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
      setNotificationsListFocused(true);
      void markAllVisibleAsRead();
      void dismissPresentedSocialPushNotifications();
      return () => {
        setNotificationsListFocused(false);
      };
    }, [markAllVisibleAsRead]),
  );

  const syncNotificationsPane = useCallback(() => {
    setActivePane(0);
  }, [setActivePane]);
  useEffect(() => {
    syncNotificationsPane();
  }, [syncNotificationsPane]);
  useFocusEffect(syncNotificationsPane);

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
    if (open) closeMenu();
  }, [closeMenu]);

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

  const dismissClearModal = useCallback(() => {
    if (clearing) return;
    setClearOpen(false);
    setClearError(null);
  }, [clearing]);

  const confirmClearAll = useCallback(async () => {
    setClearing(true);
    setClearError(null);
    try {
      await apiDeleteAllNotifications();
      setClearOpen(false);
      queryClient.setQueriesData<NotificationDto[]>(
        { queryKey: ["notifications"] },
        () => EMPTY_NOTIFICATIONS,
      );
      requestTabBadgesRefresh();
      void queryClient.invalidateQueries({ queryKey: ["notifications"] });
    } catch {
      setClearError("Не удалось удалить уведомления.");
    } finally {
      setClearing(false);
    }
  }, [queryClient]);

  return (
    <View style={styles.root}>
      <TabScreenHeader
        title="Уведомления"
        placeholder="Поиск по уведомлениям"
        value={search}
        onChangeText={(value) => {
          setSearch(value);
          if (value.trim().length > 0) setFilterOpen(false);
        }}
        dismissKey={`${activeTab}:${searchDismissEpoch}`}
        onBeforeMenuOpen={() => setFilterOpen(false)}
        onSearchActiveChange={(active) => {
          if (active) setFilterOpen(false);
        }}
        holdSearchFocusRef={holdSearchFocusRef}
        searchTags={SEARCH_SUGGESTION_TAGS.notifications}
        searchTagId={searchTagId}
        onSearchTagIdChange={setSearchTagId}
        idleMode="custom"
        idle={
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
                setClearError(null);
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
        }
      />

      {items.length === 0 ? (
        <View style={styles.listFlex}>{listEmptyContent}</View>
      ) : (
        <FlashList
          data={items}
          keyExtractor={(item) => item.notificationUuid}
          contentContainerStyle={[styles.listContent, { paddingBottom: listPaddingBottom }]}
          showsVerticalScrollIndicator={false}
          keyboardDismissMode="on-drag"
          onScrollBeginDrag={bumpSearchDismiss}
          nestedScrollEnabled={false}
          scrollEventThrottle={16}
          renderScrollComponent={renderScrollComponents[0]}
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

      <NotificationsClearModal
        visible={clearOpen}
        busy={clearing}
        error={clearError}
        onDismiss={dismissClearModal}
        onConfirm={() => void confirmClearAll()}
      />
    </View>
  );
}

const styles = liveGridStyles(() => StyleSheet.create({
  root: { flex: 1, backgroundColor: floraColors.bg },
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
  pressed: {
    opacity: 0.72,
  },
}));
