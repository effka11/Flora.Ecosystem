import type { FeedPostDto, PostEngagementSnapshot } from "@flora/client-core/contracts";
import { formatAtHandle, profileDisplayName } from "@flora/client-core/display";
import { Ionicons } from "@expo/vector-icons";
import { Link } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { FeedPostComments } from "@/components/feed/FeedPostComments";
import { FeedPostImages } from "@/components/feed/FeedPostImages";
import {
  FeedPostCommentIcon,
  FeedPostHeartIcon,
  FeedPostRepostIcon,
  FeedPostViewsIcon,
} from "@/components/feed/FeedPostIcons";
import { PostMoreMenuTrigger } from "@/components/feed/PostMoreMenu";
import { FloraAvatar } from "@/components/FloraAvatar";
import { floraColors, floraFeedPost, floraSpacing } from "@/lib/theme";
import { useSessionStore } from "@/stores/sessionStore";

type Props = {
  post: FeedPostDto;
  engagement: PostEngagementSnapshot;
  commentCount: number;
  commentsOpen: boolean;
  likePending?: boolean;
  repostPending?: boolean;
  onToggleLike: () => void;
  onToggleRepost: () => void;
  onToggleComments: () => void;
  onCommentAdded?: (postUuid: string) => void;
};

function handlesEqual(a: string, b: string) {
  return a.trim().replace(/^@+/, "").toLowerCase() === b.trim().replace(/^@+/, "").toLowerCase();
}

