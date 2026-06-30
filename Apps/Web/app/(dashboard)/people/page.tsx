"use client";

import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import emptyHintStyles from "@/app/_shared/emptyPageHint.module.css";
import {
  applyCountDelta,
  reconcilePendingFollow,
  type PendingFollowOp,
  withCountDelta,
} from "@/app/_shared/deferredSubscriptionSync";
import { TabSearchInput } from "@/app/_shared/TabSearchInput";
import { useProtectedPage } from "@/app/_dashboard/useProtectedPage";
import { apiGetMe } from "@/lib/auth";
import {
  invalidatePeopleCaches,
  peopleFollowersCache,
  peopleFollowingCache,
  peopleRecommendedCache,
} from "@/lib/dashboardPreload";
import {
  apiFollowUser,
  apiGetProfileFollowers,
  apiGetProfileFollowing,
  apiGetRecommendedUsers,
  apiSearchUsers,
  apiUnfollowUser,
} from "@/lib/socialApi";
import { PeopleListRow } from "./PeopleListRow";
import styles from "./people.module.css";

type Person = {
  id: string;
  displayName: string;
  username: string;
  followers: number;
  avatarUuid?: string | null;
};

type PeopleTab = 0 | 1 | 2;

type TabCache = Record<PeopleTab, Person[] | null>;

const EMPTY_TAB_CACHE: TabCache = { 0: null, 1: null, 2: null };

function initialPeopleTabCache(): TabCache {
  const recommended = peopleRecommendedCache.peek();
  if (!recommended) return EMPTY_TAB_CACHE;
  return {
    0: recommended.map((row) => toPerson(row)),
    1: null,
    2: null,
  };
}

/** Синхронно с `--flora-duration-6` (как MUSIC_TAB_TRANSITION_CLEAR_MS). */
const PEOPLE_PANEL_TRANSITION_CLEAR_MS = 950;

type PeoplePanelTransition = null | "fromLeft" | "fromRight";

type PeopleTabIndicatorStyle = CSSProperties &
  Record<"--people-tab-indicator-left" | "--people-tab-indicator-width", string>;

function toPerson(row: {
  username: string;
  displayName: string;
  followerCount?: number;
  avatarUuid?: string | null;
}): Person {
  const username = row.username.startsWith("@") ? row.username : `@${row.username}`;
  const id = row.username.replace(/^@+/, "");
  return {
    id,
    displayName: row.displayName,
    username,
    followers: row.followerCount ?? 0,
    avatarUuid: row.avatarUuid ?? null,
  };
}

function personForDisplay(person: Person, followerDeltas: Record<string, number>): Person {
  const delta = followerDeltas[person.id] ?? 0;
  if (delta === 0) return person;
  return { ...person, followers: withCountDelta(person.followers, delta) };
}

function upsertPerson(list: Person[], person: Person): Person[] {
  const without = list.filter((p) => p.id !== person.id);
  return [person, ...without];
}

function removePerson(list: Person[], userId: string): Person[] {
  return list.filter((p) => p.id !== userId);
}

