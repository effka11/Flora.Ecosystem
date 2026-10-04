import { runGovAuthExclusive } from "./govSessionStore";

const BROWSER_SESSION_PATH = "/api/auth/browser-session";

let loginRedirectScheduled = false;

/**
 * Hard navigation to the Gov login page. A soft App Router replace races with the
 * civic layout that is being unmounted, so the guard always leaves the document.
 * Idempotent within a tab and a no-op while already on `/login`.
 */
export function redirectToLogin(): void {
  if (typeof window === "undefined" || loginRedirectScheduled) return;
  if (window.location.pathname === "/login") return;
  loginRedirectScheduled = true;
  queueMicrotask(() => {
    window.location.replace("/login");
  });
}

/**
 * Expires the HttpOnly refresh cookie. `lib/floraApiProxy.ts` answers this path
 * locally with 204, so the request never reaches flora-api and this is not a call
 * into the public Auth HTTP contract that `@flora/client-core` owns.
 *
 * Ordered behind the refresh lock so it cannot overtake an in-flight rotation
 * that is about to set a fresh cookie.
 */
export function clearBrowserSessionCookie(): void {
  if (typeof window === "undefined") return;
  void runGovAuthExclusive(async () => {
    await fetch(BROWSER_SESSION_PATH, {
      method: "DELETE",
      credentials: "same-origin",
      keepalive: true,
    });
  }).catch(() => {
    // The local session record is already the authoritative tombstone; the cookie
    // is retried on the next explicit logout or 401.
  });
}
