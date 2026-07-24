import type { FeedPostDto, PostEngagementSnapshot } from "@flora/client-core/contracts";
import { apiFeedHasNew, apiGetFeed } from "@flora/client-core/api";
import { Ionicons } from "@expo/vector-icons";
import { FlashList } from "@shopify/flash-list";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Reanimated, {
  cancelAnimation,
  Extrapolation,
  interpolate,
  interpolateColor,
  runOnJS,
  runOnUI,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PostCard } from "@/components/PostCard";
import { TabScreenSearchHeader } from "@/components/TabScreenSearchHeader";
import { FrcMediaModeScope } from "@/lib/FrcImageDecodingScope";
import {
  ENERGETIC_OPEN_EASING,
  ENERGETIC_OPEN_MS,
  settleEnergetic,
  snapPagerOffset,
} from "@/lib/energeticSettle";
import { feedRowEqual } from "@/lib/feedRowEqual";
import { PREFETCH_END_THRESHOLD_VIEWPORTS } from "@/lib/feedPrefetchPolicy";
import {
  backgroundLookaheadForNetwork,
  computeRowMediaModes,
  type FrcRowMediaMode,
  type NetworkClass,
} from "@/lib/frcMediaMode";
import { useNetworkClass } from "@/lib/useNetworkClass";
import { useCollapsibleHeader } from "@/lib/useCollapsibleHeader";
import { useStagedFeedPagination } from "@/lib/useStagedFeedPagination";
import {
  clearFrcImageQueuePauseOwner,
  setFrcImageQueuePaused,
} from "@/lib/frcImage";
import {
  feedPostToEngagementSource,
  usePostEngagement,
  type PostEngagementSource,
} from "@/lib/usePostEngagement";
import { usePostViewTracking } from "@/lib/usePostViewTracking";
import { composeScreenHref } from "@/lib/socialRoutes";
import { floraColors, floraSpacing, floraTabBarContentPadding } from "@/lib/theme";

/** Как SWIPE_AXIS_PX у drawer — не перехватывать вертикальный скролл ленты. */
const PAGER_AXIS_PX = 10;

/** chromeRow 45 + gap 5 + tabs 35 + border 1 */
const FEED_CHROME_BODY_HEIGHT = 45 + 5 + 35 + 1;

type FeedKind = "recommendations" | "subscriptions";

type TabLayout = { x: number; width: number };

const postKeyExtractor = (post: FeedPostDto) => post.postUuid;

/**
 * Coarse recycle pools: text-only and media rows have very different subtrees
 * and heights, so keeping them in separate pools avoids re-layout thrash when a
 * text row would otherwise recycle into a media row. Finer pools are only worth
 * adding if a trace shows a win.
 */
const postItemType = (post: FeedPostDto): "text" | "media" =>
  post.imageUuids.length > 0 || post.videoUuid ? "media" : "text";

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
  network: NetworkClass;
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
  network,
  renderScrollComponent,
}: FeedPaneProps) {
  const [commentsOpenPostUuid, setCommentsOpenPostUuid] = useState<string | null>(null);
  const [localCommentCounts, setLocalCommentCounts] = useState<Record<string, number>>({});
  const { snapshotFor, toggleLike, toggleRepost, isLikePending, isRepostPending } = usePostEngagement();
  const { viewsCountFor, viewabilityConfigCallbackPairs, flashListRef, refreshViewability, visibleRange } =
    usePostViewTracking({ enabled: isActivePane });

  const posts = useMemo(
    () => feedQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [feedQuery.data?.pages],
  );
  const visiblePosts = useMemo(() => filterPosts(posts, search), [posts, search]);

  // Map the viewability band → per-post decode modes so only visible/near/
  // lookahead rows enqueue FRC-I work (mount/drawDistance no longer decode all).
  const mediaModes = useMemo(() => {
    const lookahead = backgroundLookaheadForNetwork(network);
    const indexModes = computeRowMediaModes({
      count: visiblePosts.length,
      minVisible: visibleRange.min,
      maxVisible: visibleRange.max,
      lookahead,
    });
    const byUuid = new Map<string, FrcRowMediaMode>();
    for (const [index, mode] of indexModes) {
      const post = visiblePosts[index];
      if (post) byUuid.set(post.postUuid, mode);
    }
    return byUuid;
  }, [network, visiblePosts, visibleRange.min, visibleRange.max]);
  const { onApproachingEnd } = useStagedFeedPagination({
    kind,
    feedQuery,
    isActivePane,
    isSearching: search.trim().length > 0,
  });
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
      <FrcMediaModeScope enabled={isActivePane} modes={mediaModes}>
        <FlashList
          ref={flashListRef}
          data={visiblePosts}
          extraData={rowExtraData}
          keyExtractor={postKeyExtractor}
          getItemType={postItemType}
          // The off-screen pane only needs its viewport ready for a swipe.
          // Keeping its look-ahead rows mounted makes Android traverse and
          // composite two full feed windows during every pager frame.
          drawDistance={isActivePane ? 480 : 0}
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
          onEndReachedThreshold={PREFETCH_END_THRESHOLD_VIEWPORTS}
          onEndReached={onApproachingEnd}
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
      </FrcMediaModeScope>
    </View>
  );
}

