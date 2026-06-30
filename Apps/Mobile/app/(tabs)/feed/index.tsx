import type { FeedPostDto } from "@flora/client-core/contracts";
import { apiFeedHasNew, apiGetFeed } from "@flora/client-core/api";
import { Ionicons } from "@expo/vector-icons";
import { FlashList } from "@shopify/flash-list";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollView,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FeedHamburgerMenu } from "@/components/FeedHamburgerMenu";
import { PostCard } from "@/components/PostCard";
import { feedPostToEngagementSource, usePostEngagement } from "@/lib/usePostEngagement";
import { usePostViewTracking } from "@/lib/usePostViewTracking";
import { floraColors, floraSpacing } from "@/lib/theme";

type FeedKind = "recommendations" | "subscriptions";

type TabLayout = { x: number; width: number };

function feedKindIndex(kind: FeedKind) {
  return kind === "recommendations" ? 0 : 1;
}

function filterPosts(posts: FeedPostDto[], search: string) {
  const q = search.trim().toLowerCase();
  if (!q) return posts;
  return posts.filter((post) => {
    const haystack = [
      post.text,
      post.authorDisplayName,
      post.authorUsername,
      post.communityName ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });
}

type FeedPaneProps = {
  kind: FeedKind;
  search: string;
  pageWidth: number;
};

function FeedPane({ kind, search, pageWidth }: FeedPaneProps) {
  const [commentsOpenPostUuid, setCommentsOpenPostUuid] = useState<string | null>(null);
  const [localCommentCounts, setLocalCommentCounts] = useState<Record<string, number>>({});
  const { snapshotFor, toggleLike, toggleRepost, isLikePending, isRepostPending } = usePostEngagement();
  const { viewsCountFor, viewabilityConfigCallbackPairs, flashListRef, refreshViewability } =
    usePostViewTracking();

  const feedQuery = useInfiniteQuery({
    queryKey: ["feed", kind],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      apiGetFeed({
        kind,
        cursor: pageParam,
        take: pageParam ? 20 : 30,
        refresh: kind === "recommendations" && !pageParam,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const posts = feedQuery.data?.pages.flatMap((p) => p.items) ?? [];
  const visiblePosts = useMemo(() => filterPosts(posts, search), [posts, search]);
  const isRefreshing = feedQuery.isRefetching || feedQuery.isFetchingNextPage;
  const emptyHint = feedQuery.isError
    ? "Не удалось загрузить ленту. Потяните вниз, чтобы обновить."
    : kind === "subscriptions"
      ? "Пока нет постов в подписках."
      : search.trim()
        ? "Ничего не найдено"
        : "Лента пуста";

  const commentCountFor = useCallback(
    (post: FeedPostDto) => localCommentCounts[post.postUuid] ?? post.commentCount,
    [localCommentCounts],
  );

  const handleCommentAdded = useCallback((postUuid: string) => {
    setLocalCommentCounts((prev) => ({
      ...prev,
      [postUuid]: Math.max(
        0,
        (prev[postUuid] ??
          posts.find((p) => p.postUuid === postUuid)?.commentCount ??
          0) + 1,
      ),
    }));
  }, [posts]);

  useEffect(() => {
    if (visiblePosts.length === 0) return;
    return refreshViewability();
  }, [refreshViewability, visiblePosts.length]);

  return (
    <View style={[styles.feedPage, { width: pageWidth }]}>
      <FlashList
        ref={flashListRef}
        data={visiblePosts}
        keyExtractor={(item) => item.postUuid}
        estimatedItemSize={320}
        drawDistance={480}
        contentContainerStyle={styles.listContent}
        nestedScrollEnabled
        viewabilityConfigCallbackPairs={viewabilityConfigCallbackPairs}
        refreshControl={
          <RefreshControl
            refreshing={feedQuery.isRefetching}
            onRefresh={() => {
              void feedQuery.refetch();
            }}
            tintColor={floraColors.greenLight}
          />
        }
        onEndReached={() => {
          if (feedQuery.hasNextPage && !feedQuery.isFetchingNextPage) feedQuery.fetchNextPage();
        }}
        renderItem={({ item }) => {
          const engagementSource = feedPostToEngagementSource(item);
          const engagement = snapshotFor(engagementSource);
          const commentsOpen = commentsOpenPostUuid === item.postUuid;
          return (
            <PostCard
              post={item}
              viewCount={viewsCountFor(item)}
              engagement={engagement}
              commentCount={commentCountFor(item)}
              commentsOpen={commentsOpen}
              likePending={isLikePending(item.postUuid)}
              repostPending={isRepostPending(item.postUuid)}
              onToggleLike={() => void toggleLike(engagementSource)}
              onToggleRepost={() => void toggleRepost(engagementSource)}
              onToggleComments={() =>
                setCommentsOpenPostUuid((id) => (id === item.postUuid ? null : item.postUuid))
              }
              onCommentAdded={handleCommentAdded}
            />
          );
        }}
        ListFooterComponent={
          isRefreshing && posts.length > 0 ? (
            <View style={styles.loadingMore}>
              <ActivityIndicator color={floraColors.greenLight} />
            </View>
          ) : null
        }
        ListEmptyComponent={
          feedQuery.isLoading ? (
            <View style={styles.loadingMore}>
              <ActivityIndicator color={floraColors.greenLight} />
            </View>
          ) : (
            <Text style={styles.empty}>{emptyHint}</Text>
          )
        }
      />
    </View>
  );
}

export default function FeedScreen() {
  const insets = useSafeAreaInsets();
  const { width: pageWidth } = useWindowDimensions();
  const queryClient = useQueryClient();
  const pagerRef = useRef<ScrollView>(null);
  const scrollX = useRef(new Animated.Value(0)).current;
  const [kind, setKind] = useState<FeedKind>("recommendations");
  const [tabLayouts, setTabLayouts] = useState<Record<FeedKind, TabLayout | null>>({
    recommendations: null,
    subscriptions: null,
  });
  const [search, setSearch] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);

  const recordTabLayout = useCallback((tab: FeedKind, event: LayoutChangeEvent) => {
    const { x, width } = event.nativeEvent.layout;
    setTabLayouts((prev) => {
      const existing = prev[tab];
      if (existing?.x === x && existing?.width === width) return prev;
      return { ...prev, [tab]: { x, width } };
    });
  }, []);

  const tabIndicatorStyle = useMemo(() => {
    const recommendations = tabLayouts.recommendations;
    const subscriptions = tabLayouts.subscriptions;
    if (!recommendations || !subscriptions || pageWidth <= 0) return null;

    return {
      width: scrollX.interpolate({
        inputRange: [0, pageWidth],
        outputRange: [recommendations.width, subscriptions.width],
        extrapolate: "clamp",
      }),
      transform: [
        {
          translateX: scrollX.interpolate({
            inputRange: [0, pageWidth],
            outputRange: [recommendations.x, subscriptions.x],
            extrapolate: "clamp",
          }),
        },
      ],
    };
  }, [pageWidth, scrollX, tabLayouts.recommendations, tabLayouts.subscriptions]);

  const tabLabelColors = useMemo(() => {
    if (pageWidth <= 0) return null;

    return {
      recommendations: scrollX.interpolate({
        inputRange: [0, pageWidth],
        outputRange: [floraColors.greenLight, floraColors.gray],
        extrapolate: "clamp",
      }),
      subscriptions: scrollX.interpolate({
        inputRange: [0, pageWidth],
        outputRange: [floraColors.gray, floraColors.greenLight],
        extrapolate: "clamp",
      }),
    };
  }, [pageWidth, scrollX]);

  const onPagerScroll = useMemo(
    () =>
      Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], {
        useNativeDriver: false,
      }),
    [scrollX],
  );

  const recommendationsFeedQuery = useInfiniteQuery({
    queryKey: ["feed", "recommendations"],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      apiGetFeed({
        kind: "recommendations",
        cursor: pageParam,
        take: pageParam ? 20 : 30,
        refresh: !pageParam,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const recommendationsGeneratedAt = recommendationsFeedQuery.data?.pages[0]?.generatedAt ?? null;

  const hasNewQuery = useQuery({
    queryKey: ["feed-has-new", recommendationsGeneratedAt],
    enabled: recommendationsGeneratedAt != null,
    queryFn: () => apiFeedHasNew(recommendationsGeneratedAt!),
    refetchInterval: 30_000,
  });

  const switchKind = useCallback(
    (next: FeedKind) => {
      if (next === kind) return;
      setKind(next);
      pagerRef.current?.scrollTo({
        x: feedKindIndex(next) * pageWidth,
        animated: true,
      });
    },
    [kind, pageWidth],
  );

  const onPagerScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const index = Math.round(event.nativeEvent.contentOffset.x / pageWidth);
      const next: FeedKind = index === 0 ? "recommendations" : "subscriptions";
      setKind((current) => (current === next ? current : next));
    },
    [pageWidth],
  );

  const refreshFeeds = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["feed"] });
    void hasNewQuery.refetch();
  }, [hasNewQuery, queryClient]);

  const showNewPostsBanner = kind === "recommendations" && hasNewQuery.data === true;

  return (
    <View style={styles.root}>
      <View style={[styles.topBlock, { paddingTop: insets.top + floraSpacing.grid }]}>
        <View style={styles.searchRow}>
          <View style={styles.searchBox}>
            <Ionicons name="search-outline" size={20} color={floraColors.gray} />
            <TextInput
              style={styles.searchInput}
              placeholder="Поиск в ленте"
              placeholderTextColor={floraColors.gray}
              value={search}
              onChangeText={setSearch}
            />
            {search.length > 0 ? (
              <Pressable style={styles.searchClear} onPress={() => setSearch("")} hitSlop={10}>
                <Ionicons name="close" size={18} color={floraColors.greenLight} />
              </Pressable>
            ) : null}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Меню"
            style={({ pressed }) => [styles.menuButton, pressed && styles.pressed]}
            onPress={() => setMenuOpen(true)}
          >
            <Ionicons name="menu-outline" size={24} color={floraColors.gray} />
          </Pressable>
        </View>
        <FeedHamburgerMenu visible={menuOpen} onClose={() => setMenuOpen(false)} />

        <View style={styles.navigationRow}>
          <View style={styles.tabs}>
            {tabIndicatorStyle ? (
              <Animated.View
                pointerEvents="none"
                style={[styles.tabIndicator, tabIndicatorStyle]}
              />
            ) : null}
            <Pressable
              style={({ pressed }) => [styles.tabButton, pressed && styles.tabPressed]}
              onLayout={(event) => recordTabLayout("recommendations", event)}
              onPress={() => switchKind("recommendations")}
            >
              <Animated.Text
                style={[
                  styles.tabLabel,
                  tabLabelColors ? { color: tabLabelColors.recommendations } : styles.tabLabelActive,
                ]}
              >
                Рекомендации
              </Animated.Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.tabButton, pressed && styles.tabPressed]}
              onLayout={(event) => recordTabLayout("subscriptions", event)}
              onPress={() => switchKind("subscriptions")}
            >
              <Animated.Text
                style={[
                  styles.tabLabel,
                  tabLabelColors ? { color: tabLabelColors.subscriptions } : null,
                ]}
              >
                Подписки
              </Animated.Text>
            </Pressable>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Создать пост"
            style={({ pressed }) => [styles.composeBtn, pressed && styles.pressed]}
            onPress={() => router.push("/compose")}
          >
            <Ionicons name="add" size={22} color={floraColors.greenLight} />
          </Pressable>
        </View>
      </View>

      <View style={styles.feedBody}>
        {showNewPostsBanner ? (
          <Pressable style={({ pressed }) => [styles.banner, pressed && styles.pressed]} onPress={refreshFeeds}>
            <Ionicons name="arrow-up-outline" size={14} color={floraColors.greenLight} />
            <Text style={styles.bannerText}>Новые посты — нажмите, чтобы обновить</Text>
          </Pressable>
        ) : null}
        <Animated.ScrollView
          ref={pagerRef}
          horizontal
          pagingEnabled
          decelerationRate="fast"
          showsHorizontalScrollIndicator={false}
          scrollEventThrottle={16}
          onScroll={onPagerScroll}
          onMomentumScrollEnd={onPagerScrollEnd}
          style={styles.pager}
          contentContainerStyle={styles.pagerContent}
        >
          <FeedPane kind="recommendations" search={search} pageWidth={pageWidth} />
          <FeedPane kind="subscriptions" search={search} pageWidth={pageWidth} />
        </Animated.ScrollView>
      </View>
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
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  searchBox: {
    flex: 1,
    minHeight: 45,
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
  menuButton: {
    width: 45,
    minHeight: 45,
    borderColor: floraColors.greenDark,
    borderWidth: 1,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  feedBody: {
    flex: 1,
  },
  pager: {
    flex: 1,
  },
  pagerContent: {
    flexGrow: 1,
    alignItems: "stretch",
  },
  feedPage: {
    flex: 1,
    alignSelf: "stretch",
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
  banner: {
    marginHorizontal: floraSpacing.grid,
    marginTop: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(164, 209, 138, 0.28)",
    backgroundColor: "rgba(164, 209, 138, 0.12)",
    paddingHorizontal: 14,
    paddingVertical: 9,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
  },
  bannerText: {
    color: floraColors.greenLight,
    textAlign: "center",
    fontSize: 13,
    fontWeight: "300",
    letterSpacing: 0.39,
  },
  listContent: {
    paddingBottom: 24,
  },
  loadingMore: {
    paddingVertical: 20,
    alignItems: "center",
  },
  pressed: {
    opacity: 0.72,
  },
  empty: { color: floraColors.gray, textAlign: "center", marginTop: 40, fontWeight: "300", letterSpacing: 0.45 },
});
