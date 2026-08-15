import { Ionicons } from "@expo/vector-icons";
import {
  apiFollowUser,
  apiGetProfileFollowers,
  apiGetProfileFollowing,
  apiGetRecommendedUsers,
  apiSearchUsers,
  apiUnfollowUser,
} from "@flora/client-core/api";
import type { PeopleUserDto } from "@flora/client-core/contracts";
import { sharedPresenceStore } from "@flora/client-core/presence";
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
import { PagerChipStripFollow, TabPagerPage, TabPagerTrack } from "@/components/chrome/TabPager";
import { SyncIndexTabIndicator } from "@/components/chrome/tabIndicatorBridge";
import { OnlineStatusDot } from "@/components/messages/OnlineStatusDot";
import { SEARCH_SUGGESTION_TAGS } from "@/components/SearchSuggestionTags";
import { TabScreenHeader } from "@/components/TabScreenHeader";
import { PagerOverlayScroll } from "@/lib/pagerFlashListScroll";
import { profileScreenHref } from "@/lib/socialRoutes";
import { useSessionStore } from "@/stores/sessionStore";
import { floraColors, floraSpacing, floraTabBarContentPadding } from "@/lib/theme";
import { useDeferredPagerMount } from "@/lib/useDeferredPagerMount";
import { bindChipStripBusy, usePagerBusyFlags } from "@/lib/usePagerBusyFlags";
import { usePagerListScroll } from "@/lib/usePagerListScroll";
import { usePullToRefresh } from "@/lib/usePullToRefresh";
import { useTabPager } from "@/lib/useTabPager";

type PeopleTabId = "recommended" | "friends" | "followers" | "following";

type TabLayout = { x: number; width: number };

const PEOPLE_TABS: readonly { id: PeopleTabId; label: string }[] = [
  { id: "recommended", label: "Рекомендации" },
  { id: "friends", label: "Друзья" },
  { id: "followers", label: "Подписчики" },
  { id: "following", label: "Подписки" },
];
const PEOPLE_PAGE_IDS: readonly PeopleTabId[] = PEOPLE_TABS.map((tab) => tab.id);

const AVATAR_SIZE = floraSpacing.grid * 3;
/** Match Web People `.onlineBadge` (10px on 45px avatar). */
const PEOPLE_ONLINE_DOT_AT_REF = 10;

function emptyMessage(tab: PeopleTabId, hasSearch: boolean): string {
  if (hasSearch) return "Ничего не найдено. Измените запрос в поиске.";
  if (tab === "recommended") {
    return "Пока нет рекомендаций. Загляните позже или найдите людей через поиск.";
  }
  if (tab === "friends") return "Пока нет друзей.";
  if (tab === "followers") return "Пока нет подписчиков.";
  return "Пока нет подписок.";
}

function formatFollowers(count: number): string {
  return `${count.toLocaleString("ru-RU")} подписчиков`;
}

function peopleTabIndex(tab: PeopleTabId) {
  return PEOPLE_TABS.findIndex((item) => item.id === tab);
}

type PeopleRowProps = {
  user: PeopleUserDto;
  following: boolean;
  actionBusy: boolean;
  onToggleFollow: () => void;
  meUsername?: string | null;
};

