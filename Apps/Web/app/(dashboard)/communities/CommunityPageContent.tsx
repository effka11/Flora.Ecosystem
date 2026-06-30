"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import emptyHintStyles from "@/app/_shared/emptyPageHint.module.css";
import { FeedPostList, type FeedPostListItem } from "@/app/_shared/FeedPostList";
import { FloraAvatar, FLORA_PROFILE_AVATAR_INNER_PX } from "@/app/_shared/FloraAvatar";
import { ProfileCardStatus } from "@/app/(dashboard)/profile/ProfileCardStatus";
import type { CommunityRecord } from "@/app/(dashboard)/communities/communitiesSeed";
import { isCommunityUuid } from "@/app/(dashboard)/communities/communityProfile";
import { ApiRequestError } from "@/lib/auth";
import {
  apiDeletePost,
  apiGetCommunityPosts,
  apiJoinCommunity,
  apiLeaveCommunity,
  type CommunityPostDto,
} from "@/lib/socialApi";
import { CommunityOwnHeaderActions } from "./CommunityOwnHeaderActions";
import styles from "@/app/(dashboard)/profile/profile.module.css";

const MODAL_CLOSE_MS = 220;
const PROFILE_AVATAR_INNER_PX = FLORA_PROFILE_AVATAR_INNER_PX;

function useAnimatedModal() {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openModal = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setClosing(false);
    setOpen(true);
  };

  const closeModal = () => {
    if (closing) return;
    setClosing(true);
    timerRef.current = setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, MODAL_CLOSE_MS);
  };

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return { open, closing, openModal, closeModal };
}

function seedPostsToFeedItems(community: CommunityRecord): FeedPostListItem[] {
  return community.posts.map((post, index) => ({
    postUuid: post.id,
    content: post.text,
    createdAt: new Date(Date.now() - (index + 1) * 5 * 3600000).toISOString(),
    authorUsername: community.name,
    authorDisplayName: community.name,
    commentsCount: post.comments,
    likesCount: post.likes,
    repostsCount: post.reposts,
    viewsCount: post.views,
    liked: false,
    reposted: false,
  }));
}

function apiPostsToFeedItems(communityName: string, posts: CommunityPostDto[]): FeedPostListItem[] {
  return posts.map((post) => ({
    postUuid: post.postUuid,
    content: post.content,
    createdAt: post.createdAt,
    authorUsername: post.authorUsername,
    authorDisplayName: communityName,
    commentsCount: post.commentsCount,
    likesCount: post.likesCount,
    repostsCount: post.repostsCount,
    viewsCount: post.viewsCount,
    liked: post.liked,
    reposted: post.reposted,
    imageUuids: post.imageUuids,
    video: post.video,
  }));
}

type CommunityPageContentProps = {
  community: CommunityRecord;
  isOwn: boolean;
  initialIsFollowing?: boolean;
  communityPageHref: string;
  scrollId?: string;
};

