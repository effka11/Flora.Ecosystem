"use client";

import Link from "next/link";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FeedPostComments } from "@/app/_shared/FeedPostComments";
import { ExpandablePostText } from "@/app/_shared/ExpandablePostText";
import { FeedPostImages } from "@/app/_shared/FeedPostImages";
import { FeedPostVideo } from "@/app/_shared/FeedPostVideo";
import { FloraAvatar } from "@/app/_shared/FloraAvatar";
import { FollowedRepostStack } from "@/app/_shared/FollowedRepostStack";
import { usePreloadFeedPostComments } from "@/app/_shared/usePreloadFeedPostComments";
import emptyHintStyles from "@/app/_shared/emptyPageHint.module.css";
import { PostMoreMenuRect } from "@/app/_shared/PostMoreMenuRect";
// import { PostMoreMenu } from "@/app/_shared/PostMoreMenu";
import { TabSearchInput } from "@/app/_shared/TabSearchInput";
import { useCurrentUser } from "@/app/_dashboard/CurrentUserContext";
import { useProtectedPage } from "@/app/_dashboard/useProtectedPage";
import { formatAtHandle, handlesEqual, profileDisplayName } from "@/app/_dashboard/userDisplay";
import { ApiRequestError } from "@/lib/auth";
import { formatRelativeTimeRu } from "@/lib/formatRelativeTimeRu";
import { feedCacheForKind } from "@/lib/dashboardPreload";
import { apiCheckFeedHasNew, apiDeletePost, apiGetFeed, type FeedKind, type FeedPostDto } from "@/lib/socialApi";
import { usePostEngagement } from "@/lib/usePostEngagement";
import { usePostViewTracking } from "@/lib/usePostViewTracking";
import styles from "./feed.module.css";
import { useFeedCompactHeader } from "./useFeedCompactHeader";

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
  };
}

const FEED_TAB_STORAGE_KEY = "flora.feed.activeTab";

/** Сброс класса анимации списка после `0.9s + 0.02s` (как ClearFeedTransitionAfterDelay в Dashboard.razor). */
const FEED_LIST_TRANSITION_CLEAR_MS = 950;

/** Один оборот иконки «Обновить» — синхронно с feedRefreshIconSpin в feed.module.css. */
const FEED_REFRESH_SPIN_MS = 550;

/** Подкат линии при выходе из компакта — как _feedExpandedEntry* в 2142 index.html. */
const FEED_EXPANDED_INDICATOR_DELAY_MS = 20;
const FEED_EXPANDED_INDICATOR_DURATION_MS = 400;
const FEED_EXPANDED_INDICATOR_DELTA_PX = 20;
const FEED_EXPANDED_UI_CLEANUP_MS = 600;

/** CSS-переменные индикатора вкладок (не входят в стандартный `CSSProperties` без индекса). */
type FeedTabIndicatorStyle = CSSProperties &
  Record<"--feed-tab-indicator-left" | "--feed-tab-indicator-width", string>;

function feedTabIndex(tab: FeedKind): number {
  return tab === "recommendations" ? 0 : 1;
}

type FeedSlot = {
  items: FeedPostDto[];
  loading: boolean;
  /** true когда догружается следующая страница (infinite scroll). */
  loadingMore: boolean;
  error: string | null;
  loaded: boolean;
  /** Курсор для следующей страницы (FIRA.md §13). */
  nextCursor: string | null;
  hasMore: boolean;
  /** ISO 8601 UTC — используется для поллинга has-new. */
  generatedAt: string | null;
};

function emptyFeedSlot(loading: boolean): FeedSlot {
  return { items: [], loading, loadingMore: false, error: null, loaded: false, nextCursor: null, hasMore: false, generatedAt: null };
}

function feedSlotFromPage(page: Awaited<ReturnType<typeof apiGetFeed>>, loading = false): FeedSlot {
  return {
    items: page.items,
    loading,
    loadingMore: false,
    error: null,
    loaded: true,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    generatedAt: page.generatedAt,
  };
}

