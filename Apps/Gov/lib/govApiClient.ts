import {
  configureApiClient,
  getApiClientConfig,
  syncStoredSessionTokens as syncCoreSessionTokens,
} from "@flora/client-core/api";
import { apiLogout } from "@flora/client-core/auth";
import { govSessionStore, runGovAuthExclusive } from "./govSessionStore";
import { clearBrowserSessionCookie, redirectToLogin } from "./loginRedirect";

/**
 * Empty base URL keeps every client-core request same-origin (`/api/...`), so it
 * lands on the Gov Route Handlers on :3001 that hold the HttpOnly refresh cookie.
 * The browser must never address flora-api directly.
 */
const GOV_API_BASE_URL = "";

/** Mirrors the `version` field of Apps/Gov/package.json for the X-Flora-Client header. */
const GOV_APP_VERSION = "0.12.0-alpha";

let apiClientInitialized = false;

function onGovUnauthorized(): void {
  if (typeof window === "undefined") return;
  if (window.location.pathname === "/login") return;
  // The session record is already cleared by the refresh coordinator; the cookie
  // is the only credential left to drop before leaving.
  clearBrowserSessionCookie();
  redirectToLogin();
}

/** Idempotent; safe for eager imports and for React Fast Refresh. */
export function initGovApiClient(): void {
  if (apiClientInitialized) return;
  try {
    if (getApiClientConfig().session === govSessionStore) {
      apiClientInitialized = true;
      return;
    }
  } catch {
    // No client configured yet.
  }

  configureApiClient({
    apiBaseUrl: GOV_API_BASE_URL,
    session: govSessionStore,
    clientIdentity: { platform: "web", appVersion: GOV_APP_VERSION },
    runRefreshExclusive: runGovAuthExclusive,
    onUnauthorized: onGovUnauthorized,
  });
  apiClientInitialized = true;
}

/** Proactive renew plus logout when the refresh endpoint confirms the session is gone. */
export async function syncGovSessionTokens(): Promise<void> {
  initGovApiClient();
  await syncCoreSessionTokens();
}

/**
 * Explicit civic sign-out: revoke the Auth session, tombstone `flora_gov_session_v1`,
 * drop the Gov HttpOnly cookie, then hard-navigate to this origin's `/login`.
 * Social's session key is not read or written.
 */
export async function signOutGov(): Promise<void> {
  initGovApiClient();
  try {
    await apiLogout();
  } catch {
    // Auth revocation is best-effort; the local tombstone is mandatory.
  }
  await govSessionStore.clearSession();
  clearBrowserSessionCookie();
  redirectToLogin();
}
