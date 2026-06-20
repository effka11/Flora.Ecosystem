import {
  prefersReducedDashboardMotion,
  stripDashboardHref,
} from "@/app/_dashboard/dashboardRouteTransition";

export const MUSIC_ROUTE_TRANSITION_CLEAR_MS = 950;

export type MusicRoutePanelTransition = null | "fromLeft" | "fromRight";

function musicRouteGenreRoot(path: string): string | null {
  const clean = stripDashboardHref(path);
  const match = clean.match(/^(\/music\/genre\/[^/?#]+)/);
  return match?.[1] ?? null;
}

function musicRouteArtistRoot(path: string): string | null {
  const clean = stripDashboardHref(path);
  const match = clean.match(/^(\/music\/artist\/[^/?#]+)/);
  return match?.[1] ?? null;
}

function musicRouteDepth(path: string): number {
  const clean = stripDashboardHref(path);
  if (clean === "/music") return 0;
  if (clean.startsWith("/music/artist/")) return 1;
  if (clean.startsWith("/music/")) return 1;
  return 0;
}

/** Направление как у подвкладок музыки: вглубь — fromRight, назад — fromLeft. */
export function resolveMusicRoutePanelTransition(
  fromPath: string,
  toPath: string,
): MusicRoutePanelTransition {
  const from = stripDashboardHref(fromPath);
  const to = stripDashboardHref(toPath);
  if (from === to) return null;

  const fromGenreRoot = musicRouteGenreRoot(from);
  const toGenreRoot = musicRouteGenreRoot(to);
  if (fromGenreRoot && toGenreRoot && fromGenreRoot === toGenreRoot) {
    return null;
  }

  const fromArtistRoot = musicRouteArtistRoot(from);
  const toArtistRoot = musicRouteArtistRoot(to);
  if (fromArtistRoot && toArtistRoot && fromArtistRoot === toArtistRoot) {
    return null;
  }

  const fromDepth = musicRouteDepth(from);
  const toDepth = musicRouteDepth(to);
  if (toDepth > fromDepth) return "fromRight";
  if (toDepth < fromDepth) return "fromLeft";
  return "fromRight";
}

export function shouldAnimateMusicRoute(fromPath: string, toPath: string): boolean {
  if (prefersReducedDashboardMotion()) return false;
  return resolveMusicRoutePanelTransition(fromPath, toPath) != null;
}
