import type { FeedPostDto, PostEngagementSnapshot } from "@flora/client-core/contracts";
import { apiFeedHasNew, apiGetFeed } from "@flora/client-core/api";
import { Ionicons } from "@expo/vector-icons";
import { FlashList } from "@shopify/flash-list";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollView,
} from "react-native";
import Reanimated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PostCard } from "@/components/PostCard";
import { TabScreenSearchHeader } from "@/components/TabScreenSearchHeader";
import { FrcImageDecodingScope } from "@/lib/FrcImageDecodingScope";
import { feedRowEqual } from "@/lib/feedRowEqual";
import { useCollapsibleHeader } from "@/lib/useCollapsibleHeader";
import {
  feedPostToEngagementSource,
  usePostEngagement,
  type PostEngagementSource,
} from "@/lib/usePostEngagement";
import { usePostViewTracking } from "@/lib/usePostViewTracking";
import { composeScreenHref } from "@/lib/socialRoutes";
import { floraColors, floraSpacing, floraTabBarContentPadding } from "@/lib/theme";

/** chromeRow 45 + gap 5 + tabs 35 + border 1 */
const FEED_CHROME_BODY_HEIGHT = 45 + 5 + 35 + 1;

type FeedKind = "recommendations" | "subscriptions";

type TabLayout = { x: number; width: number };

const postKeyExtractor = (post: FeedPostDto) => post.postUuid;

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

