"use client";

import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { TabSearchInput } from "@/app/_shared/TabSearchInput";
import {
  applyCountDelta,
  reconcilePendingCommunityJoin,
  type PendingCommunityOp,
  withCountDelta,
} from "@/app/_shared/deferredSubscriptionSync";
import { useProtectedPage } from "@/app/_dashboard/useProtectedPage";
import emptyHintStyles from "@/app/_shared/emptyPageHint.module.css";
import { COMMUNITIES, communityHref, type CommunityRecord, type CommunityTab } from "@/app/(dashboard)/communities/communitiesSeed";
import {
  communityListItemToRecord,
  isCommunityUuid,
  profileCommunityToRecord,
} from "@/app/(dashboard)/communities/communityProfile";
import { CreateCommunityModal, type CreatedCommunity } from "./CreateCommunityModal";
import { useAnimatedModal } from "./useAnimatedModal";
import { apiGetMe, isDevLocalOfflineSession } from "@/lib/auth";
import { communitiesBundleCache, type CommunitiesPreloadBundle } from "@/lib/dashboardPreload";
import {
  apiGetRecommendedCommunities,
  apiJoinCommunity,
  apiLeaveCommunity,
  apiListOwnedCommunities,
  apiListProfileCommunities,
  apiListPublicCommunities,
  apiSearchCommunities,
  communitySearchTab,
} from "@/lib/socialApi";
import { ApiRequestError } from "@/lib/auth";
import { notifyOwnedCommunitiesChanged, OWNED_COMMUNITIES_CHANGED_EVENT } from "./ownedCommunitiesEvents";
import styles from "./communities.module.css";

function ownedCommunityToRecord(item: CreatedCommunity): CommunityRecord {
  return communityListItemToRecord(item, "owned");
}

type CommunitiesTabIndicatorStyle = CSSProperties &
  Record<"--communities-tab-indicator-left" | "--communities-tab-indicator-width", string>;

/** Синхронно с `--flora-duration-6` (как MUSIC_TAB_TRANSITION_CLEAR_MS). */
const COMMUNITIES_PANEL_TRANSITION_CLEAR_MS = 950;

type CommunitiesPanelTransition = null | "fromLeft" | "fromRight";

function communityTabIndex(tab: CommunityTab): number {
  if (tab === "recommendations") return 0;
  if (tab === "subscriptions") return 1;
  return 2;
}

function communityForDisplay(community: CommunityRecord, memberDeltas: Record<string, number>): CommunityRecord {
  const delta = memberDeltas[community.id] ?? 0;
  if (delta === 0) return community;
  return { ...community, members: withCountDelta(community.members, delta) };
}

function upsertCommunity(list: CommunityRecord[], item: CommunityRecord): CommunityRecord[] {
  return [item, ...list.filter((c) => c.id !== item.id)];
}

function removeCommunity(list: CommunityRecord[], communityId: string): CommunityRecord[] {
  return list.filter((c) => c.id !== communityId);
}

