"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import emptyHintStyles from "@/app/_shared/emptyPageHint.module.css";
import { FeedPostList, type FeedPostListItem } from "@/app/_shared/FeedPostList";
import { useCurrentUser } from "@/app/_dashboard/CurrentUserContext";
import { useProtectedPage } from "@/app/_dashboard/useProtectedPage";
import { formatAtHandle, profileDisplayName } from "@/app/_dashboard/userDisplay";
import { FloraAvatar, FLORA_PROFILE_AVATAR_INNER_PX } from "@/app/_shared/FloraAvatar";
import { ApiRequestError } from "@/lib/auth";
import { messagesOpenChatQuery } from "@/lib/messagesUrl";
import {
  apiDeletePost,
  apiFollowUser,
  apiGetProfilePosts,
  apiGetPublicProfile,
  apiUnfollowUser,
  type ProfilePostDto,
  type PublicProfileDto,
} from "@/lib/socialApi";
import { ProfileCardStatus } from "../ProfileCardStatus";
import { ProfileOwnHeaderActions } from "../ProfileOwnHeaderActions";
import styles from "../profile.module.css";

const MODAL_CLOSE_MS = 220;

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

function slugFromParams(raw: string | string[] | undefined): string {
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (!s) return "";
  return decodeURIComponent(s).trim().replace(/^@+/, "");
}

function isSameProfileSlug(a: string | undefined, b: string): boolean {
  const left = (a ?? "").trim().replace(/^@+/, "");
  if (!left || !b) return false;
  return left.toLowerCase() === b.toLowerCase();
}

