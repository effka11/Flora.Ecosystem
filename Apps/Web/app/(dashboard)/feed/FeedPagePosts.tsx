"use client";

import Link from "next/link";
import { memo, type Ref } from "react";
import { ExpandablePostText } from "@/app/_shared/ExpandablePostText";
import { FeedPostComments } from "@/app/_shared/FeedPostComments";
import { FeedPostImages } from "@/app/_shared/FeedPostImages";
import { FeedPostVideo } from "@/app/_shared/FeedPostVideo";
import { FloraAvatar } from "@/app/_shared/FloraAvatar";
import { FollowedRepostStack } from "@/app/_shared/FollowedRepostStack";
import { PostMoreMenuRect } from "@/app/_shared/PostMoreMenuRect";
import { formatAtHandle, handlesEqual, profileDisplayName } from "@/app/_dashboard/userDisplay";
import { formatRelativeTimeRu } from "@/lib/formatRelativeTimeRu";
import type { FeedPostDto, PostEngagementSnapshot } from "@/lib/socialApi";
import styles from "./feed.module.css";

function profileHref(username: string) {
  const slug = username.trim().replace(/^@+/, "");
  return `/profile/${encodeURIComponent(slug || "user")}`;
}

function communityHref(slug: string) {
  return `/communities/${encodeURIComponent(slug.trim())}`;
}

function feedPostAuthor(post: FeedPostDto) {
  if (post.communityName) {
    return {
      label: post.communityName,
      href: post.communitySlug ? communityHref(post.communitySlug) : profileHref(post.authorUsername),
      showHandle: false,
      avatarUuid: post.communityAvatarUuid ?? null,
      seed: post.communityId ?? post.communitySlug ?? post.communityName,
      communityName: post.communityName,
      displayName: post.communityName,
      username: post.communitySlug ?? "",
    };
  }
  return {
    label: profileDisplayName(post.authorDisplayName, post.authorUsername),
    href: profileHref(post.authorUsername),
    handle: formatAtHandle(post.authorUsername),
    showHandle: true,
    avatarUuid: post.authorAvatarUuid ?? null,
    seed: post.authorUserUuid ?? post.authorUsername,
    displayName: post.authorDisplayName,
    username: post.authorUsername,
    accountBlocked: post.authorAccountBlocked,
  };
}

export type FeedPagePostsProps = {
  posts: FeedPostDto[];
  currentUsername: string;
  commentsOpenPostUuid: string | null;
  snapshotFor: (post: FeedPostDto) => PostEngagementSnapshot;
  viewsCountFor: (post: FeedPostDto) => number;
  getPostItemRef: (postUuid: string, initialViewsCount: number) => Ref<HTMLLIElement>;
  isLikePending: (postUuid: string) => boolean;
  isRepostPending: (postUuid: string) => boolean;
  onToggleLike: (post: FeedPostDto) => void;
  onToggleRepost: (post: FeedPostDto) => void;
  onToggleComments: (postUuid: string) => void;
  onDeletePost: (postUuid: string) => void;
  onNotInterested: (postUuid: string) => void;
  onHideAuthor: (post: FeedPostDto) => void;
  onCommentAdded: (postUuid: string) => void;
};

