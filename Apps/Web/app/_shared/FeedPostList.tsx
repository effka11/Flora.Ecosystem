"use client";

import Link from "next/link";
import { useCallback, useState, type RefObject } from "react";
import { formatAtHandle, handlesEqual, profileDisplayName } from "@/app/_dashboard/userDisplay";
import { formatRelativeTimeRu } from "@/lib/formatRelativeTimeRu";
import { usePostEngagement } from "@/lib/usePostEngagement";
import { usePostViewTracking } from "@/lib/usePostViewTracking";
import { ComposeFormattedContent } from "./composeFormattedText";
import { FeedPostComments } from "./FeedPostComments";
import { FeedPostImages } from "./FeedPostImages";
import { FeedPostVideo } from "./FeedPostVideo";
import { FloraAvatar } from "./FloraAvatar";
import { usePreloadFeedPostComments } from "./usePreloadFeedPostComments";
import styles from "./feedPostList.module.css";
import { PostMoreMenuRect } from "./PostMoreMenuRect";
import type { PostVideoDto } from "@/lib/socialApi";

export type FeedPostListItem = {
  postUuid: string;
  content: string;
  createdAt: string;
  authorUsername: string;
  authorDisplayName: string;
  authorAvatarUuid?: string | null;
  authorUserUuid?: string | null;
  commentsCount: number;
  likesCount: number;
  repostsCount: number;
  viewsCount: number;
  liked?: boolean;
  reposted?: boolean;
  imageUuids?: string[];
  video?: PostVideoDto | null;
};

function profileHref(username: string) {
  const slug = username.trim().replace(/^@+/, "");
  return `/profile/${encodeURIComponent(slug || "user")}`;
}

type FeedPostListProps = {
  posts: FeedPostListItem[];
  /** На стене профиля — без подтягивания первой карточки вверх. */
  variant?: "feed" | "profile";
  onCommentCountChange?: (postUuid: string, delta: number) => void;
  onEngagementChange?: (
    postUuid: string,
    snapshot: { liked: boolean; reposted: boolean; likesCount: number; repostsCount: number },
  ) => void;
  onViewsCountChange?: (postUuid: string, viewsCount: number) => void;
  /** Контейнер скролла (лента и т.п.) — для корректного IntersectionObserver. */
  scrollRootRef?: RefObject<Element | null>;
  authorHref?: (post: FeedPostListItem) => string;
  sharePathForPost?: (post: FeedPostListItem) => string;
  hideAuthorHandle?: boolean;
  /** Для сравнения автора поста с текущим пользователем (лента и чужие стены). */
  currentUsername?: string | null;
  /** Своя стена / своё сообщество — все посты в списке можно удалять. */
  canManageAllPosts?: boolean;
  onDeletePost?: (postUuid: string) => void | Promise<void>;
};