function useFeedQuery(kind: FeedKind) {
  return useInfiniteQuery({
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
}

type FeedQuery = ReturnType<typeof useFeedQuery>;

type FeedRowProps = {
  post: FeedPostDto;
  viewCount: number;
  engagement: PostEngagementSnapshot;
  commentCount: number;
  commentsOpen: boolean;
  likePending: boolean;
  repostPending: boolean;
  onToggleLike: (source: PostEngagementSource) => void;
  onToggleRepost: (source: PostEngagementSource) => void;
  onToggleComments: (postUuid: string) => void;
  onCommentAdded: (postUuid: string) => void;
};

const FeedRow = memo(
  function FeedRow({
    post,
    viewCount,
    engagement,
    commentCount,
    commentsOpen,
    likePending,
    repostPending,
    onToggleLike,
    onToggleRepost,
    onToggleComments,
    onCommentAdded,
  }: FeedRowProps) {
    const source = feedPostToEngagementSource(post);
    return (
      <PostCard
        post={post}
        viewCount={viewCount}
        engagement={engagement}
        commentCount={commentCount}
        commentsOpen={commentsOpen}
        likePending={likePending}
        repostPending={repostPending}
        onToggleLike={() => onToggleLike(source)}
        onToggleRepost={() => onToggleRepost(source)}
        onToggleComments={() => onToggleComments(post.postUuid)}
        onCommentAdded={onCommentAdded}
      />
    );
  },
  feedRowEqual,
);

type FeedPaneProps = {
  kind: FeedKind;
  feedQuery: FeedQuery;
  isActivePane: boolean;
  search: string;
  pageWidth: number;
  contentPaddingTop: number;
  contentPaddingBottom: number;
  renderScrollComponent: ReturnType<typeof useCollapsibleHeader>["renderScrollComponents"][number];
};

function FeedPane({
  kind,
  feedQuery,
  isActivePane,
  search,
  pageWidth,
  contentPaddingTop,
  contentPaddingBottom,
  renderScrollComponent,
}: FeedPaneProps) {
  const [commentsOpenPostUuid, setCommentsOpenPostUuid] = useState<string | null>(null);
  const [localCommentCounts, setLocalCommentCounts] = useState<Record<string, number>>({});
  const { snapshotFor, toggleLike, toggleRepost, isLikePending, isRepostPending } = usePostEngagement();
  const { viewsCountFor, viewabilityConfigCallbackPairs, flashListRef, refreshViewability } =
    usePostViewTracking({ enabled: isActivePane });

  const posts = useMemo(
    () => feedQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [feedQuery.data?.pages],
  );
  const visiblePosts = useMemo(() => filterPosts(posts, search), [posts, search]);
  const postsRef = useRef(posts);
  postsRef.current = posts;
  const isRefreshing = feedQuery.isRefetching || feedQuery.isFetchingNextPage;
  const emptyHint = feedQuery.isError
    ? "Не удалось загрузить ленту. Потяните вниз, чтобы обновить."
    : kind === "subscriptions"
      ? "Пока нет постов в подписках."
      : search.trim()
        ? "Ничего не найдено"
        : "Лента пуста";

  const handleCommentAdded = useCallback((postUuid: string) => {
    setLocalCommentCounts((prev) => ({
      ...prev,
      [postUuid]: Math.max(
        0,
        (prev[postUuid] ??
          postsRef.current.find((post) => post.postUuid === postUuid)?.commentCount ??
          0) + 1,
      ),
    }));
  }, []);

  const engagementActionsRef = useRef({ toggleLike, toggleRepost });
  engagementActionsRef.current = { toggleLike, toggleRepost };
  const handleToggleLike = useCallback((source: PostEngagementSource) => {
    void engagementActionsRef.current.toggleLike(source);
  }, []);
  const handleToggleRepost = useCallback((source: PostEngagementSource) => {
    void engagementActionsRef.current.toggleRepost(source);
  }, []);
  const handleToggleComments = useCallback((postUuid: string) => {
    setCommentsOpenPostUuid((current) => current === postUuid ? null : postUuid);
  }, []);

  const rowStateRef = useRef({
    snapshotFor,
    viewsCountFor,
    isLikePending,
    isRepostPending,
    commentsOpenPostUuid,
    localCommentCounts,
  });
  rowStateRef.current = {
    snapshotFor,
    viewsCountFor,
    isLikePending,
    isRepostPending,
    commentsOpenPostUuid,
    localCommentCounts,
  };
  const rowExtraData = useMemo(
    () => ({
      snapshotFor,
      viewsCountFor,
      isLikePending,
      isRepostPending,
      commentsOpenPostUuid,
      localCommentCounts,
    }),
    [
      commentsOpenPostUuid,
      isLikePending,
      isRepostPending,
      localCommentCounts,
      snapshotFor,
      viewsCountFor,
    ],
  );
  const renderFeedRow = useCallback(({ item }: { item: FeedPostDto }) => {
    const state = rowStateRef.current;
    const engagement = state.snapshotFor(feedPostToEngagementSource(item));
    return (
      <FeedRow
        post={item}
        viewCount={state.viewsCountFor(item)}
        engagement={engagement}
        commentCount={state.localCommentCounts[item.postUuid] ?? item.commentCount}
        commentsOpen={state.commentsOpenPostUuid === item.postUuid}
        likePending={state.isLikePending(item.postUuid)}
        repostPending={state.isRepostPending(item.postUuid)}
        onToggleLike={handleToggleLike}
        onToggleRepost={handleToggleRepost}
        onToggleComments={handleToggleComments}
        onCommentAdded={handleCommentAdded}
      />
    );
  }, [handleCommentAdded, handleToggleComments, handleToggleLike, handleToggleRepost]);

  useEffect(() => {
    if (!isActivePane || visiblePosts.length === 0) return;
    return refreshViewability();
  }, [isActivePane, refreshViewability, visiblePosts.length]);

  return (
    <View style={[styles.feedPage, { width: pageWidth }]}>
      <FrcImageDecodingScope enabled={isActivePane}>
        <FlashList
          ref={flashListRef}
          data={visiblePosts}
          extraData={rowExtraData}
          keyExtractor={postKeyExtractor}
          drawDistance={480}
          contentContainerStyle={[
            styles.listContent,
            { paddingTop: contentPaddingTop, paddingBottom: contentPaddingBottom },
          ]}
          nestedScrollEnabled
          scrollEventThrottle={16}
          renderScrollComponent={renderScrollComponent}
          viewabilityConfigCallbackPairs={viewabilityConfigCallbackPairs}
          refreshControl={
            <RefreshControl
              refreshing={feedQuery.isRefetching}
              onRefresh={() => {
                void feedQuery.refetch();
              }}
              tintColor={floraColors.greenLight}
              progressViewOffset={contentPaddingTop}
            />
          }
          onEndReached={() => {
            if (feedQuery.hasNextPage && !feedQuery.isFetchingNextPage) feedQuery.fetchNextPage();
          }}
          renderItem={renderFeedRow}
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
      </FrcImageDecodingScope>
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
  const listPaddingBottom = floraTabBarContentPadding(Math.max(insets.bottom, 8));
  const estimatedHeaderHeight = insets.top + floraSpacing.grid + FEED_CHROME_BODY_HEIGHT;
  const {
    headerHeightPx,
    onHeaderLayout,
    headerAnimatedStyle,
    renderScrollComponents,
    setActivePane,
  } = useCollapsibleHeader({
    estimatedHeight: estimatedHeaderHeight,
  });

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

  const recommendationsFeedQuery = useFeedQuery("recommendations");
  const subscriptionsFeedQuery = useFeedQuery("subscriptions");

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
      setActivePane(feedKindIndex(next));
      pagerRef.current?.scrollTo({
        x: feedKindIndex(next) * pageWidth,
        animated: true,
      });
    },
    [kind, pageWidth, setActivePane],
  );

  const onPagerScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const index = Math.round(event.nativeEvent.contentOffset.x / pageWidth);
      const next: FeedKind = index === 0 ? "recommendations" : "subscriptions";
      setActivePane(index);
      setKind((current) => (current === next ? current : next));
    },
    [pageWidth, setActivePane],
  );

  const refreshFeeds = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["feed"] });
    void hasNewQuery.refetch();
  }, [hasNewQuery, queryClient]);

  const showNewPostsBanner = kind === "recommendations" && hasNewQuery.data === true;

  return (
    <View style={styles.root}>
      <View style={styles.feedBody}>
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
          <FeedPane
            kind="recommendations"
            feedQuery={recommendationsFeedQuery}
            isActivePane={kind === "recommendations"}
            search={search}
            pageWidth={pageWidth}
            contentPaddingTop={headerHeightPx}
            contentPaddingBottom={listPaddingBottom}
            renderScrollComponent={renderScrollComponents[0]}
          />
          <FeedPane
            kind="subscriptions"
            feedQuery={subscriptionsFeedQuery}
            isActivePane={kind === "subscriptions"}
            search={search}
            pageWidth={pageWidth}
            contentPaddingTop={headerHeightPx}
            contentPaddingBottom={listPaddingBottom}
            renderScrollComponent={renderScrollComponents[1]}
          />
        </Animated.ScrollView>
      </View>

      <Reanimated.View style={[styles.topChrome, headerAnimatedStyle]}>
        <View
          style={[styles.topBlock, { paddingTop: insets.top + floraSpacing.grid }]}
          onLayout={onHeaderLayout}
        >
          <TabScreenSearchHeader
            title="Лента"
            placeholder="Поиск в ленте"
            value={search}
            onChangeText={setSearch}
            createAction={{
              accessibilityLabel: "Создать пост",
              onPress: () => router.push(composeScreenHref()),
            }}
          />

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
          </View>
        </View>

        {showNewPostsBanner ? (
          <Pressable
            style={({ pressed }) => [styles.banner, pressed && styles.pressed]}
            onPress={refreshFeeds}
          >
            <Ionicons name="arrow-up-outline" size={14} color={floraColors.greenLight} />
            <Text style={styles.bannerText}>Новые посты — нажмите, чтобы обновить</Text>
          </Pressable>
        ) : null}
      </Reanimated.View>

      {/* Закреплённый фон статус-бара — не уезжает вместе с chrome. */}
      <View
        pointerEvents="none"
        style={[styles.statusBarFill, { height: insets.top }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: floraColors.bg },
  topChrome: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
  },
  statusBarFill: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
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
  listContent: {},
  loadingMore: {
    paddingVertical: 20,
    alignItems: "center",
  },
  pressed: {
    opacity: 0.72,
  },
  empty: { color: floraColors.gray, textAlign: "center", marginTop: 40, fontWeight: "300", letterSpacing: 0.45 },
});
