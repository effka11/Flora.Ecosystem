"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import emptyHintStyles from "@/app/_shared/emptyPageHint.module.css";
import { TabSearchInput } from "@/app/_shared/TabSearchInput";
import { useProtectedPage } from "@/app/_dashboard/useProtectedPage";
import { formatNotificationTimeAgoRu } from "@/lib/formatNotificationTimeAgoRu";
import { invalidateNotificationsCache, notificationsAllCache } from "@/lib/dashboardPreload";
import {
  apiDeleteAllNotifications,
  apiListNotifications,
  apiMarkAllNotificationsRead,
  apiMarkNotificationRead,
  type NotificationDto,
} from "@/lib/notificationsApi";
import { NOTIFICATIONS_CHANGED_EVENT, notifyNotificationsChanged } from "@/lib/realtimeEvents";
import styles from "./notifications.module.css";

const NOTIFICATIONS_TAB_STORAGE_KEY = "flora.notifications.activeTab";

/** Синхронно с `--flora-duration-6` (как MUSIC_TAB_TRANSITION_CLEAR_MS). */
const NOTIFICATIONS_PANEL_TRANSITION_CLEAR_MS = 950;

type NotificationsPanelTransition = null | "fromLeft" | "fromRight";

type NotificationCategory = "social" | "developer";

type NotificationItem = {
  id: string;
  /** like | reply | follow | developer | default */
  type: string;
  category: NotificationCategory;
  text: string;
  timeAgo: string;
  isUnread: boolean;
};

function mapNotificationDto(dto: NotificationDto): NotificationItem {
  return {
    id: dto.notificationUuid,
    type: dto.type || "default",
    category: dto.category,
    text: dto.text,
    timeAgo: formatNotificationTimeAgoRu(dto.createdAt),
    isUnread: !dto.isRead,
  };
}

function filterByTab(items: NotificationItem[], activeTab: number): NotificationItem[] {
  if (activeTab === 1) return items.filter((n) => n.category === "social");
  if (activeTab === 2) return items.filter((n) => n.category === "developer");
  return items;
}

function filterBySearch(items: NotificationItem[], query: string): NotificationItem[] {
  const q = query.trim().toLowerCase();
  if (q.length < 1) return items;
  return items.filter((n) => n.text.toLowerCase().includes(q));
}