export const FeedPagePosts = memo(function FeedPagePosts({
  posts,
  currentUsername,
  commentsOpenPostUuid,
  snapshotFor,
  viewsCountFor,
  getPostItemRef,
  isLikePending,
  isRepostPending,
  onToggleLike,
  onToggleRepost,
  onToggleComments,
  onDeletePost,
  onNotInterested,
  onHideAuthor,
  onCommentAdded,
}: FeedPagePostsProps) {
  return (
    <ul className={styles.profilePostsList}>
      {posts.map((post) => {
        const authorMeta = feedPostAuthor(post);
        const timeLabel = formatRelativeTimeRu(post.createdAt);
        const commentsOpen = commentsOpenPostUuid === post.postUuid;
        const engagement = snapshotFor(post);
        const viewsCount = viewsCountFor(post);
        const hasMedia = post.imageUuids.length > 0 || Boolean(post.video);
        return (
          <li
            key={post.postUuid}
            ref={getPostItemRef(post.postUuid, post.viewsCount)}
            className={styles.profilePostItem}
          >
            <FloraAvatar
              plain
              href={authorMeta.href}
              avatarUuid={authorMeta.avatarUuid}
              displayName={authorMeta.displayName}
              username={authorMeta.username}
              seed={authorMeta.seed}
              communityName={authorMeta.communityName}
              accountBlocked={authorMeta.accountBlocked}
              className={`${styles.profilePostAvatar} ${styles.profilePostAvatarLink}`}
            />
            <div className={styles.profilePostHeader}>
              <div className={styles.profilePostMeta}>
                <Link href={authorMeta.href} className={styles.profilePostMetaLink}>
                  <span className={`${styles.profilePostAuthor} flora-type-15`}>{authorMeta.label}</span>
                  {authorMeta.showHandle ? (
                    <span className={`${styles.profilePostHandle} flora-type-15`}>{authorMeta.handle}</span>
                  ) : null}
                </Link>
              </div>
              <PostMoreMenuRect
                wrapClassName={styles.profilePostMoreWrap}
                buttonClassName={styles.profilePostMoreBtn}
                sharePath={authorMeta.href}
                canDeletePost={handlesEqual(currentUsername, post.authorUsername)}
                onDeletePost={() => onDeletePost(post.postUuid)}
                onNotInterested={() => onNotInterested(post.postUuid)}
                onHideAuthor={() => onHideAuthor(post)}
                hideAuthorLabel={post.communityId ? "Скрыть сообщество" : "Скрыть автора"}
              />
            </div>
            <div className={styles.profilePostBody}>
              {post.content.trim().length > 0 ? (
                <ExpandablePostText
                  text={post.content}
                  hasMedia={hasMedia}
                  className={`${styles.profilePostContent} flora-type-15`}
                />
              ) : null}
              {post.imageUuids.length > 0 ? <FeedPostImages imageUuids={post.imageUuids} /> : null}
              {post.video ? <FeedPostVideo postUuid={post.postUuid} video={post.video} /> : null}
              <div className={styles.profilePostBar}>
                <div className={styles.profilePostActions}>
                  <button
                    type="button"
                    className={`${styles.profilePostAction} ${engagement.liked ? styles.profilePostActionLikeOn : ""}`}
                    aria-pressed={engagement.liked}
                    aria-label={engagement.liked ? "Убрать лайк" : "Лайкнуть пост"}
                    disabled={isLikePending(post.postUuid)}
                    onClick={() => onToggleLike(post)}
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
                    className={`${styles.profilePostAction} ${commentsOpen ? styles.profilePostActionCommentsOpen : ""}`}
                    aria-expanded={commentsOpen}
                    aria-label={commentsOpen ? "Скрыть комментарии к посту" : "Показать комментарии к посту"}
                    onClick={() => onToggleComments(post.postUuid)}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                    <span>{post.commentsCount}</span>
                  </button>
                  <button
                    type="button"
                    className={`${styles.profilePostAction} ${engagement.reposted ? styles.profilePostActionRepostOn : ""}`}
                    aria-pressed={engagement.reposted}
                    aria-label={engagement.reposted ? "Убрать репост" : "Сделать репост"}
                    disabled={isRepostPending(post.postUuid)}
                    onClick={() => onToggleRepost(post)}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                      <path d="M17 1l4 4-4 4" />
                      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                      <path d="M7 23l-4-4 4-4" />
                      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                    </svg>
                    <span>{engagement.repostsCount}</span>
                  </button>
                  {post.followedReposts && post.followedReposts.length > 0 ? (
                    <FollowedRepostStack
                      reposters={post.followedReposts}
                      profileHref={profileHref}
                      className={styles.profilePostFollowedReposts}
                    />
                  ) : null}
                </div>
                <div className={styles.profilePostMetaRight}>
                  <time className={styles.profilePostTime} dateTime={post.createdAt}>
                    {timeLabel}
                  </time>
                  <span className={styles.profilePostViews}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                    <span>{viewsCount}</span>
                  </span>
                </div>
              </div>
            </div>
            <div className={styles.profilePostCommentsRegion}>
              <FeedPostComments
                postUuid={post.postUuid}
                open={commentsOpen}
                onCommentAdded={() => onCommentAdded(post.postUuid)}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
});
