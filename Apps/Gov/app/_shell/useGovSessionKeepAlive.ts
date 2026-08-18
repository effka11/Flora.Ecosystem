"use client";

import { useEffect } from "react";
import { syncGovSessionTokens } from "@/lib/govApiClient";
import { govSessionStore } from "@/lib/govSessionStore";

const KEEP_ALIVE_INTERVAL_MS = 4 * 60 * 1000;

/**
 * Renews the access token while a civic page is open, and lets client-core sign the
 * tab out once the refresh endpoint confirms the session is gone.
 *
 * Background timers are throttled, so visibility, focus and bfcache restore carry
 * the flow and the interval is only a backstop.
 */
export function useGovSessionKeepAlive(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      // No refresh capability means the HttpOnly cookie is gone too; nothing to renew.
      if (!govSessionStore.getRefreshTokenSync()) return;
      void syncGovSessionTokens();
    };

    tick();

    const onVisibility = () => {
      if (document.visibilityState === "visible") tick();
    };
    const onFocus = () => tick();
    const onPageShow = (event: PageTransitionEvent) => {
      // The mount tick covers the first load; only a bfcache restore needs another.
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
  }, [enabled]);
}