export default function PeoplePage() {
  const { isClient, hasToken } = useProtectedPage();
  const [searchValue, setSearchValue] = useState("");
  const [activeTab, setActiveTab] = useState<PeopleTab>(0);
  const [myUsername, setMyUsername] = useState<string | null>(null);
  const [tabCache, setTabCache] = useState<TabCache>(initialPeopleTabCache);
  const [searchPeople, setSearchPeople] = useState<Person[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [subscribedIds, setSubscribedIds] = useState<Set<string>>(() => new Set());
  const [followerDeltas, setFollowerDeltas] = useState<Record<string, number>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const serverFollowingRef = useRef<Set<string>>(new Set());
  const pendingFollowOpsRef = useRef<Map<string, PendingFollowOp>>(new Map());
  const tabCacheRef = useRef(tabCache);
  const searchPeopleRef = useRef(searchPeople);
  const subscribedIdsRef = useRef(subscribedIds);

  const friendsTabRef = useRef<HTMLButtonElement>(null);
  const followersTabRef = useRef<HTMLButtonElement>(null);
  const subscriptionsTabRef = useRef<HTMLButtonElement>(null);
  const peopleTabsRowRef = useRef<HTMLDivElement>(null);
  const [indicatorVars, setIndicatorVars] = useState<PeopleTabIndicatorStyle>({
    "--people-tab-indicator-left": "0px",
    "--people-tab-indicator-width": "0px",
  });
  const [indicatorMotionEnabled, setIndicatorMotionEnabled] = useState(false);
  const indicatorMotionPrimedRef = useRef(false);
  const [panelTransition, setPanelTransition] = useState<PeoplePanelTransition>(null);
  const [panelAnimEpoch, setPanelAnimEpoch] = useState(0);
  const panelTransitionClearRef = useRef<number | null>(null);
  const [actionAnimEpochByUser, setActionAnimEpochByUser] = useState<Record<string, number>>({});

  const hasSearch = searchValue.trim().length >= 1;

  useEffect(() => {
    tabCacheRef.current = tabCache;
  }, [tabCache]);

  useEffect(() => {
    searchPeopleRef.current = searchPeople;
  }, [searchPeople]);

  useEffect(() => {
    subscribedIdsRef.current = subscribedIds;
  }, [subscribedIds]);

  useEffect(() => {
    const recommended = peopleRecommendedCache.peek();
    if (!recommended) return;
    const following = new Set(
      recommended.filter((row) => row.isFollowing).map((row) => row.username.replace(/^@+/, "")),
    );
    for (const id of following) serverFollowingRef.current.add(id);
    setSubscribedIds((prev) => new Set([...prev, ...following]));
  }, []);

  useEffect(() => {
    if (!hasToken) return;
    let cancelled = false;
    apiGetMe()
      .then((me) => {
        if (!cancelled) setMyUsername(me.username.replace(/^@+/, ""));
      })
      .catch(() => {
        if (!cancelled) setMyUsername(null);
      });
    return () => {
      cancelled = true;
    };
  }, [hasToken]);

  const applyRecommendedRows = useCallback((rows: Awaited<ReturnType<typeof apiGetRecommendedUsers>>) => {
    peopleRecommendedCache.set(rows);
    const following = new Set(rows.filter((r) => r.isFollowing).map((r) => r.username.replace(/^@+/, "")));
    for (const id of following) serverFollowingRef.current.add(id);
    setSubscribedIds((prev) => new Set([...prev, ...following]));
    return rows.map((r) => toPerson(r));
  }, []);

  const loadTabFromApi = useCallback(
    async (tab: PeopleTab, username: string | null): Promise<Person[]> => {
      if (tab === 0) {
        const rows = await peopleRecommendedCache.get();
        return applyRecommendedRows(rows);
      }
      if (!username) return [];
      const normalized = username.replace(/^@+/, "");
      if (tab === 1) {
        const rows = await peopleFollowersCache.get(normalized);
        peopleFollowersCache.set(normalized, rows);
        return rows.map((r) => toPerson(r));
      }
      const rows = await peopleFollowingCache.get(normalized);
      peopleFollowingCache.set(normalized, rows);
      const following = new Set(rows.map((r) => r.username.replace(/^@+/, "")));
      for (const id of following) serverFollowingRef.current.add(id);
      setSubscribedIds((prev) => new Set([...prev, ...following]));
      return rows.map((r) => toPerson(r));
    },
    [applyRecommendedRows],
  );

  const loadSearchFromApi = useCallback(async (query: string): Promise<Person[]> => {
    const rows = await apiSearchUsers(query, 0, 40);
    const following = new Set(rows.filter((r) => r.isFollowing).map((r) => r.username.replace(/^@+/, "")));
    for (const id of following) serverFollowingRef.current.add(id);
    setSubscribedIds((prev) => new Set([...prev, ...following]));
    return rows.map((r) => toPerson(r));
  }, []);

  const ensureTabLoaded = useCallback(
    async (tab: PeopleTab) => {
      if (tabCacheRef.current[tab] !== null) return;

      const normalized = myUsername?.replace(/^@+/, "") ?? "";
      const cachedRows =
        tab === 0
          ? peopleRecommendedCache.peek()
          : tab === 1 && normalized
            ? peopleFollowersCache.peek(normalized)
            : tab === 2 && normalized
              ? peopleFollowingCache.peek(normalized)
              : null;

      if (cachedRows) {
        const people =
          tab === 0
            ? applyRecommendedRows(cachedRows as Awaited<ReturnType<typeof apiGetRecommendedUsers>>)
            : (cachedRows as Awaited<ReturnType<typeof apiGetProfileFollowers>>).map((r) => toPerson(r));
        setTabCache((prev) => ({ ...prev, [tab]: people }));
      } else {
        setLoading(true);
      }

      setLoadError(null);
      try {
        const rows = await loadTabFromApi(tab, myUsername);
        setTabCache((prev) => ({ ...prev, [tab]: rows }));
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : "Не удалось загрузить список");
        if (!cachedRows) {
          setTabCache((prev) => ({ ...prev, [tab]: [] }));
        }
      } finally {
        setLoading(false);
      }
    },
    [applyRecommendedRows, loadTabFromApi, myUsername],
  );

  const refreshTabFromApi = useCallback(
    async (tab: PeopleTab) => {
      try {
        if (tab === 0) {
          peopleRecommendedCache.invalidate();
        } else if (myUsername) {
          const normalized = myUsername.replace(/^@+/, "");
          if (tab === 1) peopleFollowersCache.invalidate(normalized);
          if (tab === 2) peopleFollowingCache.invalidate(normalized);
        }
        const rows = await loadTabFromApi(tab, myUsername);
        setTabCache((prev) => ({ ...prev, [tab]: rows }));
        setFollowerDeltas((prev) => {
          const next = { ...prev };
          for (const person of rows) delete next[person.id];
          return next;
        });
      } catch {
        /* оставляем локальный кэш */
      }
    },
    [loadTabFromApi, myUsername],
  );

  const flushPendingFollows = useCallback(async () => {
    const ops = new Map(pendingFollowOpsRef.current);
    if (ops.size === 0) return;
    pendingFollowOpsRef.current.clear();

    const failures: string[] = [];
    for (const [userId, op] of ops) {
      const username = userId.replace(/^@+/, "");
      try {
        if (op === "follow") {
          await apiFollowUser(username);
          serverFollowingRef.current.add(userId);
        } else {
          await apiUnfollowUser(username);
          serverFollowingRef.current.delete(userId);
        }
      } catch (e) {
        failures.push(e instanceof Error ? e.message : "Не удалось изменить подписку");
        reconcilePendingFollow(
          pendingFollowOpsRef.current,
          userId,
          op === "follow",
          serverFollowingRef.current.has(userId),
        );
      }
    }
    if (failures.length > 0) setLoadError(failures[0]!);
    else invalidatePeopleCaches(myUsername ?? undefined);
  }, [myUsername]);

  const syncContextOnLeave = useCallback(
    async (ctx: { kind: "tab"; tab: PeopleTab } | { kind: "search" }) => {
      await flushPendingFollows();
      if (ctx.kind === "tab") await refreshTabFromApi(ctx.tab);
      else {
        const q = searchValue.trim();
        if (q.length >= 1) {
          try {
            const rows = await loadSearchFromApi(q);
            setSearchPeople(rows);
            setFollowerDeltas((prev) => {
              const next = { ...prev };
              for (const person of rows) delete next[person.id];
              return next;
            });
          } catch {
            /* оставляем локальный список поиска */
          }
        }
      }
    },
    [flushPendingFollows, loadSearchFromApi, refreshTabFromApi, searchValue],
  );

  useEffect(() => {
    if (!hasToken || hasSearch) return;
    void ensureTabLoaded(activeTab);
  }, [activeTab, ensureTabLoaded, hasSearch, hasToken]);

  useEffect(() => {
    if (!hasToken || !hasSearch) {
      setSearchPeople([]);
      setSearchLoading(false);
      return;
    }

    const q = searchValue.trim();
    let cancelled = false;
    setSearchLoading(true);

    const timer = window.setTimeout(() => {
      void (async () => {
        setLoadError(null);
        try {
          const rows = await loadSearchFromApi(q);
          if (!cancelled) setSearchPeople(rows);
        } catch (e) {
          if (!cancelled) {
            setLoadError(e instanceof Error ? e.message : "Не удалось загрузить список");
            setSearchPeople([]);
          }
        } finally {
          if (!cancelled) setSearchLoading(false);
        }
      })();
    }, 280);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [hasSearch, hasToken, loadSearchFromApi, searchValue]);

  const updateFollowingTabCache = useCallback(
    (person: Person, nowSubscribed: boolean, viewingTab: PeopleTab) => {
      setTabCache((prev) => {
        if (nowSubscribed) {
          const current = prev[2];
          if (current === null) return { ...prev, 2: [person] };
          return { ...prev, 2: upsertPerson(current, person) };
        }
        // На вкладке «Подписки» строка остаётся до ухода с неё; с других вкладок — убираем из кэша подписок.
        if (viewingTab === 2) return prev;
        const current = prev[2];
        if (current === null) return prev;
        return { ...prev, 2: removePerson(current, person.id) };
      });
    },
    [],
  );

  const toggleSubscribe = useCallback(
    (userId: string) => {
      const sourceList = hasSearch ? searchPeopleRef.current : tabCacheRef.current[activeTab] ?? [];
      const person = sourceList.find((p) => p.id === userId);
      if (!person) return;

      const wasSubscribed = subscribedIdsRef.current.has(userId);
      const nowSubscribed = !wasSubscribed;

      setActionAnimEpochByUser((prev) => ({
        ...prev,
        [userId]: (prev[userId] ?? 0) + 1,
      }));

      setSubscribedIds((prev) => {
        const next = new Set(prev);
        if (nowSubscribed) next.add(userId);
        else next.delete(userId);
        return next;
      });

      setFollowerDeltas((prev) => applyCountDelta(prev, userId, nowSubscribed ? 1 : -1));
      updateFollowingTabCache(person, nowSubscribed, activeTab);

      reconcilePendingFollow(
        pendingFollowOpsRef.current,
        userId,
        nowSubscribed,
        serverFollowingRef.current.has(userId),
      );
    },
    [activeTab, hasSearch, updateFollowingTabCache],
  );

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
      }, PEOPLE_PANEL_TRANSITION_CLEAR_MS);
    } else {
      setPanelTransition(null);
    }
  }, []);

  const switchPeopleTab = useCallback(
    (next: PeopleTab) => {
      if (next === activeTab) return;
      const prev = activeTab;
      void syncContextOnLeave({ kind: "tab", tab: prev });
      applyPanelTransition(prev, next);
      setActiveTab(next);
    },
    [activeTab, applyPanelTransition, syncContextOnLeave],
  );

  const handleSearchChange = useCallback(
    (value: string) => {
      const wasSearch = searchValue.trim().length >= 1;
      const willSearch = value.trim().length >= 1;
      if (wasSearch && !willSearch) void syncContextOnLeave({ kind: "search" });
      if (!wasSearch && willSearch) void syncContextOnLeave({ kind: "tab", tab: activeTab });
      setSearchValue(value);
    },
    [activeTab, searchValue, syncContextOnLeave],
  );

  const visibleUsers = useMemo(() => {
    const base = hasSearch ? searchPeople : tabCache[activeTab] ?? [];
    return base.map((user) => personForDisplay(user, followerDeltas));
  }, [activeTab, followerDeltas, hasSearch, searchPeople, tabCache]);

  useEffect(() => {
    if (hasSearch) {
      indicatorMotionPrimedRef.current = false;
      setIndicatorMotionEnabled(false);
    }
  }, [hasSearch]);

  useEffect(() => {
    if (hasSearch) return;

    const syncIndicator = () => {
      const row = peopleTabsRowRef.current;
      const target =
        activeTab === 0 ? friendsTabRef.current : activeTab === 1 ? followersTabRef.current : subscriptionsTabRef.current;
      if (!row || !target) return;
      const rowRect = row.getBoundingClientRect();
      const tabRect = target.getBoundingClientRect();
      const left = tabRect.left - rowRect.left;
      const tabW = tabRect.width;
      if (tabW <= 0) return;
      setIndicatorVars({
        "--people-tab-indicator-left": `${left}px`,
        "--people-tab-indicator-width": `${tabW}px`,
      });
      if (!indicatorMotionPrimedRef.current) {
        indicatorMotionPrimedRef.current = true;
        requestAnimationFrame(() => setIndicatorMotionEnabled(true));
      }
    };

    syncIndicator();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(syncIndicator) : null;
    if (ro && peopleTabsRowRef.current) ro.observe(peopleTabsRowRef.current);
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
      void flushPendingFollows();
    },
    [flushPendingFollows],
  );

  if (!isClient || !hasToken) return <div className={styles.page} />;

  const emptyHint = loading || searchLoading
    ? "Загрузка…"
    : hasSearch
      ? "Ничего не найдено. Измените запрос в поиске."
      : activeTab === 0
        ? "Пока нет рекомендаций. Загляните позже или найдите людей через поиск выше."
        : "Пока никого в списке.";

  return (
    <section className={styles.page}>
      <div className={styles.peopleScroll} id="central-scroll-people">
        <div className={styles.peopleTopBlock}>
          <div className={styles.peopleTopInner}>
            <div className={styles.peopleSearchHeader}>
              <TabSearchInput
                placeholder="Поиск по имени или нику"
                value={searchValue}
                onChange={handleSearchChange}
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
            {!hasSearch ? (
              <div className={styles.peopleFiltersBlock}>
                <div className={styles.peopleTabsWrap}>
                  <div ref={peopleTabsRowRef} className={styles.peopleTabs}>
                    <button
                      ref={friendsTabRef}
                      type="button"
                      className={`${styles.peopleTab} ${activeTab === 0 ? styles.peopleTabActive : ""}`}
                      onClick={() => switchPeopleTab(0)}
                    >
                      <span className={styles.peopleTabLabel}>Рекомендации</span>
                    </button>
                    <button
                      ref={followersTabRef}
                      type="button"
                      className={`${styles.peopleTab} ${activeTab === 1 ? styles.peopleTabActive : ""}`}
                      onClick={() => switchPeopleTab(1)}
                    >
                      <span className={styles.peopleTabLabel}>Подписчики</span>
                    </button>
                    <button
                      ref={subscriptionsTabRef}
                      type="button"
                      className={`${styles.peopleTab} ${activeTab === 2 ? styles.peopleTabActive : ""}`}
                      onClick={() => switchPeopleTab(2)}
                    >
                      <span className={styles.peopleTabLabel}>Подписки</span>
                    </button>
                  </div>
                  <div
                    className={`${styles.peopleTabIndicator} ${!indicatorMotionEnabled ? styles.peopleTabIndicatorStatic : ""}`}
                    style={indicatorVars}
                    aria-hidden
                  />
                </div>
              </div>
            ) : null}
          </div>
        </div>
        {loadError ? <p className={styles.peopleLoadError}>{loadError}</p> : null}
        {hasSearch ? (
          <ul className={styles.list}>
            {visibleUsers.length === 0 ? (
              <li className={`${emptyHintStyles.hint} ${emptyHintStyles.hintInList}`}>{emptyHint}</li>
            ) : (
              visibleUsers.map((user) => (
                <PeopleListRow
                  key={user.id}
                  user={user}
                  isSubscribed={subscribedIds.has(user.id)}
                  actionAnimEpoch={actionAnimEpochByUser[user.id] ?? 0}
                  onToggleSubscribe={() => toggleSubscribe(user.id)}
                />
              ))
            )}
          </ul>
        ) : (
          <div className={styles.peopleListSection}>
            <div
              key={`${activeTab}-${panelAnimEpoch}`}
              className={`${styles.peopleListContent} ${
                panelTransition === "fromLeft"
                  ? styles.peopleListContentFromLeft
                  : panelTransition === "fromRight"
                    ? styles.peopleListContentFromRight
                    : ""
              }`}
            >
              <ul className={styles.list}>
                {visibleUsers.length === 0 ? (
                  <li className={`${emptyHintStyles.hint} ${emptyHintStyles.hintInList}`}>{emptyHint}</li>
                ) : (
                  visibleUsers.map((user) => (
                    <PeopleListRow
                      key={user.id}
                      user={user}
                      isSubscribed={subscribedIds.has(user.id)}
                      actionAnimEpoch={actionAnimEpochByUser[user.id] ?? 0}
                      onToggleSubscribe={() => toggleSubscribe(user.id)}
                    />
                  ))
                )}
              </ul>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
