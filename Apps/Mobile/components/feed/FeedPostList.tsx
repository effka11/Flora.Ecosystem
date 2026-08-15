import { apiGetFeed } from "@flora/client-core/api";
import type { FeedPostDto, PostEngagementSnapshot } from "@flora/client-core/contracts";
import { FlashList } from "@shopify/flash-list";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  View,
  type ScrollViewProps,
} from "react-native";
import { RefreshControl } from "react-native-gesture-handler";
import { PostCard } from "@/components/PostCard";
import { FrcMediaModeScope } from "@/lib/FrcImageDecodingScope";
import { feedRowEqual } from "@/lib/feedRowEqual";
import { trimFeedInfiniteDataToFirstPage } from "@/lib/feedInfiniteRefresh";
import { PREFETCH_END_THRESHOLD_VIEWPORTS } from "@/lib/feedPrefetchPolicy";
import { useFrcMediaBand } from "@/lib/useFrcMediaBand";
import { useStagedFeedPagination } from "@/lib/useStagedFeedPagination";
import {
  feedPostToEngagementSource,
  usePostEngagement,
  type PostEngagementSource,
} from "@/lib/usePostEngagement";
import { usePostViewTracking } from "@/lib/usePostViewTracking";
import { floraColors } from "@/lib/theme";
import { usePullToRefresh } from "@/lib/usePullToRefresh";

export type FeedKind = "recommendations" | "subscriptions";

const postKeyExtractor = (post: FeedPostDto) => post.postUuid;

/**
 * Coarse recycle pools: text-only and media rows have very different subtrees
 * and heights, so keeping them in separate pools avoids re-layout thrash when a
 * text row would otherwise recycle into a media row. Finer pools are only worth
 * adding if a trace shows a win.
 */
const postItemType = (post: FeedPostDto): "text" | "media" =>
  post.imageUuids.length > 0 || post.videoUuid ? "media" : "text";

