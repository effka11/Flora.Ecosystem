"use client";

import { useEffect } from "react";
import { ensureFreshAccessToken, getAccessToken, getRefreshToken } from "@/lib/auth";

const KEEP_ALIVE_INTERVAL_MS = 4 * 60 * 1000;

/**
 * Proactive token renew while the dashboard is open.
 * Primary triggers: visibility / focus / bfcache restore (background timers are unreliable).
 */
export function useSessionKeepAlive(): void {
  useEffect(() => {
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      if (!getAccessToken() || !getRefreshToken()) return;
      void ensureFreshAccessToken();
    };

    tick();

    const onVisibility = () => {
      if (document.visibilityState === "visible") tick();
    };
    const onFocus = () => tick();
    const onPageShow = (event: PageTransitionEvent) => {
      // First load is covered by mount `tick()`; only renew after bfcache restore.
      if (event.persisted) tick();
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", onPageShow);
    const intervalId = window.setInterval(tick, KEEP_ALIVE_INTERVAL_MS);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", onPageShow);
      window.clearInterval(intervalId);
    };
  }, []);
}
