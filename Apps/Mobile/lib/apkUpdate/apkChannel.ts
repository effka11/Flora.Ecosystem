/** Flora Social Android APK distribution channel (independent of GitHub Releases). */
export const FLORA_APK_CHANNEL_ORIGIN = "https://social.flora-s.net";
export const FLORA_APK_CHANNEL_BASE = `${FLORA_APK_CHANNEL_ORIGIN}/apk`;
export const FLORA_APK_CHANNEL_RELEASES_URL = `${FLORA_APK_CHANNEL_BASE}/releases.json`;
export const FLORA_APK_CHANNEL_LATEST_UPDATE_URL = `${FLORA_APK_CHANNEL_BASE}/flora.social-android-update.json`;
export const FLORA_DOWNLOAD_PAGE_URL = `${FLORA_APK_CHANNEL_ORIGIN}/download`;

export function buildFloraSocialApkChannelUrl(version: string): string {
  const v = version.trim();
  return `${FLORA_APK_CHANNEL_BASE}/flora.social-v${v}-android.apk`;
}

export type FloraApkChannelRelease = {
  version: string;
  versionCode: number;
  apkFileName: string;
  apkUrl: string;
  sha256: string;
  sizeBytes: number;
  publishedAt: string;
};

export type FloraApkChannelCatalog = {
  updatedAt: string;
  releases: FloraApkChannelRelease[];
};
