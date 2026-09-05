"use client";

import type { CSSProperties } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePreloadFeedPostComments } from "@/app/_shared/usePreloadFeedPostComments";
import emptyHintStyles from "@/app/_shared/emptyPageHint.module.css";
import { TabSearchInput } from "@/app/_shared/TabSearchInput";
import { useCurrentUser } from "@/app/_dashboard/CurrentUserContext";
import { useProtectedPage } from "@/app/_dashboard/useProtectedPage";
import { ApiRequestError } from "@/lib/auth";
import { feedCacheForKind } from "@/lib/dashboardPreload";
import { FeedPagePosts } from "./FeedPagePosts";
import {
  apiCheckFeedHasNew,
  apiDeletePost,
  apiDismissCommunity,
  apiGetFeed,
  apiHideFeedAuthor,
  apiMarkPostNotInterested,
  apiSearchFeed,
  type FeedKind,
  type FeedPostDto,
} from "@/lib/socialApi";
import { usePostEngagement } from "@/lib/usePostEngagement";
import { usePostViewTracking } from "@/lib/usePostViewTracking";
import styles from "./feed.module.css";
import { useFeedCompactHeader } from "./useFeedCompactHeader";

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
  const [searchPosts, setSearchPosts] = useState<FeedPostDto[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [appliedSearchQuery, setAppliedSearchQuery] = useState("");

  /** Флаг баннера «Новые посты» (FIRA-F has-new polling). */
  const [hasNewPosts, setHasNewPosts] = useState(false);

  /** Ref для отслеживания текущего активного таба внутри колбэков (без пересоздания observer). */
  const activeTabRef = useRef<FeedKind>("recommendations");
  /** Живая ссылка на актуальное состояние feeds, чтобы loadMoreFeedTab не зависел от стейта. */
  const feedsRef = useRef(feeds);
  /** Sentinel-элемент в конце списка для IntersectionObserver infinite scroll. */
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  const searchValueRef = useRef(searchValue);

  const hasSearch = searchValue.trim().length >= 1;

  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);
  useEffect(() => { feedsRef.current = feeds; }, [feeds]);
  useEffect(() => { searchValueRef.current = searchValue; }, [searchValue]);

  const removePostFromFeeds = useCallback((postUuid: string) => {
    const drop = (items: FeedPostDto[]) => items.filter((post) => post.postUuid !== postUuid);
    setFeeds((prev) => ({
      recommendations: { ...prev.recommendations, items: drop(prev.recommendations.items) },
      subscriptions: { ...prev.subscriptions, items: drop(prev.subscriptions.items) },
    }));
    setSearchPosts((prev) => drop(prev));
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

  /** §User Controls (FIRA-F): «Не интересно» — оптимистичное скрытие + негативный сигнал. */
  const handleNotInterested = useCallback(
    async (postUuid: string) => {
      removePostFromFeeds(postUuid);
      feedCacheForKind("recommendations").invalidate();
      try {
        await apiMarkPostNotInterested(postUuid);
      } catch (e) {
        const message =
          e instanceof ApiRequestError ? e.message : e instanceof Error ? e.message : "Не удалось отметить пост";
        window.alert(message);
      }
    },
    [removePostFromFeeds],
  );

  /** «Скрыть автора» (пользователь) / «Скрыть сообщество»: убирает из рекомендаций. */
  const handleHideFeedSource = useCallback(
    async (post: FeedPostDto) => {
      const isCommunity = Boolean(post.communityId);
      const keep = (p: FeedPostDto) =>
        isCommunity ? p.communityId !== post.communityId : p.authorUsername !== post.authorUsername;
      // Подписки не фильтруются скрытием автора (пользователь подписан явно).
      setFeeds((prev) => ({
        ...prev,
        recommendations: {
          ...prev.recommendations,
          items: prev.recommendations.items.filter(keep),
        },
      }));
      setSearchPosts((prev) => prev.filter(keep));
      feedCacheForKind("recommendations").invalidate();
      try {
        if (isCommunity && post.communityId) {
          await apiDismissCommunity(post.communityId);
        } else if (post.authorUserUuid) {
          await apiHideFeedAuthor(post.authorUserUuid);
        }
      } catch (e) {
        const message =
          e instanceof ApiRequestError ? e.message : e instanceof Error ? e.message : "Не удалось скрыть источник";
        window.alert(message);
      }
    },
    [],
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
    setSearchPosts((prev) => bump(prev));
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
      setSearchPosts((prev) => patch(prev));
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
    setSearchPosts((prev) => patch(prev));
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
    isLeavingCompact: feedLeavingCompact,
  } = useFeedCompactHeader(feedScrollRef, feedTopBlockRef, {
    base: styles.feedTopBlock,
    compact: styles.feedTopBlockCompact,
    compactAnimate: styles.feedTopBlockCompactAnimate,
    noTransition: styles.feedTopBlockNoTransition,
    leaving: styles.feedTopBlockLeavingCompact,
  });

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

  const loadFeedSearch = useCallback(async (query: string) => {
    const q = query.trim();
    if (!q) {
      setSearchPosts([]);
      setSearchError(null);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    setSearchError(null);
    try {
      const items = await apiSearchFeed(q, 30, 0);
      setSearchPosts(items);
      setSearchError(null);
      setAppliedSearchQuery(q);
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : "Не удалось выполнить поиск");
      setSearchPosts([]);
      setAppliedSearchQuery(q);
    } finally {
      setSearchLoading(false);
    }
  }, []);

  useEffect(() => {
    const q = searchValue.trim();
    if (!q) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        setSearchLoading(true);
        try {
          const items = await apiSearchFeed(q, 30, 0);
          if (cancelled) return;
          setSearchPosts(items);
          setSearchError(null);
          setAppliedSearchQuery(q);
        } catch (e) {
          if (cancelled) return;
          setSearchError(e instanceof Error ? e.message : "Не удалось выполнить поиск");
          setSearchPosts([]);
          setAppliedSearchQuery(q);
        } finally {
          if (!cancelled) setSearchLoading(false);
        }
      })();
    }, 280);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [searchValue]);

  useEffect(() => {
    if (!tabRestoreReady) return;
    void loadFeedTab("recommendations");
    void loadFeedTab("subscriptions");
  }, [tabRestoreReady, loadFeedTab]);

  useLayoutEffect(() => {
    if (!feedLeavingCompact) return;

    const row = peopleTabsRef.current;
    const block = feedTopBlockRef.current;
    const searchWrap = block?.querySelector<HTMLElement>(`.${styles.peopleSearchWrap}`) ?? null;

    const restartAnimClass = (el: HTMLElement | null, className: string) => {
      if (!el) return;
      el.classList.remove(className);
      el.style.animation = "none";
      requestAnimationFrame(() => {
        el.style.animation = "";
        el.classList.add(className);
      });
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
      /* rAF instead of void offsetHeight — avoid forced reflow in leave-compact path. */
      requestAnimationFrame(() => {
        if (cancelled) return;
        ind.style.transform = `translate3d(${fromLeft}px, 0, 0)`;
        ind.style.opacity = "1";
        requestAnimationFrame(() => {
          if (cancelled) return;
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
        });
      });
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
      if (searchValue.trim().length >= 1) {
        await loadFeedSearch(searchValue);
      } else {
        await loadFeedTab(activeTab, { refresh: true });
      }
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
          if (searchValueRef.current.trim().length >= 1) return;
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
    const savedTab = window.localStorage.getItem(FEED_TAB_STORAGE_KEY);
    if (savedTab === "recommendations" || savedTab === "subscriptions") {
      setActiveTab(savedTab);
    }
    setTabRestoreReady(true);
  }, []);

  useEffect(() => {
    if (!tabRestoreReady) return;
    window.localStorage.setItem(FEED_TAB_STORAGE_KEY, activeTab);
  }, [activeTab, tabRestoreReady]);

  const slot = feeds[activeTab];
  const searchPending = hasSearch && searchValue.trim() !== appliedSearchQuery;
  const visiblePosts = hasSearch ? searchPosts : slot.items;
  const listError = hasSearch ? searchError : slot.error;
  const listLoading = hasSearch
    ? (searchPending || searchLoading) && searchPosts.length === 0
    : slot.loading && slot.items.length === 0;

  usePreloadFeedPostComments(visiblePosts);

  const emptyHint = hasSearch
    ? "Ничего не найдено. Измените запрос в поиске."
    : activeTab === "subscriptions"
      ? "Пока нет постов в подписках. Подпишитесь на людей во вкладке «Люди» или загляните в «Рекомендации»."
      : "Пока нет постов. Создайте первый во вкладке «Создать пост».";

  const onToggleComments = useCallback((postUuid: string) => {
    setCommentsOpenPostUuid((id) => (id === postUuid ? null : postUuid));
  }, []);

  const onCommentAdded = useCallback(
    (postUuid: string) => {
      bumpPostCommentsCount(postUuid, 1);
    },
    [bumpPostCommentsCount],
  );

  return (
    <section ref={feedScrollRef} className={styles.feedPage} id="central-scroll-feed">
      {/* Классы top-block — только classList в useFeedCompactHeader (React className затирал бы compact). */}
      <div ref={feedTopBlockRef}>
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
              <div ref={peopleTabsRef} className={styles.peopleTabs}>
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
              disabled={(hasSearch ? searchPending || searchLoading : slot.loading) || isRefreshing}
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
      {hasNewPosts && !hasSearch && activeTab === "recommendations" && (
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
              {listError ? (
                <p className={`${styles.feedStatusLine} ${styles.feedStatusLineError}`} role="alert">
                  {listError}{" "}
                  <button
                    type="button"
                    className={styles.feedRetryBtn}
                    onClick={() =>
                      hasSearch ? void loadFeedSearch(searchValue) : void loadFeedTab(activeTab)
                    }
                  >
                    Повторить
                  </button>
                </p>
              ) : null}
              {listLoading ? (
                <p className={emptyHintStyles.hint}>Загрузка ленты…</p>
              ) : null}
              {!listLoading && !listError && visiblePosts.length === 0 ? (
                <p className={emptyHintStyles.hint}>{emptyHint}</p>
              ) : null}
              <FeedPagePosts
                posts={visiblePosts}
                currentUsername={me?.username ?? ""}
                commentsOpenPostUuid={commentsOpenPostUuid}
                snapshotFor={snapshotFor}
                viewsCountFor={viewsCountFor}
                getPostItemRef={getPostItemRef}
                isLikePending={isLikePending}
                isRepostPending={isRepostPending}
                onToggleLike={toggleLike}
                onToggleRepost={toggleRepost}
                onToggleComments={onToggleComments}
                onDeletePost={handleDeletePost}
                onNotInterested={handleNotInterested}
                onHideAuthor={handleHideFeedSource}
                onCommentAdded={onCommentAdded}
              />

              {/* Спиннер «загружаем ещё» + sentinel для IntersectionObserver */}
              {slot.loadingMore && !hasSearch && (
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
