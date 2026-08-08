import Constants from "expo-constants";
import {
  buildFloraSocialApkChannelUrl,
  FLORA_DOWNLOAD_PAGE_URL,
} from "@/lib/apkUpdate/apkChannel";

/** Public download page for Flora Social Android APK. */
export const FLORA_DOWNLOAD_PAGE = FLORA_DOWNLOAD_PAGE_URL;

/** @deprecated Use FLORA_DOWNLOAD_PAGE — kept for call sites during rename. */
export const FLORA_GITHUB_RELEASES_URL = FLORA_DOWNLOAD_PAGE_URL;

const FLORA_SOCIAL_VERSION_FALLBACK = "0.11.0-alpha";

/** Installed Flora Social version (from Expo manifest). */
export function getFloraSocialAppVersion(): string {
  return Constants.expoConfig?.version ?? FLORA_SOCIAL_VERSION_FALLBACK;
}

/** Direct APK download URL for a given social release on the Flora channel. */
export function buildFloraSocialApkDownloadUrl(version: string): string {
  return buildFloraSocialApkChannelUrl(version);
}

/** Human-facing download page (optional UX; fallback 2.4 uses the APK URL instead). */
export function buildFloraSocialReleasePageUrl(_version: string): string {
  return FLORA_DOWNLOAD_PAGE_URL;
}

/** Parse version from broadcast text: «Новая версия Android - 0.7.0-alpha». */

export function parseAppUpdateVersionFromText(text: string): string | null {
  const match = text.match(/Android\s*-\s*(.+)$/i);
  const version = match?.[1]?.trim();
  return version && version.length > 0 ? version : null;
}

/**
 * Compare Flora Social version strings (e.g. 0.7.0-alpha, 0.7.0-test2).
 * Returns negative if a&lt;b, 0 if equal, positive if a&gt;b.
 * Core semver first; then prerelease (no suffix &gt; with suffix; otherwise lexicographic).
 */
export function compareFloraSocialVersions(a: string, b: string): number {
  const parse = (raw: string): { core: number[]; pre: string } => {
    const trimmed = raw.trim();
    const dash = trimmed.indexOf("-");
    const corePart = dash >= 0 ? trimmed.slice(0, dash) : trimmed;
    const pre = dash >= 0 ? trimmed.slice(dash + 1) : "";
    const parts = corePart.split(".").map((p) => Number.parseInt(p, 10));
    return {
      core: [parts[0] || 0, parts[1] || 0, parts[2] || 0],
      pre,
    };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i]! - right.core[i]!;
  }
  // 0.6.0 > 0.6.0-test (release without prerelease is newer)
  if (!left.pre && right.pre) return 1;
  if (left.pre && !right.pre) return -1;
  if (left.pre === right.pre) return 0;
  // 0.6.0-test < 0.6.0-test2
  return left.pre < right.pre ? -1 : 1;
}

/** True when the app already has this notification version or newer. */
export function isAppUpdateNotificationInstalled(notificationText: string): boolean {
  const fromText = parseAppUpdateVersionFromText(notificationText);
  if (!fromText) return false;
  return compareFloraSocialVersions(getFloraSocialAppVersion(), fromText) >= 0;
}

/** APK download for app_update: version from notification text, else installed app version. */
export function resolveAppUpdateApkDownloadUrl(notificationText?: string): string {
  const fromText = notificationText ? parseAppUpdateVersionFromText(notificationText) : null;
  return buildFloraSocialApkDownloadUrl(fromText ?? getFloraSocialAppVersion());
}

/** @deprecated Prefer resolveAppUpdateApkDownloadUrl for 2.4 fallback. */
export function resolveAppUpdateReleasePageUrl(notificationText?: string): string {
  return FLORA_DOWNLOAD_PAGE_URL;
}
