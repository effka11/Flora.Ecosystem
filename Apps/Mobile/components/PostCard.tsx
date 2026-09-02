import type { FeedPostDto, PostEngagementSnapshot } from "@flora/client-core/contracts";
import { formatAtHandle } from "@flora/client-core/display";
import { Ionicons } from "@expo/vector-icons";
import { Link } from "expo-router";
import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ExpandablePostText } from "@/components/feed/ExpandablePostText";
import { FeedPostComments } from "@/components/feed/FeedPostComments";
import { FeedPostImages } from "@/components/feed/FeedPostImages";
import {
  FeedPostCommentIcon,
  FeedPostHeartIcon,
  FeedPostRepostIcon,
} from "@/components/feed/FeedPostIcons";
import { PostMoreMenuTrigger } from "@/components/feed/PostMoreMenu";
import { FloraAvatar } from "@/components/FloraAvatar";
import { FrcRowMediaScope } from "@/lib/FrcImageDecodingScope";
import { feedPostAuthor } from "@/lib/feedPostAuthor";
import { formatCompactCount } from "@/lib/formatCompactCount";
import { isOwnFeedPost } from "@/lib/isOwnFeedPost";
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
  canDeletePost?: boolean;
  onDeletePost?: () => void;
};

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
  return new Date(date)
    .toLocaleDateString("ru-RU", { day: "2-digit", month: "short" })
    .replace(/\.$/, "");
}

const ACTION_HIT_SLOP = {
  top: floraSpacing.gridFine,
  bottom: floraSpacing.gridFine,
  left: floraSpacing.gridFine,
  right: floraFeedPost.actionIconGap + floraFeedPost.actionCountWidth,
};

export const PostCard = memo(function PostCard({
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
  canDeletePost,
  onDeletePost,
}: Props) {
  const me = useSessionStore((s) => s.me);

  const authorMeta = feedPostAuthor(post, me?.username);
  const timeLabel = formatRelativeTime(post.createdAt);
  const isOwnPost = isOwnFeedPost(post, me);
  const allowDelete = Boolean(onDeletePost) && (Boolean(canDeletePost) || isOwnPost);
  const hasMedia = post.imageUuids.length > 0 || Boolean(post.videoUuid);

  return (
    <FrcRowMediaScope postUuid={post.postUuid}>
      <View style={styles.card}>
        <View style={styles.cardRow}>
        <View style={styles.avatarCell}>
          <FloraAvatar
            size={floraFeedPost.avatarSize}
            href={authorMeta.href}
            avatarUuid={authorMeta.avatarUuid}
            displayName={authorMeta.displayName}
            username={authorMeta.username}
            seed={authorMeta.seed}
            communityName={authorMeta.communityName}
            accountBlocked={authorMeta.accountBlocked}
          />
        </View>

        <View style={styles.contentColumn}>
          <View style={styles.headerBand}>
            <View style={styles.postMeta}>
              <Link href={authorMeta.href} asChild>
                <Pressable style={({ pressed }) => [styles.postMetaPressable, pressed && styles.pressed]}>
                  <View style={styles.postMetaLink}>
                    <Text style={styles.author} numberOfLines={1} ellipsizeMode="tail">
                      {authorMeta.label}
                    </Text>
                    {authorMeta.showHandle ? (
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
              <PostMoreMenuTrigger
                isOwnPost={isOwnPost}
                canDeletePost={allowDelete}
                onDeletePost={allowDelete ? onDeletePost : undefined}
              />
            </View>
          </View>

          <View style={styles.postBody}>
            {post.text.trim() ? (
              <ExpandablePostText
                postUuid={post.postUuid}
                text={post.text}
                hasMedia={hasMedia}
                containerStyle={styles.postText}
                textStyle={styles.text}
              />
            ) : null}

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
                  hitSlop={ACTION_HIT_SLOP}
                >
                  <FeedPostHeartIcon
                    size={floraFeedPost.actionIconSize}
                    color={engagement.liked ? floraColors.like : floraColors.gray}
                    filled={engagement.liked}
                  />
                  <Text style={[styles.actionText, engagement.liked && styles.liked]} numberOfLines={1}>
                    {formatCompactCount(engagement.likesCount)}
                  </Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [styles.action, pressed && styles.pressed]}
                  onPress={onToggleComments}
                  hitSlop={ACTION_HIT_SLOP}
                >
                  <FeedPostCommentIcon
                    size={floraFeedPost.actionIconSize}
                    color={commentsOpen ? floraColors.greenLight : floraColors.gray}
                  />
                  <Text style={[styles.actionText, commentsOpen && styles.commentsOpen]} numberOfLines={1}>
                    {formatCompactCount(commentCount)}
                  </Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [styles.action, pressed && styles.pressed]}
                  disabled={repostPending}
                  onPress={onToggleRepost}
                  hitSlop={ACTION_HIT_SLOP}
                >
                  <FeedPostRepostIcon
                    size={floraFeedPost.actionIconSize}
                    color={engagement.reposted ? floraColors.greenLight : floraColors.gray}
                  />
                  <Text style={[styles.actionText, engagement.reposted && styles.reposted]} numberOfLines={1}>
                    {formatCompactCount(engagement.repostsCount)}
                  </Text>
                </Pressable>
              </View>
              {timeLabel ? (
                <View style={styles.timeSlot}>
                  <Text style={styles.time} numberOfLines={1}>
                    {timeLabel}
                  </Text>
                </View>
              ) : null}
            </View>
            <FeedPostComments
              postUuid={post.postUuid}
              open={commentsOpen}
              meUsername={me?.username}
              onCommentAdded={onCommentAdded}
            />
          </View>
        </View>
      </View>
      </View>
    </FrcRowMediaScope>
  );
});