function formatRelativeTime(date: string) {
  const ms = new Date(date).getTime();
  if (!Number.isFinite(ms)) return "";
  const diffSeconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSeconds < 60) return "сейчас";
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes} мин`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} ч`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays} д`;
  return new Date(date).toLocaleDateString("ru-RU", { day: "2-digit", month: "short" });
}

export function PostCard({
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
}: Props) {
  const me = useSessionStore((s) => s.me);

  const isCommunityPost = Boolean(post.communityName);
  const authorLabel = isCommunityPost
    ? post.communityName!
    : profileDisplayName(post.authorDisplayName, post.authorUsername);
  const profileHref = `/profile/${post.authorUsername}` as const;
  const timeLabel = formatRelativeTime(post.createdAt);
  const isOwnPost = handlesEqual(me?.username ?? "", post.authorUsername);

  return (
    <View style={styles.card}>
      <View style={styles.cardRow}>
        <View style={styles.avatarCell}>
          <FloraAvatar
            size={floraFeedPost.avatarSize}
            href={post.communityName ? undefined : profileHref}
            avatarUuid={post.authorAvatarUuid}
            displayName={post.authorDisplayName}
            username={post.authorUsername}
            seed={post.communityUuid ?? post.authorUserUuid ?? post.authorUsername}
            communityName={post.communityName ?? undefined}
          />
        </View>

        <View style={styles.contentColumn}>
          <View style={styles.headerBand}>
            <View style={styles.postMeta}>
              <Link href={profileHref} asChild>
                <Pressable style={({ pressed }) => [styles.postMetaPressable, pressed && styles.pressed]}>
                  <View style={styles.postMetaLink}>
                    <Text style={styles.author} numberOfLines={1} ellipsizeMode="tail">
                      {authorLabel}
                    </Text>
                    {!isCommunityPost ? (
                      <>
                        <View style={styles.postMetaGap} />
                        <Text style={styles.handle} numberOfLines={1} ellipsizeMode="tail">
                          {formatAtHandle(post.authorUsername)}
                        </Text>
                      </>
                    ) : null}
                  </View>
                </Pressable>
              </Link>
            </View>
            <View style={styles.postMore}>
              <PostMoreMenuTrigger isOwnPost={isOwnPost} />
            </View>
          </View>

          <View style={styles.postBody}>
            {post.text.trim() ? <Text style={styles.text}>{post.text}</Text> : null}

            {post.imageUuids.length > 0 ? <FeedPostImages imageUuids={post.imageUuids} /> : null}
            {post.videoUuid ? (
              <View style={styles.mediaPill}>
                <Ionicons name="play-circle-outline" size={16} color={floraColors.greenLight} />
                <Text style={styles.mediaText}>Видео · {post.videoStatus ?? "ready"}</Text>
              </View>
            ) : null}

            <View style={styles.actionsBar}>
              <View style={styles.actions}>
                <Pressable
                  style={({ pressed }) => [styles.action, pressed && styles.pressed]}
                  disabled={likePending}
                  onPress={onToggleLike}
                >
                  <FeedPostHeartIcon
                    color={engagement.liked ? floraColors.like : floraColors.gray}
                    filled={engagement.liked}
                  />
                  <Text style={[styles.actionText, engagement.liked && styles.liked]}>{engagement.likesCount}</Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [styles.action, pressed && styles.pressed]}
                  onPress={onToggleComments}
                >
                  <FeedPostCommentIcon color={commentsOpen ? floraColors.greenLight : floraColors.gray} />
                  <Text style={[styles.actionText, commentsOpen && styles.commentsOpen]}>{commentCount}</Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [styles.action, pressed && styles.pressed]}
                  disabled={repostPending}
                  onPress={onToggleRepost}
                >
                  <FeedPostRepostIcon
                    color={engagement.reposted ? floraColors.greenLight : floraColors.gray}
                  />
                  <Text style={[styles.actionText, engagement.reposted && styles.reposted]}>
                    {engagement.repostsCount}
                  </Text>
                </Pressable>
              </View>

              <View style={styles.metaRight}>
                {timeLabel ? <Text style={styles.time}>{timeLabel}</Text> : null}
                <View style={styles.views}>
                  <FeedPostViewsIcon color={floraColors.gray} />
                  <Text style={styles.time}>{post.viewCount}</Text>
                </View>
              </View>
            </View>
            <FeedPostComments
              postUuid={post.postUuid}
              open={commentsOpen}
              onCommentAdded={onCommentAdded}
            />
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    paddingHorizontal: floraSpacing.grid,
    paddingTop: floraFeedPost.paddingTop,
    paddingBottom: floraFeedPost.paddingBottom,
    borderBottomColor: "rgba(250, 250, 250, 0.08)",
    borderBottomWidth: 1,
  },
  cardRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: floraFeedPost.columnGap,
  },
  avatarCell: {
    width: floraFeedPost.avatarSize,
    height: floraFeedPost.avatarSize,
    flexShrink: 0,
  },
  contentColumn: {
    flex: 1,
    minWidth: 0,
    marginLeft: floraFeedPost.contentNudgeX,
  },
  headerBand: {
    position: "relative",
    height: floraFeedPost.avatarSize,
    paddingTop: floraFeedPost.headerPaddingTop,
  },
  postMore: {
    position: "absolute",
    right: 0,
    top: floraFeedPost.moreMenuTop,
  },
  postMeta: {
    flex: 1,
    minWidth: 0,
    paddingRight: floraFeedPost.moreBtnSize + 6,
  },
  postBody: {
    marginTop: floraFeedPost.contentNudgeX,
  },
  postMetaPressable: {
    alignSelf: "flex-start",
    maxWidth: "100%",
  },
  postMetaLink: {
    flexDirection: "row",
    flexWrap: "nowrap",
    alignItems: "baseline",
    maxWidth: "100%",
  },
  postMetaGap: {
    width: floraSpacing.grid - 2,
    flexShrink: 0,
  },
  author: {
    color: floraColors.whiteTemplate,
    fontWeight: "300",
    fontSize: 15,
    letterSpacing: 0.45,
    lineHeight: 15,
    flexShrink: 1,
    transform: [{ translateY: floraFeedPost.nicknameNudgeY }],
  },
  handle: {
    color: floraColors.gray,
    fontWeight: "300",
    fontSize: 15,
    letterSpacing: 0.45,
    lineHeight: 15,
    flexShrink: 0,
    transform: [{ translateY: floraFeedPost.nicknameNudgeY }],
  },
  text: {
    color: floraColors.grayLight,
    fontSize: 15,
    fontWeight: "300",
    lineHeight: 25.5,
    letterSpacing: 0.45,
    includeFontPadding: false,
    marginBottom: floraFeedPost.textMarginBottom,
  },
  mediaPill: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(164, 209, 138, 0.28)",
    backgroundColor: "rgba(164, 209, 138, 0.08)",
    paddingHorizontal: 11,
    paddingVertical: 7,
    marginTop: floraSpacing.gridFine * 2,
    marginBottom: floraFeedPost.textMarginBottom,
  },
  mediaText: {
    color: floraColors.greenLight,
    fontSize: 13,
    fontWeight: "300",
    letterSpacing: 0.39,
  },
  actionsBar: {
    minHeight: floraSpacing.grid + floraSpacing.gridFine * 2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: floraSpacing.grid,
    marginTop: floraFeedPost.actionsBarMarginTop,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraFeedPost.actionGap,
  },
  action: {
    minHeight: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: floraFeedPost.actionIconGap,
  },
  actionText: {
    color: floraColors.gray,
    fontSize: floraFeedPost.actionFontSize,
    fontWeight: "300",
    letterSpacing: floraFeedPost.actionLetterSpacing,
  },
  metaRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.grid,
  },
  views: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraFeedPost.actionIconGap,
  },
  time: {
    color: floraColors.gray,
    fontSize: 13,
    fontWeight: "300",
    letterSpacing: 0.39,
  },
  liked: {
    color: floraColors.like,
  },
  reposted: {
    color: floraColors.greenLight,
  },
  commentsOpen: {
    color: floraColors.greenLight,
  },
  pressed: {
    opacity: 0.72,
  },
});