function UserPublicProfileContent({ usernameSlugOverride }: { usernameSlugOverride?: string }) {
  const params = useParams();
  const router = useRouter();
  const usernameSlug = usernameSlugOverride ?? slugFromParams(params.username);
  const { me } = useCurrentUser();

  const [publicProfile, setPublicProfile] = useState<PublicProfileDto | null>(null);
  const [profilePosts, setProfilePosts] = useState<ProfilePostDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [isFollowing, setIsFollowing] = useState<boolean>(false);
  const [localFollowersCount, setLocalFollowersCount] = useState<number>(0);

  const followersModal = useAnimatedModal();
  const followingModal = useAnimatedModal();
  const [followersTab, setFollowersTab] = useState<0 | 1>(0);
  const [followingTab, setFollowingTab] = useState<0 | 1>(0);

  const loadProfile = useCallback(async (username: string) => {
    setError(null);
    setLoading(true);
    try {
      const [pub, posts] = await Promise.all([apiGetPublicProfile(username), apiGetProfilePosts(username, 0, 30)]);
      setPublicProfile(pub);
      setProfilePosts(posts);
      setLocalFollowersCount(pub?.followersCount ?? 0);
      setIsFollowing(pub?.isFollowingByMe ?? false);
    } catch (e) {
      const msg = e instanceof ApiRequestError ? e.message : e instanceof Error ? e.message : "Не удалось загрузить профиль";
      setError(msg);
      setPublicProfile(null);
      setProfilePosts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const isOwnSlug = useMemo(
    () => isSameProfileSlug(me?.username, usernameSlug),
    [me?.username, usernameSlug],
  );

  useEffect(() => {
    if (isOwnSlug) {
      router.replace("/profile");
    }
  }, [isOwnSlug, router]);

  useEffect(() => {
    if (!usernameSlug) {
      setLoading(false);
      setError("Укажите ник в адресе страницы.");
      return;
    }
    if (isOwnSlug) return;
    void loadProfile(usernameSlug);
  }, [usernameSlug, loadProfile, isOwnSlug]);

  const isOwn = useMemo(() => {
    if (isOwnSlug) return true;
    if (!me || !publicProfile) return false;
    return me.userUuid.toLowerCase() === publicProfile.userUuid.toLowerCase();
  }, [isOwnSlug, me, publicProfile]);

  const name = publicProfile ? profileDisplayName(publicProfile.displayName, publicProfile.username) : loading ? "…" : "Профиль";
  const handle = publicProfile ? formatAtHandle(publicProfile.username) : loading ? "…" : "@…";
  const following = publicProfile?.followingCount ?? 0;

  const feedPosts = useMemo((): FeedPostListItem[] => {
    if (!publicProfile) return [];
    return profilePosts.map((post) => ({
      ...post,
      authorUsername: publicProfile.username,
      authorDisplayName: publicProfile.displayName,
    }));
  }, [profilePosts, publicProfile]);

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
    } catch (e) {
      const message =
        e instanceof ApiRequestError ? e.message : e instanceof Error ? e.message : "Не удалось удалить пост";
      window.alert(message);
    }
  }, []);

  const messagesHref =
    publicProfile && !isOwn
      ? messagesOpenChatQuery({
          userUuid: publicProfile.userUuid,
          username: publicProfile.username,
          displayName: publicProfile.displayName,
        })
      : null;

  const handleFollow = () => {
    if (!publicProfile) return;
    const username = publicProfile.username;
    void (async () => {
      try {
        await apiFollowUser(username);
        setIsFollowing(true);
        setLocalFollowersCount((c) => c + 1);
      } catch (e) {
        const message =
          e instanceof ApiRequestError ? e.message : e instanceof Error ? e.message : "Не удалось подписаться";
        window.alert(message);
      }
    })();
  };

  const handleUnfollow = () => {
    if (!publicProfile) return;
    const username = publicProfile.username;
    void (async () => {
      try {
        await apiUnfollowUser(username);
        setIsFollowing(false);
        setLocalFollowersCount((c) => Math.max(0, c - 1));
      } catch (e) {
        const message =
          e instanceof ApiRequestError ? e.message : e instanceof Error ? e.message : "Не удалось отписаться";
        window.alert(message);
      }
    })();
  };

  if (!usernameSlug) {
    return (
      <section className={styles.page}>
        <p className={styles.profilePostsError}>Некорректный адрес профиля.</p>
        <Link href="/feed" className={styles.profileActionBtn}>
          На главную
        </Link>
      </section>
    );
  }

  if (isOwnSlug) {
    return <section className={styles.page} />;
  }

  return (
    <section ref={pageScrollRef} className={styles.page}>
      <header className={styles.profileHeader} aria-hidden />

      <div className={styles.profileCard} data-profile-status-measure>
        <div className={styles.profileCover} />
        <div className={styles.profileInfo}>
          <div className={styles.profileInfoTop}>
            <div className={styles.profileAvatar}>
              <FloraAvatar
                size={FLORA_PROFILE_AVATAR_INNER_PX}
                avatarUuid={publicProfile?.avatarUuid}
                displayName={publicProfile?.displayName ?? name}
                username={publicProfile?.username ?? ""}
                seed={publicProfile?.userUuid}
              />
            </div>
            <ProfileCardStatus status={publicProfile?.status} loading={loading} />
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
              <strong>{localFollowersCount}</strong>&nbsp;подписчиков
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
          {isOwn ? (
            <ProfileOwnHeaderActions />
          ) : (
            <div className={styles.profileHeaderActions}>
              {messagesHref ? (
                <Link href={messagesHref} className={styles.profileActionBtn}>
                  Написать
                </Link>
              ) : null}
              {!loading && publicProfile ? (
                isFollowing ? (
                  <button
                    type="button"
                    className={`${styles.profileActionBtn} ${styles.profileActionBtnSecondary}`}
                    onClick={handleUnfollow}
                  >
                    Отписаться
                  </button>
                ) : (
                  <button
                    type="button"
                    className={styles.profileActionBtn}
                    onClick={handleFollow}
                  >
                    Подписаться
                  </button>
                )
              ) : null}
            </div>
          )}
        </div>
      </div>

      {/* Модалка: подписчики */}
      {followersModal.open ? (
        <>
          <div
            className={`${styles.profileListModalBackdrop}${followersModal.closing ? ` ${styles.profileListModalBackdropClosing}` : ""}`}
            onClick={followersModal.closeModal}
          />
          <div className={styles.profileListModal} role="dialog" aria-modal aria-labelledby="pub-followers-title">
            <div
              className={`${styles.profileListModalDialog}${followersModal.closing ? ` ${styles.profileListModalDialogClosing}` : ""}`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className={styles.profileListModalHeader}>
                <h2 id="pub-followers-title" className={styles.profileListModalTitle}>Подписчики</h2>
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
          <div className={styles.profileListModal} role="dialog" aria-modal aria-labelledby="pub-following-title">
            <div
              className={`${styles.profileListModalDialog}${followingModal.closing ? ` ${styles.profileListModalDialogClosing}` : ""}`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className={styles.profileListModalHeader}>
                <h2 id="pub-following-title" className={styles.profileListModalTitle}>Подписки</h2>
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

      <section className={styles.profileSection}>
        {error ? <p className={styles.profilePostsError}>{error}</p> : null}
        {loading ? (
          <p className={emptyHintStyles.hint}>Загрузка…</p>
        ) : null}
        {!loading && !error && profilePosts.length === 0 ? (
          <p className={emptyHintStyles.hint}>
            Пока нет постов на стене. Загляните позже.
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
            canManageAllPosts={isOwn}
            onDeletePost={isOwn ? handleDeletePost : undefined}
          />
        ) : null}
      </section>
    </section>
  );
}

export function UserPublicProfileView({ usernameSlug }: { usernameSlug: string }) {
  const { isClient, hasToken } = useProtectedPage();
  if (!isClient || !hasToken) return <div className={styles.page} />;
  return <UserPublicProfileContent usernameSlugOverride={usernameSlug} />;
}

export default function UserPublicProfilePage() {
  const { isClient, hasToken } = useProtectedPage();
  if (!isClient || !hasToken) return <div className={styles.page} />;
  return <UserPublicProfileContent />;
}