const styles = StyleSheet.create({
  card: {
    paddingHorizontal: floraFeedPost.paddingHorizontal,
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
    paddingTop: floraFeedPost.nicknameGapFromAvatarTop,
    overflow: "visible",
  },
  postMore: {
    position: "absolute",
    right: 0,
    top: floraFeedPost.moreMenuTop,
  },
  postMeta: {
    flex: 1,
    minWidth: 0,
    paddingRight: floraFeedPost.moreBtnSize,
    overflow: "visible",
  },
  postBody: {
    marginTop: floraFeedPost.bodyMarginTop,
    paddingRight: floraFeedPost.contentInsetRight,
  },
  postText: {
    marginTop: floraFeedPost.textCapTrim,
    marginBottom: floraFeedPost.textMarginBottom,
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
    overflow: "visible",
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
    lineHeight: floraFeedPost.nicknamePaintLineHeight,
    flexShrink: 1,
    includeFontPadding: false,
    textAlignVertical: "top",
    overflow: "visible",
    transform: [{ translateY: floraFeedPost.nicknamePaintShiftY }],
  },
  handle: {
    color: floraColors.gray,
    fontWeight: "300",
    fontSize: 15,
    letterSpacing: 0.45,
    lineHeight: floraFeedPost.nicknamePaintLineHeight,
    flexShrink: 0,
    includeFontPadding: false,
    textAlignVertical: "top",
    overflow: "visible",
    transform: [{ translateY: floraFeedPost.nicknamePaintShiftY }],
  },
  text: {
    color: floraColors.grayLight,
    fontSize: floraFeedPost.textFontSize,
    fontWeight: "300",
    lineHeight: floraFeedPost.textLineHeight,
    letterSpacing: 0.45,
    includeFontPadding: false,
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
    marginTop: floraFeedPost.actionsBarMarginTop,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraFeedPost.actionGap,
    flexShrink: 0,
    overflow: "visible",
  },
  action: {
    width: floraFeedPost.actionIconSize,
    minHeight: 28,
    justifyContent: "center",
    overflow: "visible",
  },
  actionText: {
    position: "absolute",
    left: floraFeedPost.actionIconSize + floraFeedPost.actionIconGap,
    top: 0,
    bottom: 0,
    width: floraFeedPost.actionCountWidth,
    color: floraColors.gray,
    fontSize: floraFeedPost.actionFontSize,
    fontWeight: "300",
    letterSpacing: floraFeedPost.actionLetterSpacing,
    fontVariant: ["tabular-nums"],
    includeFontPadding: false,
    textAlignVertical: "center",
  },
  timeSlot: {
    flex: 1,
    minWidth: 0,
    alignItems: "flex-end",
    marginLeft: floraSpacing.grid,
  },
  time: {
    maxWidth: "100%",
    color: floraColors.gray,
    fontSize: 13,
    fontWeight: "300",
    letterSpacing: 0.39,
    includeFontPadding: false,
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
