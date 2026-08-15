/**
 * Hard-nav to /login — same path as 401 (`scheduleUnauthorizedRedirect`).
 * Soft App Router replace is unreliable inside DashboardShell (instant views +
 * replace+refresh races). Full reload tears down the shell.
 */

let loginRedirectScheduled = false;

/** Hard redirect to the login page. Idempotent within a tab; no-op on /login. */
export function redirectToLogin(): void {
  if (typeof window === "undefined" || loginRedirectScheduled) return;
  if (window.location.pathname === "/login") return;
  loginRedirectScheduled = true;
  queueMicrotask(() => {
    window.location.replace("/login");
  });
}

/** Test-only: reset the once-per-tab latch. */
export function resetLoginRedirectForTests(): void {
  loginRedirectScheduled = false;
}
