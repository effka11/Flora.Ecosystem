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
import { FlashList } from "@shopify/flash-list";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DropdownMenuOverlay } from "@/components/DropdownMenuOverlay";
import { FloraAvatar } from "@/components/FloraAvatar";
import { TabScreenSearchHeader } from "@/components/TabScreenSearchHeader";
import { useSessionStore } from "@/stores/sessionStore";
import { floraColors, floraSpacing } from "@/lib/theme";

type PeopleMainTab = "recommended" | "friends";
type FriendsFilter = "friends" | "followers" | "following";

type TabLayout = { x: number; width: number };

const FRIENDS_FILTER_OPTIONS: readonly { id: FriendsFilter; label: string }[] = [
  { id: "friends", label: "Друзья" },
  { id: "followers", label: "Подписчики" },
  { id: "following", label: "Подписки" },
];

const AVATAR_SIZE = floraSpacing.grid * 3;

function emptyMessage(mainTab: PeopleMainTab, friendsFilter: FriendsFilter, hasSearch: boolean): string {
  if (hasSearch) return "Ничего не найдено. Измените запрос в поиске.";
  if (mainTab === "recommended") {
    return "Пока нет рекомендаций. Загляните позже или найдите людей через поиск.";
  }
  if (friendsFilter === "friends") return "Пока нет друзей.";
  if (friendsFilter === "followers") return "Пока нет подписчиков.";
  return "Пока нет подписок.";
}

function formatFollowers(count: number): string {
  return `${count.toLocaleString("ru-RU")} подписчиков`;
}

type PeopleRowProps = {
  user: PeopleUserDto;
  following: boolean;
  actionBusy: boolean;
  onToggleFollow: () => void;
};

