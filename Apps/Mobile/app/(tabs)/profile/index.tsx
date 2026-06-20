import { apiGetProfilePosts } from "@flora/client-core/api";
import type { FeedPostDto } from "@flora/client-core/contracts";
import { profilePostToFeedPost } from "@flora/client-core/contracts";
import { FlashList } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ProfileCardHeader } from "@/components/profile/ProfileCardHeader";
import { PostCard } from "@/components/PostCard";
import { feedPostToEngagementSource, usePostEngagement } from "@/lib/usePostEngagement";
import { useSessionStore } from "@/stores/sessionStore";
import { floraColors, floraSpacing } from "@/lib/theme";

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const me = useSessionStore((s) => s.me);
  const [commentsOpenPostUuid, setCommentsOpenPostUuid] = useState<string | null>(null);
  const [localCommentCounts, setLocalCommentCounts] = useState<Record<string, number>>({});
  const { snapshotFor, toggleLike, toggleRepost, isLikePending, isRepostPending } = usePostEngagement();

  const username = me?.username ?? "";
  const postsQuery = useQuery({
    queryKey: ["profile-posts", username],
    enabled: username.length > 0,
    queryFn: () => apiGetProfilePosts(username, { skip: 0, take: 30 }),
  });

  const posts = useMemo((): FeedPostDto[] => {
    if (!me) return [];
    return (postsQuery.data ?? []).map((post) =>
      profilePostToFeedPost(post, {
        userUuid: me.userUuid,
        username: me.username,
        displayName: me.displayName,
        avatarUuid: me.avatarUuid,
      }),
    );
  }, [me, postsQuery.data]);

  useFocusEffect(
    useCallback(() => {
      if (username.length > 0) void postsQuery.refetch();
    }, [postsQuery.refetch, username]),
  );

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

  const header = useMemo(
    () => (
      <ProfileCardHeader
        displayName={me?.displayName ?? "Профиль"}
        username={username}
        avatarUuid={me?.avatarUuid}
        userUuid={me?.userUuid}
        status={me?.status}
        followersCount={me?.followersCount}
        followingCount={me?.followingCount}
        onSettingsPress={() => router.push({ pathname: "/settings", params: { section: "account" } })}
        actionVariant="own"
        avatarEditable
      />
    ),
    [me, username],
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <FlashList
        data={posts}
        keyExtractor={(item) => item.postUuid}
        ListHeaderComponent={header}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={postsQuery.isRefetching}
            onRefresh={() => postsQuery.refetch()}
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
            />
          );
        }}
        ListEmptyComponent={
          postsQuery.isLoading ? (
            <View style={styles.loading}>
              <ActivityIndicator color={floraColors.greenLight} />
            </View>
          ) : postsQuery.isError ? (
            <Text style={styles.empty}>Не удалось загрузить посты.</Text>
          ) : (
            <Text style={styles.empty}>Пока нет постов.</Text>
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
