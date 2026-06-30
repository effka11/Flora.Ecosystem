import { apiFollowUser, apiGetProfile, apiGetProfilePosts, apiUnfollowUser } from "@flora/client-core/api";
import type { FeedPostDto } from "@flora/client-core/contracts";
import { profilePostToFeedPost } from "@flora/client-core/contracts";
import { FlashList } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, Redirect } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ProfileCardHeader } from "@/components/profile/ProfileCardHeader";
import { PostCard } from "@/components/PostCard";
import { openDmWithUser } from "@/lib/openDm";
import { decodeRouteParam, isOwnUsername } from "@/lib/socialRoutes";
import { feedPostToEngagementSource, usePostEngagement } from "@/lib/usePostEngagement";
import { usePostViewTracking } from "@/lib/usePostViewTracking";
import { useSessionStore } from "@/stores/sessionStore";
import { floraColors, floraSpacing } from "@/lib/theme";

export default function UserProfileScreen() {
  const { username: rawUsername } = useLocalSearchParams<{ username: string | string[] }>();
  const username = decodeRouteParam(Array.isArray(rawUsername) ? rawUsername[0] ?? "" : rawUsername ?? "");
  const insets = useSafeAreaInsets();
  const me = useSessionStore((s) => s.me);
  const [commentsOpenPostUuid, setCommentsOpenPostUuid] = useState<string | null>(null);
  const [localCommentCounts, setLocalCommentCounts] = useState<Record<string, number>>({});
  const [followBusy, setFollowBusy] = useState(false);
  const { snapshotFor, toggleLike, toggleRepost, isLikePending, isRepostPending } = usePostEngagement();
  const { viewsCountFor, viewabilityConfigCallbackPairs, flashListRef, refreshViewability } =
    usePostViewTracking();
  const isSelfProfile = isOwnUsername(username, me?.username);
  const profileQuery = useQuery({
    queryKey: ["profile", username],
    enabled: !!username && !isSelfProfile,
    queryFn: () => apiGetProfile(username!),
  });
  const postsQuery = useQuery({
    queryKey: ["profile-posts", username],
    enabled: !!username && !isSelfProfile,
    queryFn: () => apiGetProfilePosts(username!, { skip: 0, take: 30 }),
  });

  const profile = profileQuery.data;
  const isOwnProfile =
    !!me?.userUuid && !!profile?.userUuid && me.userUuid === profile.userUuid;
  const canShowOtherActions =
    !isOwnProfile && !!me?.userUuid && !!profile?.userUuid;
  const posts = useMemo((): FeedPostDto[] => {
    if (!username || !profile) return [];
    const author = {
      userUuid: profile.userUuid,
      username,
      displayName: profile.displayName,
      avatarUuid: profile.avatarUuid,
    };
    return (postsQuery.data ?? []).map((post) => profilePostToFeedPost(post, author));
  }, [postsQuery.data, profile, username]);

  useEffect(() => {
    if (posts.length === 0) return;
    return refreshViewability();
  }, [posts.length, refreshViewability]);

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

  const handleToggleFollow = useCallback(async () => {
    if (!username || followBusy) return;
    setFollowBusy(true);
    try {
      if (profile?.isFollowingByMe) await apiUnfollowUser(username);
      else await apiFollowUser(username);
      await profileQuery.refetch();
    } catch (err) {
      Alert.alert("Подписка", err instanceof Error ? err.message : "Не удалось изменить подписку.");
    } finally {
      setFollowBusy(false);
    }
  }, [followBusy, profile?.isFollowingByMe, profileQuery, username]);

  const handleRefresh = useCallback(() => {
    void profileQuery.refetch();
    void postsQuery.refetch();
  }, [postsQuery, profileQuery]);

  const header = useMemo(
    () => (
      <ProfileCardHeader
        displayName={profile?.displayName ?? username ?? ""}
        username={username ?? ""}
        avatarUuid={profile?.avatarUuid}
        userUuid={profile?.userUuid}
        status={profile?.status ?? null}
        followersCount={profile?.followersCount ?? 0}
        followingCount={profile?.followingCount ?? 0}
        statusLoading={profileQuery.isLoading}
        actionVariant={canShowOtherActions ? "other" : undefined}
        onWritePress={
          canShowOtherActions && profile?.canMessageByMe
            ? () => openDmWithUser(me!.userUuid, profile.userUuid)
            : undefined
        }
        isFollowing={profile?.isFollowingByMe}
        followBusy={followBusy}
        onToggleFollow={canShowOtherActions ? () => void handleToggleFollow() : undefined}
      />
    ),
    [
      canShowOtherActions,
      followBusy,
      handleToggleFollow,
      me,
      profile,
      profileQuery.isLoading,
      username,
    ],
  );

  if (isSelfProfile) {
    return <Redirect href="/(tabs)/profile" />;
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <FlashList
        ref={flashListRef}
        data={posts}
        keyExtractor={(item) => item.postUuid}
        ListHeaderComponent={header}
        contentContainerStyle={styles.listContent}
        viewabilityConfigCallbackPairs={viewabilityConfigCallbackPairs}
        refreshControl={
          <RefreshControl
            refreshing={profileQuery.isRefetching || postsQuery.isRefetching}
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
        ListEmptyComponent={
          postsQuery.isLoading || profileQuery.isLoading ? (
            <View style={styles.loading}>
              <ActivityIndicator color={floraColors.greenLight} />
            </View>
          ) : profileQuery.isError ? (
            <Text style={styles.empty}>Не удалось загрузить профиль.</Text>
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
