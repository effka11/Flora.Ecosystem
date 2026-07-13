import Constants from "expo-constants";

/** GitHub releases for Flora Social Android APK (alpha distribution). */
export const FLORA_GITHUB_RELEASES_URL = "https://github.com/effka11/Flora.Ecosystem/releases";

const FLORA_SOCIAL_VERSION_FALLBACK = "0.5.0-alpha";

/** Installed Flora Social version (from Expo manifest). */
export function getFloraSocialAppVersion(): string {
  return Constants.expoConfig?.version ?? FLORA_SOCIAL_VERSION_FALLBACK;
}

/** Direct APK download URL for a given social release tag. */
export function buildFloraSocialApkDownloadUrl(version: string): string {
  const v = version.trim();
  return `https://github.com/effka11/Flora.Ecosystem/releases/download/social/v${v}/flora.social-v${v}-android.apk`;
}

/** HTML release page (more reliable for Linking than a direct .apk URL on Android). */
export function buildFloraSocialReleasePageUrl(version: string): string {
  const v = version.trim();
  return `https://github.com/effka11/Flora.Ecosystem/releases/tag/social/v${v}`;
}

/** Parse version from broadcast text: «Новая версия Android - 0.5.0-alpha». */
export function parseAppUpdateVersionFromText(text: string): string | null {
  const match = text.match(/Android\s*-\s*(.+)$/i);
  const version = match?.[1]?.trim();
  return version && version.length > 0 ? version : null;
}

/**
 * Compare Flora Social semver strings (e.g. 0.5.0-alpha).
 * Returns negative if a<b, 0 if equal, positive if a>b. Prerelease suffix is ignored for ordering.
 */
export function compareFloraSocialVersions(a: string, b: string): number {
  const parse = (raw: string): number[] => {
    const core = raw.trim().split("-")[0] ?? "";
    const parts = core.split(".").map((p) => Number.parseInt(p, 10));
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i]! - right[i]!;
  }
  return 0;
}

/** True when the app already has this notification version or newer. */
export function isAppUpdateNotificationInstalled(notificationText: string): boolean {
  const fromText = parseAppUpdateVersionFromText(notificationText);
  if (!fromText) return false;
  return compareFloraSocialVersions(getFloraSocialAppVersion(), fromText) >= 0;
}

/** APK URL for app_update: version from notification text, else installed app version. */
export function resolveAppUpdateApkDownloadUrl(notificationText?: string): string {
  const fromText = notificationText ? parseAppUpdateVersionFromText(notificationText) : null;
  return buildFloraSocialApkDownloadUrl(fromText ?? getFloraSocialAppVersion());
}

/** Bootstrap fallback when PackageInstaller module is not in the binary. */
export function resolveAppUpdateReleasePageUrl(notificationText?: string): string {
  const fromText = notificationText ? parseAppUpdateVersionFromText(notificationText) : null;
  return buildFloraSocialReleasePageUrl(fromText ?? getFloraSocialAppVersion());
}
