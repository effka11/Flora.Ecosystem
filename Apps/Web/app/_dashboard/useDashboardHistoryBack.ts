"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { tryDashboardNavigation } from "@/app/_dashboard/dashboardLeaveGuard";

export function useDashboardHistoryBack() {
  const router = useRouter();

  return useCallback(() => {
    tryDashboardNavigation("__history_back__", () => {
      router.back();
    });
  }, [router]);
}
