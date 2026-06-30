import { Ionicons } from "@expo/vector-icons";
import {
  apiGetCommunities,
  apiGetOwnedCommunities,
  apiGetRecommendedCommunities,
  apiJoinCommunity,
  apiLeaveCommunity,
  apiListProfileCommunities,
  apiSearchCommunities,
} from "@flora/client-core/api";
import type { CommunityListItemDto } from "@flora/client-core/contracts";
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
import { FloraAvatar } from "@/components/FloraAvatar";
import { CreateCommunitySheet } from "@/components/communities/CreateCommunitySheet";
import { TabScreenSearchHeader } from "@/components/TabScreenSearchHeader";
import { communityScreenHref } from "@/lib/socialRoutes";
import { useSessionStore } from "@/stores/sessionStore";
import { floraColors, floraSpacing } from "@/lib/theme";

type CommunityTab = "recommended" | "subscriptions";

type TabLayout = { x: number; width: number };

const COMMUNITY_TABS: readonly { id: CommunityTab; label: string }[] = [
  { id: "recommended", label: "Рекомендации" },
  { id: "subscriptions", label: "Подписки" },
];

const AVATAR_SIZE = floraSpacing.grid * 3;
const COMMUNITY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isCommunityUuid(value: string): boolean {
  return COMMUNITY_UUID_RE.test(value.trim());
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

async function loadSubscriptions(username: string): Promise<CommunityListItemDto[]> {
  const [profileItems, publicList] = await Promise.all([
    apiListProfileCommunities(username),
    apiGetCommunities(),
  ]);
  const publicBySlug = new Map(publicList.map((item) => [item.slug, item]));
  return profileItems.map((item) => {
    const full = publicBySlug.get(item.slug);
    if (full) return { ...full, role: "Member" as const };
    return {
      communityId: item.slug,
      name: item.name,
      slug: item.slug,
      memberCount: 0,
      avatarUuid: null,
      role: "Member" as const,
    };
  });
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
          size={AVATAR_SIZE}
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

export default function CommunitiesScreen() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const me = useSessionStore((s) => s.me);
  const [search, setSearch] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<CommunityTab>("recommended");
  const [localJoined, setLocalJoined] = useState<Record<string, boolean>>({});
  const [busyCommunityId, setBusyCommunityId] = useState<string | null>(null);
  const [tabLayouts, setTabLayouts] = useState<Record<CommunityTab, TabLayout | null>>({
    recommended: null,
    subscriptions: null,
  });
  const indicatorLeft = useRef(new Animated.Value(0)).current;
  const indicatorWidth = useRef(new Animated.Value(0)).current;

  const recordTabLayout = useCallback((tab: CommunityTab, event: LayoutChangeEvent) => {
    const { x, width } = event.nativeEvent.layout;
    setTabLayouts((prev) => {
      const existing = prev[tab];
      if (existing?.x === x && existing?.width === width) return prev;
      return { ...prev, [tab]: { x, width } };
    });
  }, []);

  const activeTabLayout = tabLayouts[activeTab];

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
  }, [activeTab, activeTabLayout, indicatorLeft, indicatorWidth]);

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
    queryKey: ["communities", "recommended"],
    enabled: !hasSearch && activeTab === "recommended",
    queryFn: () => apiGetRecommendedCommunities(30),
  });

  const ownedQuery = useQuery({
    queryKey: ["communities", "owned"],
    queryFn: () => apiGetOwnedCommunities(),
  });

  const subscriptionsQuery = useQuery({
    queryKey: ["communities", "subscriptions", myUsername],
    enabled: !hasSearch && activeTab === "subscriptions" && myUsername.length > 0,
    queryFn: () => loadSubscriptions(myUsername),
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

  const visibleCommunities = hasSearch
    ? searchQuery.data ?? []
    : activeTab === "subscriptions"
      ? subscriptionsQuery.data ?? []
      : recommendedQuery.data ?? [];

  const listLoading = hasSearch
    ? searchQuery.isLoading
    : activeTab === "recommended"
      ? recommendedQuery.isLoading
      : subscriptionsQuery.isLoading;

  const listError = hasSearch
    ? searchQuery.isError
    : activeTab === "recommended"
      ? recommendedQuery.isError
      : subscriptionsQuery.isError;

  const listRefreshing = hasSearch
    ? searchQuery.isRefetching
    : activeTab === "recommended"
      ? recommendedQuery.isRefetching
      : subscriptionsQuery.isRefetching;

  const refreshCommunities = () => {
    void queryClient.invalidateQueries({ queryKey: ["communities"] });
  };

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

  const rowActions = useCallback(
    (community: CommunityListItemDto) => {
      if (community.role === "Owner" || ownedIds.has(community.communityId)) {
        return { showJoin: false, showLeave: false };
      }
      if (!isCommunityUuid(community.communityId)) {
        return { showJoin: false, showLeave: false };
      }
      const member = isMember(community);
      if (member) {
        const showLeave = hasSearch || activeTab === "subscriptions" || community.role === "Member";
        return { showJoin: false, showLeave };
      }
      return { showJoin: true, showLeave: false };
    },
    [activeTab, hasSearch, isMember],
  );

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

  return (
    <View style={styles.root}>
      <View style={[styles.topBlock, { paddingTop: insets.top + floraSpacing.grid }]}>
        <TabScreenSearchHeader
          placeholder="Поиск по названию или ссылке"
          value={search}
          onChangeText={setSearch}
          menuOpen={menuOpen}
          onMenuOpen={() => setMenuOpen(true)}
          onMenuClose={() => setMenuOpen(false)}
        />

        {!hasSearch ? (
          <View style={styles.navigationRow}>
            <View style={styles.tabs}>
              {tabIndicatorStyle ? (
                <Animated.View pointerEvents="none" style={[styles.tabIndicator, tabIndicatorStyle]} />
              ) : null}
              {COMMUNITY_TABS.map((tab) => (
                <Pressable
                  key={tab.id}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: activeTab === tab.id }}
                  style={({ pressed }) => [styles.tabButton, pressed && styles.tabPressed]}
                  onLayout={(event) => recordTabLayout(tab.id, event)}
                  onPress={() => setActiveTab(tab.id)}
                >
                  <Text style={[styles.tabLabel, activeTab === tab.id && styles.tabLabelActive]}>{tab.label}</Text>
                </Pressable>
              ))}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Создать сообщество"
              style={({ pressed }) => [styles.composeBtn, pressed && styles.pressed]}
              onPress={() => setCreateOpen(true)}
            >
              <Ionicons name="add" size={22} color={floraColors.greenLight} />
            </Pressable>
          </View>
        ) : null}
      </View>

      <FlashList
        style={styles.list}
        data={visibleCommunities}
        extraData={`${activeTab}:${queryText}:${JSON.stringify(localJoined)}`}
        keyExtractor={(item) => item.communityId}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={listRefreshing}
            onRefresh={refreshCommunities}
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
              onJoin={() => void toggleMembership(item, true)}
              onLeave={() => void toggleMembership(item, false)}
            />
          );
        }}
        ListEmptyComponent={
          listLoading ? (
            <View style={styles.loading}>
              <ActivityIndicator color={floraColors.greenLight} />
              <Text style={styles.emptyHint}>Загрузка сообществ…</Text>
            </View>
          ) : listError ? (
            <Text style={styles.emptyHint}>Не удалось загрузить список.</Text>
          ) : (
            <Text style={styles.emptyHint}>{emptyMessage(activeTab, hasSearch)}</Text>
          )
        }
      />

      <CreateCommunitySheet
        visible={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCommunityCreated}
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
  navigationRow: {
    position: "relative",
    minHeight: 35,
    width: "100%",
  },
  composeBtn: {
    position: "absolute",
    right: 0,
    top: 0,
    width: 45,
    height: 35,
    alignItems: "center",
    justifyContent: "center",
  },
  tabs: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    overflow: "visible",
    paddingRight: 45 + 10,
  },
  tabButton: {
    height: 35,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
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
});