function PeopleRow({ user, following, actionBusy, onToggleFollow, meUsername }: PeopleRowProps) {
  const profileHref = profileScreenHref(user.username, meUsername);
  const [presenceTick, setPresenceTick] = useState(0);
  useEffect(() => sharedPresenceStore.subscribe(() => setPresenceTick((n) => n + 1)), []);
  void presenceTick;
  const overlay = user.userUuid
    ? sharedPresenceStore.overlayOnline(user.userUuid, user.isOnline ?? false, user.lastSeenAt)
    : { isOnline: false, lastSeenAt: user.lastSeenAt ?? null };

  return (
    <View style={styles.shell}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Открыть профиль ${user.displayName}`}
        style={({ pressed }) => [styles.rowMain, pressed && styles.rowMainPressed]}
        onPress={() => router.push(profileHref)}
      >
        <View style={styles.avatarWrap}>
          <FloraAvatar
            size={AVATAR_SIZE}
            avatarUuid={user.avatarUuid}
            displayName={user.displayName}
            username={user.username}
            seed={user.userUuid ?? user.username}
          />
          {user.userUuid ? (
            <OnlineStatusDot
              key={user.userUuid}
              identityKey={user.userUuid}
              online={overlay.isOnline}
              avatarDiameter={AVATAR_SIZE}
              sizeAtRef={PEOPLE_ONLINE_DOT_AT_REF}
              style={styles.peopleOnlineInset}
            />
          ) : null}
        </View>
        <View style={styles.rowBody}>
          <View style={styles.nameLine}>
            <Text style={styles.displayName} numberOfLines={1}>
              {user.displayName}
            </Text>
            <Text style={styles.username} numberOfLines={1}>
              @{user.username}
            </Text>
          </View>
          <Text style={styles.followers}>{formatFollowers(user.followerCount)}</Text>
        </View>
      </Pressable>
      <View style={styles.trailing}>
        {following ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Отписаться"
            disabled={actionBusy}
            style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed, actionBusy && styles.disabled]}
            onPress={onToggleFollow}
          >
            <Ionicons name="person-remove-outline" size={18} color={floraColors.greenLight} />
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Подписаться"
            disabled={actionBusy}
            style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed, actionBusy && styles.disabled]}
            onPress={onToggleFollow}
          >
            <Ionicons name="person-add-outline" size={18} color={floraColors.greenLight} />
          </Pressable>
        )}
      </View>
    </View>
  );
}

type PeoplePaneProps = {
  tab: PeopleTabId;
  users: PeopleUserDto[];
  loading: boolean;
  error: boolean;
  isActive: boolean;
  searching: boolean;
  pageWidth: number;
  listPaddingBottom: number;
  renderScrollComponent: ComponentType<ScrollViewProps>;
  extraData: string;
  meUsername?: string | null;
  busyUsername: string | null;
  isFollowing: (user: PeopleUserDto) => boolean;
  onToggleFollow: (user: PeopleUserDto) => void;
  onRefresh: () => Promise<void>;
  onScrollBeginDrag: () => void;
};

function PeoplePane({
  tab,
  users,
  loading,
  error,
  isActive,
  searching,
  pageWidth,
  listPaddingBottom,
  renderScrollComponent,
  extraData,
  meUsername,
  busyUsername,
  isFollowing,
  onToggleFollow,
  onRefresh,
  onScrollBeginDrag,
}: PeoplePaneProps) {
  const { pullRefreshing, onRefresh: onPullRefresh } = usePullToRefresh(onRefresh);
  return (
    <TabPagerPage pageWidth={pageWidth}>
      <FlashList
        data={users}
        extraData={extraData}
        keyExtractor={(item) => item.username}
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
        renderItem={({ item }) => (
          <PeopleRow
            user={item}
            following={isFollowing(item)}
            actionBusy={busyUsername === item.username}
            onToggleFollow={() => onToggleFollow(item)}
            meUsername={meUsername}
          />
        )}
        ListEmptyComponent={
          loading ? (
            <View style={styles.loading}>
              <ActivityIndicator color={floraColors.greenLight} />
              <Text style={styles.emptyHint}>Загрузка людей…</Text>
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

export default function PeopleScreen() {
  const insets = useSafeAreaInsets();
  const listPaddingBottom = floraTabBarContentPadding(Math.max(insets.bottom, 8));
  const queryClient = useQueryClient();
  const me = useSessionStore((s) => s.me);
  const [search, setSearch] = useState("");
  const [searchTagId, setSearchTagId] = useState<string>(SEARCH_SUGGESTION_TAGS.people[0].id);
  const holdSearchFocusRef = useRef<(() => void) | null>(null);
  const [searchDismissEpoch, setSearchDismissEpoch] = useState(0);
  const bumpSearchDismiss = useCallback(() => {
    setSearchDismissEpoch((n) => n + 1);
  }, []);
  const [searchChromeOpen, setSearchChromeOpen] = useState(false);
  const [mainTab, setMainTab] = useState<PeopleTabId>("recommended");
  const [tabLayouts, setTabLayouts] = useState<Record<PeopleTabId, TabLayout | null>>({
    recommended: null,
    friends: null,
    followers: null,
    following: null,
  });
  const { renderScrollComponents, setActivePane } = usePagerListScroll(PEOPLE_TABS.length);
  const { mountedIds, setBusy, ensureMounted, onCommitted } = useDeferredPagerMount(
    PEOPLE_PAGE_IDS,
    0,
  );
  const pagerGenRef = useRef(0);
  const { reportTouch, reportPager, reportStrip, getEpoch } = usePagerBusyFlags(setBusy);
  const tapTargetRef = useRef<PeopleTabId>("recommended");
  const chipStripBusy = useMemo(
    () => bindChipStripBusy(reportTouch, reportStrip, bumpSearchDismiss),
    [bumpSearchDismiss, reportStrip, reportTouch],
  );

  const recordTabLayout = useCallback((tab: PeopleTabId, event: LayoutChangeEvent) => {
    const { x, width } = event.nativeEvent.layout;
    setTabLayouts((prev) => {
      const existing = prev[tab];
      if (existing?.x === x && existing?.width === width) return prev;
      return { ...prev, [tab]: { x, width } };
    });
  }, []);

  const indicatorLayouts = PEOPLE_TABS.map((tab) => tabLayouts[tab.id]);

  const commitPagerIndex = useCallback(
    (index: number) => {
      const next = PEOPLE_TABS[index]?.id ?? "recommended";
      setActivePane(index);
      setMainTab((current) => (current === next ? current : next));
      onCommitted(index);
    },
    [onCommitted, setActivePane],
  );

  const queryText = search.trim();
  const hasSearch = queryText.length > 0;
  const pagerEnabled = !hasSearch && !searchChromeOpen;

  const beginPeopleTouch = useCallback(() => {
    bumpSearchDismiss();
    reportTouch(true);
  }, [bumpSearchDismiss, reportTouch]);

  const {
    scrollX,
    pageWidth,
    pageWidthSV,
    tabProgress,
    pagerPan,
    onBodyLayout,
    settleToIndex,
    pagerTargetRef,
  } = useTabPager({
    pageCount: PEOPLE_TABS.length,
    enabled: pagerEnabled,
    initialIndex: 0,
    onTouchBegin: beginPeopleTouch,
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
    (next: PeopleTabId) => {
      const index = peopleTabIndex(next);
      if (index < 0 || index === pagerTargetRef.current) return;
      tapTargetRef.current = next;
      bumpSearchDismiss();
      const gen = reportPager(true);
      pagerGenRef.current = gen;
      const epochAtTap = getEpoch();
      const needsMount = ensureMounted(next);
      const go = () => {
        if (tapTargetRef.current !== next) return;
        if (getEpoch() !== epochAtTap) {
          reportPager(false, gen);
          return;
        }
        settleToIndex(index);
      };
      if (needsMount) requestAnimationFrame(go);
      else go();
    },
    [bumpSearchDismiss, ensureMounted, getEpoch, pagerTargetRef, reportPager, settleToIndex],
  );

  const syncPeoplePane = useCallback(() => {
    setActivePane(peopleTabIndex(mainTab));
  }, [mainTab, setActivePane]);
  useEffect(() => {
    syncPeoplePane();
  }, [syncPeoplePane]);
  useFocusEffect(syncPeoplePane);

  const [localFollowing, setLocalFollowing] = useState<Record<string, boolean>>({});
  const [busyUsername, setBusyUsername] = useState<string | null>(null);

  const myUsername = me?.username?.replace(/^@+/, "") ?? "";

  const recommendedQuery = useQuery({
    queryKey: ["people", "recommended"],
    enabled: !hasSearch,
    queryFn: () => apiGetRecommendedUsers(40),
  });

  const followersQuery = useQuery({
    queryKey: ["people", "followers", myUsername],
    enabled: !hasSearch && myUsername.length > 0,
    queryFn: () => apiGetProfileFollowers(myUsername, { take: 50 }),
  });

  const followingQuery = useQuery({
    queryKey: ["people", "following", myUsername],
    enabled: !hasSearch && myUsername.length > 0,
    queryFn: () => apiGetProfileFollowing(myUsername, { take: 50 }),
  });

  const searchQuery = useQuery({
    queryKey: ["people", "search", queryText],
    enabled: hasSearch,
    queryFn: () => apiSearchUsers(queryText, 40),
  });

  const followingFromServer = useMemo(() => {
    const next = new Set<string>();
    for (const item of followingQuery.data ?? []) next.add(item.username);
    for (const item of recommendedQuery.data ?? []) {
      if (item.isFollowing) next.add(item.username);
    }
    for (const item of searchQuery.data ?? []) {
      if (item.isFollowing) next.add(item.username);
    }
    return next;
  }, [followingQuery.data, recommendedQuery.data, searchQuery.data]);

  const mutualFriends = useMemo(() => {
    const followers = followersQuery.data ?? [];
    const following = followingQuery.data ?? [];
    const followingUsernames = new Set(following.map((user) => user.username));
    return followers.filter((user) => followingUsernames.has(user.username));
  }, [followersQuery.data, followingQuery.data]);

  const recommendedUsers = recommendedQuery.data ?? [];
  const followersUsers = followersQuery.data ?? [];
  const followingUsers = followingQuery.data ?? [];
  const searchUsers = searchQuery.data ?? [];

  const presenceUsers = hasSearch
    ? searchUsers
    : mainTab === "recommended"
      ? recommendedUsers
      : mainTab === "followers"
        ? followersUsers
        : mainTab === "following"
          ? followingUsers
          : mutualFriends;

  const [presenceEpoch, setPresenceEpoch] = useState(() => sharedPresenceStore.getSessionEpoch());
  useEffect(() => {
    return sharedPresenceStore.subscribe(() => {
      setPresenceEpoch(sharedPresenceStore.getSessionEpoch());
    });
  }, []);

  useEffect(() => {
    const uuids = presenceUsers.map((u) => u.userUuid).filter((u): u is string => !!u);
    if (!sharedPresenceStore.surfacesAccepted) {
      sharedPresenceStore.unregisterSurface("people");
      return undefined;
    }
    sharedPresenceStore.registerSurface("people", uuids);
    void sharedPresenceStore.resyncSnapshots().catch(() => {});
    return () => sharedPresenceStore.unregisterSurface("people");
  }, [presenceUsers, presenceEpoch]);

  const extraData = `${busyUsername}:${JSON.stringify(localFollowing)}`;

  const refreshRecommended = useCallback(async () => {
    await recommendedQuery.refetch();
  }, [recommendedQuery]);
  const refreshFriends = useCallback(async () => {
    await Promise.all([followersQuery.refetch(), followingQuery.refetch()]);
  }, [followersQuery, followingQuery]);
  const refreshFollowers = useCallback(async () => {
    await followersQuery.refetch();
  }, [followersQuery]);
  const refreshFollowing = useCallback(async () => {
    await followingQuery.refetch();
  }, [followingQuery]);
  const refreshSearch = useCallback(async () => {
    await searchQuery.refetch();
  }, [searchQuery]);

  const isFollowing = useCallback(
    (user: PeopleUserDto) =>
      localFollowing[user.username] ?? (user.isFollowing || followingFromServer.has(user.username)),
    [followingFromServer, localFollowing],
  );

  const refreshPeople = () => {
    void queryClient.invalidateQueries({ queryKey: ["people"] });
  };

  const toggleFollow = async (user: PeopleUserDto) => {
    const nextFollowing = !isFollowing(user);
    setBusyUsername(user.username);
    setLocalFollowing((prev) => ({ ...prev, [user.username]: nextFollowing }));
    try {
      if (nextFollowing) await apiFollowUser(user.username);
      else await apiUnfollowUser(user.username);
      refreshPeople();
    } catch (err) {
      setLocalFollowing((prev) => ({ ...prev, [user.username]: !nextFollowing }));
      Alert.alert("Подписка", err instanceof Error ? err.message : "Не удалось изменить подписку.");
    } finally {
      setBusyUsername(null);
    }
  };

  const paneProps = {
    pageWidth,
    listPaddingBottom,
    extraData,
    meUsername: me?.username,
    busyUsername,
    isFollowing,
    onToggleFollow: (user: PeopleUserDto) => void toggleFollow(user),
    onScrollBeginDrag: bumpSearchDismiss,
    searching: false,
  };

  return (
    <View style={styles.root}>
      <TabScreenHeader
        title="Люди"
        placeholder="Поиск по имени или нику"
        value={search}
        onChangeText={setSearch}
        dismissKey={`${mainTab}:${searchDismissEpoch}`}
        holdSearchFocusRef={holdSearchFocusRef}
        searchTags={SEARCH_SUGGESTION_TAGS.people}
        searchTagId={searchTagId}
        onSearchTagIdChange={setSearchTagId}
        onSearchActiveChange={setSearchChromeOpen}
        onChipPanBegin={chipStripBusy.onChipPanBegin}
        onChipPanFinalize={chipStripBusy.onChipPanFinalize}
        onChipPanDecayEnd={chipStripBusy.onChipPanDecayEnd}
        idle={({ stripOffset, maxOffset, viewportW }) => (
          <>
            <PagerChipStripFollow
              scrollX={scrollX}
              pageWidthSV={pageWidthSV}
              offset={stripOffset}
              maxOffset={maxOffset}
              viewportW={viewportW}
              layouts={indicatorLayouts}
            />
            <View style={styles.tabs}>
              <SyncIndexTabIndicator
                progress={tabProgress}
                layouts={indicatorLayouts}
                scrollX={stripOffset}
                insetX={FLORA_TAB_STRIP_PAD_X}
              />
              {PEOPLE_TABS.map((tab, index) => (
                <GesturePressable
                  key={tab.id}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: mainTab === tab.id }}
                  style={floraTabChrome.tabButton}
                  onLayout={(event) => recordTabLayout(tab.id, event)}
                  onPress={() => selectTab(tab.id)}
                >
                  <FloraTabLabel index={index} label={tab.label} progress={tabProgress} />
                </GesturePressable>
              ))}
            </View>
          </>
        )}
      />

      <View style={styles.body} onLayout={onBodyLayout}>
        <View style={styles.pagerHost} pointerEvents={hasSearch ? "none" : "auto"}>
          <TabPagerTrack
            pageCount={PEOPLE_TABS.length}
            pageWidth={pageWidth}
            pagerPan={pagerPan}
            scrollX={scrollX}
          >
            {mountedIds.has("recommended") ? (
              <PeoplePane
                {...paneProps}
                tab="recommended"
                users={recommendedUsers}
                loading={recommendedQuery.isLoading}
                error={recommendedQuery.isError}
                isActive={!hasSearch && mainTab === "recommended"}
                renderScrollComponent={renderScrollComponents[0]}
                onRefresh={refreshRecommended}
              />
            ) : (
              <TabPagerPage pageWidth={pageWidth} />
            )}
            {mountedIds.has("friends") ? (
              <PeoplePane
                {...paneProps}
                tab="friends"
                users={mutualFriends}
                loading={followersQuery.isLoading || followingQuery.isLoading}
                error={followersQuery.isError || followingQuery.isError}
                isActive={!hasSearch && mainTab === "friends"}
                renderScrollComponent={renderScrollComponents[1]}
                onRefresh={refreshFriends}
              />
            ) : (
              <TabPagerPage pageWidth={pageWidth} />
            )}
            {mountedIds.has("followers") ? (
              <PeoplePane
                {...paneProps}
                tab="followers"
                users={followersUsers}
                loading={followersQuery.isLoading}
                error={followersQuery.isError}
                isActive={!hasSearch && mainTab === "followers"}
                renderScrollComponent={renderScrollComponents[2]}
                onRefresh={refreshFollowers}
              />
            ) : (
              <TabPagerPage pageWidth={pageWidth} />
            )}
            {mountedIds.has("following") ? (
              <PeoplePane
                {...paneProps}
                tab="following"
                users={followingUsers}
                loading={followingQuery.isLoading}
                error={followingQuery.isError}
                isActive={!hasSearch && mainTab === "following"}
                renderScrollComponent={renderScrollComponents[3]}
                onRefresh={refreshFollowing}
              />
            ) : (
              <TabPagerPage pageWidth={pageWidth} />
            )}
          </TabPagerTrack>
        </View>
        {hasSearch ? (
          <View style={styles.searchOverlay}>
            <PeoplePane
              {...paneProps}
              tab={mainTab}
              users={searchUsers}
              loading={searchQuery.isLoading}
              error={searchQuery.isError}
              isActive
              searching
              renderScrollComponent={PagerOverlayScroll}
              onRefresh={refreshSearch}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
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
  avatarWrap: {
    position: "relative",
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    flexShrink: 0,
  },
  /** Match Web People `.onlineBadge` inset (−1), not SE-edge formula. */
  peopleOnlineInset: {
    right: -1,
    bottom: -1,
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
    gap: floraSpacing.gridFine,
  },
  nameLine: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: floraSpacing.gridFine * 2,
    minWidth: 0,
  },
  displayName: {
    flexShrink: 1,
    minWidth: 0,
    color: floraColors.whiteTemplate,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    lineHeight: 20,
  },
  username: {
    flexShrink: 0,
    color: floraColors.gray,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    lineHeight: 20,
  },
  followers: {
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
});
