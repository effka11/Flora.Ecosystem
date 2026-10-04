/** Как `FEED_LIST_TRANSITION_CLEAR_MS` в feed/page.tsx. */
export const DASHBOARD_ROUTE_TRANSITION_CLEAR_MS = 950;

/** Маршруты сайдбара — prefetch для мгновенного переключения. */
export const DASHBOARD_INSTANT_PREFETCH = [
  "/feed",
  "/compose",
  "/messages",
  "/people",
  "/communities",
  "/music",
  "/notifications",
  "/profile",
  "/settings"
] as const;

export const DASHBOARD_COMPOSE_PATH = "/compose";

export function stripDashboardHref(href: string): string {
  return href.split("?")[0]?.split("#")[0] ?? href;
}

export function isMusicSectionPath(pathname: string): boolean {
  const clean = stripDashboardHref(pathname);
  return clean === "/music" || clean.startsWith("/music/");
}

/** Ключ панели контента: все маршруты музыки — одна панель (переходы в music/layout). */
export function contentRoutePanelKey(displayPath: string): string {
  const clean = stripDashboardHref(displayPath);
  if (clean === "/music" || clean.startsWith("/music/")) {
    return "/music";
  }
  return clean;
}

export type DashboardRouteTransition = "fromLeft" | "fromRight";

const SIDEBAR_NAV_ORDER = [
  "/feed",
  "/compose",
  "/messages",
  "/people",
  "/communities",
  "/music",
  "/notifications"
] as const;

function normalizeNavPath(pathname: string): string {
  const path = stripDashboardHref(pathname);
  if (path.startsWith("/profile")) return "/profile";
  if (path === "/settings") return "/settings";
  if (path === DASHBOARD_COMPOSE_PATH) return DASHBOARD_COMPOSE_PATH;
  if (path.startsWith("/feed/")) return "/feed";
  if (path.startsWith("/notifications/")) return "/notifications";
  if (path.startsWith("/music")) return "/music";
  if (path.startsWith("/communities/")) return "/communities";
  return path;
}

function routeOrderIndex(pathname: string): number {
  const path = normalizeNavPath(pathname);
  if (path === "/profile") return SIDEBAR_NAV_ORDER.length;
  if (path === "/settings") return SIDEBAR_NAV_ORDER.length + 1;
  const idx = SIDEBAR_NAV_ORDER.indexOf(path as (typeof SIDEBAR_NAV_ORDER)[number]);
  return idx >= 0 ? idx : 0;
}

/** Направление как у подвкладок ленты (вправо по сайдбару → fromRight). */
export function routeTransitionDirection(
  fromPathname: string,
  toHref: string
): DashboardRouteTransition {
  const toPath = normalizeNavPath(toHref);
  const fromIdx = routeOrderIndex(fromPathname);
  const toIdx = routeOrderIndex(toPath);
  return toIdx > fromIdx ? "fromRight" : "fromLeft";
}

export function prefersReducedDashboardMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Внутренние маршруты дашборда (сайдбар + профиль + настройки). */
const DASHBOARD_ROUTE_PREFIXES = [
  "/feed",
  "/compose",
  "/messages",
  "/people",
  "/communities",
  "/music",
  "/notifications",
  "/profile",
  "/settings"
] as const;

export function isDashboardNavHref(href: string): boolean {
  if (!href.startsWith("/") || href.startsWith("//")) return false;
  const path = stripDashboardHref(href);
  return DASHBOARD_ROUTE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** Лента настроек с сайдбаром в колонках 92+ — нужен overflow:visible у .content. */
export function isDashboardSettingsLayoutPath(pathname: string): boolean {
  const path = stripDashboardHref(pathname);
  if (path === "/settings" || path.startsWith("/settings/")) return true;
  return /^\/communities\/[^/]+\/settings$/.test(path);
}

export function isDashboardRouteActive(pathname: string, href: string): boolean {
  const path = stripDashboardHref(href);
  const current = stripDashboardHref(pathname);
  if (current === path) return true;
  if (path === "/feed" && current.startsWith("/feed/")) return true;
  if (path === "/notifications" && current.startsWith("/notifications/")) return true;
  if (path === "/music" && current.startsWith("/music")) return true;
  if (path === "/profile" && current.startsWith("/profile/")) return true;
  if (path === "/communities" && current.startsWith("/communities/")) return true;
  return false;
}