export function CommunityPageContent({
  community,
  isOwn,
  initialIsFollowing = false,
  communityPageHref,
  scrollId = "central-scroll-community",
}: CommunityPageContentProps) {
  const membersModal = useAnimatedModal();
  const descriptionModal = useAnimatedModal();

  const [isFollowing, setIsFollowing] = useState(initialIsFollowing);
  const [membershipBusy, setMembershipBusy] = useState(false);
  const [membershipError, setMembershipError] = useState<string | null>(null);
  const [localMembersCount, setLocalMembersCount] = useState(community.members);
  const [feedPosts, setFeedPosts] = useState<FeedPostListItem[]>([]);
  const [postsLoading, setPostsLoading] = useState(false);
  const [postsError, setPostsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!isCommunityUuid(community.id)) {
      setPostsError(null);
      setPostsLoading(false);
      setFeedPosts(seedPostsToFeedItems(community));
      return;
    }

    void (async () => {
      setPostsLoading(true);
      setPostsError(null);
      try {
        const posts = await apiGetCommunityPosts(community.id, 0, 30);
        if (cancelled) return;
        setFeedPosts(apiPostsToFeedItems(community.name, posts));
      } catch (e) {
        if (cancelled) return;
        setPostsError(e instanceof Error ? e.message : "Не удалось загрузить посты сообщества");
        setFeedPosts([]);
      } finally {
        if (!cancelled) setPostsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [community]);

  const bumpCommentCount = useCallback((postUuid: string, delta: number) => {
    setFeedPosts((items) =>
      items.map((post) =>
        post.postUuid === postUuid
          ? { ...post, commentsCount: Math.max(0, post.commentsCount + delta) }
          : post,
      ),
    );
  }, []);

  const syncPostEngagement = useCallback(
    (
      postUuid: string,
      snapshot: { liked: boolean; reposted: boolean; likesCount: number; repostsCount: number },
    ) => {
      setFeedPosts((items) => items.map((post) => (post.postUuid === postUuid ? { ...post, ...snapshot } : post)));
    },
    [],
  );

  const syncPostViewsCount = useCallback((postUuid: string, viewsCount: number) => {
    setFeedPosts((items) =>
      items.map((post) => (post.postUuid === postUuid ? { ...post, viewsCount } : post)),
    );
  }, []);

  const pageScrollRef = useRef<HTMLElement>(null);

  const handleDeletePost = useCallback(async (postUuid: string) => {
    try {
      await apiDeletePost(postUuid);
      setFeedPosts((items) => items.filter((post) => post.postUuid !== postUuid));
    } catch (e) {
      const message =
        e instanceof ApiRequestError ? e.message : e instanceof Error ? e.message : "Не удалось удалить пост";
      window.alert(message);
    }
  }, []);

  useEffect(() => {
    setIsFollowing(initialIsFollowing);
  }, [initialIsFollowing, community.id]);

  const handleFollow = async () => {
    if (!isCommunityUuid(community.id) || membershipBusy || isFollowing) return;
    setMembershipError(null);
    setMembershipBusy(true);
    try {
      const joined = await apiJoinCommunity(community.id);
      setIsFollowing(true);
      setLocalMembersCount(joined.memberCount);
    } catch (e) {
      setMembershipError(
        e instanceof ApiRequestError ? e.message : e instanceof Error ? e.message : "Не удалось подписаться.",
      );
    } finally {
      setMembershipBusy(false);
    }
  };

  const handleUnfollow = async () => {
    if (!isCommunityUuid(community.id) || membershipBusy || !isFollowing) return;
    setMembershipError(null);
    setMembershipBusy(true);
    try {
      await apiLeaveCommunity(community.id);
      setIsFollowing(false);
      setLocalMembersCount((count) => Math.max(0, count - 1));
    } catch (e) {
      setMembershipError(
        e instanceof ApiRequestError ? e.message : e instanceof Error ? e.message : "Не удалось отписаться.",
      );
    } finally {
      setMembershipBusy(false);
    }
  };

  return (
    <section ref={pageScrollRef} className={styles.page} id={scrollId}>
      <header className={styles.profileHeader} aria-hidden />

      <div className={styles.profileCard} data-profile-status-measure>
        <div className={styles.profileCover} />
        <div className={styles.profileInfo}>
          <div className={styles.profileInfoTop}>
            <div className={styles.profileAvatar}>
              <FloraAvatar
                size={PROFILE_AVATAR_INNER_PX}
                avatarUuid={community.avatarUuid}
                displayName={community.name}
                communityName={community.name}
                seed={community.id}
              />
            </div>
            <ProfileCardStatus status={community.description} />
          </div>
          <div className={styles.profileNameRow}>
            <h2 className={styles.profileName}>{community.name}</h2>
          </div>
          <div className={styles.profileStats}>
            <button
              type="button"
              className={styles.profileStatBtn}
              onClick={membersModal.openModal}
              aria-label="Показать участников"
            >
              <strong>{localMembersCount.toLocaleString("ru-RU")}</strong>&nbsp;участников
            </button>
          </div>
          {isOwn ? (
            <CommunityOwnHeaderActions communityId={community.id} communitySlug={community.slug} />
          ) : (
            <div className={styles.profileHeaderActions}>
              {membershipError ? (
                <p className={styles.profilePostsError} role="alert">
                  {membershipError}
                </p>
              ) : null}
              {isFollowing ? (
                <button
                  type="button"
                  className={`${styles.profileActionBtn} ${styles.profileActionBtnSecondary}`}
                  onClick={() => void handleUnfollow()}
                  disabled={membershipBusy}
                >
                  {membershipBusy ? "Отписка…" : "Отписаться"}
                </button>
              ) : (
                <button
                  type="button"
                  className={styles.profileActionBtn}
                  onClick={() => void handleFollow()}
                  disabled={membershipBusy}
                >
                  {membershipBusy ? "Подписка…" : "Подписаться"}
                </button>
              )}
            </div>
          )}

          {isOwn ? (
            <div className={styles.profileDetailsTriggerWrap}>
              <button
                type="button"
                className={styles.profileDetailsTrigger}
                onClick={descriptionModal.openModal}
                aria-label="Описание сообщества"
                title="Описание сообщества"
              >
                <svg
                  className={styles.profileDetailsTriggerIcon}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
                  <line x1="8" y1="12" x2="16" y2="12" />
                  <line x1="8" y1="9" x2="16" y2="9" />
                  <line x1="8" y1="15" x2="14" y2="15" />
                </svg>
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {membersModal.open ? (
        <>
          <div
            className={`${styles.profileListModalBackdrop}${membersModal.closing ? ` ${styles.profileListModalBackdropClosing}` : ""}`}
            onClick={membersModal.closeModal}
          />
          <div className={styles.profileListModal} role="dialog" aria-modal aria-labelledby="community-members-title">
            <div
              className={`${styles.profileListModalDialog}${membersModal.closing ? ` ${styles.profileListModalDialogClosing}` : ""}`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className={styles.profileListModalHeader}>
                <h2 id="community-members-title" className={styles.profileListModalTitle}>Участники</h2>
                <button type="button" className={styles.profileListModalClose} onClick={membersModal.closeModal} aria-label="Закрыть">
                  &times;
                </button>
              </div>
              <div className={styles.profileListModalBody}>
                <ul className={styles.profileUsersList}>
                  <li>Список участников появится позже.</li>
                </ul>
              </div>
            </div>
          </div>
        </>
      ) : null}

      {descriptionModal.open ? (
        <>
          <div
            className={`${styles.profileListModalBackdrop}${descriptionModal.closing ? ` ${styles.profileListModalBackdropClosing}` : ""}`}
            onClick={descriptionModal.closeModal}
          />
          <div className={styles.profileListModal} role="dialog" aria-modal aria-labelledby="community-desc-title">
            <div
              className={`${styles.profileListModalDialog}${descriptionModal.closing ? ` ${styles.profileListModalDialogClosing}` : ""}`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className={styles.profileListModalHeader}>
                <h2 id="community-desc-title" className={styles.profileListModalTitle}>Описание сообщества</h2>
                <button type="button" className={styles.profileListModalClose} onClick={descriptionModal.closeModal} aria-label="Закрыть">
                  &times;
                </button>
              </div>
              <div className={`${styles.profileListModalBody} ${styles.profileDescriptionBody}`}>
                <dl className={styles.profileDescriptionDl}>
                  <dt>Название</dt>
                  <dd>{community.name}</dd>
                  <dt>Описание</dt>
                  <dd>{community.description || "—"}</dd>
                </dl>
              </div>
            </div>
          </div>
        </>
      ) : null}

      <section className={styles.profileSection}>
        {postsError ? <p className={styles.profilePostsError}>{postsError}</p> : null}
        {postsLoading ? <p className={emptyHintStyles.hint}>Загрузка постов…</p> : null}
        {!postsLoading && !postsError && feedPosts.length === 0 ? (
          <p className={emptyHintStyles.hint}>
            {isOwn
              ? "Пока нет постов в сообществе. Нажмите «Сделать пост» в шапке."
              : "Пока нет постов в сообществе. Загляните позже."}
          </p>
        ) : null}
        {!postsLoading && feedPosts.length > 0 ? (
          <FeedPostList
            variant="profile"
            posts={feedPosts}
            scrollRootRef={pageScrollRef}
            onCommentCountChange={bumpCommentCount}
            onEngagementChange={syncPostEngagement}
            onViewsCountChange={syncPostViewsCount}
            hideAuthorHandle
            authorHref={() => communityPageHref}
            sharePathForPost={() => communityPageHref}
            canManageAllPosts={isOwn}
            onDeletePost={isOwn ? handleDeletePost : undefined}
          />
        ) : null}
      </section>
    </section>
  );
}

export function CommunityNotFound() {
  return (
    <section className={styles.page}>
      <p className={styles.profilePostsError}>
        Сообщество не найдено.{" "}
        <Link href="/communities" style={{ color: "var(--flora-green-light)" }}>
          К списку
        </Link>
      </p>
    </section>
  );
}