export function useFeedQuery(kind: FeedKind) {
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

export type FeedPostListHandle = {
  refreshToTop: () => Promise<void>;
};

export type FeedPostListProps = {
  kind: FeedKind;
  feedQuery: FeedQuery;
  isActivePane: boolean;
  /** FRC-I / drawDistance gate — deferred after pager settle (not chrome active). */
  mediaEnabled: boolean;
  /** Catalog FSA hits; when set, the infinite feed query is not listed. */
  listedPosts?: FeedPostDto[];
  listedLoading?: boolean;
  listedError?: boolean;
  onListedRefresh?: () => Promise<void>;
  pageWidth: number;
  contentPaddingTop: number;
  contentPaddingBottom: number;
  online: boolean;
  renderScrollComponent: ComponentType<ScrollViewProps>;
  /** Expand collapsible chrome for this pane after scroll-to-top. */
  onScrolledToTop: () => void;
  /** Скролл списка (вне поиска) — закрыть полноширинный поиск. */
  onScrollBeginDrag?: () => void;
};

export const FeedPostList = forwardRef<FeedPostListHandle, FeedPostListProps>(
  function FeedPostList(
    {
      kind,
      feedQuery,
      isActivePane,
      mediaEnabled,
      listedPosts,
      listedLoading,
      listedError,
      onListedRefresh,
      pageWidth,
      contentPaddingTop,
      contentPaddingBottom,
      online,
      renderScrollComponent,
      onScrolledToTop,
      onScrollBeginDrag,
    },
    ref,
  ) {
    const queryClient = useQueryClient();
    const [commentsOpenPostUuid, setCommentsOpenPostUuid] = useState<string | null>(null);
    const [localCommentCounts, setLocalCommentCounts] = useState<Record<string, number>>({});
    const { snapshotFor, toggleLike, toggleRepost, isLikePending, isRepostPending } =
      usePostEngagement();
    const { viewabilityConfigCallbackPairs, flashListRef, refreshViewability, visibleRange } =
      usePostViewTracking({ enabled: mediaEnabled });

    const feedPosts = useMemo(
      () => feedQuery.data?.pages.flatMap((page) => page.items) ?? [],
      [feedQuery.data?.pages],
    );
    const isListed = listedPosts !== undefined;
    const visiblePosts = listedPosts ?? feedPosts;

    const mediaBand = useFrcMediaBand(visiblePosts, visibleRange, {
      enabled: mediaEnabled,
      online,
    });
    const { onApproachingEnd } = useStagedFeedPagination({
      kind,
      feedQuery,
      isActivePane: mediaEnabled,
      isSearching: isListed,
    });
    const postsRef = useRef(visiblePosts);
    postsRef.current = visiblePosts;
    const pendingScrollToTopRef = useRef(false);
    const onScrolledToTopRef = useRef(onScrolledToTop);
    onScrolledToTopRef.current = onScrolledToTop;
    const [scrollToTopNonce, setScrollToTopNonce] = useState(0);
    const refreshToTop = useCallback(async () => {
      if (onListedRefresh) {
        await onListedRefresh();
      } else {
        queryClient.setQueryData(["feed", kind], trimFeedInfiniteDataToFirstPage);
        await feedQuery.refetch();
      }
      pendingScrollToTopRef.current = true;
      setScrollToTopNonce((n) => n + 1);
    }, [feedQuery, kind, onListedRefresh, queryClient]);
    useLayoutEffect(() => {
      if (scrollToTopNonce === 0 || !pendingScrollToTopRef.current) return;
      pendingScrollToTopRef.current = false;
      flashListRef.current?.scrollToTop({ animated: false });
      onScrolledToTopRef.current();
    }, [flashListRef, scrollToTopNonce]);
    useImperativeHandle(ref, () => ({ refreshToTop }), [refreshToTop]);
    const { pullRefreshing, onRefresh: onPullRefresh } = usePullToRefresh(refreshToTop);
    const emptyHint =
      listedError || (!isListed && feedQuery.isError)
        ? "Не удалось загрузить ленту. Потяните вниз, чтобы обновить."
        : isListed
          ? "Ничего не найдено"
          : kind === "subscriptions"
            ? "Пока нет постов в подписках."
            : "Лента пуста";
    const listLoading = isListed ? Boolean(listedLoading) : feedQuery.isLoading;

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
      setCommentsOpenPostUuid((current) => (current === postUuid ? null : postUuid));
    }, []);

    const rowStateRef = useRef({
      snapshotFor,
      isLikePending,
      isRepostPending,
      commentsOpenPostUuid,
      localCommentCounts,
    });
    rowStateRef.current = {
      snapshotFor,
      isLikePending,
      isRepostPending,
      commentsOpenPostUuid,
      localCommentCounts,
    };
    const rowExtraData = useMemo(
      () => ({
        snapshotFor,
        isLikePending,
        isRepostPending,
        commentsOpenPostUuid,
        localCommentCounts,
      }),
      [commentsOpenPostUuid, isLikePending, isRepostPending, localCommentCounts, snapshotFor],
    );
    const renderFeedRow = useCallback(
      ({ item }: { item: FeedPostDto }) => {
        const state = rowStateRef.current;
        const engagement = state.snapshotFor(feedPostToEngagementSource(item));
        return (
          <FeedRow
            post={item}
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
      },
      [handleCommentAdded, handleToggleComments, handleToggleLike, handleToggleRepost],
    );

    useEffect(() => {
      if (!mediaEnabled || visiblePosts.length === 0) return;
      return refreshViewability();
    }, [mediaEnabled, refreshViewability, visiblePosts.length]);

    return (
      <View style={[styles.feedPage, { width: pageWidth }]}>
        <FrcMediaModeScope {...mediaBand}>
          <FlashList
            ref={flashListRef}
            data={visiblePosts}
            extraData={rowExtraData}
            keyExtractor={postKeyExtractor}
            getItemType={postItemType}
            keyboardDismissMode="on-drag"
            onScrollBeginDrag={onScrollBeginDrag}
            drawDistance={mediaEnabled ? 480 : 0}
            contentContainerStyle={[
              styles.listContent,
              { paddingTop: contentPaddingTop, paddingBottom: contentPaddingBottom },
            ]}
            nestedScrollEnabled={false}
            maintainVisibleContentPosition={{ disabled: true }}
            scrollEventThrottle={16}
            renderScrollComponent={renderScrollComponent}
            viewabilityConfigCallbackPairs={viewabilityConfigCallbackPairs}
            refreshControl={
              <RefreshControl
                refreshing={isActivePane && pullRefreshing}
                onRefresh={onPullRefresh}
                tintColor={floraColors.greenLight}
                progressViewOffset={contentPaddingTop}
              />
            }
            onEndReachedThreshold={PREFETCH_END_THRESHOLD_VIEWPORTS}
            onEndReached={isListed ? undefined : onApproachingEnd}
            renderItem={renderFeedRow}
            ListFooterComponent={
              !isListed && feedQuery.isFetchingNextPage && feedPosts.length > 0 ? (
                <View style={styles.loadingMore}>
                  <ActivityIndicator color={floraColors.greenLight} />
                </View>
              ) : null
            }
            ListEmptyComponent={
              listLoading ? (
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
  },
);

const styles = StyleSheet.create({
  feedPage: {
    flex: 1,
    alignSelf: "stretch",
  },
  listContent: {},
  loadingMore: {
    paddingVertical: 20,
    alignItems: "center",
  },
  empty: {
    color: floraColors.gray,
    textAlign: "center",
    marginTop: 40,
    fontWeight: "300",
    letterSpacing: 0.45,
  },
});
