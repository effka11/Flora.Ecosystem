import { apiGetProfile, apiGetProfilePosts } from "@flora/client-core/api";
import { apiGetMe } from "@flora/client-core/auth";
import type { FeedPostDto } from "@flora/client-core/contracts";
import { profilePostToFeedPost } from "@flora/client-core/contracts";
import { sharedPresenceStore } from "@flora/client-core/presence";
import { FlashList } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ProfileCardHeader } from "@/components/profile/ProfileCardHeader";
import { PostCard } from "@/components/PostCard";
import { FrcMediaModeScope } from "@/lib/FrcImageDecodingScope";
import { resolveOwnProfileAvatarUuid } from "@/lib/ownProfileAvatar";
import { useFrcMediaBand } from "@/lib/useFrcMediaBand";
import { useNetworkClass } from "@/lib/useNetworkClass";
import { feedPostToEngagementSource, usePostEngagement } from "@/lib/usePostEngagement";
import { usePostViewTracking } from "@/lib/usePostViewTracking";
import { useDeletePost } from "@/lib/useDeletePost";
import { useEditPost } from "@/lib/useEditPost";
import { usePullToRefresh } from "@/lib/usePullToRefresh";
import { useSessionStore } from "@/stores/sessionStore";
import { floraColors, floraSpacing, floraTabBarContentPadding } from "@/lib/theme";

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const listPaddingBottom = floraTabBarContentPadding(Math.max(insets.bottom, 8));
  const me = useSessionStore((s) => s.me);
  const setMe = useSessionStore((s) => s.setMe);
  const network = useNetworkClass();
  const [commentsOpenPostUuid, setCommentsOpenPostUuid] = useState<string | null>(null);
  const [localCommentCounts, setLocalCommentCounts] = useState<Record<string, number>>({});
  const [focused, setFocused] = useState(false);
  const { snapshotFor, toggleLike, toggleRepost, isLikePending, isRepostPending } = usePostEngagement();
  const handleDeletePost = useDeletePost();
  const { openEditPost, editSheet } = useEditPost();
  const { viewabilityConfigCallbackPairs, flashListRef, refreshViewability, visibleRange } =
    usePostViewTracking({ enabled: focused });

  const username = me?.username ?? "";
  const profileQuery = useQuery({
    queryKey: ["profile", username],
    enabled: username.length > 0,
    queryFn: () => apiGetProfile(username),
    refetchOnMount: false,
  });
  const postsQuery = useQuery({
    queryKey: ["profile-posts", username],
    enabled: username.length > 0,
    queryFn: () => apiGetProfilePosts(username, { skip: 0, take: 30 }),
    refetchOnMount: false,
  });

  const refreshMe = useCallback(async () => {
    try {
      setMe(await apiGetMe());
    } catch {
      /* keep last session me */
    }
  }, [setMe]);

  const pullPosts = useCallback(async () => {
    await Promise.all([postsQuery.refetch(), profileQuery.refetch(), refreshMe()]);
  }, [postsQuery, profileQuery, refreshMe]);
  const { pullRefreshing, onRefresh: onPullRefresh } = usePullToRefresh(pullPosts);

  const posts = useMemo((): FeedPostDto[] => {
    if (!me) return [];
    const avatarUuid = resolveOwnProfileAvatarUuid(me.avatarUuid, profileQuery.data?.avatarUuid);
    return (postsQuery.data ?? []).map((post) => ({
      ...profilePostToFeedPost(post, {
        userUuid: me.userUuid,
        username: me.username,
        displayName: me.displayName,
        avatarUuid,
      }),
      authorAccountBlocked: me.accountBlocked ?? false,
    }));
  }, [me, postsQuery.data, profileQuery.data?.avatarUuid]);

  const mediaBand = useFrcMediaBand(posts, visibleRange, { online: network === "online" });

  useEffect(() => {
    if (posts.length === 0) return;
    return refreshViewability();
  }, [posts.length, refreshViewability]);

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      if (username.length > 0) {
        void postsQuery.refetch();
        void profileQuery.refetch();
        void refreshMe();
      }
      return () => setFocused(false);
    }, [postsQuery.refetch, profileQuery.refetch, refreshMe, username]),
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

  const [presenceTick, setPresenceTick] = useState(0);
  const [presenceEpoch, setPresenceEpoch] = useState(() => sharedPresenceStore.getSessionEpoch());
  useEffect(() => {
    return sharedPresenceStore.subscribe(() => {
      setPresenceTick((n) => n + 1);
      setPresenceEpoch(sharedPresenceStore.getSessionEpoch());
    });
  }, []);

  useEffect(() => {
    const uuid = me?.userUuid;
    if (!focused || !uuid || !sharedPresenceStore.surfacesAccepted) {
      sharedPresenceStore.unregisterSurface("public-profile");
      return undefined;
    }
    sharedPresenceStore.registerSurface("public-profile", [uuid]);
    void sharedPresenceStore.resyncSnapshots().catch(() => {});
    return () => sharedPresenceStore.unregisterSurface("public-profile");
  }, [focused, me?.userUuid, presenceEpoch]);

  const isOnline = useMemo(() => {
    void presenceTick;
    const uuid = me?.userUuid;
    if (!uuid) return false;
    return sharedPresenceStore.overlayOnline(uuid, false, null).isOnline;
  }, [me?.userUuid, presenceTick]);

  const publicProfile = profileQuery.data;
  const header = useMemo(
    () => (
      <ProfileCardHeader
        displayName={me?.displayName ?? "Профиль"}
        username={username}
        avatarUuid={resolveOwnProfileAvatarUuid(me?.avatarUuid, publicProfile?.avatarUuid)}
        userUuid={me?.userUuid}
        status={publicProfile?.status ?? me?.status}
        followersCount={publicProfile?.followersCount ?? me?.followersCount}
        followingCount={publicProfile?.followingCount ?? me?.followingCount}
        isOnline={isOnline}
        onSettingsPress={() =>
          router.push({ pathname: "/(tabs)/settings", params: { section: "account" } })
        }
        actionVariant="own"
        avatarEditable
        accountBlocked={me?.accountBlocked}
      />
    ),
    [me, publicProfile, username, isOnline],
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {editSheet}
      <FrcMediaModeScope {...mediaBand}>
        <FlashList
          ref={flashListRef}
          data={posts}
          keyExtractor={(item) => item.postUuid}
          ListHeaderComponent={header}
          contentContainerStyle={[styles.listContent, { paddingBottom: listPaddingBottom }]}
          showsVerticalScrollIndicator={false}
          maintainVisibleContentPosition={{ disabled: true }}
          viewabilityConfigCallbackPairs={viewabilityConfigCallbackPairs}
          refreshControl={
            <RefreshControl
              refreshing={pullRefreshing}
              onRefresh={onPullRefresh}
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
                canDeletePost
                onDeletePost={() => handleDeletePost(item.postUuid)}
                onEditPost={() => openEditPost(item)}
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
      </FrcMediaModeScope>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: floraColors.bg },
  listContent: {},
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
