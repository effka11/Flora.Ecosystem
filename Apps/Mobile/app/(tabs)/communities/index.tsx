import { liveGridStyles } from "@/lib/liveGridStyles";
import { Ionicons } from "@expo/vector-icons";
import { apiJoinCommunity, apiLeaveCommunity, apiSearchCommunities } from "@flora/client-core/api";
import type { CommunityListItemDto } from "@flora/client-core/contracts";
import { FlashList } from "@shopify/flash-list";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useFocusEffect } from "expo-router/react-navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type ScrollViewProps,
} from "react-native";
import { Pressable as GesturePressable, RefreshControl } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FloraAvatar } from "@/components/FloraAvatar";
import { FLORA_TAB_STRIP_PAD_X } from "@/components/chrome/FloraTabChipStrip";
import { FloraTabLabel, floraTabChrome } from "@/components/chrome/FloraTabLabel";
import { TabPagerPage, TabPagerTrack } from "@/components/chrome/TabPager";
import { SyncPagerTabIndicator } from "@/components/chrome/tabIndicatorBridge";
import { CreateCommunitySheet } from "@/components/communities/CreateCommunitySheet";
import { SEARCH_SUGGESTION_TAGS } from "@/components/SearchSuggestionTags";
import { TabScreenHeader } from "@/components/TabScreenHeader";
import {
  fetchCommunitiesOwnedQuery,
  fetchCommunitiesRecommendedQuery,
  fetchCommunitiesSubscriptionsQuery,
  communitiesIndexUsername,
  communitiesSubscriptionsQueryKey,
  COMMUNITIES_OWNED_QUERY_KEY,
  COMMUNITIES_RECOMMENDED_QUERY_KEY,
} from "@/lib/communities/communitiesIndexQueries";
import { PagerOverlayScroll } from "@/lib/pagerFlashListScroll";
import { communityScreenHref } from "@/lib/socialRoutes";
import { useSessionStore } from "@/stores/sessionStore";
import { floraColors, floraSpacing, floraTabBarContentPadding } from "@/lib/theme";
import { bindChipStripBusy, usePagerBusyFlags } from "@/lib/usePagerBusyFlags";
import { usePagerListScroll } from "@/lib/usePagerListScroll";
import { usePullToRefresh } from "@/lib/usePullToRefresh";
import { useTabPager } from "@/lib/useTabPager";

type CommunityTab = "recommended" | "subscriptions";

type TabLayout = { x: number; width: number };

const COMMUNITY_TABS: readonly { id: CommunityTab; label: string }[] = [
  { id: "recommended", label: "Рекомендации" },
  { id: "subscriptions", label: "Подписки" },
];

const AVATAR_SIZE = () => floraSpacing.grid * 3;
const COMMUNITY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isCommunityUuid(value: string): boolean {
  return COMMUNITY_UUID_RE.test(value.trim());
}

function communityTabIndex(tab: CommunityTab) {
  return tab === "recommended" ? 0 : 1;
}

function emptyMessage(tab: CommunityTab, hasSearch: boolean): string {
  if (hasSearch) return "Ничего не найдено. Измените запрос в поиске.";
  if (tab === "subscriptions") {
    return "Пока нет подписок на сообщества. Найдите интересные во вкладке «Рекомендации».";
  }
  return "Пока нет рекомендаций. Загляните позже или создайте своё через кнопку «+».";
}

function formatMembers(count: number): string {
  return `${count.toLocaleString("ru-RU")} участников`;
}

type CommunityRowProps = {
  community: CommunityListItemDto;
  showLeave: boolean;
  showJoin: boolean;
  actionBusy: boolean;
  onJoin: () => void;
  onLeave: () => void;
};