export default function CommunitiesPage() {
  const { isClient, hasToken } = useProtectedPage();
  const createCommunityModal = useAnimatedModal();
  const [searchValue, setSearchValue] = useState("");
  const [activeTab, setActiveTab] = useState<CommunityTab>("recommendations");
  const [ownedFromApi, setOwnedFromApi] = useState<CommunityRecord[]>([]);
  const [recommendationsFromApi, setRecommendationsFromApi] = useState<CommunityRecord[]>([]);
  const [subscriptionsFromApi, setSubscriptionsFromApi] = useState<CommunityRecord[]>([]);
  const [joinedCommunityIds, setJoinedCommunityIds] = useState<Set<string>>(() => new Set());
  const [memberDeltas, setMemberDeltas] = useState<Record<string, number>>({});
  const [joinError, setJoinError] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<CommunityRecord[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const serverMemberIdsRef = useRef<Set<string>>(new Set());
  const pendingCommunityOpsRef = useRef<Map<string, PendingCommunityOp>>(new Map());

  const recommendationsTabRef = useRef<HTMLButtonElement>(null);
  const subscriptionsTabRef = useRef<HTMLButtonElement>(null);
  const ownedTabRef = useRef<HTMLButtonElement>(null);
  const communitiesTabsRowRef = useRef<HTMLDivElement>(null);
  const [indicatorVars, setIndicatorVars] = useState<CommunitiesTabIndicatorStyle>({
    "--communities-tab-indicator-left": "0px",
    "--communities-tab-indicator-width": "0px",
  });
  const [indicatorMotionEnabled, setIndicatorMotionEnabled] = useState(false);
  const indicatorMotionPrimedRef = useRef(false);
  const [panelTransition, setPanelTransition] = useState<CommunitiesPanelTransition>(null);
  const [panelAnimEpoch, setPanelAnimEpoch] = useState(0);
  const panelTransitionClearRef = useRef<number | null>(null);

  const hasSearch = searchValue.trim().length >= 1;

  const memberCommunityIds = useMemo(() => {
    const ids = new Set<string>();
    for (const c of ownedFromApi) ids.add(c.id);
    for (const c of subscriptionsFromApi) ids.add(c.id);
    for (const id of joinedCommunityIds) ids.add(id);
    return ids;
  }, [joinedCommunityIds, ownedFromApi, subscriptionsFromApi]);

  const applyCommunitiesBundle = useCallback((bundle: CommunitiesPreloadBundle) => {
    const ownedRecords = bundle.ownedList.map((item) => communityListItemToRecord(item, "owned"));
    setOwnedFromApi(ownedRecords);

    if (isDevLocalOfflineSession()) {
      setRecommendationsFromApi([]);
      setSubscriptionsFromApi([]);
      return;
    }

    const publicBySlug = new Map(bundle.publicList.map((c) => [c.slug, c]));
    const subscribedRecords = bundle.subscribedList.map((item) =>
      profileCommunityToRecord(item, publicBySlug, "subscriptions"),
    );

    setSubscriptionsFromApi(subscribedRecords);
    setRecommendationsFromApi(
      bundle.recommendedList.map((item) => communityListItemToRecord(item, "recommendations")),
    );

    serverMemberIdsRef.current = new Set([
      ...ownedRecords.map((c) => c.id),
      ...subscribedRecords.map((c) => c.id),
    ]);
    setJoinedCommunityIds(new Set(serverMemberIdsRef.current));
  }, []);

  const loadCommunities = useCallback(async () => {
    try {
      const bundle = await communitiesBundleCache.get();
      communitiesBundleCache.set(bundle);
      applyCommunitiesBundle(bundle);
    } catch {
      /* список подтянется после создания или при следующем заходе */
    }
  }, [applyCommunitiesBundle]);

  const refreshCommunitiesTab = useCallback(
    async (tab: CommunityTab) => {
      if (isDevLocalOfflineSession()) return;
      try {
        if (tab === "owned") {
          const ownedList = await apiListOwnedCommunities();
          const ownedRecords = ownedList.map((item) => communityListItemToRecord(item, "owned"));
          setOwnedFromApi(ownedRecords);
          for (const c of ownedRecords) serverMemberIdsRef.current.add(c.id);
          return;
        }
        if (tab === "subscriptions") {
          const me = await apiGetMe().catch(() => null);
          const publicList = await apiListPublicCommunities();
          const publicBySlug = new Map(publicList.map((c) => [c.slug, c]));
          const subscribedList = me?.username
            ? await apiListProfileCommunities(me.username).catch(() => [])
            : [];
          const subscribedRecords = subscribedList.map((item) =>
            profileCommunityToRecord(item, publicBySlug, "subscriptions"),
          );
          setSubscriptionsFromApi(subscribedRecords);
          setMemberDeltas((prev) => {
            const next = { ...prev };
            for (const c of subscribedRecords) delete next[c.id];
            return next;
          });
          for (const c of subscribedRecords) serverMemberIdsRef.current.add(c.id);
          return;
        }
        const recommendedList = await apiGetRecommendedCommunities();
        const rows = recommendedList.map((item) => communityListItemToRecord(item, "recommendations"));
        setRecommendationsFromApi(rows);
        setMemberDeltas((prev) => {
          const next = { ...prev };
          for (const c of rows) delete next[c.id];
          return next;
        });
      } catch {
        /* оставляем локальный кэш */
      }
    },
    [],
  );

  const flushPendingCommunityOps = useCallback(async () => {
    const ops = new Map(pendingCommunityOpsRef.current);
    if (ops.size === 0) return;
    pendingCommunityOpsRef.current.clear();

    const failures: string[] = [];
    for (const [communityId, op] of ops) {
      try {
        if (op === "join") {
          await apiJoinCommunity(communityId);
          serverMemberIdsRef.current.add(communityId);
        } else {
          await apiLeaveCommunity(communityId);
          serverMemberIdsRef.current.delete(communityId);
        }
      } catch (e) {
        failures.push(
          e instanceof ApiRequestError || e instanceof Error
            ? e.message
            : "Не удалось изменить подписку на сообщество.",
        );
        reconcilePendingCommunityJoin(
          pendingCommunityOpsRef.current,
          communityId,
          op === "join",
          serverMemberIdsRef.current.has(communityId),
        );
      }
    }
    if (failures.length > 0) setJoinError(failures[0]!);
    else communitiesBundleCache.invalidate();
  }, []);

  const syncCommunitiesContextOnLeave = useCallback(
    async (ctx: { kind: "tab"; tab: CommunityTab } | { kind: "search" }) => {
      await flushPendingCommunityOps();
      if (ctx.kind === "tab") await refreshCommunitiesTab(ctx.tab);
      else if (searchValue.trim().length >= 1) {
        try {
          const rows = await apiSearchCommunities(searchValue.trim(), 0, 40);
          const mapped = rows.map((item) => communityListItemToRecord(item, communitySearchTab(item.role)));
          setSearchResults(mapped);
          setMemberDeltas((prev) => {
            const next = { ...prev };
            for (const c of mapped) delete next[c.id];
            return next;
          });
        } catch {
          /* оставляем локальный список поиска */
        }
      }
    },
    [flushPendingCommunityOps, refreshCommunitiesTab, searchValue],
  );

  useEffect(() => {
    if (!isClient || !hasToken) return;
    const cached = communitiesBundleCache.peek();
    if (cached) applyCommunitiesBundle(cached);
    void loadCommunities();
  }, [applyCommunitiesBundle, isClient, hasToken, loadCommunities]);

  useEffect(() => {
    if (!isClient || !hasToken) return;
    const onChanged = () => void loadCommunities();
    window.addEventListener(OWNED_COMMUNITIES_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(OWNED_COMMUNITIES_CHANGED_EVENT, onChanged);
  }, [isClient, hasToken, loadCommunities]);

  useEffect(() => {
    if (!isClient || !hasToken || !hasSearch) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }

    const q = searchValue.trim();
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        setSearchLoading(true);
        try {
          const rows = await apiSearchCommunities(q, 0, 40);
          if (cancelled) return;
          setSearchResults(
            rows.map((item) => communityListItemToRecord(item, communitySearchTab(item.role))),
          );
        } catch {
          if (!cancelled) setSearchResults([]);
        } finally {
          if (!cancelled) setSearchLoading(false);
        }
      })();
    }, 280);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [hasSearch, hasToken, isClient, searchValue]);

  const applyPanelTransition = useCallback((prevIdx: number, nextIdx: number) => {
    if (panelTransitionClearRef.current !== null) {
      window.clearTimeout(panelTransitionClearRef.current);
      panelTransitionClearRef.current = null;
    }

    const reduced =
      typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (!reduced && prevIdx !== nextIdx) {
      setPanelAnimEpoch((epoch) => epoch + 1);
      setPanelTransition(nextIdx > prevIdx ? "fromRight" : "fromLeft");
      panelTransitionClearRef.current = window.setTimeout(() => {
        setPanelTransition(null);
        panelTransitionClearRef.current = null;
      }, COMMUNITIES_PANEL_TRANSITION_CLEAR_MS);
    } else {
      setPanelTransition(null);
    }
  }, []);

  useEffect(() => {
    if (hasSearch) {
      indicatorMotionPrimedRef.current = false;
      setIndicatorMotionEnabled(false);
    }
  }, [hasSearch]);

  useEffect(() => {
    if (hasSearch) return;

    const syncIndicator = () => {
      const row = communitiesTabsRowRef.current;
      const target =
        activeTab === "recommendations"
          ? recommendationsTabRef.current
          : activeTab === "subscriptions"
            ? subscriptionsTabRef.current
            : ownedTabRef.current;
      if (!row || !target) return;
      const rowRect = row.getBoundingClientRect();
      const tabRect = target.getBoundingClientRect();
      const left = tabRect.left - rowRect.left;
      const tabW = tabRect.width;
      if (tabW <= 0) return;
      setIndicatorVars({
        "--communities-tab-indicator-left": `${left}px`,
        "--communities-tab-indicator-width": `${tabW}px`,
      });
      if (!indicatorMotionPrimedRef.current) {
        indicatorMotionPrimedRef.current = true;
        requestAnimationFrame(() => setIndicatorMotionEnabled(true));
      }
    };

    syncIndicator();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(syncIndicator) : null;
    if (ro && communitiesTabsRowRef.current) ro.observe(communitiesTabsRowRef.current);
    window.addEventListener("resize", syncIndicator);
    return () => {
      window.removeEventListener("resize", syncIndicator);
      ro?.disconnect();
    };
  }, [activeTab, hasSearch]);

  useEffect(
    () => () => {
      if (panelTransitionClearRef.current !== null) {
        window.clearTimeout(panelTransitionClearRef.current);
      }
    },
    [],
  );

  const switchCommunitiesTab = useCallback(
    (next: CommunityTab) => {
      if (next === activeTab) return;
      const prev = activeTab;
      void syncCommunitiesContextOnLeave({ kind: "tab", tab: prev });
      applyPanelTransition(communityTabIndex(prev), communityTabIndex(next));
      setActiveTab(next);
    },
    [activeTab, applyPanelTransition, syncCommunitiesContextOnLeave],
  );

  const handleSearchChange = useCallback(
    (value: string) => {
      const wasSearch = searchValue.trim().length >= 1;
      const willSearch = value.trim().length >= 1;
      if (wasSearch && !willSearch) void syncCommunitiesContextOnLeave({ kind: "search" });
      if (!wasSearch && willSearch) void syncCommunitiesContextOnLeave({ kind: "tab", tab: activeTab });
      setSearchValue(value);
    },
    [activeTab, searchValue, syncCommunitiesContextOnLeave],
  );

  const onJoinCommunity = useCallback(
    (community: CommunityRecord) => {
      if (community.tab === "owned" || memberCommunityIds.has(community.id)) return;
      if (!isCommunityUuid(community.id)) {
        setJoinError("Не удалось подписаться: сообщество не синхронизировано с сервером.");
        return;
      }
      setJoinError(null);

      const subscriptionRecord: CommunityRecord = {
        ...community,
        tab: "subscriptions",
      };

      setMemberDeltas((prev) => applyCountDelta(prev, community.id, 1));
      setJoinedCommunityIds((prev) => new Set(prev).add(community.id));
      setSubscriptionsFromApi((prev) => upsertCommunity(prev, subscriptionRecord));

      reconcilePendingCommunityJoin(
        pendingCommunityOpsRef.current,
        community.id,
        true,
        serverMemberIdsRef.current.has(community.id),
      );
    },
    [memberCommunityIds],
  );

  const onLeaveCommunity = useCallback(
    (community: CommunityRecord) => {
      if (community.tab === "owned" || !memberCommunityIds.has(community.id)) return;
      if (!isCommunityUuid(community.id)) return;
      setJoinError(null);

      setMemberDeltas((prev) => applyCountDelta(prev, community.id, -1));
      setJoinedCommunityIds((prev) => {
        const next = new Set(prev);
        next.delete(community.id);
        return next;
      });

      if (activeTab !== "subscriptions") {
        setSubscriptionsFromApi((prev) => removeCommunity(prev, community.id));
      }

      reconcilePendingCommunityJoin(
        pendingCommunityOpsRef.current,
        community.id,
        false,
        serverMemberIdsRef.current.has(community.id),
      );
    },
    [activeTab, memberCommunityIds],
  );

  const renderCommunityJoinButton = (community: CommunityRecord) => {
    if (community.tab === "owned" || !isCommunityUuid(community.id)) return null;
    if (memberCommunityIds.has(community.id)) {
      if (activeTab === "subscriptions" || community.tab === "subscriptions" || hasSearch) {
        return (
          <button
            className={`${styles.btn} ${styles.btnJoined}`}
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onLeaveCommunity(community);
            }}
          >
            Отписаться
          </button>
        );
      }
      return (
        <span className={`${styles.btn} ${styles.btnJoined}`} aria-label="Вы подписаны">
          Подписка
        </span>
      );
    }
    return (
      <button
        className={styles.btn}
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onJoinCommunity(community);
        }}
      >
        Подписаться
      </button>
    );
  };

  const renderCommunityRow = (community: CommunityRecord) => {
    const display = communityForDisplay(community, memberDeltas);
    return (
      <li key={community.id} className={styles.item}>
        <Link className={styles.rowMainLink} href={communityHref(community)}>
          <div className={styles.userMain}>
            <div className={styles.avatar} aria-hidden>
              {display.name.slice(0, 1)}
            </div>
            <div className={styles.userBody}>
              <span className={styles.userPrimaryLine}>
                <span className={styles.displayName}>{display.name}</span>
              </span>
              <span className={styles.userSecondaryLine}>
                <strong className={styles.followersCountValue}>{display.members.toLocaleString("ru-RU")}</strong>
                <span>участников</span>
              </span>
            </div>
          </div>
        </Link>
        {renderCommunityJoinButton(community)}
      </li>
    );
  };

  const onCommunityCreated = useCallback(
    (community: CreatedCommunity) => {
      communitiesBundleCache.invalidate();
      const record = ownedCommunityToRecord(community);
      notifyOwnedCommunitiesChanged();
      setOwnedFromApi((prev) => [record, ...prev.filter((c) => c.id !== record.id)]);
      setRecommendationsFromApi((prev) => prev.filter((c) => c.id !== record.id && c.slug !== record.slug));
      switchCommunitiesTab("owned");
    },
    [switchCommunitiesTab],
  );

  const visibleRows = useMemo(() => {
    if (hasSearch) return searchResults;
    if (activeTab === "owned") return ownedFromApi;
    if (activeTab === "subscriptions") return subscriptionsFromApi;
    if (isDevLocalOfflineSession()) {
      const ownedIds = new Set(ownedFromApi.map((c) => c.id));
      return COMMUNITIES.filter((c) => !ownedIds.has(c.id) && c.tab === "recommendations");
    }
    return recommendationsFromApi;
  }, [activeTab, hasSearch, ownedFromApi, recommendationsFromApi, searchResults, subscriptionsFromApi]);

  useEffect(
    () => () => {
      void flushPendingCommunityOps();
    },
    [flushPendingCommunityOps],
  );

  if (!isClient || !hasToken) return <div className={styles.page} />;

  const communitiesEmptyHint = (() => {
    if (hasSearch) return searchLoading ? "Загрузка…" : "Ничего не найдено. Измените запрос в поиске.";
    if (activeTab === "owned") {
      return "Пока нет своих сообществ. Нажмите «Создать сообщество» в шапке или кнопку ниже.";
    }
    if (activeTab === "subscriptions") {
      return "Пока нет подписок на сообщества. Найдите интересные во вкладке «Рекомендации».";
    }
    return "Пока нет рекомендаций. Загляните позже или создайте своё во вкладке «Ваши сообщества».";
  })();

  return (
      <section className={styles.page}>
        <div className={styles.communitiesScroll} id="central-scroll-communities">
          <div className={styles.communitiesTopBlock}>
            <div className={styles.communitiesTopInner}>
              <div className={styles.communitiesSearchHeader}>
                <TabSearchInput
                  placeholder="Поиск по названию или ссылке"
                  value={searchValue}
                  onChange={handleSearchChange}
                  classNames={{
                    wrap: styles.communitiesSearchWrap,
                    box: styles.communitiesSearchBox,
                    icon: styles.communitiesSearchIcon,
                    input: styles.communitiesSearchInput,
                    actionButton: styles.communitiesSearchSendBtn,
                    actionButtonShown: styles.communitiesSearchSendBtnShown,
                    actionButtonHidden: styles.communitiesSearchSendBtnHidden
                  }}
                />
              </div>

              {!hasSearch ? (
                <div className={styles.communitiesFiltersBlock}>
                  <div className={styles.communitiesTabsWrap}>
                    <div ref={communitiesTabsRowRef} className={styles.communitiesTabs}>
                      <button
                        ref={recommendationsTabRef}
                        type="button"
                        className={`${styles.communitiesTab} flora-type-15 ${activeTab === "recommendations" ? styles.communitiesTabActive : ""}`}
                        onClick={() => switchCommunitiesTab("recommendations")}
                      >
                        <span className={styles.communitiesTabLabel}>Рекомендации</span>
                      </button>
                      <button
                        ref={subscriptionsTabRef}
                        type="button"
                        className={`${styles.communitiesTab} flora-type-15 ${activeTab === "subscriptions" ? styles.communitiesTabActive : ""}`}
                        onClick={() => switchCommunitiesTab("subscriptions")}
                      >
                        <span className={styles.communitiesTabLabel}>Подписки</span>
                      </button>
                      <button
                        ref={ownedTabRef}
                        type="button"
                        className={`${styles.communitiesTab} flora-type-15 ${activeTab === "owned" ? styles.communitiesTabActive : ""}`}
                        onClick={() => switchCommunitiesTab("owned")}
                      >
                        <span className={styles.communitiesTabLabel}>Ваши сообщества</span>
                      </button>
                    </div>
                    <div
                      className={`${styles.communitiesTabIndicator} ${!indicatorMotionEnabled ? styles.communitiesTabIndicatorStatic : ""}`}
                      style={indicatorVars}
                      aria-hidden
                    />
                  </div>
                  <button type="button" className={styles.communitiesCreateBtn} onClick={createCommunityModal.openModal}>
                    Создать сообщество
                  </button>
                </div>
              ) : null}
            </div>
          </div>

          {hasSearch ? (
            visibleRows.length > 0 ? (
              <ul className={styles.list}>{visibleRows.map((c) => renderCommunityRow(c))}</ul>
            ) : (
              <p className={emptyHintStyles.hint}>{communitiesEmptyHint}</p>
            )
          ) : (
            <div className={styles.communitiesListSection}>
              <div
                key={`${activeTab}-${panelAnimEpoch}`}
                className={`${styles.communitiesListContent} ${
                  panelTransition === "fromLeft"
                    ? styles.communitiesListContentFromLeft
                    : panelTransition === "fromRight"
                      ? styles.communitiesListContentFromRight
                      : ""
                }`}
              >
                {joinError ? (
                  <p className={styles.formFeedbackError} role="alert">
                    {joinError}
                  </p>
                ) : null}
                {visibleRows.length > 0 ? (
                  <ul className={styles.list}>{visibleRows.map((c) => renderCommunityRow(c))}</ul>
                ) : activeTab === "owned" ? (
                  <div className={styles.ownedEmptyState}>
                    <p className={emptyHintStyles.hint}>
                      Пока нет своих сообществ. Нажмите «Создать сообщество» в шапке или кнопку ниже.
                    </p>
                    <button type="button" className={styles.ownedEmptyCreateBtn} onClick={createCommunityModal.openModal}>
                      Создать сообщество
                    </button>
                  </div>
                ) : (
                  <p className={emptyHintStyles.hint}>{communitiesEmptyHint}</p>
                )}
              </div>
            </div>
          )}
        </div>

        <CreateCommunityModal
          open={createCommunityModal.open}
          closing={createCommunityModal.closing}
          onClose={createCommunityModal.closeModal}
          onCreated={onCommunityCreated}
        />
      </section>
  );
}
