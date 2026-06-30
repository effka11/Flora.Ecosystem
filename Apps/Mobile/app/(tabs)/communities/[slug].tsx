import {
  apiDeletePost,
  apiGetCommunityBySlug,
  apiGetCommunityPosts,
  apiJoinCommunity,
  apiLeaveCommunity,
  isApiRequestError,
} from "@flora/client-core/api";
import type { FeedPostDto } from "@flora/client-core/contracts";
import { communityPostToFeedPost } from "@flora/client-core/contracts";
import { FlashList } from "@shopify/flash-list";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CommunityCardHeader } from "@/components/communities/CommunityCardHeader";
import { PostCard } from "@/components/PostCard";
import {
  communitySettingsScreenHref,
  decodeRouteParam,
} from "@/lib/socialRoutes";
import { feedPostToEngagementSource, usePostEngagement } from "@/lib/usePostEngagement";
import { floraColors, floraSpacing } from "@/lib/theme";

export default function CommunityScreen() {
  const { slug: rawSlug } = useLocalSearchParams<{ slug: string | string[] }>();
  const slug = decodeRouteParam(Array.isArray(rawSlug) ? rawSlug[0] ?? "" : rawSlug ?? "");
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const [commentsOpenPostUuid, setCommentsOpenPostUuid] = useState<string | null>(null);
  const [localCommentCounts, setLocalCommentCounts] = useState<Record<string, number>>({});
  const [localMembersCount, setLocalMembersCount] = useState<number | null>(null);
  const [membershipBusy, setMembershipBusy] = useState(false);
  const [membershipError, setMembershipError] = useState<string | null>(null);
  const [deletedPostUuids, setDeletedPostUuids] = useState<Set<string>>(() => new Set());
  const { snapshotFor, toggleLike, toggleRepost, isLikePending, isRepostPending } = usePostEngagement();

  const communityQuery = useQuery({
    queryKey: ["community", slug],
    enabled: slug.length > 0,
    queryFn: () => apiGetCommunityBySlug(slug),
  });

  const community = communityQuery.data;
  const isOwner = community?.role === "Owner";
  const communityId = community?.communityId;

  const postsQuery = useQuery({
    queryKey: ["community-posts", communityId],
    enabled: !!communityId,
    queryFn: () => apiGetCommunityPosts(communityId!, { skip: 0, take: 30 }),
    retry: (count, err) => {
      if (isApiRequestError(err) && err.status === 403) return false;
      return count < 2;
    },
  });

  useEffect(() => {
    setLocalMembersCount(null);
    setMembershipError(null);
    setDeletedPostUuids(new Set());
    setCommentsOpenPostUuid(null);
    setLocalCommentCounts({});
  }, [slug]);

  useEffect(() => {
    if (community?.memberCount != null) {
      setLocalMembersCount(community.memberCount);
    }
  }, [community?.memberCount, community?.communityId]);

  useFocusEffect(
    useCallback(() => {
      if (slug.length > 0) void communityQuery.refetch();
      if (communityId) void postsQuery.refetch();
    }, [communityId, communityQuery.refetch, postsQuery.refetch, slug.length]),
  );

  const posts = useMemo((): FeedPostDto[] => {
    if (!community) return [];
    return (postsQuery.data ?? [])
      .filter((post) => !deletedPostUuids.has(post.postUuid))
      .map((post) => communityPostToFeedPost(post, community));
  }, [community, deletedPostUuids, postsQuery.data]);

  const commentCountFor = useCallback(
    (post: FeedPostDto) => localCommentCounts[post.postUuid] ?? post.commentCount,
    [localCommentCounts],
  );

  const handleCommentAdded = useCallback(
    (postUuid: string) => {
      setLocalCommentCounts((prev) => ({
        ...prev,
        [postUuid]: Math.max(
          0,
          (prev[postUuid] ?? posts.find((p) => p.postUuid === postUuid)?.commentCount ?? 0) + 1,
        ),
      }));
    },
    [posts],
  );

  const handleSubscribe = useCallback(async () => {
    if (!community || membershipBusy) return;
    setMembershipBusy(true);
    setMembershipError(null);
    try {
      const joined = await apiJoinCommunity(community.communityId);
      const merged = {
        ...community,
        ...joined,
        role: joined.role ?? ("Member" as const),
        avatarUuid: joined.avatarUuid ?? community.avatarUuid,
      };
      queryClient.setQueryData(["community", slug], merged);
      setLocalMembersCount(merged.memberCount);
      void queryClient.invalidateQueries({ queryKey: ["communities"] });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Не удалось подписаться.";
      setMembershipError(message);
      Alert.alert("Сообщество", message);
    } finally {
      setMembershipBusy(false);
    }
  }, [community, membershipBusy, queryClient, slug]);

  const handleUnsubscribe = useCallback(async () => {
    if (!community || membershipBusy) return;
    setMembershipBusy(true);
    setMembershipError(null);
    try {
      await apiLeaveCommunity(community.communityId);
      queryClient.setQueryData(["community", slug], (old: typeof community | undefined) =>
        old ? { ...old, role: undefined } : old,
      );
      void queryClient.invalidateQueries({ queryKey: ["community-posts", community.communityId] });
      setLocalMembersCount((n) => Math.max(0, (n ?? community.memberCount) - 1));
      void queryClient.invalidateQueries({ queryKey: ["communities"] });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Не удалось отписаться.";
      setMembershipError(message);
      Alert.alert("Сообщество", message);
    } finally {
      setMembershipBusy(false);
    }
  }, [community, membershipBusy, queryClient, slug]);

  const handleDeletePost = useCallback(
    (postUuid: string) => {
      Alert.alert("Удалить пост?", "Это действие нельзя отменить.", [
        { text: "Отмена", style: "cancel" },
        {
          text: "Удалить",
          style: "destructive",
          onPress: () => {
            void (async () => {
              try {
                await apiDeletePost(postUuid);
                setDeletedPostUuids((prev) => new Set(prev).add(postUuid));
              } catch (err) {
                Alert.alert(
                  "Удаление",
                  err instanceof Error ? err.message : "Не удалось удалить пост.",
                );
              }
            })();
          },
        },
      ]);
    },
    [],
  );

  const handleRefresh = useCallback(() => {
    void communityQuery.refetch();
    void postsQuery.refetch();
  }, [communityQuery, postsQuery]);

  const memberCount = localMembersCount ?? community?.memberCount ?? 0;

  const header = useMemo(
    () => (
      <CommunityCardHeader
        name={community?.name ?? slug}
        communityId={community?.communityId ?? slug}
        slug={community?.slug ?? slug}
        avatarUuid={community?.avatarUuid}
        memberCount={memberCount}
        isPrivate={community?.isPrivate}
        role={community?.role}
        loading={communityQuery.isLoading}
        membershipBusy={membershipBusy}
        membershipError={membershipError}
        onComposePress={
          isOwner && community
            ? () =>
                router.push({
                  pathname: "/compose",
                  params: { communityUuid: community.communityId },
                })
            : undefined
        }
        onSettingsPress={
          isOwner && community ? () => router.push(communitySettingsScreenHref(community.slug)) : undefined
        }
        onSubscribePress={
          community && !isOwner && community.role !== "Member" ? () => void handleSubscribe() : undefined
        }
        onUnsubscribePress={community?.role === "Member" ? () => void handleUnsubscribe() : undefined}
      />
    ),
    [
      community,
      communityQuery.isLoading,
      handleSubscribe,
      handleUnsubscribe,
      isOwner,
      memberCount,
      membershipBusy,
      membershipError,
      slug,
    ],
  );

  const postsForbidden = postsQuery.isError && isApiRequestError(postsQuery.error) && postsQuery.error.status === 403;

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <FlashList
        key={slug}
        data={posts}
        keyExtractor={(item) => item.postUuid}
        ListHeaderComponent={header}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={communityQuery.isRefetching || postsQuery.isRefetching}
            onRefresh={handleRefresh}
            tintColor={floraColors.greenLight}
          />
        }
        renderItem={({ item }) => {
          const engagementSource = feedPostToEngagementSource(item);
          const engagement = snapshotFor(engagementSource);
          const commentsOpen = commentsOpenPostUuid === item.postUuid;
          return (
            <PostCard
              post={item}
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
              canDeletePost={isOwner}
              onDeletePost={isOwner ? () => handleDeletePost(item.postUuid) : undefined}
            />
          );
        }}
        ListEmptyComponent={
          communityQuery.isLoading ? (
            <View style={styles.loading}>
              <ActivityIndicator color={floraColors.greenLight} />
            </View>
          ) : communityQuery.isError ? (
            <Text style={styles.empty}>Сообщество не найдено.</Text>
          ) : postsQuery.isLoading ? (
            <View style={styles.loading}>
              <ActivityIndicator color={floraColors.greenLight} />
            </View>
          ) : postsForbidden ? (
            <Text style={styles.empty}>Посты недоступны.</Text>
          ) : postsQuery.isError ? (
            <Text style={styles.empty}>Не удалось загрузить посты.</Text>
          ) : (
            <Text style={styles.empty}>
              {isOwner ? "Пока нет постов. Сделайте первый пост." : "Пока нет постов."}
            </Text>
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: floraColors.bg },
  listContent: {
    paddingBottom: floraSpacing.grid * 2,
  },
  loading: {
    paddingVertical: floraSpacing.grid * 3,
  },
  empty: {
    color: floraColors.gray,
    paddingHorizontal: floraSpacing.grid,
    paddingVertical: floraSpacing.grid * 2,
    fontSize: 14,
    fontWeight: "300",
    letterSpacing: 0.42,
  },
});