function CommunityRow({ community, showLeave, showJoin, actionBusy, onJoin, onLeave }: CommunityRowProps) {
  return (
    <View style={styles.shell}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Открыть сообщество ${community.name}`}
        style={({ pressed }) => [styles.rowMain, pressed && styles.rowMainPressed]}
        onPress={() => router.push(communityScreenHref(community.slug))}
      >
        <FloraAvatar
          size={AVATAR_SIZE()}
          avatarUuid={community.avatarUuid}
          displayName={community.name}
          communityName={community.name}
          username={community.slug}
          seed={community.communityId}
        />
        <View style={styles.rowBody}>
          <Text style={styles.displayName} numberOfLines={1}>
            {community.name}
          </Text>
          <Text style={styles.members}>{formatMembers(community.memberCount)}</Text>
        </View>
      </Pressable>
      <View style={styles.trailing}>
        {showLeave ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Отписаться"
            disabled={actionBusy}
            style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed, actionBusy && styles.disabled]}
            onPress={onLeave}
          >
            <Ionicons name="person-remove-outline" size={18} color={floraColors.greenLight} />
          </Pressable>
        ) : null}
        {showJoin ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Подписаться"
            disabled={actionBusy}
            style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed, actionBusy && styles.disabled]}
            onPress={onJoin}
          >
            <Ionicons name="person-add-outline" size={18} color={floraColors.greenLight} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

type CommunityPaneProps = {
  tab: CommunityTab;
  communities: CommunityListItemDto[];
  loading: boolean;
  error: boolean;
  isActive: boolean;
  searching: boolean;
  pageWidth: number;
  listPaddingBottom: number;
  renderScrollComponent: ComponentType<ScrollViewProps>;
  extraData: string;
  rowActions: (community: CommunityListItemDto) => { showJoin: boolean; showLeave: boolean };
  busyCommunityId: string | null;
  onJoin: (community: CommunityListItemDto) => void;
  onLeave: (community: CommunityListItemDto) => void;
  onRefresh: () => Promise<void>;
  onScrollBeginDrag: () => void;
};

function CommunityPane({
  tab,
  communities,
  loading,
  error,
  isActive,
  searching,
  pageWidth,
  listPaddingBottom,
  renderScrollComponent,
  extraData,
  rowActions,
  busyCommunityId,
  onJoin,
  onLeave,
  onRefresh,
  onScrollBeginDrag,
}: CommunityPaneProps) {
  const { pullRefreshing, onRefresh: onPullRefresh } = usePullToRefresh(onRefresh);
  return (
    <TabPagerPage pageWidth={pageWidth}>
      <FlashList
        data={communities}
        extraData={extraData}
        keyExtractor={(item) => item.communityId}
        contentContainerStyle={[styles.listContent, { paddingBottom: listPaddingBottom }]}
        keyboardDismissMode="on-drag"
        onScrollBeginDrag={onScrollBeginDrag}
        drawDistance={isActive ? 250 : 0}
        nestedScrollEnabled={false}
        scrollEventThrottle={16}
        renderScrollComponent={renderScrollComponent}
        refreshControl={
          <RefreshControl
            refreshing={isActive && pullRefreshing}
            onRefresh={onPullRefresh}
            tintColor={floraColors.greenLight}
          />
        }
        renderItem={({ item }) => {
          const actions = rowActions(item);
          return (
            <CommunityRow
              community={item}
              showJoin={actions.showJoin}
              showLeave={actions.showLeave}
              actionBusy={busyCommunityId === item.communityId}
              onJoin={() => onJoin(item)}
              onLeave={() => onLeave(item)}
            />
          );
        }}
        ListEmptyComponent={
          loading ? (
            <View style={styles.loading}>
              <ActivityIndicator color={floraColors.greenLight} />
              <Text style={styles.emptyHint}>Загрузка сообществ…</Text>
            </View>
          ) : error ? (
            <Text style={styles.emptyHint}>Не удалось загрузить список.</Text>
          ) : (
            <Text style={styles.emptyHint}>{emptyMessage(tab, searching)}</Text>
          )
        }
      />
    </TabPagerPage>
  );
}

export default function CommunitiesScreen() {
  const insets = useSafeAreaInsets();
  const listPaddingBottom = floraTabBarContentPadding(Math.max(insets.bottom, 8));
  const queryClient = useQueryClient();
  const me = useSessionStore((s) => s.me);
  const [search, setSearch] = useState("");
  const [searchTagId, setSearchTagId] = useState<string>(SEARCH_SUGGESTION_TAGS.communities[0].id);
  const holdSearchFocusRef = useRef<(() => void) | null>(null);
  const [searchDismissEpoch, setSearchDismissEpoch] = useState(0);
  const bumpSearchDismiss = useCallback(() => {
    setSearchDismissEpoch((n) => n + 1);
  }, []);
  const pagerGenRef = useRef(0);
  const { reportTouch, reportPager, reportStrip } = usePagerBusyFlags();
  const chipStripBusy = useMemo(
    () => bindChipStripBusy(reportTouch, reportStrip, bumpSearchDismiss),
    [bumpSearchDismiss, reportStrip, reportTouch],
  );
  const [searchChromeOpen, setSearchChromeOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<CommunityTab>("recommended");
  const [localJoined, setLocalJoined] = useState<Record<string, boolean>>({});
  const [busyCommunityId, setBusyCommunityId] = useState<string | null>(null);
  const [tabLayouts, setTabLayouts] = useState<Record<CommunityTab, TabLayout | null>>({
    recommended: null,
    subscriptions: null,
  });
  const { renderScrollComponents, setActivePane } = usePagerListScroll(2);

  const recordTabLayout = useCallback((tab: CommunityTab, event: LayoutChangeEvent) => {
    const { x, width } = event.nativeEvent.layout;
    setTabLayouts((prev) => {
      const existing = prev[tab];
      if (existing?.x === x && existing?.width === width) return prev;
      return { ...prev, [tab]: { x, width } };
    });
  }, []);

  const commitPagerIndex = useCallback(
    (index: number) => {
      const next: CommunityTab = index === 0 ? "recommended" : "subscriptions";
      setActivePane(index);
      setActiveTab((current) => (current === next ? current : next));
    },
    [setActivePane],
  );

  const queryText = search.trim();
  const hasSearch = queryText.length > 0;

  const {
    scrollX,
    pageWidth,
    tabProgress,
    pagerPan,
    onBodyLayout,
    settleToIndex,
    pagerTargetRef,
  } = useTabPager({
    pageCount: 2,
    enabled: !hasSearch && !searchChromeOpen,
    initialIndex: 0,
    onTouchBegin: () => {
      bumpSearchDismiss();
      reportTouch(true);
    },
    onTouchEnd: () => reportTouch(false),
    onPagerStart: () => {
      pagerGenRef.current = reportPager(true);
    },
    onMotionEnd: () => {
      reportPager(false, pagerGenRef.current);
    },
    onCommitIndex: commitPagerIndex,
  });

  const selectTab = useCallback(
    (next: CommunityTab) => {
      const index = communityTabIndex(next);
      if (index === pagerTargetRef.current) return;
      bumpSearchDismiss();
      settleToIndex(index);
    },
    [bumpSearchDismiss, pagerTargetRef, settleToIndex],
  );

  const syncCommunityPane = useCallback(() => {
    setActivePane(communityTabIndex(activeTab));
  }, [activeTab, setActivePane]);
  useEffect(() => {
    syncCommunityPane();
  }, [syncCommunityPane]);
  useFocusEffect(syncCommunityPane);

  const myUsername = communitiesIndexUsername(me?.username ?? "");

  const recommendedQuery = useQuery({
    queryKey: COMMUNITIES_RECOMMENDED_QUERY_KEY,
    enabled: !hasSearch,
    queryFn: fetchCommunitiesRecommendedQuery,
    refetchOnMount: false,
  });

  const ownedQuery = useQuery({
    queryKey: COMMUNITIES_OWNED_QUERY_KEY,
    queryFn: fetchCommunitiesOwnedQuery,
    refetchOnMount: false,
  });

  const subscriptionsQuery = useQuery({
    queryKey: communitiesSubscriptionsQueryKey(myUsername),
    enabled: !hasSearch && myUsername.length > 0,
    queryFn: () => fetchCommunitiesSubscriptionsQuery(myUsername),
    refetchOnMount: false,
  });

  const searchQuery = useQuery({
    queryKey: ["communities", "search", queryText],
    enabled: hasSearch,
    queryFn: () => apiSearchCommunities(queryText, { take: 40 }),
  });

  const ownedIds = useMemo(
    () => new Set((ownedQuery.data ?? []).map((item) => item.communityId)),
    [ownedQuery.data],
  );

  const memberIdsFromServer = useMemo(() => {
    const ids = new Set<string>();
    for (const item of ownedQuery.data ?? []) ids.add(item.communityId);
    for (const item of subscriptionsQuery.data ?? []) ids.add(item.communityId);
    for (const item of recommendedQuery.data ?? []) {
      if (item.role === "Owner" || item.role === "Member") ids.add(item.communityId);
    }
    for (const item of searchQuery.data ?? []) {
      if (item.role === "Owner" || item.role === "Member") ids.add(item.communityId);
    }
    return ids;
  }, [ownedQuery.data, subscriptionsQuery.data, recommendedQuery.data, searchQuery.data]);

  const isMember = useCallback(
    (community: CommunityListItemDto) => {
      if (community.role === "Owner" || ownedIds.has(community.communityId)) return true;
      if (typeof localJoined[community.communityId] === "boolean") {
        return localJoined[community.communityId];
      }
      return community.role === "Member" || memberIdsFromServer.has(community.communityId);
    },
    [localJoined, memberIdsFromServer, ownedIds],
  );

  const rowActionsFor = useCallback(
    (tab: CommunityTab, searching: boolean) => (community: CommunityListItemDto) => {
      if (community.role === "Owner" || ownedIds.has(community.communityId)) {
        return { showJoin: false, showLeave: false };
      }
      if (!isCommunityUuid(community.communityId)) {
        return { showJoin: false, showLeave: false };
      }
      const member = isMember(community);
      if (member) {
        const showLeave = searching || tab === "subscriptions" || community.role === "Member";
        return { showJoin: false, showLeave };
      }
      return { showJoin: true, showLeave: false };
    },
    [isMember, ownedIds],
  );

  const extraData = `${JSON.stringify(localJoined)}:${busyCommunityId}`;

  const refreshRecommended = useCallback(async () => {
    await recommendedQuery.refetch();
  }, [recommendedQuery]);
  const refreshSubscriptions = useCallback(async () => {
    await subscriptionsQuery.refetch();
  }, [subscriptionsQuery]);
  const refreshSearch = useCallback(async () => {
    await searchQuery.refetch();
  }, [searchQuery]);

  const refreshCommunities = () => {
    void queryClient.invalidateQueries({ queryKey: ["communities"] });
  };

  const toggleMembership = async (community: CommunityListItemDto, join: boolean) => {
    setBusyCommunityId(community.communityId);
    setLocalJoined((prev) => ({ ...prev, [community.communityId]: join }));
    try {
      if (join) await apiJoinCommunity(community.communityId);
      else await apiLeaveCommunity(community.communityId);
      refreshCommunities();
    } catch (err) {
      setLocalJoined((prev) => ({ ...prev, [community.communityId]: !join }));
      Alert.alert("Сообщество", err instanceof Error ? err.message : "Не удалось изменить подписку.");
    } finally {
      setBusyCommunityId(null);
    }
  };

  const handleCommunityCreated = (community: CommunityListItemDto) => {
    refreshCommunities();
    router.push(communityScreenHref(community.slug));
  };

  const paneBase = {
    pageWidth,
    listPaddingBottom,
    extraData,
    busyCommunityId,
    onJoin: (community: CommunityListItemDto) => void toggleMembership(community, true),
    onLeave: (community: CommunityListItemDto) => void toggleMembership(community, false),
    onScrollBeginDrag: bumpSearchDismiss,
    searching: false,
  };

  return (
    <View style={styles.root}>
      <TabScreenHeader
        title="Сообщества"
        placeholder="Поиск по названию или ссылке"
        value={search}
        onChangeText={setSearch}
        dismissKey={`${activeTab}:${searchDismissEpoch}`}
        holdSearchFocusRef={holdSearchFocusRef}
        createAction={{
          accessibilityLabel: "Создать сообщество",
          onPress: () => setCreateOpen(true),
        }}
        searchTags={SEARCH_SUGGESTION_TAGS.communities}
        searchTagId={searchTagId}
        onSearchTagIdChange={setSearchTagId}
        onSearchActiveChange={setSearchChromeOpen}
        onChipPanBegin={chipStripBusy.onChipPanBegin}
        onChipPanFinalize={chipStripBusy.onChipPanFinalize}
        onChipPanDecayEnd={chipStripBusy.onChipPanDecayEnd}
        idle={({ stripOffset }) => (
          <View style={styles.tabs}>
            <SyncPagerTabIndicator
              scrollX={scrollX}
              pageWidth={pageWidth}
              start={tabLayouts.recommended}
              end={tabLayouts.subscriptions}
              insetX={FLORA_TAB_STRIP_PAD_X()}
              stripOffset={stripOffset}
            />
            {COMMUNITY_TABS.map((tab, index) => (
              <GesturePressable
                key={tab.id}
                accessibilityRole="tab"
                accessibilityState={{ selected: activeTab === tab.id }}
                style={floraTabChrome.tabButton}
                onLayout={(event) => recordTabLayout(tab.id, event)}
                onPress={() => selectTab(tab.id)}
              >
                <FloraTabLabel index={index} label={tab.label} progress={tabProgress} />
              </GesturePressable>
            ))}
          </View>
        )}
      />

      <View style={styles.body} onLayout={onBodyLayout}>
        <View style={styles.pagerHost} pointerEvents={hasSearch ? "none" : "auto"}>
          <TabPagerTrack pageCount={2} pageWidth={pageWidth} pagerPan={pagerPan} scrollX={scrollX}>
            <CommunityPane
              {...paneBase}
              tab="recommended"
              communities={recommendedQuery.data ?? []}
              loading={recommendedQuery.isLoading}
              error={recommendedQuery.isError}
              isActive={!hasSearch && activeTab === "recommended"}
              renderScrollComponent={renderScrollComponents[0]}
              rowActions={rowActionsFor("recommended", false)}
              onRefresh={refreshRecommended}
            />
            <CommunityPane
              {...paneBase}
              tab="subscriptions"
              communities={subscriptionsQuery.data ?? []}
              loading={subscriptionsQuery.isLoading}
              error={subscriptionsQuery.isError}
              isActive={!hasSearch && activeTab === "subscriptions"}
              renderScrollComponent={renderScrollComponents[1]}
              rowActions={rowActionsFor("subscriptions", false)}
              onRefresh={refreshSubscriptions}
            />
          </TabPagerTrack>
        </View>
        {hasSearch ? (
          <View style={styles.searchOverlay}>
            <CommunityPane
              {...paneBase}
              tab={activeTab}
              communities={searchQuery.data ?? []}
              loading={searchQuery.isLoading}
              error={searchQuery.isError}
              isActive
              searching
              renderScrollComponent={PagerOverlayScroll}
              rowActions={rowActionsFor(activeTab, true)}
              onRefresh={refreshSearch}
            />
          </View>
        ) : null}
      </View>

      <CreateCommunitySheet
        visible={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCommunityCreated}
      />
    </View>
  );
}

const styles = liveGridStyles(() => StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: floraColors.bg,
  },
  body: {
    flex: 1,
    overflow: "hidden",
  },
  pagerHost: {
    flex: 1,
  },
  searchOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: floraColors.bg,
    zIndex: 1,
  },
  tabs: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    overflow: "visible",
  },
  listContent: {},
  shell: {
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    borderBottomColor: "rgba(250, 250, 250, 0.06)",
    borderBottomWidth: 1,
  },
  rowMain: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    minWidth: 0,
    gap: floraSpacing.grid,
    paddingTop: floraSpacing.grid * 2 - 1,
    paddingBottom: floraSpacing.grid * 2 - 2,
    paddingLeft: floraSpacing.grid,
    paddingRight: floraSpacing.gridFine,
  },
  rowMainPressed: {
    backgroundColor: "rgba(250, 250, 250, 0.04)",
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
    gap: floraSpacing.gridFine,
  },
  displayName: {
    color: floraColors.whiteTemplate,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    lineHeight: 20,
  },
  members: {
    color: floraColors.gray,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    lineHeight: 20,
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.gridFine,
    flexShrink: 0,
    alignSelf: "stretch",
    paddingRight: floraSpacing.grid,
    paddingTop: floraSpacing.grid * 2 - 1,
    paddingBottom: floraSpacing.grid * 2 - 2,
    minWidth: floraSpacing.grid + 34,
  },
  iconBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(164, 209, 138, 0.08)",
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
  disabled: {
    opacity: 0.45,
  },
  pressed: {
    opacity: 0.72,
  },
}));
