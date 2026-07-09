"use client";

import { useEffect, useRef } from "react";
import { useCurrentUser } from "@/app/_dashboard/CurrentUserContext";
import { getAccessToken } from "@/lib/auth";
import {
  attachPendingThreadPrefetchViewer,
  resetDashboardPrefetchState,
  startCriticalDashboardPrefetch,
  startDashboardDataPrefetch,
} from "@/lib/dashboardPreload";

/**
 * Тихая предзагрузка вкладок:
 * 1) критичные API (лента / чаты / уведомления) — сразу при токене, параллельно с apiGetMe;
 * 2) полный прогрев (треды, people, music, …) — после появления профиля.
 */
export function useDashboardDataPrefetch(): void {
  const { me, loading } = useCurrentUser();
  const criticalStartedRef = useRef(false);
  const startedForUserRef = useRef<string | null>(null);

  useEffect(() => {
    const hasToken = Boolean(getAccessToken());
    if (!hasToken) {
      if (criticalStartedRef.current || startedForUserRef.current) {
        criticalStartedRef.current = false;
        startedForUserRef.current = null;
        resetDashboardPrefetchState();
      }
      return;
    }
    if (criticalStartedRef.current) return;
    criticalStartedRef.current = true;
    startCriticalDashboardPrefetch();
  }, [me?.userUuid, loading]);

  useEffect(() => {
    if (!me?.userUuid) return;
    attachPendingThreadPrefetchViewer(me.userUuid);
    if (startedForUserRef.current === me.userUuid) return;
    startedForUserRef.current = me.userUuid;
    startDashboardDataPrefetch(me.username, me.userUuid);
  }, [me?.userUuid, me?.username]);
}