function initialFeedsState(): { recommendations: FeedSlot; subscriptions: FeedSlot } {
  const recommendationsCached = feedCacheForKind("recommendations").peek();
  const subscriptionsCached = feedCacheForKind("subscriptions").peek();
  return {
    recommendations: recommendationsCached ? feedSlotFromPage(recommendationsCached) : emptyFeedSlot(true),
    subscriptions: subscriptionsCached ? feedSlotFromPage(subscriptionsCached) : emptyFeedSlot(false),
  };
}

function createFeedScrollByTab(): Record<FeedKind, number> {
  return { recommendations: 0, subscriptions: 0 };
}

function clampScrollTop(el: HTMLElement, scrollTop: number): number {
  const max = Math.max(0, el.scrollHeight - el.clientHeight);
  return Math.min(Math.max(0, scrollTop), max);
}

function FeedPageContent() {
  const { me } = useCurrentUser();
  const [activeTab, setActiveTab] = useState<FeedKind>("recommendations");
  const [searchValue, setSearchValue] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshSpinEpoch, setRefreshSpinEpoch] = useState(0);
  const [commentsOpenPostUuid, setCommentsOpenPostUuid] = useState<string | null>(null);

  const [feeds, setFeeds] = useState(initialFeedsState);

  /** Флаг баннера «Новые посты» (FIRA-F has-new polling). */
  const [hasNewPosts, setHasNewPosts] = useState(false);

  /** Ref для отслеживания текущего активного таба внутри колбэков (без пересоздания observer). */
  const activeTabRef = useRef<FeedKind>("recommendations");
  /** Живая ссылка на актуальное состояние feeds, чтобы loadMoreFeedTab не зависел от стейта. */
  const feedsRef = useRef(feeds);
  /** Sentinel-элемент в конце списка для IntersectionObserver infinite scroll. */
  const bottomSentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);
  useEffect(() => { feedsRef.current = feeds; }, [feeds]);

  const removePostFromFeeds = useCallback((postUuid: string) => {
    const drop = (items: FeedPostDto[]) => items.filter((post) => post.postUuid !== postUuid);
    setFeeds((prev) => ({
      recommendations: { ...prev.recommendations, items: drop(prev.recommendations.items) },
      subscriptions: { ...prev.subscriptions, items: drop(prev.subscriptions.items) },
    }));
    setCommentsOpenPostUuid((openId) => (openId === postUuid ? null : openId));
  }, []);

  const handleDeletePost = useCallback(
    async (postUuid: string) => {
      try {
        await apiDeletePost(postUuid);
        removePostFromFeeds(postUuid);
      } catch (e) {
        const message =
          e instanceof ApiRequestError ? e.message : e instanceof Error ? e.message : "Не удалось удалить пост";
        window.alert(message);
      }
    },
    [removePostFromFeeds],
  );

  const bumpPostCommentsCount = useCallback((postUuid: string, delta: number) => {
    const bump = (items: FeedPostDto[]) =>
      items.map((p) =>
        p.postUuid === postUuid ? { ...p, commentsCount: Math.max(0, p.commentsCount + delta) } : p
      );
    setFeeds((prev) => ({
      recommendations: { ...prev.recommendations, items: bump(prev.recommendations.items) },
      subscriptions: { ...prev.subscriptions, items: bump(prev.subscriptions.items) },
    }));
  }, []);

  const syncPostEngagement = useCallback(
    (
      postUuid: string,
      snapshot: { liked: boolean; reposted: boolean; likesCount: number; repostsCount: number },
    ) => {
      const patch = (items: FeedPostDto[]) =>
        items.map((p) => (p.postUuid === postUuid ? { ...p, ...snapshot } : p));
      setFeeds((prev) => ({
        recommendations: { ...prev.recommendations, items: patch(prev.recommendations.items) },
        subscriptions: { ...prev.subscriptions, items: patch(prev.subscriptions.items) },
      }));
    },
    [],
  );

  const syncPostViewsCount = useCallback((postUuid: string, viewsCount: number) => {
    const patch = (items: FeedPostDto[]) =>
      items.map((p) => (p.postUuid === postUuid ? { ...p, viewsCount } : p));
    setFeeds((prev) => ({
      recommendations: { ...prev.recommendations, items: patch(prev.recommendations.items) },
      subscriptions: { ...prev.subscriptions, items: patch(prev.subscriptions.items) },
    }));
  }, []);

  const recommendationsTabRef = useRef<HTMLButtonElement>(null);
  const subscriptionsTabRef = useRef<HTMLButtonElement>(null);
  const peopleTabsRef = useRef<HTMLDivElement>(null);
  const tabIndicatorRef = useRef<HTMLDivElement>(null);
  const indicatorExpandedAnimRef = useRef<Animation | null>(null);
  const feedScrollRef = useRef<HTMLElement>(null);
  const feedScrollByTabRef = useRef<Record<FeedKind, number>>(createFeedScrollByTab());
  const feedTopBlockRef = useRef<HTMLDivElement>(null);
  const {
    isCompact: feedCompact,
    compactAnimate: feedCompactAnimate,
    noTransition: feedNoTransition,
    isLeavingCompact: feedLeavingCompact,
  } = useFeedCompactHeader(feedScrollRef, feedTopBlockRef);

  const { snapshotFor, toggleLike, toggleRepost, isLikePending, isRepostPending } = usePostEngagement({
    onEngagementChange: syncPostEngagement,
  });
  const { viewsCountFor, getPostItemRef } = usePostViewTracking({
    scrollRootRef: feedScrollRef,
    onViewsCountChange: syncPostViewsCount,
  });

  const [indicatorVars, setIndicatorVars] = useState<FeedTabIndicatorStyle>({
    "--feed-tab-indicator-left": "0px",
    "--feed-tab-indicator-width": "0px",
  });
  const [indicatorMotionEnabled, setIndicatorMotionEnabled] = useState(false);
  const indicatorMotionPrimedRef = useRef(false);
  const [tabRestoreReady, setTabRestoreReady] = useState(false);
  const [listTransition, setListTransition] = useState<null | "fromLeft" | "fromRight">(null);
  const [refreshTransition, setRefreshTransition] = useState<null | "fade">(null);
  const [refreshAnimEpoch, setRefreshAnimEpoch] = useState(0);
  const listTransitionClearRef = useRef<number | null>(null);
  const refreshTransitionClearRef = useRef<number | null>(null);

  const restoreFeedScrollForTab = useCallback((tab: FeedKind) => {
    const el = feedScrollRef.current;
    if (!el) return;
    el.scrollTop = clampScrollTop(el, feedScrollByTabRef.current[tab]);
  }, []);

  const switchFeedTab = useCallback(
    (next: FeedKind) => {
      if (next === activeTab) return;

      const scrollEl = feedScrollRef.current;
      if (scrollEl) {
        feedScrollByTabRef.current[activeTab] = scrollEl.scrollTop;
      }

      if (listTransitionClearRef.current !== null) {
        window.clearTimeout(listTransitionClearRef.current);
        listTransitionClearRef.current = null;
      }

      const reduced =
        typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const prevIdx = feedTabIndex(activeTab);
      const nextIdx = feedTabIndex(next);

      if (!reduced) {
        setListTransition(nextIdx > prevIdx ? "fromRight" : "fromLeft");
        listTransitionClearRef.current = window.setTimeout(() => {
          setListTransition(null);
          listTransitionClearRef.current = null;
        }, FEED_LIST_TRANSITION_CLEAR_MS);
      } else {
        setListTransition(null);
      }

      setCommentsOpenPostUuid(null);
      setActiveTab(next);
    },
    [activeTab]
  );

  useEffect(() => {
    const el = feedScrollRef.current;
    if (!el) return;
    const onScroll = () => {
      feedScrollByTabRef.current[activeTab] = el.scrollTop;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [activeTab]);

  useEffect(() => {
    if (!tabRestoreReady) return;
    const slot = feeds[activeTab];
    if (!slot.loaded) return;

    const apply = () => restoreFeedScrollForTab(activeTab);
    requestAnimationFrame(() => {
      requestAnimationFrame(apply);
    });
  }, [
    activeTab,
    tabRestoreReady,
    feeds[activeTab].loaded,
    feeds[activeTab].items.length,
    restoreFeedScrollForTab,
  ]);

  useEffect(
    () => () => {
      if (listTransitionClearRef.current !== null) window.clearTimeout(listTransitionClearRef.current);
      if (refreshTransitionClearRef.current !== null) window.clearTimeout(refreshTransitionClearRef.current);
    },
    []
  );

  const applyRefreshFade = useCallback(() => {
    if (refreshTransitionClearRef.current !== null) {
      window.clearTimeout(refreshTransitionClearRef.current);
      refreshTransitionClearRef.current = null;
    }

    const reduced =
      typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (!reduced) {
      setRefreshAnimEpoch((epoch) => epoch + 1);
      setRefreshTransition("fade");
      refreshTransitionClearRef.current = window.setTimeout(() => {
        setRefreshTransition(null);
        refreshTransitionClearRef.current = null;
      }, FEED_LIST_TRANSITION_CLEAR_MS);
    } else {
      setRefreshTransition(null);
    }
  }, []);

  const loadFeedTab = useCallback(async (tab: FeedKind, options?: { refresh?: boolean }) => {
    const cache = feedCacheForKind(tab);
    if (options?.refresh) {
      cache.invalidate();
    }

    const cached = options?.refresh ? null : cache.peek();
    if (cached) {
      setFeeds((prev) => ({
        ...prev,
        [tab]: feedSlotFromPage(cached),
      }));
    } else {
      setFeeds((prev) => ({
        ...prev,
        [tab]: { ...prev[tab], loading: true, loadingMore: false, error: null },
      }));
    }

    try {
      const page = options?.refresh
        ? await apiGetFeed(30, null, tab, { refresh: tab === "recommendations" })
        : await cache.get();
      cache.set(page);
      setFeeds((prev) => ({
        ...prev,
        [tab]: feedSlotFromPage(page),
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Не удалось загрузить ленту";
      setFeeds((prev) => ({
        ...prev,
        [tab]: {
          ...prev[tab],
          items: [],
          loading: false,
          loadingMore: false,
          error: msg,
          loaded: true,
          nextCursor: null,
          hasMore: false,
        },
      }));
    }
  }, []);

  /** Догрузка следующей страницы (infinite scroll). Использует ref для стейта. */
  const loadMoreFeedTab = useCallback(async (tab: FeedKind) => {
    const slot = feedsRef.current[tab];
    if (!slot.hasMore || slot.loading || slot.loadingMore || !slot.nextCursor) return;

    setFeeds((prev) => ({
      ...prev,
      [tab]: { ...prev[tab], loadingMore: true },
    }));
    try {
      const page = await apiGetFeed(20, slot.nextCursor, tab);
      setFeeds((prev) => ({
        ...prev,
        [tab]: {
          ...prev[tab],
          items: [...prev[tab].items, ...page.items],
          loadingMore: false,
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        },
      }));
    } catch {
      setFeeds((prev) => ({
        ...prev,
        [tab]: { ...prev[tab], loadingMore: false },
      }));
    }
  }, []);

  useEffect(() => {
    if (!tabRestoreReady) return;
    const id = window.setTimeout(() => {
      void loadFeedTab("recommendations");
      void loadFeedTab("subscriptions");
    }, 0);
    return () => window.clearTimeout(id);
  }, [tabRestoreReady, loadFeedTab]);

  useLayoutEffect(() => {
    if (!feedLeavingCompact) return;

    const row = peopleTabsRef.current;
    const block = feedTopBlockRef.current;
    const searchWrap = block?.querySelector<HTMLElement>(`.${styles.peopleSearchWrap}`) ?? null;

    const restartAnimClass = (el: HTMLElement | null, className: string) => {
      if (!el) return;
      el.classList.remove(className);
      void el.offsetHeight;
      el.classList.add(className);
    };

    restartAnimClass(row, styles.peopleTabsExpanding);
    restartAnimClass(searchWrap, styles.peopleSearchExpanding);

    const clearExpandClasses = () => {
      row?.classList.remove(styles.peopleTabsExpanding);
      searchWrap?.classList.remove(styles.peopleSearchExpanding);
    };

    const onTabsEnd = (event: AnimationEvent) => {
      if (event.target !== row) return;
      clearExpandClasses();
    };
    row?.addEventListener("animationend", onTabsEnd);
    window.setTimeout(clearExpandClasses, FEED_EXPANDED_UI_CLEANUP_MS);

    return () => {
      row?.removeEventListener("animationend", onTabsEnd);
      /* Классы снимает animationend/таймер — не в cleanup при isLeavingCompact=false (420ms), иначе рывок. */
    };
  }, [feedLeavingCompact]);

  useLayoutEffect(() => {
    if (!feedLeavingCompact) return;

    const ind = tabIndicatorRef.current;
    const target =
      activeTab === "recommendations" ? recommendationsTabRef.current : subscriptionsTabRef.current;
    if (!ind || !target) return;

    const left = target.offsetLeft;
    const tabW = target.offsetWidth;
    if (tabW <= 0) return;

    const toLeft = left;
    const fromLeft = toLeft + FEED_EXPANDED_INDICATOR_DELTA_PX;
    let cancelled = false;

    setIndicatorMotionEnabled(false);
    setIndicatorVars({
      "--feed-tab-indicator-left": `${toLeft}px`,
      "--feed-tab-indicator-width": `${tabW}px`,
    });

    const clearInline = () => {
      ind.style.removeProperty("opacity");
      ind.style.removeProperty("transition");
      ind.style.removeProperty("transform");
    };

    const finish = () => {
      if (cancelled) return;
      indicatorExpandedAnimRef.current = null;
      clearInline();
      setIndicatorMotionEnabled(true);
    };

    const startAnim = () => {
      if (cancelled) return;
      indicatorExpandedAnimRef.current?.cancel();
      clearInline();
      ind.style.transition = "none";
      ind.style.opacity = "0";
      void ind.offsetHeight;
      ind.style.transform = `translate3d(${fromLeft}px, 0, 0)`;
      ind.style.opacity = "1";
      void ind.offsetHeight;

      if (typeof ind.animate !== "function") {
        finish();
        return;
      }

      const anim = ind.animate(
        [
          { transform: `translate3d(${fromLeft}px, 0, 0)` },
          { transform: `translate3d(${toLeft}px, 0, 0)` },
        ],
        {
          duration: FEED_EXPANDED_INDICATOR_DURATION_MS,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          fill: "forwards",
        }
      );
      indicatorExpandedAnimRef.current = anim;
      anim.onfinish = finish;
      anim.oncancel = finish;
    };

    const delayId = window.setTimeout(startAnim, FEED_EXPANDED_INDICATOR_DELAY_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(delayId);
      indicatorExpandedAnimRef.current?.cancel();
      indicatorExpandedAnimRef.current = null;
      clearInline();
    };
  }, [feedLeavingCompact, activeTab]);

  useLayoutEffect(() => {
    if (!tabRestoreReady || feedLeavingCompact || indicatorMotionPrimedRef.current) return;

    const target =
      activeTab === "recommendations" ? recommendationsTabRef.current : subscriptionsTabRef.current;
    if (!target) return;

    const left = target.offsetLeft;
    const tabW = target.offsetWidth;
    if (tabW <= 0) return;

    setIndicatorVars({
      "--feed-tab-indicator-left": `${left}px`,
      "--feed-tab-indicator-width": `${tabW}px`,
    });
  }, [tabRestoreReady, activeTab, feedLeavingCompact]);

  useEffect(() => {
    if (!tabRestoreReady || feedLeavingCompact) return;

    const syncIndicator = () => {
      const row = peopleTabsRef.current;
      const target =
        activeTab === "recommendations" ? recommendationsTabRef.current : subscriptionsTabRef.current;
      if (!row || !target) return;

      const left = target.offsetLeft;
      const tabW = target.offsetWidth;
      if (tabW <= 0) return;
      setIndicatorVars({
        "--feed-tab-indicator-left": `${left}px`,
        "--feed-tab-indicator-width": `${tabW}px`,
      });
      if (!indicatorMotionPrimedRef.current) {
        indicatorMotionPrimedRef.current = true;
        requestAnimationFrame(() => setIndicatorMotionEnabled(true));
      }
    };

    syncIndicator();

    const row = peopleTabsRef.current;
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(syncIndicator) : null;
    if (ro) {
      if (row) ro.observe(row);
      if (recommendationsTabRef.current) ro.observe(recommendationsTabRef.current);
      if (subscriptionsTabRef.current) ro.observe(subscriptionsTabRef.current);
    }

    window.addEventListener("resize", syncIndicator);
    const fontsReady = document.fonts?.ready;
    void fontsReady?.then(syncIndicator);

    return () => {
      window.removeEventListener("resize", syncIndicator);
      ro?.disconnect();
    };
  }, [
    activeTab,
    tabRestoreReady,
    feedCompact,
    feedCompactAnimate,
    feedLeavingCompact,
    feeds[activeTab].loaded,
    feeds[activeTab].items.length,
  ]);

  const scrollFeedToTop = useCallback(() => {
    feedScrollByTabRef.current[activeTab] = 0;
    feedScrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [activeTab]);

  const handleRefresh = async () => {
    if (isRefreshing) return;

    if (listTransitionClearRef.current !== null) {
      window.clearTimeout(listTransitionClearRef.current);
      listTransitionClearRef.current = null;
    }
    setListTransition(null);
    setHasNewPosts(false);

    setRefreshSpinEpoch((epoch) => epoch + 1);
    setIsRefreshing(true);
    scrollFeedToTop();
    applyRefreshFade();
    try {
      await loadFeedTab(activeTab, { refresh: true });
    } finally {
      window.setTimeout(() => setIsRefreshing(false), FEED_REFRESH_SPIN_MS);
    }
  };

  /** IntersectionObserver для infinite scroll: наблюдаем sentinel в конце списка. */
  useEffect(() => {
    const sentinel = bottomSentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          void loadMoreFeedTab(activeTabRef.current);
        }
      },
      { rootMargin: "300px", threshold: 0 }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // однократно; актуальный таб и feeds читаются через рефы

  /** Поллинг has-new (FIRA-F §13.4): каждые 30 с при активном табе рекомендаций. */
  useEffect(() => {
    if (activeTab !== "recommendations") {
      setHasNewPosts(false);
      return;
    }
    const generatedAt = feeds.recommendations.generatedAt;
    if (!generatedAt) return;

    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      const hasNew = await apiCheckFeedHasNew(generatedAt);
      if (!cancelled) setHasNewPosts(hasNew);
    };

    const intervalId = window.setInterval(() => { void poll(); }, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeTab, feeds.recommendations.generatedAt]);

  useEffect(() => {
    queueMicrotask(() => {
      const savedTab = window.localStorage.getItem(FEED_TAB_STORAGE_KEY);
      if (savedTab === "recommendations" || savedTab === "subscriptions") {
        setActiveTab(savedTab);
      }
      setTabRestoreReady(true);
    });
  }, []);

  useEffect(() => {
    if (!tabRestoreReady) return;
    window.localStorage.setItem(FEED_TAB_STORAGE_KEY, activeTab);
  }, [activeTab, tabRestoreReady]);

  const slot = feeds[activeTab];

  const visiblePosts = useMemo(() => {
    const q = searchValue.trim().toLowerCase();
    const items = slot.items;
    if (!q) return items;
    return items.filter(
      (p) =>
        p.content.toLowerCase().includes(q) ||
        p.authorDisplayName.toLowerCase().includes(q) ||
        p.authorUsername.toLowerCase().includes(q) ||
        (p.communityName && p.communityName.toLowerCase().includes(q))
    );
  }, [slot.items, searchValue]);

  usePreloadFeedPostComments(visiblePosts);

  const emptyHint =
    activeTab === "subscriptions"
      ? "Пока нет постов в подписках. Подпишитесь на людей во вкладке «Люди» или загляните в «Рекомендации»."
      : "Пока нет постов. Создайте первый во вкладке «Создать пост».";

  const feedTopBlockClass = [
    styles.feedTopBlock,
    feedCompact ? styles.feedTopBlockCompact : "",
    feedCompactAnimate ? styles.feedTopBlockCompactAnimate : "",
    feedNoTransition ? styles.feedTopBlockNoTransition : "",
    feedLeavingCompact ? styles.feedTopBlockLeavingCompact : "",
  ]
    .filter(Boolean)
    .join(" ");

  const peopleTabsClass = [styles.peopleTabs, feedCompact ? styles.peopleTabsCompact : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <section ref={feedScrollRef} className={styles.feedPage} id="central-scroll-feed">
      <div ref={feedTopBlockRef} className={feedTopBlockClass}>
        <div className={styles.feedTopBlockInner}>
          <div className={styles.searchHeader}>
            <TabSearchInput
              placeholder="Поиск в ленте"
              value={searchValue}
              onChange={setSearchValue}
              classNames={{
                wrap: styles.peopleSearchWrap,
                box: styles.peopleSearchBox,
                icon: styles.peopleSearchIcon,
                input: styles.peopleSearchInput,
                actionButton: styles.peopleSearchSendBtn,
                actionButtonShown: styles.peopleSearchSendBtnShown,
                actionButtonHidden: styles.peopleSearchSendBtnHidden,
              }}
            />
          </div>

          <div className={styles.feedFiltersBlock}>
            <div className={styles.peopleTabsWrap}>
              <div ref={peopleTabsRef} className={peopleTabsClass}>
                <button
                  ref={recommendationsTabRef}
                  type="button"
                  className={`${styles.peopleTab} ${activeTab === "recommendations" ? styles.peopleTabActive : ""}`}
                  onClick={() => switchFeedTab("recommendations")}
                >
                  <span className={styles.peopleTabLabel}>Рекомендации</span>
                </button>
                <button
                  ref={subscriptionsTabRef}
                  type="button"
                  className={`${styles.peopleTab} ${activeTab === "subscriptions" ? styles.peopleTabActive : ""}`}
                  onClick={() => switchFeedTab("subscriptions")}
                >
                  <span className={styles.peopleTabLabel}>Подписки</span>
                </button>
                <div
                  ref={tabIndicatorRef}
                  className={`${styles.peopleTabIndicator} ${!indicatorMotionEnabled ? styles.peopleTabIndicatorStatic : ""}`}
                  style={indicatorVars}
                  aria-hidden
                />
              </div>
            </div>

            <button
              type="button"
              className={`${styles.feedTabRefreshBtn} ${styles.feedTabRefreshBtnExpand}`}
              onClick={() => void handleRefresh()}
              disabled={slot.loading || isRefreshing}
              aria-busy={isRefreshing}
              aria-label="Обновить ленту"
            >
              <span className={`${styles.feedTabRefreshLabel} flora-type-15`}>Обновить</span>
              <span
                key={refreshSpinEpoch}
                className={`${styles.feedTabRefreshSpin} ${isRefreshing ? styles.refreshSpinning : ""}`}
                aria-hidden
              >
                <svg className={styles.feedTabRefreshIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                  <path d="M21 3v6h-6" />
                </svg>
              </span>
            </button>
            <button
              type="button"
              className={styles.feedScrollTopBtn}
              onClick={scrollFeedToTop}
              aria-label="В начало ленты"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M18 15l-6-6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M18 9l-6-6-6 6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Баннер «Новые посты» (FIRA-F has-new, §13.4). Sticky под компактной шапкой. */}
      {hasNewPosts && activeTab === "recommendations" && (
        <button
          type="button"
          className={styles.newPostsBanner}
          onClick={() => {
            setHasNewPosts(false);
            scrollFeedToTop();
            void handleRefresh();
          }}
        >
          <svg
            className={styles.newPostsBannerIcon}
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden
          >
            <path d="M12 19V5M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Новые посты — нажмите, чтобы обновить
        </button>
      )}

      <div className={styles.feedList}>
        <div className={styles.peopleListSection}>
          <section className={styles.feed}>
            <div
              className={`${styles.peopleListContent} ${
                listTransition === "fromLeft"
                  ? styles.peopleListContentFromLeft
                  : listTransition === "fromRight"
                    ? styles.peopleListContentFromRight
                    : ""
              }`}
            >
              <div
                key={refreshAnimEpoch}
                className={
                  refreshTransition === "fade" ? styles.feedListRefreshFade : styles.feedListRefreshBody
                }
              >
              {slot.error ? (
                <p className={`${styles.feedStatusLine} ${styles.feedStatusLineError}`} role="alert">
                  {slot.error}{" "}
                  <button type="button" className={styles.feedRetryBtn} onClick={() => void loadFeedTab(activeTab)}>
                    Повторить
                  </button>
                </p>
              ) : null}
              {slot.loading && slot.items.length === 0 ? (
                <p className={emptyHintStyles.hint}>Загрузка ленты…</p>
              ) : null}
              {!slot.loading && !slot.error && visiblePosts.length === 0 ? (
                <p className={emptyHintStyles.hint}>{emptyHint}</p>
              ) : null}
              <ul className={styles.profilePostsList}>
                {visiblePosts.map((post) => {
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
                        href={authorMeta.href}
                        avatarUuid={authorMeta.avatarUuid}
                        displayName={authorMeta.displayName}
                        username={authorMeta.username}
                        seed={authorMeta.seed}
                        communityName={authorMeta.communityName}
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
                        {/* Notch-panel: PostMoreMenu — заменено на прямоугольное меню как в Messages. */}
                        <PostMoreMenuRect
                          wrapClassName={styles.profilePostMoreWrap}
                          buttonClassName={styles.profilePostMoreBtn}
                          sharePath={authorMeta.href}
                          canDeletePost={handlesEqual(me?.username ?? "", post.authorUsername)}
                          onDeletePost={() => void handleDeletePost(post.postUuid)}
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
                        {post.imageUuids.length > 0 ? (
                          <FeedPostImages imageUuids={post.imageUuids} />
                        ) : null}
                        {post.video ? <FeedPostVideo postUuid={post.postUuid} video={post.video} /> : null}
                        <div className={styles.profilePostBar}>
                          <div className={styles.profilePostActions}>
                            <button
                              type="button"
                              className={`${styles.profilePostAction} ${engagement.liked ? styles.profilePostActionLikeOn : ""}`}
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
                              className={`${styles.profilePostAction} ${commentsOpen ? styles.profilePostActionCommentsOpen : ""}`}
                              aria-expanded={commentsOpen}
                              aria-label={commentsOpen ? "Скрыть комментарии к посту" : "Показать комментарии к посту"}
                              onClick={() =>
                                setCommentsOpenPostUuid((id) => (id === post.postUuid ? null : post.postUuid))
                              }
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
                          onCommentAdded={() => bumpPostCommentsCount(post.postUuid, 1)}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>

              {/* Спиннер «загружаем ещё» + sentinel для IntersectionObserver */}
              {slot.loadingMore && (
                <div className={styles.feedLoadingMore}>
                  <span className={styles.feedLoadMoreSpinner} aria-label="Загружаем ещё…" role="status" />
                </div>
              )}
              <div ref={bottomSentinelRef} className={styles.feedLoadMoreSentinel} aria-hidden />

              </div>
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}

export default function FeedPage() {
  const { isClient, hasToken } = useProtectedPage();

  if (!isClient || !hasToken) return <div className={styles.feedPage} />;

  return <FeedPageContent />;
}
