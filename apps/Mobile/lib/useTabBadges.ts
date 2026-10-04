import { apiMessagingUnreadCount, apiNotificationsUnreadCount } from "@flora/client-core/api";
import type { SignalsSnapshot } from "@flora/client-core/signals";
import { useFocusEffect } from "expo-router/react-navigation";
import { useCallback, useEffect, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { useSessionStore } from "@/stores/sessionStore";

const POLL_MS = 120_000;

const EMPTY_SNAPSHOT: SignalsSnapshot = {
  feedHasNew: false,
  notificationsUnread: 0,
  messagesUnread: 0,
};

const refreshListeners = new Set<() => void>();

/** Сбросить счётчики tab bar сразу (после mark-read, push и т.д.). */
export function requestTabBadgesRefresh(): void {
  refreshListeners.forEach((listener) => listener());
}

export function useTabBadges(): SignalsSnapshot {
  const isAuthenticated = useSessionStore((s) => s.isAuthenticated);
  const [snapshot, setSnapshot] = useState<SignalsSnapshot>(EMPTY_SNAPSHOT);

  const refresh = useCallback(async () => {
    if (!isAuthenticated) {
      setSnapshot(EMPTY_SNAPSHOT);
      return;
    }
    const [notifResult, msgResult] = await Promise.allSettled([
      apiNotificationsUnreadCount(),
      apiMessagingUnreadCount(),
    ]);
    setSnapshot((prev) => ({
      ...prev,
      notificationsUnread:
        notifResult.status === "fulfilled" ? notifResult.value : prev.notificationsUnread,
      messagesUnread: msgResult.status === "fulfilled" ? msgResult.value : prev.messagesUnread,
    }));
  }, [isAuthenticated]);

  useEffect(() => {
    refreshListeners.add(refresh);
    return () => {
      refreshListeners.delete(refresh);
    };
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!isAuthenticated) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [isAuthenticated, refresh]);

  useFocusEffect(
    useCallback(() => {
      if (!isAuthenticated) return;
      void refresh();
    }, [isAuthenticated, refresh]),
  );

  useEffect(() => {
    if (!isAuthenticated) return;
    const onAppState = (state: AppStateStatus) => {
      if (state === "active") void refresh();
    };
    const sub = AppState.addEventListener("change", onAppState);
    return () => sub.remove();
  }, [isAuthenticated, refresh]);

  return isAuthenticated ? snapshot : EMPTY_SNAPSHOT;
}