function PeopleRow({ user, following, actionBusy, onToggleFollow }: PeopleRowProps) {
  const profileHref = { pathname: "/profile/[username]", params: { username: user.username } } as const;
  return (
    <View style={styles.shell}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Открыть профиль ${user.displayName}`}
        style={({ pressed }) => [styles.rowMain, pressed && styles.rowMainPressed]}
        onPress={() => router.push(profileHref)}
      >
        <FloraAvatar
          size={AVATAR_SIZE}
          avatarUuid={user.avatarUuid}
          displayName={user.displayName}
          username={user.username}
          seed={user.userUuid ?? user.username}
        />
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

export default function PeopleScreen() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const me = useSessionStore((s) => s.me);
  const [search, setSearch] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [mainTab, setMainTab] = useState<PeopleMainTab>("recommended");
  const [friendsFilter, setFriendsFilter] = useState<FriendsFilter>("friends");
  const [friendsFilterOpen, setFriendsFilterOpen] = useState(false);
  const [localFollowing, setLocalFollowing] = useState<Record<string, boolean>>({});
  const [busyUsername, setBusyUsername] = useState<string | null>(null);
  const friendsFilterAnchorRef = useRef<View>(null);
  const [tabLayouts, setTabLayouts] = useState<Record<PeopleMainTab, TabLayout | null>>({
    recommended: null,
    friends: null,
  });
  const indicatorLeft = useRef(new Animated.Value(0)).current;
  const indicatorWidth = useRef(new Animated.Value(0)).current;

  const recordTabLayout = useCallback((tab: PeopleMainTab, event: LayoutChangeEvent) => {
    const { x, width } = event.nativeEvent.layout;
    setTabLayouts((prev) => {
      const existing = prev[tab];
      if (existing?.x === x && existing?.width === width) return prev;
      return { ...prev, [tab]: { x, width } };
    });
  }, []);

  const activeTabLayout = tabLayouts[mainTab];

  useEffect(() => {
    if (!activeTabLayout) return;
    Animated.parallel([
      Animated.spring(indicatorLeft, {
        toValue: activeTabLayout.x,
        useNativeDriver: false,
        stiffness: 320,
        damping: 32,
        mass: 0.8,
      }),
      Animated.spring(indicatorWidth, {
        toValue: activeTabLayout.width,
        useNativeDriver: false,
        stiffness: 320,
        damping: 32,
        mass: 0.8,
      }),
    ]).start();
  }, [mainTab, activeTabLayout, indicatorLeft, indicatorWidth]);

  const tabIndicatorStyle = useMemo(() => {
    if (!activeTabLayout) return null;
    return {
      width: indicatorWidth,
      transform: [{ translateX: indicatorLeft }],
    };
  }, [activeTabLayout, indicatorLeft, indicatorWidth]);

  const myUsername = me?.username?.replace(/^@+/, "") ?? "";
  const queryText = search.trim();
  const hasSearch = queryText.length > 0;

  const recommendedQuery = useQuery({
    queryKey: ["people", "recommended"],
    enabled: !hasSearch && mainTab === "recommended",
    queryFn: () => apiGetRecommendedUsers(40),
  });

  const followersQuery = useQuery({
    queryKey: ["people", "followers", myUsername],
    enabled: !hasSearch && mainTab === "friends" && myUsername.length > 0,
    queryFn: () => apiGetProfileFollowers(myUsername, { take: 50 }),
  });

  const followingQuery = useQuery({
    queryKey: ["people", "following", myUsername],
    enabled: !hasSearch && mainTab === "friends" && myUsername.length > 0,
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

  const friendsUsers = useMemo(() => {
    if (friendsFilter === "followers") return followersQuery.data ?? [];
    if (friendsFilter === "following") return followingQuery.data ?? [];
    return mutualFriends;
  }, [followersQuery.data, followingQuery.data, friendsFilter, mutualFriends]);

  const visibleUsers = hasSearch ? searchQuery.data ?? [] : mainTab === "friends" ? friendsUsers : recommendedQuery.data ?? [];

  const friendsListLoading =
    friendsFilter === "followers"
      ? followersQuery.isLoading
      : friendsFilter === "following"
        ? followingQuery.isLoading
        : followersQuery.isLoading || followingQuery.isLoading;

  const friendsListError =
    friendsFilter === "followers"
      ? followersQuery.isError
      : friendsFilter === "following"
        ? followingQuery.isError
        : followersQuery.isError || followingQuery.isError;

  const listLoading = hasSearch ? searchQuery.isLoading : mainTab === "recommended" ? recommendedQuery.isLoading : friendsListLoading;
  const listError = hasSearch ? searchQuery.isError : mainTab === "recommended" ? recommendedQuery.isError : friendsListError;
  const listRefreshing = hasSearch
    ? searchQuery.isRefetching
    : mainTab === "recommended"
      ? recommendedQuery.isRefetching
      : followersQuery.isRefetching || followingQuery.isRefetching;

  const selectRecommendations = useCallback(() => {
    setFriendsFilterOpen(false);
    setMainTab("recommended");
  }, []);

  const handleFriendsTabPress = useCallback(() => {
    if (mainTab === "friends") {
      setFriendsFilterOpen((open) => !open);
      return;
    }
    setFriendsFilterOpen(false);
    setMainTab("friends");
  }, [mainTab]);

  const selectFriendsFilter = useCallback((filter: FriendsFilter) => {
    setFriendsFilter(filter);
    setFriendsFilterOpen(false);
    setMainTab("friends");
  }, []);

  const isFollowing = (user: PeopleUserDto) =>
    localFollowing[user.username] ?? (user.isFollowing || followingFromServer.has(user.username));

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

  const activeFriendsFilterLabel =
    FRIENDS_FILTER_OPTIONS.find((option) => option.id === friendsFilter)?.label ?? "Друзья";

  return (
    <View style={styles.root}>
      <View style={[styles.topBlock, { paddingTop: insets.top + floraSpacing.grid }]}>
        <TabScreenSearchHeader
          placeholder="Поиск по имени или нику"
          value={search}
          onChangeText={(value) => {
            setSearch(value);
            setFriendsFilterOpen(false);
          }}
          menuOpen={menuOpen}
          onMenuOpen={() => {
            setFriendsFilterOpen(false);
            setMenuOpen(true);
          }}
          onMenuClose={() => setMenuOpen(false)}
        />

        {!hasSearch ? (
          <View style={styles.tabs}>
            {tabIndicatorStyle ? (
              <Animated.View pointerEvents="none" style={[styles.tabIndicator, tabIndicatorStyle]} />
            ) : null}
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: mainTab === "recommended" }}
              style={({ pressed }) => [styles.tabButton, pressed && styles.tabPressed]}
              onLayout={(event) => recordTabLayout("recommended", event)}
              onPress={selectRecommendations}
            >
              <Text style={[styles.tabLabel, mainTab === "recommended" && styles.tabLabelActive]}>Рекомендации</Text>
            </Pressable>
            <View
              style={styles.friendsTabWrap}
              collapsable={false}
              onLayout={(event) => recordTabLayout("friends", event)}
            >
              <Pressable
                accessibilityRole="tab"
                accessibilityLabel={`Друзья: ${activeFriendsFilterLabel}`}
                accessibilityState={{ selected: mainTab === "friends", expanded: friendsFilterOpen }}
                style={({ pressed }) => [styles.tabButton, styles.friendsTabButton, pressed && styles.tabPressed]}
                onPress={handleFriendsTabPress}
              >
                <Text style={[styles.tabLabel, mainTab === "friends" && styles.tabLabelActive]}>
                  {mainTab === "friends" ? activeFriendsFilterLabel : "Друзья"}
                </Text>
                {mainTab === "friends" ? (
                  <Ionicons
                    name="chevron-down"
                    size={16}
                    color={friendsFilterOpen ? floraColors.greenLight : floraColors.gray}
                    style={friendsFilterOpen ? styles.chevronOpen : undefined}
                  />
                ) : null}
              </Pressable>
              <View ref={friendsFilterAnchorRef} pointerEvents="none" style={styles.anchorMarker} collapsable={false} />
              <DropdownMenuOverlay
                open={friendsFilterOpen}
                onClose={() => setFriendsFilterOpen(false)}
                anchorRef={friendsFilterAnchorRef}
                menuStyle={styles.filterMenu}
              >
                {FRIENDS_FILTER_OPTIONS.map((option, index) => (
                  <Pressable
                    key={option.id}
                    accessibilityRole="menuitem"
                    accessibilityState={{ selected: friendsFilter === option.id }}
                    style={({ pressed }) => [
                      styles.filterMenuItem,
                      index === 0 && styles.filterMenuItemFirst,
                      index === FRIENDS_FILTER_OPTIONS.length - 1 && styles.filterMenuItemLast,
                      friendsFilter === option.id && styles.filterMenuItemActive,
                      pressed && styles.pressed,
                    ]}
                    onPress={() => selectFriendsFilter(option.id)}
                  >
                    <Text
                      style={[
                        styles.filterMenuItemLabel,
                        friendsFilter === option.id && styles.filterMenuItemLabelActive,
                      ]}
                    >
                      {option.label}
                    </Text>
                  </Pressable>
                ))}
              </DropdownMenuOverlay>
            </View>
          </View>
        ) : null}
      </View>

      <FlashList
        style={styles.list}
        data={visibleUsers}
        extraData={`${mainTab}:${friendsFilter}:${queryText}`}
        keyExtractor={(item) => item.username}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={listRefreshing}
            onRefresh={refreshPeople}
            tintColor={floraColors.greenLight}
          />
        }
        renderItem={({ item }) => (
          <PeopleRow
            user={item}
            following={isFollowing(item)}
            actionBusy={busyUsername === item.username}
            onToggleFollow={() => void toggleFollow(item)}
          />
        )}
        ListEmptyComponent={
          listLoading ? (
            <View style={styles.loading}>
              <ActivityIndicator color={floraColors.greenLight} />
              <Text style={styles.emptyHint}>Загрузка людей…</Text>
            </View>
          ) : listError ? (
            <Text style={styles.emptyHint}>Не удалось загрузить список.</Text>
          ) : (
            <Text style={styles.emptyHint}>{emptyMessage(mainTab, friendsFilter, hasSearch)}</Text>
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
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
    gap: 13,
    overflow: "visible",
  },
  list: {
    flex: 1,
  },
  tabs: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    overflow: "visible",
  },
  tabButton: {
    height: 35,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  friendsTabWrap: {
    position: "relative",
    overflow: "visible",
  },
  friendsTabButton: {
    flexDirection: "row",
    gap: floraSpacing.gridFine,
  },
  chevronOpen: {
    transform: [{ rotate: "180deg" }],
  },
  anchorMarker: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 0,
  },
  filterMenu: {
    minWidth: 220,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(250, 250, 250, 0.12)",
    backgroundColor: floraColors.surface,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 16,
  },
  filterMenuItem: {
    paddingHorizontal: floraSpacing.grid,
    paddingVertical: floraSpacing.gridFine * 2,
  },
  filterMenuItemFirst: {
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
  },
  filterMenuItemLast: {
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 12,
  },
  filterMenuItemActive: {
    backgroundColor: "rgba(164, 209, 138, 0.08)",
  },
  filterMenuItemLabel: {
    color: floraColors.gray,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    lineHeight: 20,
  },
  filterMenuItemLabelActive: {
    color: floraColors.greenLight,
  },
  tabPressed: {
    opacity: 0.72,
  },
  tabLabel: {
    color: floraColors.gray,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    lineHeight: 15,
  },
  tabLabelActive: {
    color: floraColors.greenLight,
  },
  tabIndicator: {
    position: "absolute",
    left: 0,
    bottom: 0,
    height: 2,
    borderRadius: 999,
    backgroundColor: floraColors.greenLight,
    zIndex: 2,
  },
  listContent: {
    paddingBottom: floraSpacing.grid * 2,
  },
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
