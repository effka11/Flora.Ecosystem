import Constants from "expo-constants";

/** GitHub releases for Flora Social Android APK (alpha distribution). */
export const FLORA_GITHUB_RELEASES_URL = "https://github.com/effka11/Flora.Ecosystem/releases";

const FLORA_SOCIAL_VERSION_FALLBACK = "0.4.0-alpha";

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

/** Parse version from broadcast text: «Новая версия Android - 0.4.0-alpha». */
export function parseAppUpdateVersionFromText(text: string): string | null {
  const match = text.match(/Android\s*-\s*(.+)$/i);
  const version = match?.[1]?.trim();
  return version && version.length > 0 ? version : null;
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