export default function NotificationsPage() {
  const { isClient, hasToken } = useProtectedPage();
  const [searchValue, setSearchValue] = useState("");
  const [activeTab, setActiveTab] = useState(0);
  const [notifications, setNotifications] = useState<NotificationItem[]>(() => {
    const cached = notificationsAllCache.peek();
    return cached ? cached.map(mapNotificationDto) : [];
  });
  const [loading, setLoading] = useState(() => notificationsAllCache.peek() === null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [indicatorLeft, setIndicatorLeft] = useState(0);
  const [indicatorWidth, setIndicatorWidth] = useState(0);
  const [indicatorAnimated, setIndicatorAnimated] = useState(false);
  const [tabRestoreReady, setTabRestoreReady] = useState(false);
  const [panelTransition, setPanelTransition] = useState<NotificationsPanelTransition>(null);
  const [panelAnimEpoch, setPanelAnimEpoch] = useState(0);
  const panelTransitionClearRef = useRef<number | null>(null);
  const markAllReadInFlightRef = useRef(false);
  const initialMarkAllDoneRef = useRef(false);

  const tabAllRef = useRef<HTMLButtonElement>(null);
  const tabSocialRef = useRef<HTMLButtonElement>(null);
  const tabDevRef = useRef<HTMLButtonElement>(null);

  const [showClearModal, setShowClearModal] = useState(false);
  const [clearModalClosing, setClearModalClosing] = useState(false);
  const [clearingAll, setClearingAll] = useState(false);

  const hasSearch = searchValue.trim().length >= 1;

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
      }, NOTIFICATIONS_PANEL_TRANSITION_CLEAR_MS);
    } else {
      setPanelTransition(null);
    }
  }, []);

  const visibleItems = useMemo(() => {
    const byTab = filterByTab(notifications, activeTab);
    return filterBySearch(byTab, searchValue);
  }, [notifications, activeTab, searchValue]);

  const syncIndicator = useCallback(() => {
    if (hasSearch) return;
    const refs = [tabAllRef, tabSocialRef, tabDevRef];
    const target = refs[activeTab]?.current;
    if (!target) return;
    setIndicatorLeft(target.offsetLeft);
    setIndicatorWidth(target.offsetWidth);
    if (!indicatorAnimated) {
      requestAnimationFrame(() => setIndicatorAnimated(true));
    }
  }, [activeTab, hasSearch, indicatorAnimated]);

  useEffect(() => {
    if (!isClient || !hasToken || !tabRestoreReady || hasSearch) return;
    syncIndicator();
    window.addEventListener("resize", syncIndicator);
    return () => window.removeEventListener("resize", syncIndicator);
  }, [isClient, hasToken, tabRestoreReady, hasSearch, syncIndicator]);

  useEffect(() => {
    if (!isClient || !hasToken) return;
    queueMicrotask(() => {
      const saved = window.localStorage.getItem(NOTIFICATIONS_TAB_STORAGE_KEY);
      if (saved === "0" || saved === "1" || saved === "2") {
        setActiveTab(Number(saved));
      }
      setTabRestoreReady(true);
    });
  }, [isClient, hasToken]);

  useEffect(() => {
    if (!isClient || !hasToken || !tabRestoreReady) return;
    window.localStorage.setItem(NOTIFICATIONS_TAB_STORAGE_KEY, String(activeTab));
  }, [activeTab, isClient, hasToken, tabRestoreReady]);

  useEffect(
    () => () => {
      if (panelTransitionClearRef.current !== null) {
        window.clearTimeout(panelTransitionClearRef.current);
      }
    },
    [],
  );

  const switchTab = useCallback(
    (next: number) => {
      if (next === activeTab) return;
      applyPanelTransition(activeTab, next);
      setActiveTab(next);
    },
    [activeTab, applyPanelTransition],
  );

  const reloadNotifications = useCallback(async () => {
    if (!hasToken) return;
    setLoadError(null);
    const hasSearchQuery = searchValue.trim().length > 0;
    if (!hasSearchQuery) {
      const cached = notificationsAllCache.peek();
      if (cached) {
        setNotifications(cached.map(mapNotificationDto));
        setLoading(false);
      } else {
        setLoading(true);
      }
    } else {
      setLoading(true);
    }
    try {
      const list = hasSearchQuery
        ? await apiListNotifications({
            category: "all",
            search: searchValue,
            take: 100,
          })
        : await notificationsAllCache.get();
      if (!hasSearchQuery) {
        notificationsAllCache.set(list);
      }
      setNotifications(list.map(mapNotificationDto));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Не удалось загрузить уведомления");
      if (!hasSearchQuery && notificationsAllCache.peek() === null) {
        setNotifications([]);
      }
    } finally {
      setLoading(false);
    }
  }, [hasToken, searchValue]);

  const markAllVisibleAsRead = useCallback(async () => {
    if (markAllReadInFlightRef.current) return;
    markAllReadInFlightRef.current = true;
    try {
      await apiMarkAllNotificationsRead();
      setNotifications((prev) => prev.map((n) => (n.isUnread ? { ...n, isUnread: false } : n)));
      const cached = notificationsAllCache.peek();
      if (cached) {
        notificationsAllCache.set(cached.map((n) => (n.isRead ? n : { ...n, isRead: true })));
      }
      notifyNotificationsChanged();
    } catch {
      /* keep list as-is */
    } finally {
      markAllReadInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!isClient || !hasToken || !tabRestoreReady) return;
    if (!initialMarkAllDoneRef.current) {
      initialMarkAllDoneRef.current = true;
      void (async () => {
        await markAllVisibleAsRead();
        await reloadNotifications();
      })();
      return;
    }
    void reloadNotifications();
  }, [isClient, hasToken, tabRestoreReady, markAllVisibleAsRead, reloadNotifications]);

  useEffect(() => {
    if (!isClient || !hasToken) return;
    const onRealtime = () => {
      invalidateNotificationsCache();
      void reloadNotifications();
    };
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, onRealtime);
    return () => window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, onRealtime);
  }, [isClient, hasToken, reloadNotifications]);

  const markAsRead = useCallback((id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id && n.isUnread ? { ...n, isUnread: false } : n)),
    );
    void apiMarkNotificationRead(id).catch(() => {
      void reloadNotifications();
    });
    notifyNotificationsChanged();
  }, [reloadNotifications]);

  const getEmptyMessage = () => {
    if (hasSearch) return "Ничего не найдено. Измените запрос в поиске.";
    if (activeTab === 1) {
      return "Пока нет социальных уведомлений. Подпишитесь на людей во вкладке «Люди».";
    }
    if (activeTab === 2) {
      return "Пока нет уведомлений от разработчика. Здесь будут новости и обновления Flora.";
    }
    return "Пока нет уведомлений. Здесь появятся лайки, комментарии и другие события.";
  };

  const openClearModal = () => {
    setShowClearModal(true);
  };

  const closeClearModal = async () => {
    if (clearModalClosing || clearingAll) return;
    setClearModalClosing(true);
    await new Promise((r) => window.setTimeout(r, 220));
    setShowClearModal(false);
    setClearModalClosing(false);
  };

  const confirmClearAllNotifications = async () => {
    if (clearingAll) return;
    setClearingAll(true);
    try {
      await apiDeleteAllNotifications();
      invalidateNotificationsCache();
      setNotifications([]);
      notifyNotificationsChanged();
      await closeClearModal();
    } catch {
      await reloadNotifications();
    } finally {
      setClearingAll(false);
    }
  };

  if (!isClient || !hasToken) return <div className={styles.page} />;

  return (
      <section className={styles.page}>
        <div className={styles.notificationsScroll} id="central-scroll-notifications">
          <div className={styles.notificationsTopBlock}>
            <div className={styles.notificationsTopInner}>
              <div className={styles.notificationsSearchHeader}>
                <TabSearchInput
                  placeholder="Поиск по уведомлениям"
                  value={searchValue}
                  onChange={setSearchValue}
                  classNames={{
                    wrap: styles.notificationsSearchWrap,
                    box: styles.notificationsSearchBox,
                    icon: styles.notificationsSearchIcon,
                    input: styles.notificationsSearchInput,
                    actionButton: styles.notificationsSearchSendBtn,
                    actionButtonShown: styles.notificationsSearchSendBtnShown,
                    actionButtonHidden: styles.notificationsSearchSendBtnHidden
                  }}
                />
              </div>

              {!hasSearch ? (
                <div className={styles.notificationsFiltersBlock}>
                  <div className={styles.notificationsTabsWrap} id="notifications-tabs-wrap">
                    <div className={styles.notificationsTabs}>
                      <button
                        ref={tabAllRef}
                        type="button"
                        className={`${styles.notificationsTab} flora-type-15 ${activeTab === 0 ? styles.notificationsTabActive : ""}`}
                        onClick={() => switchTab(0)}
                      >
                        <span className={styles.notificationsTabLabel}>Все</span>
                      </button>
                      <button
                        ref={tabSocialRef}
                        type="button"
                        className={`${styles.notificationsTab} flora-type-15 ${activeTab === 1 ? styles.notificationsTabActive : ""}`}
                        onClick={() => switchTab(1)}
                      >
                        <span className={styles.notificationsTabLabel}>Социальные</span>
                      </button>
                      <button
                        ref={tabDevRef}
                        type="button"
                        className={`${styles.notificationsTab} flora-type-15 ${activeTab === 2 ? styles.notificationsTabActive : ""}`}
                        onClick={() => switchTab(2)}
                      >
                        <span className={styles.notificationsTabLabel}>От разработчика</span>
                      </button>
                    </div>
                    <div
                      className={`${styles.notificationsTabIndicator} ${indicatorAnimated ? styles.notificationsTabIndicatorAnimated : styles.notificationsTabIndicatorNoTransition}`}
                      style={{ transform: `translateX(${indicatorLeft}px)`, width: `${indicatorWidth}px` }}
                      aria-hidden
                    />
                  </div>
                  <button
                    type="button"
                    className={styles.notificationsClearBtn}
                    onClick={openClearModal}
                    disabled={loading}
                    aria-label="Стереть уведомления"
                  >
                    Стереть уведомления
                    <svg className={styles.notificationsClearBtnIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ) : null}
            </div>
          </div>

          {hasSearch ? (
            <div className={styles.notificationsSearchSection}>
              {loadError ? (
                <p className={emptyHintStyles.hint} role="alert">
                  {loadError}
                </p>
              ) : null}
              {loading && visibleItems.length === 0 ? (
                <p className={emptyHintStyles.hint}>Загрузка уведомлений…</p>
              ) : null}
              {!loading && visibleItems.length === 0 ? (
                <p className={emptyHintStyles.hint}>{getEmptyMessage()}</p>
              ) : (
                <div className={styles.notificationsList}>
                  {visibleItems.map((n) => (
                    <NotificationRow key={n.id} item={n} onMarkRead={() => markAsRead(n.id)} />
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className={styles.notificationsListSection}>
              <div
                key={`${activeTab}-${panelAnimEpoch}`}
                className={`${styles.notificationsListContent} ${
                  panelTransition === "fromLeft"
                    ? styles.notificationsListContentFromLeft
                    : panelTransition === "fromRight"
                      ? styles.notificationsListContentFromRight
                      : ""
                }`}
              >
                {loadError ? (
                  <p className={emptyHintStyles.hint} role="alert">
                    {loadError}
                  </p>
                ) : null}
                {loading && visibleItems.length === 0 ? (
                  <p className={emptyHintStyles.hint}>Загрузка уведомлений…</p>
                ) : null}
                {!loading && visibleItems.length === 0 ? (
                  <p className={emptyHintStyles.hint}>{getEmptyMessage()}</p>
                ) : (
                  <div className={styles.notificationsList}>
                    {visibleItems.map((n) => (
                      <NotificationRow key={n.id} item={n} onMarkRead={() => markAsRead(n.id)} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {showClearModal ? (
          <>
            <div
              className={`${styles.notificationsClearBackdrop} ${clearModalClosing ? styles.notificationsClearBackdropClosing : ""}`}
              onClick={() => void closeClearModal()}
              role="button"
              tabIndex={-1}
              aria-label="Закрыть"
            />
            <div className={styles.notificationsClearModal} role="dialog" aria-modal="true" aria-labelledby="notifications-clear-modal-title">
              <div
                className={`${styles.notificationsClearDialog} ${clearModalClosing ? styles.notificationsClearDialogClosing : ""}`}
                onClick={(e) => e.stopPropagation()}
              >
                <div className={styles.notificationsClearHeader}>
                  <h2 id="notifications-clear-modal-title" className={styles.notificationsClearTitle}>
                    Стереть уведомления
                  </h2>
                  <button type="button" className={styles.notificationsClearClose} onClick={() => void closeClearModal()} aria-label="Закрыть">
                    ×
                  </button>
                </div>
                <div className={styles.notificationsClearBody}>
                  <p className={styles.notificationsClearConfirmText}>
                    Удалить все уведомления? Это действие нельзя отменить.
                  </p>
                  <div className={styles.notificationsClearActions}>
                    <button
                      type="button"
                      className={styles.notificationsClearBtnConfirm}
                      onClick={() => void confirmClearAllNotifications()}
                      disabled={clearingAll}
                    >
                      {clearingAll ? "Удаление…" : "Удалить все"}
                    </button>
                    <button
                      type="button"
                      className={styles.notificationsClearBtnCancel}
                      onClick={() => void closeClearModal()}
                      disabled={clearingAll}
                    >
                      Отмена
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </>
        ) : null}
      </section>
  );
}

function NotificationRow({ item, onMarkRead }: { item: NotificationItem; onMarkRead: () => void }) {
  const iconClass =
    item.type === "follow"
      ? styles.notificationIconReply
      : item.type === "like"
        ? styles.notificationIconLike
        : item.type === "reply"
          ? styles.notificationIconReply
          : item.type === "developer"
            ? styles.notificationIconDeveloper
            : styles.notificationIconDefault;

  return (
    <button type="button" className={`${styles.notificationItem} flora-type-15 ${item.isUnread ? styles.notificationItemUnread : ""}`} onClick={onMarkRead}>
      <div className={`${styles.notificationIcon} ${iconClass}`} aria-hidden>
        {item.type === "like" ? (
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
          </svg>
        ) : item.type === "reply" || item.type === "follow" ? (
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1.5-1.4-3-1.9-4.3-1.9-1.1 0-2 .2-2.7.6V17c-1.2-.8-2.5-1.2-3.8-1.2-3.4 0-6.2 2.8-6.2 6.2 0 1.2.3 2.3.9 3.3L5 17.4c-.6-1.1-.9-2.3-.9-3.6 0-4 3.2-7.2 7.2-7.2 1.9 0 3.6.7 4.9 1.9l.9-.9z" />
          </svg>
        ) : item.type === "developer" ? (
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z" />
          </svg>
        )}
      </div>
      <div className={styles.notificationBody}>
        <p className={styles.notificationText}>{item.text}</p>
        <span className={styles.notificationTime}>{item.timeAgo}</span>
      </div>
    </button>
  );
}
