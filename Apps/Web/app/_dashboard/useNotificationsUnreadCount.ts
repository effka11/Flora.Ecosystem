"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGetNotificationsUnreadCount } from "@/lib/notificationsApi";
import { NOTIFICATIONS_CHANGED_EVENT } from "@/lib/realtimeEvents";

export function useNotificationsUnreadCount(enabled: boolean): number {
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    if (!enabled) {
      setCount(0);
      return;
    }
    try {
      setCount(await apiGetNotificationsUnreadCount());
    } catch {
      setCount(0);
    }
  }, [enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!enabled) return;
    const onChanged = () => void refresh();
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, onChanged);
    const timer = window.setInterval(() => void refresh(), 120_000);
    return () => {
      window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, onChanged);
      window.clearInterval(timer);
    };
  }, [enabled, refresh]);

  return count;
}
