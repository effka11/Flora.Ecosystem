"use client";

import { useEffect, useRef } from "react";
import { useCurrentUser } from "@/app/_dashboard/CurrentUserContext";
import { startDashboardDataPrefetch } from "@/lib/dashboardPreload";

/** Запускает тихую предзагрузку данных всех вкладок после появления профиля. */
export function useDashboardDataPrefetch(): void {
  const { me } = useCurrentUser();
  const startedForUserRef = useRef<string | null>(null);

  useEffect(() => {
    if (!me?.userUuid) return;
    if (startedForUserRef.current === me.userUuid) return;
    startedForUserRef.current = me.userUuid;
    startDashboardDataPrefetch(me.username);
  }, [me?.userUuid, me?.username]);
}
