/**
 * Cover request from the hamburger (ancestor of Tabs) into `useTabRouteTransition`.
 * Process-wide like the idle serializer: no React context through the provider.
 */

const HAMBURGER_TAB_NAMES = ["people", "communities", "settings", "contribute"] as const;

export type HamburgerTabName = (typeof HAMBURGER_TAB_NAMES)[number];

function isHamburgerTabName(value: string): value is HamburgerTabName {
  return (HAMBURGER_TAB_NAMES as readonly string[]).includes(value);
}

/** `/(tabs)/people` or `{ pathname: "/(tabs)/settings", params }` → tab name. */
export function tabNameFromHamburgerTarget(target: {
  pathname?: string;
  params?: unknown;
} | string): HamburgerTabName | null {
  const path = typeof target === "string" ? target : (target.pathname ?? "");
  const fromGroups = path.match(/\/\(tabs\)\/([^/?#]+)/);
  const fromRoot = fromGroups == null ? path.match(/^\/([^/?#]+)/) : null;
  const segment = fromGroups?.[1] ?? fromRoot?.[1];
  if (segment == null || !isHamburgerTabName(segment)) {
    return null;
  }
  return segment;
}

export function shouldCoverTabSwitch(
  activeName: string | undefined,
  targetName: string,
): boolean {
  return activeName !== targetName;
}

/** Pathname already on this hamburger tab — close the drawer, do not navigate. */
export function isHamburgerTabPathActive(
  pathname: string,
  tabName: HamburgerTabName,
): boolean {
  return pathname === `/${tabName}` || pathname.startsWith(`/${tabName}/`);
}

type TabRouteCoverHandler = (tabName: string) => void;
type TabRouteRevealHandler = () => void;

let coverHandler: TabRouteCoverHandler | null = null;
let revealHandler: TabRouteRevealHandler | null = null;

export function registerTabRouteCoverHandler(handler: TabRouteCoverHandler | null): void {
  coverHandler = handler;
}

export function registerTabRouteRevealHandler(handler: TabRouteRevealHandler | null): void {
  revealHandler = handler;
}

export function requestTabRouteCover(tabName: string): void {
  coverHandler?.(tabName);
}

/** Reveal after hamburger `navigate` — `transitionEnd` may not fire (`animation: "none"`). */
export function requestTabRouteReveal(): void {
  revealHandler?.();
}

/** test-only */
export function __resetTabRouteCoverHandler(): void {
  coverHandler = null;
  revealHandler = null;
}