export function FeedPostList({
  posts,
  variant = "feed",
  onCommentCountChange,
  onEngagementChange,
  onViewsCountChange,
  scrollRootRef,
  authorHref,
  sharePathForPost,
  hideAuthorHandle = false,
  currentUsername = null,
  canManageAllPosts = false,
  onDeletePost,
}: FeedPostListProps) {
  const [commentsOpenPostUuid, setCommentsOpenPostUuid] = useState<string | null>(null);
  const [localCounts, setLocalCounts] = useState<Record<string, number>>({});
  const { snapshotFor, toggleLike, toggleRepost, isLikePending, isRepostPending } = usePostEngagement({
    onEngagementChange,
  });
  const { viewsCountFor, getPostItemRef } = usePostViewTracking({
    scrollRootRef,
    onViewsCountChange,
  });

  usePreloadFeedPostComments(posts);

  const commentsCountFor = useCallback(
    (post: FeedPostListItem) => localCounts[post.postUuid] ?? post.commentsCount,
    [localCounts],
  );

  const handleCommentAdded = useCallback(
    (postUuid: string) => {
      setLocalCounts((prev) => ({
        ...prev,
        [postUuid]: Math.max(0, (prev[postUuid] ?? posts.find((p) => p.postUuid === postUuid)?.commentsCount ?? 0) + 1),
      }));
      onCommentCountChange?.(postUuid, 1);
    },
    [onCommentCountChange, posts],
  );

  const rootClass = variant === "profile" ? `${styles.root} ${styles.rootProfile}` : styles.root;

  return (
    <div className={rootClass}>
      <ul className={styles.list}>
        {posts.map((post) => {
          const author = profileDisplayName(post.authorDisplayName, post.authorUsername);
          const handle = hideAuthorHandle ? "" : formatAtHandle(post.authorUsername);
          const timeLabel = formatRelativeTimeRu(post.createdAt);
          const commentsOpen = commentsOpenPostUuid === post.postUuid;
          const commentsCount = commentsCountFor(post);
          const engagement = snapshotFor(post);
          const viewsCount = viewsCountFor(post);
          const postAuthorHref = authorHref?.(post) ?? profileHref(post.authorUsername);
          const postSharePath = sharePathForPost?.(post) ?? profileHref(post.authorUsername);
          const canDeletePost =
            Boolean(onDeletePost) &&
            (canManageAllPosts || handlesEqual(currentUsername ?? "", post.authorUsername));

          return (
            <li key={post.postUuid} ref={getPostItemRef(post.postUuid, post.viewsCount)} className={styles.postItem}>
              <FloraAvatar
                href={postAuthorHref}
                avatarUuid={post.authorAvatarUuid}
                displayName={post.authorDisplayName}
                username={post.authorUsername}
                seed={post.authorUserUuid ?? post.authorUsername}
                className={`${styles.postAvatar} ${styles.postAvatarLink}`}
              />
              <div className={styles.postHeader}>
                <div className={styles.postMeta}>
                  <Link href={postAuthorHref} className={styles.postMetaLink}>
                    <span className={`${styles.postAuthor} flora-type-15`}>{author}</span>
                    {hideAuthorHandle ? null : (
                      <span className={`${styles.postHandle} flora-type-15`}>{handle}</span>
                    )}
                  </Link>
                </div>
                <PostMoreMenuRect
                  wrapClassName={styles.postMoreWrap}
                  buttonClassName={styles.postMoreBtn}
                  sharePath={postSharePath}
                  canDeletePost={canDeletePost}
                  onDeletePost={canDeletePost && onDeletePost ? () => void onDeletePost(post.postUuid) : undefined}
                />
              </div>
              <div className={styles.postBody}>
                {post.content.trim().length > 0 ? (
                  <p className={`${styles.postContent} flora-type-15`}>
                    <ComposeFormattedContent text={post.content} />
                  </p>
                ) : null}
                {post.imageUuids && post.imageUuids.length > 0 ? (
                  <FeedPostImages imageUuids={post.imageUuids} />
                ) : null}
                {post.video ? <FeedPostVideo postUuid={post.postUuid} video={post.video} /> : null}
                <div className={styles.postBar}>
                  <div className={styles.postActions}>
                    <button
                      type="button"
                      className={`${styles.postAction} ${engagement.liked ? styles.postActionLikeOn : ""}`}
                      aria-pressed={engagement.liked}
                      aria-label={engagement.liked ? "Убрать лайк" : "Лайкнуть пост"}
                      disabled={isLikePending(post.postUuid)}
                      onClick={() => void toggleLike(post)}
                    >
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill={engagement.liked ? "currentColor" : "none"}
                        stroke="currentColor"
                        strokeWidth="2"
                        aria-hidden
                      >
                        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                      </svg>
                      <span>{engagement.likesCount}</span>
                    </button>
                    <button
                      type="button"
                      className={`${styles.postAction} ${commentsOpen ? styles.postActionCommentsOpen : ""}`}
                      aria-expanded={commentsOpen}
                      aria-label={commentsOpen ? "Скрыть комментарии к посту" : "Показать комментарии к посту"}
                      onClick={() => setCommentsOpenPostUuid((id) => (id === post.postUuid ? null : post.postUuid))}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                      </svg>
                      <span>{commentsCount}</span>
                    </button>
                    <button
                      type="button"
                      className={`${styles.postAction} ${engagement.reposted ? styles.postActionRepostOn : ""}`}
                      aria-pressed={engagement.reposted}
                      aria-label={engagement.reposted ? "Убрать репост" : "Сделать репост"}
                      disabled={isRepostPending(post.postUuid)}
                      onClick={() => void toggleRepost(post)}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                        <path d="M17 1l4 4-4 4" />
                        <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                        <path d="M7 23l-4-4 4-4" />
                        <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                      </svg>
                      <span>{engagement.repostsCount}</span>
                    </button>
                  </div>
                  <div className={styles.postMetaRight}>
                    <time className={styles.postTime} dateTime={post.createdAt}>
                      {timeLabel}
                    </time>
                    <span className={styles.postViews}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                      <span>{viewsCount}</span>
                    </span>
                  </div>
                </div>
              </div>
              <div className={styles.postCommentsRegion}>
                <FeedPostComments
                  postUuid={post.postUuid}
                  open={commentsOpen}
                  onCommentAdded={() => handleCommentAdded(post.postUuid)}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