export default function FeedScreen() {
  const insets = useSafeAreaInsets();
  const { width: pageWidth } = useWindowDimensions();
  const network = useNetworkClass();
  const queryClient = useQueryClient();
  const scrollX = useSharedValue(0);
  const dragStartX = useSharedValue(0);
  const pageWidthSV = useSharedValue(pageWidth);
  const pagerMediaPauseOwner = useRef(Symbol("feed-pager")).current;
  const [kind, setKind] = useState<FeedKind>("recommendations");
  const pagerTargetRef = useRef<FeedKind>(kind);
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

  useEffect(() => {
    pageWidthSV.value = pageWidth;
    // Только при смене ширины (rotate): kind-переходы анимирует settle/switchKind.
    scrollX.value = feedKindIndex(kind) * pageWidth;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- kind drives animated settles, not this jump
  }, [pageWidth, pageWidthSV, scrollX]);

  useEffect(
    () => () => clearFrcImageQueuePauseOwner(pagerMediaPauseOwner),
    [pagerMediaPauseOwner],
  );

  const beginPagerMotion = useCallback(() => {
    // Production feeds decode real FRC media. A cancellable download/decode
    // must not invalidate the transformed list tree while Android is
    // compositing both pages.
    setFrcImageQueuePaused(pagerMediaPauseOwner, "drag", true);
  }, [pagerMediaPauseOwner]);

  const endPagerMotion = useCallback(() => {
    setFrcImageQueuePaused(pagerMediaPauseOwner, "drag", false);
  }, [pagerMediaPauseOwner]);

  const recordTabLayout = useCallback((tab: FeedKind, event: LayoutChangeEvent) => {
    const { x, width } = event.nativeEvent.layout;
    setTabLayouts((prev) => {
      const existing = prev[tab];
      if (existing?.x === x && existing?.width === width) return prev;
      return { ...prev, [tab]: { x, width } };
    });
  }, []);

  const hasTabLayouts = Boolean(
    tabLayouts.recommendations && tabLayouts.subscriptions && pageWidth > 0,
  );

  const commitPagerIndex = useCallback(
    (index: number) => {
      const next: FeedKind = index === 0 ? "recommendations" : "subscriptions";
      pagerTargetRef.current = next;
      setActivePane(index);
      setKind((current) => (current === next ? current : next));
    },
    [setActivePane],
  );

  // Tab indicator + label colors run entirely on the UI thread off the pager's
  // scroll offset, so a horizontal switch never round-trips through JS.
  const tabIndicatorStyle = useAnimatedStyle(() => {
    const recommendations = tabLayouts.recommendations;
    const subscriptions = tabLayouts.subscriptions;
    if (!recommendations || !subscriptions || pageWidth <= 0) return {};
    return {
      width: interpolate(
        scrollX.value,
        [0, pageWidth],
        [recommendations.width, subscriptions.width],
        Extrapolation.CLAMP,
      ),
      transform: [
        {
          translateX: interpolate(
            scrollX.value,
            [0, pageWidth],
            [recommendations.x, subscriptions.x],
            Extrapolation.CLAMP,
          ),
        },
      ],
    };
  });

  const recommendationsLabelStyle = useAnimatedStyle(() => {
    if (pageWidth <= 0) return {};
    return {
      color: interpolateColor(
        scrollX.value,
        [0, pageWidth],
        [floraColors.greenLight, floraColors.gray],
      ),
    };
  });

  const subscriptionsLabelStyle = useAnimatedStyle(() => {
    if (pageWidth <= 0) return {};
    return {
      color: interpolateColor(
        scrollX.value,
        [0, pageWidth],
        [floraColors.gray, floraColors.greenLight],
      ),
    };
  });

  const pagerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -scrollX.value }],
  }));

  const recommendationsFeedQuery = useFeedQuery("recommendations");
  const subscriptionsFeedQuery = useFeedQuery("subscriptions");

  const recommendationsGeneratedAt = recommendationsFeedQuery.data?.pages[0]?.generatedAt ?? null;

  const hasNewQuery = useQuery({
    queryKey: ["feed-has-new", recommendationsGeneratedAt],
    enabled: recommendationsGeneratedAt != null,
    queryFn: () => apiFeedHasNew(recommendationsGeneratedAt!),
    refetchInterval: 30_000,
  });

  const pagerPan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-PAGER_AXIS_PX, PAGER_AXIS_PX])
        .failOffsetY([-PAGER_AXIS_PX * 2, PAGER_AXIS_PX * 2])
        .onStart(() => {
          "worklet";
          cancelAnimation(scrollX);
          dragStartX.value = scrollX.value;
          runOnJS(beginPagerMotion)();
        })
        .onUpdate((event) => {
          "worklet";
          const width = pageWidthSV.value;
          if (width <= 0) return;
          scrollX.value = Math.max(0, Math.min(width, dragStartX.value - event.translationX));
        })
        .onEnd((event) => {
          "worklet";
          const width = pageWidthSV.value;
          if (width <= 0) return;
          const target = snapPagerOffset(scrollX.value, width, 2, event.velocityX);
          settleEnergetic(
            scrollX,
            target,
            width,
            1,
            event.velocityX,
            ENERGETIC_OPEN_MS,
            ENERGETIC_OPEN_EASING,
            (finished) => {
              runOnJS(endPagerMotion)();
              if (finished) runOnJS(commitPagerIndex)(Math.round(target / width));
            },
          );
        })
        .onFinalize((_event, success) => {
          "worklet";
          if (!success) runOnJS(endPagerMotion)();
        }),
    [
      beginPagerMotion,
      commitPagerIndex,
      dragStartX,
      endPagerMotion,
      pageWidthSV,
      scrollX,
    ],
  );

  const switchKind = useCallback(
    (next: FeedKind) => {
      if (next === pagerTargetRef.current) return;
      pagerTargetRef.current = next;
      beginPagerMotion();
      const target = feedKindIndex(next) * pageWidth;
      runOnUI(() => {
        "worklet";
        cancelAnimation(scrollX);
        const width = pageWidthSV.value;
        settleEnergetic(
          scrollX,
          target,
          width > 0 ? width : 1,
          1,
          0,
          ENERGETIC_OPEN_MS,
          ENERGETIC_OPEN_EASING,
          (finished) => {
            runOnJS(endPagerMotion)();
            if (finished) runOnJS(commitPagerIndex)(Math.round(target / width));
          },
        );
      })();
    },
    [
      beginPagerMotion,
      commitPagerIndex,
      endPagerMotion,
      pageWidth,
      pageWidthSV,
      scrollX,
    ],
  );

  const refreshFeeds = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["feed"] });
    void hasNewQuery.refetch();
  }, [hasNewQuery, queryClient]);

  const showNewPostsBanner = kind === "recommendations" && hasNewQuery.data === true;

  return (
    <View style={styles.root}>
      <View style={styles.feedBody}>
        <GestureDetector gesture={pagerPan}>
          <Reanimated.View
            style={[styles.pagerRow, { width: pageWidth * 2 }, pagerStyle]}
          >
            <FeedPane
              kind="recommendations"
              feedQuery={recommendationsFeedQuery}
              isActivePane={kind === "recommendations"}
              search={search}
              pageWidth={pageWidth}
              contentPaddingTop={headerHeightPx}
              contentPaddingBottom={listPaddingBottom}
              network={network}
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
              network={network}
              renderScrollComponent={renderScrollComponents[1]}
            />
          </Reanimated.View>
        </GestureDetector>
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
              {hasTabLayouts ? (
                <Reanimated.View
                  pointerEvents="none"
                  style={[styles.tabIndicator, tabIndicatorStyle]}
                />
              ) : null}
              <Pressable
                style={({ pressed }) => [styles.tabButton, pressed && styles.tabPressed]}
                onLayout={(event) => recordTabLayout("recommendations", event)}
                onPress={() => switchKind("recommendations")}
              >
                <Reanimated.Text
                  style={[
                    styles.tabLabel,
                    hasTabLayouts ? recommendationsLabelStyle : styles.tabLabelActive,
                  ]}
                >
                  Рекомендации
                </Reanimated.Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.tabButton, pressed && styles.tabPressed]}
                onLayout={(event) => recordTabLayout("subscriptions", event)}
                onPress={() => switchKind("subscriptions")}
              >
                <Reanimated.Text
                  style={[styles.tabLabel, hasTabLayouts ? subscriptionsLabelStyle : null]}
                >
                  Подписки
                </Reanimated.Text>
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
    overflow: "hidden",
  },
  pagerRow: {
    flex: 1,
    flexDirection: "row",
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
