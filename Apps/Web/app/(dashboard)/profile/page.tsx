"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import emptyHintStyles from "@/app/_shared/emptyPageHint.module.css";
import { FeedPostList, type FeedPostListItem } from "@/app/_shared/FeedPostList";
import { useCurrentUser } from "@/app/_dashboard/CurrentUserContext";
import { useProtectedPage } from "@/app/_dashboard/useProtectedPage";
import { formatAtHandle, profileDisplayName } from "@/app/_dashboard/userDisplay";
import { FloraAvatar, FLORA_PROFILE_AVATAR_INNER_PX } from "@/app/_shared/FloraAvatar";
import { ApiRequestError } from "@/lib/auth";
import { invalidateProfileCache, profileBundleCache } from "@/lib/dashboardPreload";
import { apiDeletePost, type ProfilePostDto, type PublicProfileDto } from "@/lib/socialApi";
import { ProfileCardStatus } from "./ProfileCardStatus";
import { ProfileOwnHeaderActions } from "./ProfileOwnHeaderActions";
import styles from "./profile.module.css";

const MODAL_CLOSE_MS = 220;

/** Внутренний диаметр зелёного круга: profile-avatar-size минус 4px border с каждой стороны. */
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

function ProfilePageContent() {
  const { me, loading } = useCurrentUser();

  const followersModal = useAnimatedModal();
  const followingModal = useAnimatedModal();
  const descriptionModal = useAnimatedModal();

  const [followersTab, setFollowersTab] = useState<0 | 1>(0);
  const [followingTab, setFollowingTab] = useState<0 | 1>(0);

  const [publicProfile, setPublicProfile] = useState<PublicProfileDto | null>(null);
  const [profilePosts, setProfilePosts] = useState<ProfilePostDto[]>([]);
  const [postsLoading, setPostsLoading] = useState(false);
  const [postsError, setPostsError] = useState<string | null>(null);

  const loadWall = useCallback(async (username: string) => {
    const normalized = username.trim().replace(/^@+/, "");
    const cached = profileBundleCache.peek(normalized);
    if (cached) {
      setPublicProfile(cached.publicProfile);
      setProfilePosts(cached.posts);
      setPostsLoading(false);
    } else {
      setPostsLoading(true);
    }
    setPostsError(null);
    try {
      const bundle = await profileBundleCache.get(normalized);
      profileBundleCache.set(normalized, bundle);
      setPublicProfile(bundle.publicProfile);
      setProfilePosts(bundle.posts);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Не удалось загрузить профиль";
      if (!cached) {
        setPostsError(msg);
        setPublicProfile(null);
        setProfilePosts([]);
      }
    } finally {
      setPostsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!me?.username) return;
    void loadWall(me.username);
  }, [me?.username, loadWall]);

  const isOwnProfile = true;
  const name = me ? profileDisplayName(me.displayName, me.username) : loading ? "…" : "Профиль";
  const handle = me ? formatAtHandle(me.username) : loading ? "…" : "@…";
  const profileStatus = publicProfile?.status ?? me?.status;
  const followers = publicProfile?.followersCount ?? me?.followersCount ?? 0;
  const following = publicProfile?.followingCount ?? me?.followingCount ?? 0;

  const feedPosts = useMemo((): FeedPostListItem[] => {
    if (!me?.username) return [];
    return profilePosts.map((post) => ({
      ...post,
      authorUsername: me.username,
      authorDisplayName: me.displayName ?? me.username,
    }));
  }, [profilePosts, me?.username, me?.displayName]);

  const bumpCommentCount = useCallback((postUuid: string, delta: number) => {
    setProfilePosts((items) =>
      items.map((p) =>
        p.postUuid === postUuid ? { ...p, commentsCount: Math.max(0, p.commentsCount + delta) } : p,
      ),
    );
  }, []);

  const syncPostEngagement = useCallback(
    (
      postUuid: string,
      snapshot: { liked: boolean; reposted: boolean; likesCount: number; repostsCount: number },
    ) => {
      setProfilePosts((items) => items.map((p) => (p.postUuid === postUuid ? { ...p, ...snapshot } : p)));
    },
    [],
  );

  const syncPostViewsCount = useCallback((postUuid: string, viewsCount: number) => {
    setProfilePosts((items) =>
      items.map((p) => (p.postUuid === postUuid ? { ...p, viewsCount } : p)),
    );
  }, []);

  const pageScrollRef = useRef<HTMLElement>(null);

  const handleDeletePost = useCallback(async (postUuid: string) => {
    try {
      await apiDeletePost(postUuid);
      setProfilePosts((items) => items.filter((post) => post.postUuid !== postUuid));
      if (me?.username) {
        invalidateProfileCache(me.username);
      }
    } catch (e) {
      const message =
        e instanceof ApiRequestError ? e.message : e instanceof Error ? e.message : "Не удалось удалить пост";
      window.alert(message);
    }
  }, [me?.username]);

  return (
    <section ref={pageScrollRef} className={styles.page}>
      <header className={styles.profileHeader} aria-hidden />

      <div className={styles.profileCard} data-profile-status-measure>
        <div className={styles.profileCover} />
        <div className={styles.profileInfo}>
          <div className={styles.profileInfoTop}>
            <div className={styles.profileAvatar}>
              <FloraAvatar
                size={PROFILE_AVATAR_INNER_PX}
                avatarUuid={me?.avatarUuid ?? publicProfile?.avatarUuid}
                displayName={me?.displayName ?? name}
                username={me?.username ?? ""}
                seed={me?.userUuid}
              />
            </div>
            <ProfileCardStatus status={profileStatus} loading={loading && !profileStatus?.trim()} />
          </div>
          <div className={styles.profileNameRow}>
            <h2 className={styles.profileName}>{name}</h2>
            <p className={styles.profileHandle}>{handle}</p>
          </div>
          <div className={styles.profileStats}>
            <button
              type="button"
              className={styles.profileStatBtn}
              onClick={() => { setFollowersTab(0); followersModal.openModal(); }}
              aria-label="Показать подписчиков"
            >
              <strong>{followers}</strong>&nbsp;подписчиков
            </button>
            <button
              type="button"
              className={styles.profileStatBtn}
              onClick={() => { setFollowingTab(0); followingModal.openModal(); }}
              aria-label="Показать подписки"
            >
              <strong>{following}</strong>&nbsp;подписок
            </button>
          </div>
          {isOwnProfile ? <ProfileOwnHeaderActions /> : null}

          {isOwnProfile ? (
            <div className={styles.profileDetailsTriggerWrap}>
              <button
                type="button"
                className={styles.profileDetailsTrigger}
                onClick={descriptionModal.openModal}
                aria-label="Описание профиля"
                title="Описание профиля"
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

      {/* Модалка: подписчики */}
      {followersModal.open ? (
        <>
          <div
            className={`${styles.profileListModalBackdrop}${followersModal.closing ? ` ${styles.profileListModalBackdropClosing}` : ""}`}
            onClick={followersModal.closeModal}
          />
          <div className={styles.profileListModal} role="dialog" aria-modal aria-labelledby="profile-followers-title">
            <div className={`${styles.profileListModalDialog}${followersModal.closing ? ` ${styles.profileListModalDialogClosing}` : ""}`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className={styles.profileListModalHeader}>
                <h2 id="profile-followers-title" className={styles.profileListModalTitle}>Подписчики</h2>
                <button type="button" className={styles.profileListModalClose} onClick={followersModal.closeModal} aria-label="Закрыть">&times;</button>
              </div>
              <div className={styles.profileListModalTabs}>
                <button
                  type="button"
                  className={`${styles.profileListModalTab}${followersTab === 0 ? ` ${styles.profileListModalTabActive}` : ""}`}
                  onClick={() => setFollowersTab(0)}
                >Подписчики</button>
                <button
                  type="button"
                  className={`${styles.profileListModalTab}${followersTab === 1 ? ` ${styles.profileListModalTabActive}` : ""}`}
                  onClick={() => setFollowersTab(1)}
                >Сообщества</button>
              </div>
              <div className={styles.profileListModalBody}>
                {followersTab === 0 ? (
                  <ul className={styles.profileUsersList}>
                    <li>Список подписчиков появится позже.</li>
                  </ul>
                ) : (
                  <ul className={styles.profileCommunitiesList}>
                    <li>Нет сообществ.</li>
                  </ul>
                )}
              </div>
            </div>
          </div>
        </>
      ) : null}

      {/* Модалка: подписки */}
      {followingModal.open ? (
        <>
          <div
            className={`${styles.profileListModalBackdrop}${followingModal.closing ? ` ${styles.profileListModalBackdropClosing}` : ""}`}
            onClick={followingModal.closeModal}
          />
          <div className={styles.profileListModal} role="dialog" aria-modal aria-labelledby="profile-following-title">
            <div className={`${styles.profileListModalDialog}${followingModal.closing ? ` ${styles.profileListModalDialogClosing}` : ""}`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className={styles.profileListModalHeader}>
                <h2 id="profile-following-title" className={styles.profileListModalTitle}>Подписки</h2>
                <button type="button" className={styles.profileListModalClose} onClick={followingModal.closeModal} aria-label="Закрыть">&times;</button>
              </div>
              <div className={styles.profileListModalTabs}>
                <button
                  type="button"
                  className={`${styles.profileListModalTab}${followingTab === 0 ? ` ${styles.profileListModalTabActive}` : ""}`}
                  onClick={() => setFollowingTab(0)}
                >Подписки</button>
                <button
                  type="button"
                  className={`${styles.profileListModalTab}${followingTab === 1 ? ` ${styles.profileListModalTabActive}` : ""}`}
                  onClick={() => setFollowingTab(1)}
                >Сообщества</button>
              </div>
              <div className={styles.profileListModalBody}>
                {followingTab === 0 ? (
                  <ul className={styles.profileUsersList}>
                    <li>Список подписок появится позже.</li>
                  </ul>
                ) : (
                  <ul className={styles.profileCommunitiesList}>
                    <li>Нет сообществ.</li>
                  </ul>
                )}
              </div>
            </div>
          </div>
        </>
      ) : null}

      {/* Модалка: описание профиля */}
      {descriptionModal.open ? (
        <>
          <div
            className={`${styles.profileListModalBackdrop}${descriptionModal.closing ? ` ${styles.profileListModalBackdropClosing}` : ""}`}
            onClick={descriptionModal.closeModal}
          />
          <div className={styles.profileListModal} role="dialog" aria-modal aria-labelledby="profile-desc-title">
            <div className={`${styles.profileListModalDialog}${descriptionModal.closing ? ` ${styles.profileListModalDialogClosing}` : ""}`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className={styles.profileListModalHeader}>
                <h2 id="profile-desc-title" className={styles.profileListModalTitle}>Описание профиля</h2>
                <button
                  type="button"
                  className={styles.profileListModalClose}
                  onClick={descriptionModal.closeModal}
                  aria-label="Закрыть"
                >&times;</button>
              </div>
              <div className={`${styles.profileListModalBody} ${styles.profileDescriptionBody}`}>
                <dl className={styles.profileDescriptionDl}>
                  <dt>Имя</dt>
                  <dd>{me?.displayName || "—"}</dd>
                  <dt>Юзернейм</dt>
                  <dd>@{me?.username || "—"}</dd>
                  {(me?.status ?? publicProfile?.status) ? (
                    <>
                      <dt>Статус</dt>
                      <dd>{me?.status ?? publicProfile?.status}</dd>
                    </>
                  ) : null}
                </dl>
              </div>
            </div>
          </div>
        </>
      ) : null}

      <section className={styles.profileSection}>
        {postsError ? <p className={styles.profilePostsError}>{postsError}</p> : null}
        {postsLoading ? (
          <p className={emptyHintStyles.hint}>Загрузка постов…</p>
        ) : null}
        {!postsLoading && !postsError && profilePosts.length === 0 ? (
          <p className={emptyHintStyles.hint}>
            Пока нет постов на стене. Создайте первый во вкладке «Создать пост».
          </p>
        ) : null}
        {feedPosts.length > 0 ? (
          <FeedPostList
            variant="profile"
            posts={feedPosts}
            scrollRootRef={pageScrollRef}
            onCommentCountChange={bumpCommentCount}
            onEngagementChange={syncPostEngagement}
            onViewsCountChange={syncPostViewsCount}
            canManageAllPosts
            onDeletePost={handleDeletePost}
          />
        ) : null}
      </section>
    </section>
  );
}

export default function ProfilePage() {
  useProtectedPage();
  return <ProfilePageContent />;
}
